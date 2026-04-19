// Builds a single DecisionRecord from inputs supplied by the proxy
// integration point. Applies the configured content-redaction mode to the
// extracted signals before returning. Other section invariants:
//
//   - chosen_model is the actual upstream model — callers (proxy/§04) are
//     responsible for using message_start.model rather than the inbound
//     request body's model.
//   - In shadow mode, forwarded_model equals the client-requested model and
//     shadow_choice holds the would-have-been override.
//   - usage and cost_estimate_usd are null when usage was unavailable.

import type { Signals } from '../signals/types.js';
import type { PolicyResult } from '../policy/dsl.js';
import type { ClassifierResult } from '../classifier/types.js';
import { redactSignals } from './redaction.js';
import type {
  ContentMode,
  DecisionClassifierResult,
  DecisionMode,
  DecisionPolicyResult,
  DecisionRecord,
  DecisionSource,
  UsageFields,
} from './types.js';

export interface BuildDecisionRecordInput {
  readonly now: Date;
  readonly sessionId: string;
  readonly requestHash: string;
  readonly extractedSignals: Signals;
  readonly policyResult: PolicyResult;
  readonly classifierResult: ClassifierResult | null;
  readonly stickyHit: boolean;
  readonly chosenModel: string;
  readonly chosenBy: DecisionSource;
  readonly forwardedModel: string;
  readonly mode: DecisionMode;
  readonly shadowChoice: string | null;
  readonly upstreamLatencyMs: number;
  readonly usage: UsageFields | null;
  readonly costEstimateUsd: number | null;
  readonly classifierCostUsd: number | null;
  readonly contentMode: ContentMode;
}

function projectPolicy(p: PolicyResult): DecisionPolicyResult {
  if (p.kind === 'matched') return { rule_id: p.ruleId };
  return { abstain: true };
}

function projectClassifier(c: ClassifierResult | null): DecisionClassifierResult | null {
  if (c === null) return null;
  return {
    score: c.score,
    suggested: c.suggestedModel,
    confidence: c.confidence,
    source: c.source,
    latencyMs: c.latencyMs,
  };
}

export function buildDecisionRecord(input: BuildDecisionRecordInput): DecisionRecord {
  return {
    timestamp: input.now.toISOString(),
    session_id: input.sessionId,
    request_hash: input.requestHash,
    extracted_signals: redactSignals(input.extractedSignals, input.contentMode),
    policy_result: projectPolicy(input.policyResult),
    classifier_result: projectClassifier(input.classifierResult),
    sticky_hit: input.stickyHit,
    chosen_model: input.chosenModel,
    chosen_by: input.chosenBy,
    forwarded_model: input.forwardedModel,
    upstream_latency_ms: input.upstreamLatencyMs,
    usage: input.usage,
    cost_estimate_usd: input.costEstimateUsd,
    classifier_cost_usd: input.classifierCostUsd,
    mode: input.mode,
    shadow_choice: input.shadowChoice,
  };
}
