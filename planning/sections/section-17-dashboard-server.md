# section-17-dashboard-server

## Purpose

Implement the ccmux dashboard HTTP server: a Fastify process bound to `127.0.0.1` that serves a paginated decisions API, a Prometheus `/metrics` endpoint, and the config-sourced pricing table. The server reads from the decision-log directory (JSONL files) produced by section-13 and is the sole data source for the SPA in section-18. No credentials, no outbound calls, no writes.

## Dependencies

- **section-02-logging-paths** — consumes `paths.logDir()` to locate `decisions.jsonl` and `outcomes.jsonl`; uses the shared pino factory.
- **section-13-decision-log** — consumes the on-disk JSONL schema (one object per line) with the fields enumerated below. This section only reads.

Parallelizable with section-14-outcome-tagger, section-15-report-cli, section-16-tune.

## Background (self-contained)

### Decision-log record shape (read-only contract)

Each line in `decisions.jsonl` is a JSON object with at least:

```
{
  "decision_id": string,
  "ts": ISO-8601 string,
  "session_id_hash": string,
  "requested_model": string,
  "forwarded_model": string,
  "rule_id": string | null,
  "classifier_result": { "score": number, "suggested": string, "confidence": number, "source": "heuristic" | "haiku", "latencyMs": number } | null,
  "signals": { ... },
  "upstream_latency_ms": number,
  "usage": { "input_tokens": number, "output_tokens": number, "cache_read_input_tokens": number, "cache_creation_input_tokens": number } | null,
  "cost_usd": number | null,
  "classifier_cost_usd": number | null,
  "request_hash": string
}
```

`outcomes.jsonl` is keyed by `request_hash`. Tags: `continued`, `retried`, `frustration_next_turn`, `abandoned`.

### Pricing table

Sourced from `config.yaml` under `pricing.<model>: { input, output, cacheRead, cacheCreate }` (per-million-token USD). The dashboard server re-reads this via the same in-memory config that the config watcher (section-06) hot-swaps.

### Network stance

- Bind **`127.0.0.1` only** — never `0.0.0.0`. Reject if the OS returns a non-loopback bound address.
- Default port `8788`; honor `config.dashboard.port` override; sequential fallback on `EADDRINUSE` (same helper as section-05).
- No auth — loopback-only is the security boundary. Document this in response to any `Host:` header that isn't `127.0.0.1` / `localhost` (reject with 421).
- Zero outbound calls from this server.

## Files to create

- `src/dashboard/server.ts` — Fastify factory + `listen()` with loopback guard.
- `src/dashboard/api.ts` — registers `/api/summary`, `/api/decisions`, `/api/costs`, `/api/pricing`.
- `src/dashboard/metrics.ts` — `/metrics` Prometheus text renderer.
- `src/dashboard/read-log.ts` — streaming JSONL reader (line-by-line via `readline`, never `readFile` on whole log). Accepts `{ since?: Date, limit: number, offset?: number }`. Returns typed records + total-scanned count for pagination cursors.
- `src/dashboard/aggregate.ts` — pure aggregation helpers used by both `/api/summary`, `/api/costs`, and `/metrics`: routing distribution per model, cache-hit rate, p50/p95/p99 of `upstream_latency_ms`, classifier-overhead totals.
- `src/dashboard/index.ts` — barrel export.
- `tests/dashboard/server.test.ts`
- `tests/dashboard/api.test.ts`
- `tests/dashboard/metrics.test.ts`
- `tests/dashboard/pagination.test.ts`
- `tests/dashboard/fixtures/decisions.sample.jsonl` — hand-authored fixture (~30 lines covering every model tier, with/without classifier, with/without usage).

Serving of the built SPA (`reply.sendFile` from `dist/`) is added in section-18; this section leaves a stub route that 404s until the SPA is built.

## Endpoints

### `GET /api/decisions`

Query params:
- `limit` — integer, default **100**, clamped to max **1000** (clamp silently; do not 400).
- `offset` — integer, default 0.
- `since` — ISO-8601; filters `ts >= since`. Large windows must stream-aggregate (do **not** load the full log into memory).
- `group_by` — optional pass-through for the SPA (`model`, `rule`, `hour`); server returns grouped counts when supplied, otherwise raw records.

Response: `{ items: DecisionRecord[], limit, offset, total_scanned }`. Total file size is **not** required — avoid O(N) scans on every request; return `total_scanned` as the number of records traversed for the current window only.

### `GET /api/summary`

Rolling snapshot for the window (default last 24h, overridable via `since`):
- routing distribution per forwarded model
- cache-hit rate
- p50/p95/p99 `upstream_latency_ms`
- total cost with and without classifier overhead (difference = sum of `classifier_cost_usd`)

### `GET /api/costs`

Time-bucketed cost series for charting. Buckets: `hour` (default), `day`. Each point: `{ ts_bucket, cost_usd, classifier_cost_usd, requests }`.

### `GET /api/pricing`

Returns the pricing table from the live config (read-only). Used by the SPA to annotate charts.

### `GET /metrics`

