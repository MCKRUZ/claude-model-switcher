// Decision-log record schema. This is the contract consumed by sections
// 14 (outcome-tagger), 15 (report-cli), 16 (tune), and 17 (dashboard-server).
// One JSONL line per intercepted /v1/messages request.

import type { ContentMode } from '../config/schema.js';
import type { Tier } from '../classifier/types.js';

export type { ContentMode };

export type DecisionSource =
  | 'policy'
  | 'classifier'
  | 'fallback'
  | 'sticky'
  | 'explicit'
  | 'shadow';

export type DecisionMode = 'live' | 'shadow';

export type DecisionRotationStrategy = 'daily' | 'size';

export interface UsageFields {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
}

export interface DecisionPolicyResult {
  readonly rule_id?: string;
  readonly abstain?: true;
}

export interface DecisionClassifierResult {
  readonly score: number;
  readonly suggested: Tier;
  readonly confidence: number;
  readonly source: 'haiku' | 'heuristic';
  readonly latencyMs: number;
}

export interface DecisionRecord {
  readonly timestamp: string;
  readonly session_id: string;
  readonly request_hash: string;
  readonly extracted_signals: Readonly<Record<string, unknown>>;
  readonly policy_result: DecisionPolicyResult;
  readonly classifier_result: DecisionClassifierResult | null;
  readonly sticky_hit: boolean;
  readonly chosen_model: string;
  readonly chosen_by: DecisionSource;
  readonly forwarded_model: string;
  readonly upstream_latency_ms: number;
  readonly usage: UsageFields | null;
  readonly cost_estimate_usd: number | null;
  readonly classifier_cost_usd: number | null;
  readonly mode: DecisionMode;
  readonly shadow_choice: string | null;
}

export interface DropEvent {
  readonly event: 'decision_log_dropped';
  readonly reason: 'queue_full' | 'closed';
}
