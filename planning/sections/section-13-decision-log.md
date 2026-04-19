# section-13-decision-log

## Overview

Implement the JSONL decision log writer, cost accounting, and logging privacy modes. Every proxied `/v1/messages` request produces exactly one JSONL record capturing extracted signals, policy/classifier verdicts, the **actual forwarded model**, upstream latency, token usage, and estimated cost. The writer must be performant (no per-append `stat`), durable-enough (best-effort, no fsync by default), rotation-aware (size or daily), and privacy-preserving (hashed by default).

This section is consumed by sections 14 (outcome-tagger), 15 (report-cli), 16 (tune), and 17 (dashboard-server) — all of which read the JSONL files this section produces. The record schema is the contract.

## Dependencies

- **section-02-logging-paths** — XDG path helpers (`~/.config/ccmux/logs/`), pino logger, auth-header sanitizer already in place.
- **section-09-sticky-model** — provides `session_id`, `request_hash`, and `sticky_hit` fields to include in the record.
- Reads **config** from section-03 (`logging.*`, `pricing.*` tables).

Parallelizable with: section-10-wrapper, section-11-classifier-heuristic, section-12-classifier-haiku.

## Files to Create

> Implementation note: paths landed under `src/decisions/` (not `src/feedback/`)
> to match the project's existing top-level convention. The `DecisionRecord`
> type lives next to its writer in `src/decisions/types.ts` rather than in
> `src/types/decision.ts` — sections 14-17 import from `src/decisions/types.js`.

```
src/decisions/types.ts              # DecisionRecord + DecisionMode + DecisionSource
src/decisions/_fs.ts                # fsHelpers indirection (so tests can vi.spyOn ESM-exported fs)
src/decisions/redaction.ts          # hashed | full | none modes; recursive auth-header guard
src/decisions/cost.ts               # parseUsage + computeCostUsd (warn-once on unknown model)
src/decisions/rotate.ts             # daily/size policies, EBUSY/EPERM rename fallback, retention by filename date
src/decisions/record.ts             # buildDecisionRecord projector
src/decisions/log.ts                # DecisionLogWriter: bounded queue, serialized promise chain, in-process byte counter
src/decisions/reader.ts             # readDecisions(dir, {since, limit}) async iterator (used by §15/§17)
tests/decisions/redaction.test.ts   # 8 tests
tests/decisions/cost.test.ts        # 8 tests
tests/decisions/rotation.test.ts    # 7 tests
tests/decisions/record.test.ts      # 5 tests
tests/decisions/decision-log.test.ts # 14 tests
```

Total: 8 source files, 5 test files, 42 tests. No JSONL fixture files were
needed — the golden round-trip lives inline in `decision-log.test.ts`.

Log directory layout:
```
~/.config/ccmux/logs/
  decisions-YYYY-MM-DD.jsonl        # daily rotation default
  decisions-YYYY-MM-DD.1.jsonl      # size-rotation suffix within the same day
  outcomes.jsonl                    # sidecar written by section-14 (not here)
```

## Record Schema (authoritative)

One JSONL line per decision. This is the contract — sections 14/15/16/17 depend on it.

```json
{
  "timestamp": "2026-04-17T14:00:00Z",
  "session_id": "...",
  "request_hash": "...",
  "extracted_signals": { "...": "..." },
  "policy_result": { "rule_id": "short-simple-haiku" },
  "classifier_result": {
    "score": 0.0,
    "suggested": "haiku",
    "confidence": 0.82,
    "source": "haiku",
    "latencyMs": 512
  },
  "sticky_hit": false,
  "chosen_model": "claude-haiku-4-5-20251001",
  "chosen_by": "policy",
  "forwarded_model": "claude-haiku-4-5-20251001",
  "upstream_latency_ms": 0,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  },
  "cost_estimate_usd": 0.0,
  "classifier_cost_usd": 0.0,
  "mode": "live",
  "shadow_choice": null
}
```

Field rules:

