import type { Logger } from 'pino';
import type { CcmuxConfig } from '../config/schema.js';
import type { Signals, SessionContext } from '../signals/types.js';
import type { PolicyResult, Rule } from '../policy/dsl.js';
import type { DecisionRecord, DecisionSource, UsageFields } from '../decisions/types.js';
import type { Tier } from '../classifier/types.js';
import { extractSignals } from '../signals/extract.js';
import { loadRules } from '../policy/load.js';
import { evaluate } from '../policy/evaluate.js';
import { tierOf, firstModelIdForTier, nextTier } from '../sticky/tiers.js';

const DEFAULT_MODELS: Readonly<Record<Tier, string>> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

export interface RouteResult {
  readonly forwardedModel: string;
  readonly originalModel: string;
  readonly chosenBy: DecisionSource;
  readonly signals: Signals;
  readonly policyResult: PolicyResult;
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

export function routeRequest(
  parsedBody: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  config: CcmuxConfig,
  session: SessionContext,
  logger: Logger,
): RouteResult {
  const rules = compileRules(config);
  const signals = extractSignals(parsedBody, headers, session, logger);
  const policy = evaluate(rules, signals);
  const tierMap = buildTierMap(config);
  const originalModel = getModelFromBody(parsedBody);
  const { modelId, chosenBy } = resolveModel(policy, originalModel, tierMap);
  return { forwardedModel: modelId, originalModel, chosenBy, signals, policyResult: policy };
}

export function buildDecisionRecord(
  route: RouteResult,
  sessionId: string,
  upstreamLatencyMs: number,
  usage: UsageFields | null = null,
  costEstimateUsd: number | null = null,
): DecisionRecord {
  const s = route.signals;
  return {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    request_hash: s.requestHash,
    extracted_signals: {
      plan_mode: s.planMode,
      message_count: s.messageCount,
      tool_use_count: s.toolUseCount,
      est_input_tokens: s.estInputTokens,
      retry_count: s.retryCount,
      frustration: s.frustration,
    },
    policy_result: route.policyResult.kind === 'matched'
      ? { rule_id: route.policyResult.ruleId }
      : { abstain: true },
    classifier_result: null,
    sticky_hit: false,
    chosen_model: route.forwardedModel,
    chosen_by: route.chosenBy,
    forwarded_model: route.forwardedModel,
    upstream_latency_ms: upstreamLatencyMs,
    usage,
    cost_estimate_usd: costEstimateUsd,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
  };
}
