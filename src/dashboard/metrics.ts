import type { DecisionRecord } from '../decisions/types.js';
import {
  routingDistribution,
  cacheHitRate,
  latencyPercentiles,
  costSummary,
} from './aggregate.js';

export function renderPrometheusMetrics(
  records: readonly DecisionRecord[],
): string {
  const lines: string[] = [];

  const dist = routingDistribution(records);
  lines.push('# HELP ccmux_decisions_total Total routing decisions per forwarded model.');
  lines.push('# TYPE ccmux_decisions_total gauge');
  for (const [model, count] of Object.entries(dist)) {
    lines.push(`ccmux_decisions_total{forwarded_model="${model}"} ${count}`);
  }

  const hitRate = cacheHitRate(records);
  lines.push('# HELP ccmux_cache_hit_ratio Cache hit ratio by input tokens.');
  lines.push('# TYPE ccmux_cache_hit_ratio gauge');
  lines.push(`ccmux_cache_hit_ratio ${hitRate}`);

  const uLatency = latencyPercentiles(records.map(r => r.upstream_latency_ms));
  lines.push('# HELP ccmux_upstream_latency_ms Upstream latency in milliseconds.');
  lines.push('# TYPE ccmux_upstream_latency_ms gauge');
  lines.push(`ccmux_upstream_latency_ms{quantile="0.5"} ${uLatency.p50}`);
  lines.push(`ccmux_upstream_latency_ms{quantile="0.95"} ${uLatency.p95}`);
  lines.push(`ccmux_upstream_latency_ms{quantile="0.99"} ${uLatency.p99}`);

  const cLatencies = records
    .filter(r => r.classifier_result != null)
    .map(r => r.classifier_result!.latencyMs);
  const cLatency = latencyPercentiles(cLatencies);
  lines.push('# HELP ccmux_classifier_latency_ms Classifier latency in milliseconds.');
  lines.push('# TYPE ccmux_classifier_latency_ms gauge');
  lines.push(`ccmux_classifier_latency_ms{quantile="0.5"} ${cLatency.p50}`);
  lines.push(`ccmux_classifier_latency_ms{quantile="0.95"} ${cLatency.p95}`);
  lines.push(`ccmux_classifier_latency_ms{quantile="0.99"} ${cLatency.p99}`);

  const costs = costSummary(records);
  lines.push('# HELP ccmux_cost_usd_total Cumulative cost in USD.');
  lines.push('# TYPE ccmux_cost_usd_total gauge');
  lines.push(`ccmux_cost_usd_total{kind="forwarded"} ${costs.totalCost}`);
  lines.push(`ccmux_cost_usd_total{kind="classifier"} ${costs.classifierCost}`);

  return lines.join('\n') + '\n';
}

let metricsCache: { value: string; expiresAt: number } | null = null;

export function invalidateMetricsCache(): void {
  metricsCache = null;
}

export async function getOrComputeMetrics(
  readFn: () => Promise<readonly DecisionRecord[]>,
): Promise<string> {
  const now = Date.now();
  if (metricsCache && metricsCache.expiresAt > now) {
    return metricsCache.value;
  }
  const records = await readFn();
  const value = renderPrometheusMetrics(records);
  metricsCache = { value, expiresAt: now + 10_000 };
  return value;
}