- `policy_result` is either `{ rule_id: string }` or `{ abstain: true }`.
- `classifier_result` is `null` when the classifier did not run.
- `chosen_by` ∈ `"policy" | "classifier" | "fallback" | "sticky" | "explicit" | "shadow"`.
- `chosen_model` = **actual model used on the upstream request** (NOT the client-requested one). In `shadow` mode, `forwarded_model` equals the client-requested model and `shadow_choice` holds the would-have-been override.
- `usage` is `null` if the upstream response never emitted a `message_delta.usage` (e.g., stream errored mid-flight). In that case `cost_estimate_usd` is also `null`.
- `mode` ∈ `"live" | "shadow"`.

## Implementation Details

### 1. Writer (`decision-log.ts`)

- Single `fs.createWriteStream(path, { flags: "a", highWaterMark: 64 * 1024 })` per active rotation file.
- **Bounded queue**: max 1000 pending records. When `stream.write(...)` returns `false`, stop enqueueing and wait for `"drain"`. Records that would overflow the queue are dropped and logged via pino (`{ event: "decision_log_dropped", reason }`) — do not block the hot path.
- **In-process byte counter**: accumulates the JSON line length + 1 (newline) per successful write. **Do not** `statSync` on every append.
- **Startup stat**: on first open (or after rotation), `fs.statSync(path).size` seeds the counter accurately.
- **Periodic reconcile**: every 5 minutes, `fs.stat` the file and re-seed the counter, correcting any drift (e.g., external log compaction).
- **Durability**: no `fsync`. If `config.logging.fsync === true`, call `fs.fsync(fd, cb)` after each write. Document as best-effort in header comment.
- Public API:

```ts
export interface DecisionLogWriter {
  append(record: DecisionRecord): void;          // fire-and-forget, non-blocking
  flush(): Promise<void>;                        // wait for queue drain (used on shutdown)
  close(): Promise<void>;                        // flush + end stream
}

export function createDecisionLogWriter(opts: {
  dir: string;
  rotation: "daily" | "size";
  maxBytes: number;                              // for size rotation
  retentionDays: number;
  fsync: boolean;
  logger: Logger;
  clock: () => Date;                             // injectable for tests
}): DecisionLogWriter;
```

### 2. Rotation (`rotation.ts`)

- **Daily** (default): on `append`, compare `clock().toISOString().slice(0,10)` against the current filename date. When different, atomic-rename the current file (already date-stamped) — but since the filename includes the date, just open the new day's file. No rename needed for daily.
- **Size**: when byte counter ≥ `maxBytes`, rotate to `decisions-YYYY-MM-DD.<n>.jsonl` where `n` increments. Use `fs.renameSync` in try; on `EBUSY`/`EPERM` (Windows holds locks), fall back to copy-then-truncate.
- **Retention**: on every rotation, scan the log directory and unlink files older than `retentionDays` (parse the date from the filename; do not rely on mtime).
- Rotation must flush any buffered writes before swapping the stream; the next `append` opens the new file.

### 3. Cost (`cost.ts`)

