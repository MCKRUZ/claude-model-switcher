# section-15-report-cli

## Purpose

Implement the `ccmux report` CLI: a terminal command that reads the decision log JSONL files and renders ASCII tables summarizing routing distribution, cost (with/without classifier overhead), cache-hit rate, and latency percentiles.

Usage:

```
ccmux report [--since <duration>] [--group-by <key>] [--format <fmt>]
```

- `--since` accepts durations like `7d`, `24h`, `30m` (default: `7d`).
- `--group-by` supports at minimum `model` (default) and `project` (inferred project path from the decision log entry).
- `--format` supports `ascii` (default) and `json`.

Exit codes:
- `0` on success.
- Non-zero when the decision log directory is missing or unreadable.

## Dependencies (must be complete before this section)

- **section-11-classifier-heuristic** and **section-12-classifier-haiku** — decision-log entries contain `classifier_cost_usd` from the Haiku classifier path.
- **section-13-decision-log** — provides the JSONL schema this CLI reads, including `usage` cost fields (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), the actual forwarded model, project path, latencies, and `classifier_cost_usd`.

Do not re-implement log parsing logic owned by section-13 — import and reuse its reader/cost parser.

## Background Context (self-contained)

The decision log is JSONL, one line per forwarded request, written by section-13 under the ccmux log directory (resolved via section-02's path helpers — typically `~/.config/ccmux/logs/decisions-YYYY-MM-DD.jsonl` on Unix, the XDG-equivalent location on Windows). Each line records:

- `timestamp` (ISO-8601)
- `session_id` (hashed)
- `project_path` (inferred)
- `chosen_model` (the actual upstream model from the response)
- `rule_id` or `abstain` reason
- `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens` (any may be absent → cost component `null`)
- `classifier_cost_usd` (nullable; present when the Haiku classifier ran)
- `latency_ms` (proxy overhead; upstream total separately recorded)
- `cost_usd` (derived total; `null` if any usage field was missing)

Pricing is loaded from `config.yaml`'s `pricing` table — section-03 owns the loader; this CLI receives the already-parsed pricing map.

Routing distribution sums to 100% across all observed `chosen_model` values (including any synthetic `abstain` bucket if logged). "With overhead" totals add `classifier_cost_usd` across all entries; "without overhead" totals omit it. The two columns must differ by exactly `sum(classifier_cost_usd)`.

## Files to Create

- `src/cli/report.ts` — command entry point. Parses flags, resolves time window, calls the aggregation pipeline, dispatches to the renderer.
- `src/report/tables.ts` — ASCII table renderers: routing-distribution, cost breakdown, cache-hit rate, latency percentiles.
- `src/report/aggregate.ts` — pure aggregation: filter by `since`, group by key, compute sums/percentages/percentiles.
- `src/report/duration.ts` — parse `7d`/`24h`/`30m` → milliseconds.
- Wire `report` into the root `ccmux` CLI dispatcher (section-05 owns the CLI entry; this section adds the `report` subcommand registration).

### Implementation notes (actual, post-build)

- **Decision-record field names.** The spec uses `chosen_model` / `latency_ms` / `cost_usd` / `project_path`; the real schema from section-13 uses `forwarded_model` / `upstream_latency_ms` / `cost_estimate_usd` and stores `projectPath` inside `extracted_signals`. Aggregation reads the real names.
- **Commander flag wiring.** Flags are intentionally NOT declared via `.option()` on the `report` subcommand. With `.allowUnknownOption(true)` set, commander passes the entire flag tail through to `cmd.args`, which `runReport` parses with its own argv parser. This keeps the `runReport(argv)` signature testable in isolation and avoids double-parsing. See the inline comment in `src/cli/main.ts`.
- **Null-cost semantics.** `totalWithoutOverhead` is null iff no record had a base cost; `totalWithOverhead` is null iff no record had any cost component. The invariant `withOverhead − withoutOverhead === sum(classifier_cost_usd)` holds when both totals are numeric. In the edge case where every record lacks a base cost, both columns render "—" and no diff is meaningful. See the block comment at the top of `src/report/aggregate.ts`.
- **Integration test added** (not listed in the original plan): `tests/cli/report.test.ts` exercises the full `run(['report', ...])` path through commander to prevent a regression of the flag-wiring bug found in code review.

Keep every file under 400 lines and every function under 50 lines (global standards). Table rendering is pure; no side effects except the final `process.stdout.write`.

## Tests FIRST (from claude-plan-tdd §10.1)

Place in `tests/report/` using Vitest. Write each as RED first, then implement.

1. `--since 7d filters log entries by timestamp` — seed a fixture JSONL with entries at `now-1d`, `now-8d`, `now-30d`; run aggregation with `--since 7d`; assert only the `now-1d` entry is included.

2. `--group-by project aggregates cost by inferred project path` — seed entries across two project paths; assert two groups with costs summed correctly per project.

3. `routing-distribution table sums to 100%` — seed a mixed set of `chosen_model` values; render the distribution table; parse percentages from the rendered output; assert they sum to exactly `100.0` (allowing the renderer to apply largest-remainder rounding so the sum is exact, not merely within epsilon).

4. `"with overhead" vs "without overhead" totals differ by the sum of classifier_cost_usd` — seed entries, some with `classifier_cost_usd` set, some `null`; assert `total_with_overhead - total_without_overhead === sum(classifier_cost_usd ?? 0)`.

5. `exits non-zero when the log directory is missing` — invoke the CLI with a non-existent log directory; assert non-zero exit code and a human-readable stderr message (no stack trace leaked per security standards).

Additional tests to include (coverage-driven, not from tdd.md but required by the standards):

6. Duration parser: `parseDuration('7d')` / `'24h'` / `'30m'` / invalid input returns `Result.Fail`.
7. Aggregation handles entries with `null` cost components (total cost bucket stays `null`, does not crash).
8. Default `--since` is applied when the flag is omitted.
9. `--format json` emits valid JSON parseable by `JSON.parse` with the same group totals as the ASCII view.
10. Cache-hit rate = `sum(cache_read_input_tokens) / (sum(cache_read_input_tokens) + sum(input_tokens))`; verify on a fixture.
11. Latency percentiles: p50/p95/p99 computed with linear interpolation on sorted `latency_ms`; verify on a known fixture.

Test fixtures live in `tests/fixtures/decision-logs/` — small hand-written JSONL files. Do not mock the log reader; feed real files through the real section-13 reader.

## Implementation Notes

**Aggregation pipeline** is `filter → group → reduce → render`. Each stage is a pure function returning plain data. Keep it streaming-friendly: read the JSONL line-by-line, do not load the full log into memory. For multi-day windows, read only the date-partitioned files that intersect the window.

**Rounding for 100% sums:** use largest-remainder (Hamilton) method so the printed percentages add up to exactly `100.0` even after truncation to one decimal place. This is the simplest approach that satisfies the test.

**Percentiles:** sort `latency_ms` values, compute p50/p95/p99 via linear interpolation (`value = sorted[floor(idx)] + fraction * (sorted[ceil(idx)] - sorted[floor(idx)])` where `idx = p * (n-1)`). Small sample sizes (n<3) print `—` for p95/p99 rather than a misleading number.

**Table renderer:** a minimal ASCII-box renderer in `tables.ts` — columns with padding, header row, separator, data rows. No external dependency (no `cli-table`, keeps the bundle small).

**Error handling:** Result-style for expected failures (missing dir, bad duration, invalid group-by key). Exceptions only for truly exceptional conditions. Never leak internal paths or stack traces in error messages per global security rules.

**Signatures (stubs only — do not over-specify):**

```ts
// src/report/duration.ts
export function parseDuration(input: string): Result<number>;

// src/report/aggregate.ts
export interface ReportOptions {
  since: number;            // ms window
  groupBy: 'model' | 'project';
  logDir: string;
  pricing: PricingTable;
}
export interface ReportData {
  routingDistribution: ReadonlyArray<{ key: string; count: number; pct: number }>;
  costBreakdown: ReadonlyArray<{ key: string; withoutOverhead: number | null; withOverhead: number | null }>;
  cacheHitRate: number | null;
  latency: { p50: number | null; p95: number | null; p99: number | null };
}
export async function aggregate(opts: ReportOptions): Promise<Result<ReportData>>;

// src/report/tables.ts
export function renderAscii(data: ReportData): string;
export function renderJson(data: ReportData): string;

// src/cli/report.ts
export async function runReport(argv: ReadonlyArray<string>): Promise<number>; // exit code
```

No other exports are required. Keep public surface minimal (YAGNI).

## Acceptance Checklist

- [x] All five plan-tdd tests pass.
- [x] All six supplementary tests pass.
- [x] `ccmux report` wired into the CLI dispatcher and visible in `ccmux --help`.
- [x] No `console.log` (use `process.stdout.write` / pino for diagnostics).
- [x] No file exceeds 400 lines; no function exceeds 50 lines.
- [x] Coverage on new code ≥ 80%.
- [x] Missing log directory exits non-zero with a clear, non-leaky message.
- [x] Works identically on Linux, macOS, and Windows (CI matrix for section-13's reader already covers this; no OS-specific paths here — use section-02's path helpers).
