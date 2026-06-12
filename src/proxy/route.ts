import type { Logger } from 'pino';
import type { CcmuxConfig } from '../config/schema.js';
import type { Signals, SessionContext } from '../signals/types.js';
import type { PolicyResult, Rule } from '../policy/dsl.js';
import type { DecisionSource, DecisionMode } from '../decisions/types.js';
import type { Classifier, ClassifierInput, ClassifierResult, Tier } from '../classifier/types.js';
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

// A pre-bound classifier invocation: the caller closes over the ClassifierInput
// (body, headers, signals) so decideRoute only supplies the race deadline.
export type ClassifyFn = (deadline: AbortSignal) => Promise<ClassifierResult | null>;

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

async function runClassifier(classify: ClassifyFn, timeoutMs: number): Promise<ClassifierResult | null> {
  try {
    return await classify(AbortSignal.timeout(timeoutMs));
  } catch {
    return null;
  }
}

// Only act on a classifier suggestion when it clears the per-source confidence
// gate; a low-confidence guess is worse than honoring the client's request.
function isConfident(cls: ClassifierResult, config: CcmuxConfig): boolean {
  const thresholds = config.classifier.confidenceThresholds;
  const threshold = cls.source === 'haiku' ? thresholds.haiku : thresholds.heuristic;
  return cls.confidence >= threshold;
}

// Apply the classifier's tier and, when stickiness is on, persist it so the
// session stays on that tier for subsequent turns.
function applyClassifierTier(
  store: StickyStore,
  config: CcmuxConfig,
  signals: Signals,
  tier: Tier,
  tierMap: ReadonlyMap<string, Tier>,
  now: number,
): ResolvedModel {
  const modelId = modelForTier(tier, tierMap);
  if (config.stickyModel.enabled) {
    // The synthetic ruleId is internal to the sticky write; the decision record
    // still logs the real policy result (an abstain) plus the classifier_result.
    resolveStickyDecision(store, {
      sessionId: signals.sessionId,
      policyResult: { kind: 'matched', ruleId: '__classifier__', result: { choice: { modelId } } },
      explicitModel: null,
      defaultTier: tier,
      tierMap,
      now,
    });
  }
  return { modelId, chosenBy: 'classifier', stickyHit: false };
}

// Pure routing decision. No request I/O — signals and the classifier thunk are
// supplied by the caller, which keeps this fully unit-testable.
export async function decideRoute(
  signals: Signals,
  originalModel: string,
  config: CcmuxConfig,
  store: StickyStore,
  now: number,
  classify?: ClassifyFn,
): Promise<RouteDecision> {
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

  // Classifier fills the gap only when nothing else resolved the model: a new
  // or expired session whose request matched no rule and carried no explicit
  // model. That `fallback` outcome is the single trigger — it already excludes
  // policy hits, explicit models, and live sticky sessions.
  let classifierResult: ClassifierResult | null = null;
  if (resolved.chosenBy === 'fallback' && config.classifier.enabled && classify !== undefined) {
    classifierResult = await runClassifier(classify, config.classifier.timeoutMs);
    if (classifierResult !== null && isConfident(classifierResult, config)) {
      resolved = applyClassifierTier(store, config, signals, classifierResult.suggestedModel, tierMap, now);
    }
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
      classifierResult,
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
    classifierResult,
  };
}

// Lower-cased, string-valued view of the incoming headers — the Haiku
// classifier reads auth/version/beta from this to authenticate its own call.
function lowerStringHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key.toLowerCase()] = value[0];
  }
  return out;
}

function buildClassifyFn(
  classifier: Classifier | null,
  signals: Signals,
  parsedBody: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  config: CcmuxConfig,
): ClassifyFn | undefined {
  if (classifier === null || !config.classifier.enabled) return undefined;
  const input: ClassifierInput = {
    signals,
    body: parsedBody,
    requestHash: signals.requestHash,
    incomingHeaders: lowerStringHeaders(headers),
  };
  return (deadline) => classifier.classify(input, deadline);
}

export async function routeRequest(
  parsedBody: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  config: CcmuxConfig,
  session: SessionContext,
  store: StickyStore,
  classifier: Classifier | null,
  logger: Logger,
): Promise<RouteResult> {
  const signals = extractSignals(parsedBody, headers, session, logger);
  const originalModel = getModelFromBody(parsedBody);
  const classify = buildClassifyFn(classifier, signals, parsedBody, headers, config);
  const decision = await decideRoute(signals, originalModel, config, store, Date.now(), classify);
  return { ...decision, signals };
}