- Parses **only**: `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming path: accumulates `message_delta.usage` emitted at stream end. The proxy (section-04) must tee final `message_delta` events to this module (integration point — expose a `recordUsage(requestHash, usage)` callback).
- Pricing: `config.pricing[<model>]` provides `{ input, output, cacheRead, cacheCreate }` in USD per million tokens. Cost = sum of `(tokens / 1_000_000) * rate`.
- **Unknown model** in pricing table → `cost_estimate_usd = null`, log a single warning per model per process.
- If **any** of the four usage fields is absent, that component is `null`; if all are null/absent, `cost_estimate_usd = null` (do not silently under-report).
- The **actual upstream model** is read from the response body's `model` field (not the request's `model`). For streaming, it comes in the `message_start` event.
- `classifier_cost_usd`: computed from the classifier's own usage (when `classifier_result.source === "haiku"`) so `ccmux report` can show "with overhead" vs "without overhead".

### 4. Redaction (`redaction.ts`)

Three modes, configured via `config.logging.content`:

| Mode     | Behavior                                                                                                                                      |
|----------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| `hashed` | (default) Replace each message string and each tool `input` object with `sha256(JSON.stringify(x)).slice(0, 12)`. Equality remains linkable. |
| `full`   | Log raw content. Auth headers still redacted unconditionally via pino redact.                                                                 |
| `none`   | Drop `messages`, tool `input`, and any content fields from `extracted_signals` entirely. Only shape/metadata counts remain.                   |

Privacy mode is **config-only** — no CLI flag may toggle it. Document in code comment:

> With `hashed`, two identical secrets become the same 12-char hash and are linkable across log entries. Use `none` on shared machines.

Auth headers (`authorization`, `x-api-key`, `x-ccmux-token`) must NEVER appear in any record regardless of mode — this is enforced both here and at the pino layer (section-02).

### 5. Record Builder (`record.ts`)

```ts
export function buildDecisionRecord(input: {
  now: Date;
  sessionId: string;
  requestHash: string;
  extractedSignals: Signals;
  policyResult: PolicyResult;
  classifierResult: ClassifierResult | null;
  stickyHit: boolean;
  chosenModel: string;
  chosenBy: DecisionSource;
  forwardedModel: string;
  mode: "live" | "shadow";
  shadowChoice: string | null;
  upstreamLatencyMs: number;
  usage: UsageFields | null;
  costEstimateUsd: number | null;
  classifierCostUsd: number | null;
  contentMode: "hashed" | "full" | "none";
}): DecisionRecord;
```

Applies the `contentMode` redaction to `extractedSignals` before returning.

## Tests (TDD — write first)

All in `tests/decisions/`. Use Vitest with `vi.useFakeTimers()` for clock control and `tmp-promise` (or `os.tmpdir()`) for isolated log dirs. Stubbed `Logger`.

### `decision-log.test.ts`

```ts
describe("DecisionLogWriter", () => {
  it("writes one JSONL line per decision matching the documented schema", () => { /* … */ });
  it("records the actual forwarded model, not the requested one", () => { /* … */ });
  it("triggers size-based rotation from the in-process byte counter without stat-per-append", () => { /* … */ });
  it("seeds the byte counter from startup stat of an existing log file", () => { /* … */ });
  it("rotates daily at local midnight", () => { /* fake timer across midnight */ });
  it("deletes files older than retentionDays on rotation", () => { /* … */ });
  it("handles burst writes via a single stream without losing lines (backpressure)", async () => { /* … */ });
  it("does not fsync on each append by default (best-effort durability)", () => { /* spy on fs.fsync */ });
  it("drops records when the bounded queue overflows and logs the drop", () => { /* … */ });
});
```

### `rotation.test.ts`

```ts
describe("rotation", () => {
  it("size strategy rotates when byte counter >= maxBytes", () => { /* … */ });
  it("daily strategy opens a new file when the date changes", () => { /* … */ });
  it("falls back to copy+truncate on Windows rename EBUSY", () => { /* mock fs.rename to throw */ });
  it("retention parses dates from filenames, not mtime", () => { /* … */ });
});
```

### `cost.test.ts`

```ts
describe("cost accounting", () => {
  it("parses usage.input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens", () => { /* … */ });
  it("accumulates message_delta.usage at stream end for streaming responses", () => { /* … */ });
  it("leaves cost null and emits a single cost_unavailable log when usage is absent", () => { /* … */ });
  it("uses the pricing table from config.yaml for per-model math", () => { /* … */ });
  it("records the actual upstream response model, not the client-requested model", () => { /* … */ });
  it("returns null cost for an unknown model and warns once per model", () => { /* … */ });
});
```

### `redaction.test.ts`

```ts
describe("redaction", () => {
  it("default hashed mode replaces content with a 12-char hex digest", () => { /* … */ });
  it("full mode logs raw content but still redacts auth headers", () => { /* … */ });
  it("none mode drops content and tool-input fields entirely", () => { /* … */ });
  it("no CLI flag toggles any privacy mode (config only)", () => { /* grep CLI parser */ });
  it("never writes auth headers regardless of mode", () => { /* fixture round-trip */ });
});
```

### Shadow mode (cross-cutting)

```ts
it("in shadow mode, records the would-have-been model under shadow_choice while forwarded_model is the client-requested", () => { /* … */ });
```

## Config consumed

```yaml
logging:
  dir: ~/.config/ccmux/logs       # resolved by section-02
  rotation: daily                 # or "size"
  maxBytes: 104857600             # 100 MiB (size strategy only)
  retentionDays: 30
  content: hashed                 # hashed | full | none
  fsync: false

