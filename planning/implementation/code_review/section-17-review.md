# Section 17 Code Review

## IMPORTANT

### I-1: Loopback guard is defense-in-depth only
The Host header check is client-controlled. Real protection is `server.listen({ host: '127.0.0.1' })`. buildServer returns a raw FastifyInstance that a caller could bind to 0.0.0.0.

### I-2: Unbounded memory on /api/summary and /api/costs
Both use `limit: Number.MAX_SAFE_INTEGER`, loading all records into memory. Mitigated by default 24h `since` window, but could OOM with large logs.

### I-3: Invalid `since` parameter silently passes through
`new Date("garbage")` produces Invalid Date with NaN getTime(), causing all records to pass the filter.

### I-4: `group_by` parameter not validated
Accepts any string, falls through to hour bucketing silently.

### I-5: Module-level mutable cache in metrics.ts
Shared across server instances. Test workaround via `invalidateMetricsCache()`.

### I-6: Prometheus counter type mismatch
`ccmux_decisions_total` and `ccmux_cost_usd_total` use TYPE counter but values come from a 1-hour sliding window and can decrease between scrapes.

## NICE-TO-HAVE

### N-1: Duplicated testConfig() across 4 test files
### N-2: readdirSync blocks event loop
### N-3: Repeated Date construction in sort comparator
### N-4: No test for invalid since parameter
### N-5: afterAll/beforeEach mismatch in pricing test cleanup