Prometheus text format (v0.0.4 content type `text/plain; version=0.0.4`). Minimum series:
- `ccmux_decisions_total{forwarded_model="..."}` counter (from log scan, monotonic for the current window).
- `ccmux_cache_hit_ratio` gauge.
- `ccmux_upstream_latency_ms{quantile="0.5|0.95|0.99"}` gauge (summary-style).
- `ccmux_classifier_latency_ms{quantile="0.5|0.95|0.99"}` gauge.
- `ccmux_cost_usd_total{kind="forwarded|classifier"}` counter.

Compute from a streamed pass over `decisions.jsonl` for the last hour; cache for 10s to avoid stampede.

## Tests (TDD stubs — write these first, they must fail before implementation)

All tests go under `tests/dashboard/`. Use `buildServer()` factory and `server.inject()` (Fastify's in-process injection) — no actual port bind in tests except where noted.

```ts
// tests/dashboard/server.test.ts
describe('dashboard server', () => {
  it('binds to 127.0.0.1 only (rejects non-loopback address)');
  it('falls back sequentially on EADDRINUSE');
  it('rejects requests with a non-loopback Host header with 421');
  it('makes zero outbound network calls during a full request cycle'); // spy on undici/global fetch
});

// tests/dashboard/api.test.ts
describe('/api/decisions', () => {
  it('defaults limit to 100 when unspecified');
  it('clamps limit=2000 to 1000 silently (no 400)');
  it('honors since= to filter older records');
  it('does not load the full log into memory for a large since window'); // assert via a fixture with N=10k and a memory budget check
  it('returns { items, limit, offset, total_scanned }');
});

describe('/api/summary', () => {
  it('computes routing distribution per forwarded model');
  it('computes cache-hit rate from usage.cache_read_input_tokens');
  it('computes p50/p95/p99 of upstream_latency_ms');
  it('reports cost with and without classifier overhead, differing by sum(classifier_cost_usd)');
});

describe('/api/pricing', () => {
  it('returns the live config pricing table');
  it('reflects hot-swapped pricing after a config reload'); // uses the section-06 watcher hook or a manual config.reload()
});

// tests/dashboard/metrics.test.ts
describe('/metrics', () => {
  it('returns Prometheus text format with the expected content-type');
  it('includes ccmux_decisions_total counters per forwarded_model');
  it('includes cache-hit ratio gauge');
  it('includes p50/p95/p99 latency gauges');
  it('caches for 10s to prevent repeated full-log scans');
});

// tests/dashboard/pagination.test.ts
describe('pagination', () => {
  it('offset+limit traverses the log without duplicates or gaps');
  it('stable ordering by ts descending');
});
```

Fixture `tests/dashboard/fixtures/decisions.sample.jsonl` must include records for at least `haiku`, `sonnet`, `opus` forwarded models, a null `classifier_result`, and records with and without `usage.cache_read_input_tokens` so aggregation tests cover edge paths.

## Implementation notes (actual)

- **Streaming log read.** `node:readline` over `createReadStream()` with try/catch that skips malformed lines. No `fs.readFile` on log paths.
- **Fastify setup.** Uses the same Fastify peer dep as the proxy. Did NOT add `@fastify/sensible` — 421 handled via `reply.code(421).send()` directly. No CORS.
- **Loopback guard.** `onRequest` hook checks `Host` header against `127.0.0.1`, `localhost`, `::1`. Returns 421 for non-loopback hosts. Actual bind enforcement is via `listenWithFallback` from section-05 (caller responsibility).
- **Port fallback.** Uses `listenWithFallback` from `src/lifecycle/ports.ts` (not duplicated).
- **Config access.** Uses `ConfigStore.getCurrent()` from section-06 watcher. No YAML reading.
- **Logger.** Accepts pino logger via `DashboardServerOpts`. Caller creates child logger.
- **No SPA yet.** `GET /` returns `404 { error: 'spa-not-built' }`. Comment in server.ts marks the spot for section-18.
- **Aggregation purity.** `aggregate.ts` is free of I/O — pure functions only.
- **Metrics cache.** `{ value, expiresAt }` memo in `metrics.ts`, 10s TTL. `getOrComputeMetrics` accepts a callback to defer log reads until cache miss. `invalidateMetricsCache()` exported for tests and SIGHUP integration.
- **Input validation.** (Code review fix) `since` returns 400 for unparseable dates; `group_by` returns 400 for unknown values.
- **Memory cap.** (Code review fix) Summary/costs/metrics endpoints cap at 100k records with `truncated` flag.
- **Prometheus types.** (Code review fix) `ccmux_decisions_total` and `ccmux_cost_usd_total` use `gauge` type (correct for sliding-window values).

## Acceptance checklist

- [x] All 26 tests fail before implementation, pass after.
- [x] `src/dashboard/` files each ≤ 400 lines (max: aggregate.ts at 109), functions ≤ 50 lines.
- [x] No `readFile` calls against log paths.
- [x] `::` only appears in loopback detection set (IPv6 `::1`), not as a bind address.
- [x] `/metrics` uses Prometheus text format v0.0.4 with correct content-type.
- [x] 441 full-suite tests pass with 0 regressions.