pricing:
  claude-opus-4-7:     { input: 15,  output: 75,   cacheRead: 1.5,  cacheCreate: 18.75 }
  claude-sonnet-4-7:   { input: 3,   output: 15,   cacheRead: 0.3,  cacheCreate: 3.75 }
  claude-haiku-4-5:    { input: 0.8, output: 4,    cacheRead: 0.08, cacheCreate: 1 }
```

Config schema shape is defined in section-03; this section only consumes the typed config.

## Integration points (contracts for other sections)

- **section-04 (proxy)** calls `writer.append(record)` after the upstream response terminates (success or SSE `error`). Must include the `message_start.model` (actual upstream model) in `chosenModel`/`forwardedModel`.
- **section-09 (sticky)** provides `sessionId`, `requestHash`, `stickyHit`.
- **section-14 (outcome-tagger)** consumes the JSONL files this writer produces — do not change schema without updating section-14.
- **section-17 (dashboard-server)** reads paginated records via a simple `readDecisions(dir, { since, limit })` helper. Expose that reader here as `src/feedback/reader.ts` with a stream-style async iterator to avoid loading whole files into memory.

## Acceptance Criteria

- All tests in `tests/decisions/` pass under `npm test`.
- Append latency overhead under 100μs p95 for a single record (measured in a microbench, not required in CI).
- Zero `statSync` calls on the hot append path (enforceable via a spy test).
- Golden-file test: feed a fixed `DecisionRecord` through the writer and assert byte-for-byte equality against `tests/fixtures/decisions/sample.jsonl`.
- Files never exceed `maxBytes` + one-record slop under size rotation.
- Auth headers absent from every fixture in `tests/fixtures/decisions/` (grep check in CI).

---

## Implementation Outcome (2026-04-18)

Status: ✅ Implemented, reviewed, and committed.

### Deviations from plan

- **Module location:** `src/feedback/` → `src/decisions/` (project convention).
- **DecisionRecord home:** Lives at `src/decisions/types.ts`, not `src/types/decision.ts`.
- **fs indirection:** Added `src/decisions/_fs.ts` exporting a mutable `fsHelpers` object so vitest can `vi.spyOn(fsHelpers, 'renameSync')` etc. ESM module exports are read-only descriptors and cannot be spied directly.
- **Reader added:** `src/decisions/reader.ts` (async iterator) was not in the original Files-to-Create list but is required by §15/§17 and ships with this section.
- **Daily rollover:** Uses `getUTC*` accessors so `dateStamp` always returns UTC (`toISOString().slice(0,10)` equivalent). The first impl used local time; switched per code review.
- **Fixture files:** Not needed — the golden round-trip test inlines the fixed record. The "auth headers absent from fixtures (grep check)" line above is therefore moot for this section; redaction.test.ts greps `src/cli/*.ts` instead to enforce the spec rule that privacy mode is config-only (no CLI flag).

### Code-review fixes applied (see code_review/section-13-interview.md)

1. **Infinite rotation retry bug** — `log.ts` now resets `bytes = 0` if `rotateRename` throws, so we don't re-enter the rotation branch on every subsequent append.
2. **Recursive auth-header guard** — `redaction.ts` `ensureNoAuth` now walks the full value tree, not just top-level keys.
3. **droppedPostAccept counter** — writer exposes `droppedPostAccept()` for observability of write failures after a record was accepted into the queue.
4. **Real queue-full test** — replaced the closed-then-append test with one that synchronously enqueues 1500 records to actually exercise the MAX_QUEUE drop path; kept the closed test as a separate case.
5. **JSDoc contract** — `redactSignals` now documents that section-04 is responsible for redacting message bodies / tool-call inputs.

### Test count

42 tests, all green. (cost: 8, record: 5, redaction: 8, rotation: 7, decision-log: 14.)
