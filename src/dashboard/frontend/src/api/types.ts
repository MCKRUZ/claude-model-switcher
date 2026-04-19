export interface SummaryResponse {
  readonly routingDistribution: Record<string, number>;
  readonly cacheHitRate: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly totalCost: number;
  readonly classifierCost: number;
  readonly truncated?: boolean;
}

export interface DecisionRow {
  readonly decision_id: string;
  readonly timestamp: string;
  readonly session_id: string;
  readonly request_hash: string;
  readonly requested_model: string;
  readonly forwarded_model: string;
  readonly chosen_by: string;
  readonly upstream_latency_ms: number;
  readonly cost_estimate_usd: number | null;
  readonly classifier_cost_usd: number | null;
  readonly policy_result: {
    readonly rule_id: string | null;
    readonly action: string;
    readonly target_model: string;
  };
  readonly classifier_result: {
    readonly score: number;
    readonly suggested: string;
    readonly confidence: number;
    readonly source: 'heuristic' | 'haiku';
    readonly latencyMs: number;
  } | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens: number;
    readonly cache_creation_input_tokens: number;
  } | null;
}

export interface DecisionsResponse {
  readonly items: readonly DecisionRow[];
  readonly limit: number;
  readonly offset: number;
  readonly total_scanned: number;
}

export interface CostBucket {
  readonly ts_bucket: string;
  readonly cost_usd: number;
  readonly classifier_cost_usd: number;
  readonly requests: number;
}

export interface CostsResponse {
  readonly buckets: readonly CostBucket[];
  readonly truncated?: boolean;
}
