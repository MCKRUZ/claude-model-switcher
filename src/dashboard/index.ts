export { buildServer, type DashboardServerOpts } from './server.js';
export { registerRoutes, type ApiOpts } from './api.js';
export { readDecisions, type ReadOpts, type ReadResult } from './read-log.js';
export {
  routingDistribution,
  cacheHitRate,
  latencyPercentiles,
  costSummary,
  computeSummary,
  timeBuckets,
  type TimeBucket,
  type SummaryResult,
} from './aggregate.js';
export { renderPrometheusMetrics, invalidateMetricsCache, getOrComputeMetrics } from './metrics.js';
