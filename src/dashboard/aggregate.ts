import type { DecisionRecord } from '../decisions/types.js';

export interface TimeBucket {
  readonly ts_bucket: string;
  readonly cost_usd: number;
  readonly classifier_cost_usd: number;
  readonly requests: number;
}

export interface SummaryResult {
  readonly routingDistribution: Readonly<Record<string, number>>;
  readonly cacheHitRate: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly totalCost: number;
  readonly classifierCost: number;
}

export function routingDistribution(
  records: readonly DecisionRecord[],
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of records) {
    dist[r.forwarded_model] = (dist[r.forwarded_model] ?? 0) + 1;
  }
  return dist;
}

export function cacheHitRate(records: readonly DecisionRecord[]): number {
  let totalInput = 0;
  let cacheRead = 0;
  for (const r of records) {
    if (!r.usage) continue;
    totalInput += r.usage.input_tokens ?? 0;
    cacheRead += r.usage.cache_read_input_tokens ?? 0;
  }
  return totalInput > 0 ? cacheRead / totalInput : 0;
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const idx = p * (n - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (idx - lower) * (sorted[upper]! - sorted[lower]!);
}

export function latencyPercentiles(
  latencies: readonly number[],
): { p50: number; p95: number; p99: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

export function costSummary(
  records: readonly DecisionRecord[],
): { totalCost: number; classifierCost: number } {
  let totalCost = 0;
  let classifierCost = 0;
  for (const r of records) {
    if (r.cost_estimate_usd != null) totalCost += r.cost_estimate_usd;
    if (r.classifier_cost_usd != null) classifierCost += r.classifier_cost_usd;
  }
  return { totalCost, classifierCost };
}

export function computeSummary(
  records: readonly DecisionRecord[],
): SummaryResult {
  const costs = costSummary(records);
  return {
    routingDistribution: routingDistribution(records),
    cacheHitRate: cacheHitRate(records),
    latency: latencyPercentiles(records.map(r => r.upstream_latency_ms)),
    totalCost: costs.totalCost,
    classifierCost: costs.classifierCost,
  };
}

function bucketKey(ts: string, bucket: 'hour' | 'day'): string {
  const d = new Date(ts);
  if (bucket === 'day') return d.toISOString().slice(0, 10);
  return d.toISOString().slice(0, 13) + ':00:00.000Z';
}

export function timeBuckets(
  records: readonly DecisionRecord[],
  bucket: 'hour' | 'day',
): TimeBucket[] {
  const map = new Map<string, { cost_usd: number; classifier_cost_usd: number; requests: number }>();
  for (const r of records) {
    const key = bucketKey(r.timestamp, bucket);
    const cur = map.get(key) ?? { cost_usd: 0, classifier_cost_usd: 0, requests: 0 };
    cur.cost_usd += r.cost_estimate_usd ?? 0;
    cur.classifier_cost_usd += r.classifier_cost_usd ?? 0;
    cur.requests += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ts_bucket, data]) => ({ ts_bucket, ...data }));
}
