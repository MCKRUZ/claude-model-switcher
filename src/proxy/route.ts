import type { Logger } from 'pino';
import type { CcmuxConfig } from '../config/schema.js';
import type { Signals, SessionContext } from '../signals/types.js';
import type { PolicyResult, Rule } from '../policy/dsl.js';
import type { DecisionSource, DecisionMode } from '../decisions/types.js';
import type { ClassifierResult, Tier } from '../classifier/types.js';
import type { StickyStore } from '../sticky/store.js';
import type { StickyChosenBy } from '../sticky/types.js';
import { extractSignals } from '../signals/extract.js';
import { loadRules } from '../policy/load.js';
import { evaluate } from '../policy/evaluate.js';
import { resolveStickyDecision } from '../sticky/policy.js';
import { tierOf, firstModelIdForTier, nextTier } from '../sticky/tiers.js';

const DEFAULT_MODELS: Readonly<Record<Tier, string>> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

// The routing decision, independent of how signals were obtained. Pure and
// testable: given signals + config + the sticky store, it picks the model.
export interface RouteDecision {
  readonly forwardedModel: string;
  readonly originalModel: string;
  readonly chosenBy: DecisionSource;
  readonly stickyHit: boolean;
  readonly shadowChoice: string | null;
  readonly mode: DecisionMode;
  readonly policyResult: PolicyResult;
  readonly classifierResult: ClassifierResult | null;
}

export interface RouteResult extends RouteDecision {
  readonly signals: Signals;
}

export function createSessionContext(): SessionContext {
  const retryCounts = new Map<string, number>();
  return {
    createdAt: Date.now(),
    retrySeen(hash: string): number {
      const count = retryCounts.get(hash) ?? 0;
      retryCounts.set(hash, count + 1);
      return count;
    },
  };
}

let cachedConfigRef: CcmuxConfig | null = null;
let cachedRules: readonly Rule[] = [];

function compileRules(config: CcmuxConfig): readonly Rule[] {
  if (config === cachedConfigRef) return cachedRules;
  const raw = config.rules.map((r) => ({
    id: r.id,
    when: r.when,
    then: r.allowDowngrade !== undefined
      ? { ...r.then, allowDowngrade: r.allowDowngrade }
      : r.then,
  }));
  const result = loadRules(raw, { modelTiers: config.modelTiers ?? {} });
  if (!result.ok) return cachedRules;
  cachedConfigRef = config;
  cachedRules = result.value;
  return cachedRules;
}

function buildTierMap(config: CcmuxConfig): ReadonlyMap<string, Tier> {
  const map = new Map<string, Tier>();
  for (const [tier, modelId] of Object.entries(DEFAULT_MODELS)) {
    map.set(modelId, tier as Tier);
  }
  if (config.modelTiers) {
    for (const [modelId, tier] of Object.entries(config.modelTiers)) {
      map.set(modelId, tier as Tier);
    }
  }
  return map;
}

function modelForTier(tier: Tier, tierMap: ReadonlyMap<string, Tier>): string {
  return firstModelIdForTier(tier, tierMap) ?? DEFAULT_MODELS[tier];
}

export function getModelFromBody(body: unknown): string {
  if (body && typeof body === 'object' && 'model' in body) {
    return String((body as { model: unknown }).model);
  }
  return 'unknown';
}

function resolveModel(
  policy: PolicyResult,
  requestedModel: string,
  tierMap: ReadonlyMap<string, Tier>,
): { modelId: string; chosenBy: DecisionSource } {
  if (policy.kind === 'abstain') {
    return { modelId: requestedModel, chosenBy: 'fallback' };
  }
  const { result } = policy;
  if ('choice' in result) {
    const { choice } = result;
    if (typeof choice === 'string') {
      return { modelId: modelForTier(choice, tierMap), chosenBy: 'policy' };
    }
    return { modelId: choice.modelId, chosenBy: 'policy' };
  }
  if ('escalate' in result) {
    try {
      const current = tierOf(requestedModel, tierMap);
      const target = nextTier(current, result.escalate);
      return { modelId: modelForTier(target, tierMap), chosenBy: 'policy' };
    } catch {
      return { modelId: requestedModel, chosenBy: 'fallback' };
    }
  }
  return { modelId: requestedModel, chosenBy: 'fallback' };
}

// DecisionSource has no 'escalate' member; an escalation is a policy-driven move.
function mapStickyChosenBy(chosenBy: StickyChosenBy): DecisionSource {
  return chosenBy === 'escalate' ? 'policy' : chosenBy;
}

interface ResolvedModel {
  readonly modelId: string;
  readonly chosenBy: DecisionSource;
  readonly stickyHit: boolean;
}

// Run the policy result through the sticky store: this is where session
// stability, asymmetric escalation, and downgrade-blocking are enforced.
function resolveViaSticky(
  store: StickyStore,
  policy: PolicyResult,
  signals: Signals,
  originalModel: string,
  tierMap: ReadonlyMap<string, Tier>,
  now: number,
): ResolvedModel {
  let defaultTier: Tier;
  try {
    defaultTier = tierOf(originalModel, tierMap);
  } catch {
    defaultTier = 'sonnet';
  }
  const decision = resolveStickyDecision(store, {
    sessionId: signals.sessionId,
    policyResult: policy,
    explicitModel: signals.explicitModel,
    defaultTier,
    tierMap,
    now,
  });
  if (decision.kind === 'chosen') {
    return {
      modelId: decision.modelId,
      chosenBy: mapStickyChosenBy(decision.chosenBy),
      stickyHit: decision.chosenBy === 'sticky',
    };
  }
  // A blocked downgrade keeps the session on its existing (higher) sticky model.
  if (decision.reason === 'downgrade-blocked' && decision.sticky !== undefined) {
    return { modelId: decision.sticky.modelId, chosenBy: 'sticky', stickyHit: true };
  }
  // No sticky state to apply (new or expired session). Phase C inserts the
  // classifier here; until then, honor the client's requested model.
  return { modelId: originalModel, chosenBy: 'fallback', stickyHit: false };
}

// Pure routing decision. No I/O — signals are supplied by the caller.
export function decideRoute(
  signals: Signals,
  originalModel: string,
  config: CcmuxConfig,
  store: StickyStore,
  now: number,
): RouteDecision {
  const rules = compileRules(config);
  const policy = evaluate(rules, signals);
  const tierMap = buildTierMap(config);

  let resolved: ResolvedModel;
  if (config.stickyModel.enabled) {
    resolved = resolveViaSticky(store, policy, signals, originalModel, tierMap, now);
  } else {
    const r = resolveModel(policy, originalModel, tierMap);
    resolved = { modelId: r.modelId, chosenBy: r.chosenBy, stickyHit: false };
  }

  // Shadow mode: never change live traffic — forward the client's model and
  // record what the router would have done so `tune` can measure it.
  if (config.mode === 'shadow') {
    return {
      forwardedModel: originalModel,
      originalModel,
      chosenBy: 'shadow',
      stickyHit: resolved.stickyHit,
      shadowChoice: resolved.modelId !== originalModel ? resolved.modelId : null,
      mode: 'shadow',
      policyResult: policy,
      classifierResult: null,
    };
  }

  return {
    forwardedModel: resolved.modelId,
    originalModel,
    chosenBy: resolved.chosenBy,
    stickyHit: resolved.stickyHit,
    shadowChoice: null,
    mode: 'live',
    policyResult: policy,
    classifierResult: null,
  };
}

export function routeRequest(
  parsedBody: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  config: CcmuxConfig,
  session: SessionContext,
  store: StickyStore,
  logger: Logger,
): RouteResult {
  const signals = extractSignals(parsedBody, headers, session, logger);
  const originalModel = getModelFromBody(parsedBody);
  const decision = decideRoute(signals, originalModel, config, store, Date.now());
  return { ...decision, signals };
}
