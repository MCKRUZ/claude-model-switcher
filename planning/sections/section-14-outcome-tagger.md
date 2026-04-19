# section-14-outcome-tagger

## Purpose

Implement the passive outcome tagger that annotates prior decision-log entries with a post-hoc session outcome label. The tagger never touches the request/response path; it runs asynchronously against the tail of the decision log and writes tags to an `outcomes.jsonl` sidecar keyed by `request_hash`.

Four tag values:

- `continued` — the session moved forward to a new, non-repeated turn.
- `retried` — the same canonical request (same `request_hash`) reappeared within N seconds.
- `frustration_next_turn` — the follow-up user turn within the same `sessionId` contains a frustration marker.
- `abandoned` — no follow-up turn seen within the configured idle TTL.

Tags are advisory signals consumed by `ccmux tune` and by the dashboard. They are never used to alter routing in-flight.

## Dependencies (required upstream)

- **section-13-decision-log** — defines the JSONL record shape, `requestHash`, `sessionId`, timestamp, and the log rotation/retention semantics. This section reads that log and writes a sibling sidecar in the same directory.

Referenced signal fields (already produced upstream, do not re-derive):

- `requestHash` — 32-hex canonical request hash from `signals/canonical.ts`.
- `sessionId` — from `signals/session.ts` (metadata.user_id or hmac fallback).
- `signals.frustration` — boolean | null extracted by `signals/frustration.ts`.
- `ts` — ISO timestamp on each decision record.

Do NOT re-parse the raw HTTP body here. Consume the already-written log record.

## Files to create

- `src/decisions/outcome.ts` — the tagger implementation.
- `tests/decisions/outcome.test.ts` — unit tests for the four tag cases.

No existing files are modified by this section. The tagger is wired into the process lifecycle in a later section (referenced only — not this section's concern).

## Configuration surface

Read from the existing config object (already loaded by section-06). Add the following keys under `decisions.outcome` (documented here; schema update lives with the config section — not duplicated):

- `retryWindowSec` (default `60`) — upper bound for classifying a repeat `requestHash` as `retried`.
- `idleTtlSec` (default `900`) — after this much wall-clock silence on a `sessionId`, open entries are tagged `abandoned`.
- `tailIntervalMs` (default `2000`) — how often the tagger polls the tail of the decision log.

No CLI flag toggles outcome tagging on or off. It is always on when the log writer is on.

## Sidecar file format

`outcomes.jsonl` lives next to `decisions.jsonl` in the same XDG log directory. One JSON object per line, newline-terminated, append-only:

```
{"requestHash":"<32hex>","sessionId":"<id>","tag":"continued|retried|frustration_next_turn|abandoned","ts":"<iso>"}
```

Rules:

- One tag per `requestHash`. If a later event would retag the same hash, **skip** it — first tag wins. This keeps the sidecar idempotent across process restarts.
- On startup, scan the existing `outcomes.jsonl` once to rebuild the tagged-hash set. Do not re-tag entries already present.
- Writes go through the same bounded-buffer writer primitives as the decision log (reuse; do not reimplement). Rotation rules mirror the decision log — if `decisions.jsonl` rotates, `outcomes.jsonl` rotates with it under the same name scheme.

## Algorithm

Maintain an in-memory index as the log is tailed:

1. **Last-seen-by-sessionId**: `Map<sessionId, { requestHash, ts, frustration }>` — the tail record for each open session.
2. **Recent-hashes**: `Map<requestHash, ts>` with eviction past `retryWindowSec * 2`.
3. **Tagged set**: `Set<requestHash>` — everything already in `outcomes.jsonl`.

On each new decision record `R` from the tail:

- If `R.requestHash` is in recent-hashes within `retryWindowSec`, emit `retried` for the **prior** occurrence's `requestHash` (which equals `R.requestHash`; tag the earlier record only if not already tagged).
- Else if there is a prior `last-seen` entry for `R.sessionId`:
  - If the prior record's `frustration` is false/null **and** `R.signals.frustration === true`, tag the prior `requestHash` as `frustration_next_turn`.
  - Otherwise tag the prior `requestHash` as `continued`.
- Update `last-seen[R.sessionId] = R`.

A separate `setInterval` (cadence: `tailIntervalMs`) sweeps `last-seen`: any entry older than `idleTtlSec` that is not yet tagged becomes `abandoned`, and its `sessionId` key is removed.

The tagger must handle the log being empty, the sidecar being missing, and partial last-line reads from an actively-written JSONL file (skip and retry on next tick).

## Tests (write FIRST, TDD)

Create `tests/decisions/outcome.test.ts`. Use vitest (project convention). Drive the tagger with synthetic in-memory arrays of decision records rather than real files where possible — keep one end-to-end test that exercises the real file tail.

```ts
import { describe, it, expect } from 'vitest';
// import { OutcomeTagger } from '../../src/decisions/outcome.ts';

describe('outcome tagger', () => {
  it('tags "continued" when the next turn in the same session is a new prompt', async () => {
    // Arrange: two records, same sessionId, different requestHash, frustration=false on both.
    // Act: feed records to tagger in order.
    // Assert: the first requestHash is tagged "continued"; the second is untagged (pending).
  });

  it('tags "retried" when the same requestHash repeats within retryWindowSec', async () => {
    // Arrange: two records, same requestHash, ts delta < retryWindowSec.
    // Assert: first occurrence is tagged "retried".
  });

  it('does NOT tag "retried" when the same requestHash repeats AFTER retryWindowSec', async () => {
    // Arrange: delta > retryWindowSec. Expect "continued" semantics on session if applicable.
  });

  it('tags "frustration_next_turn" when the follow-up turn has frustration=true', async () => {
    // Arrange: prior record frustration=false, follow-up same sessionId frustration=true.
    // Assert: prior requestHash tagged "frustration_next_turn" (not "continued").
  });

  it('tags "abandoned" when no follow-up occurs within idleTtlSec', async () => {
    // Arrange: single record, advance fake clock beyond idleTtlSec, run sweep.
    // Assert: that record's requestHash tagged "abandoned".
  });

  it('writes one tag per requestHash; subsequent events do not retag', async () => {
    // Arrange: trigger "continued" tag, then feed a later event that would imply "retried" for same hash.
    // Assert: outcomes.jsonl contains exactly one line for that hash.
  });

  it('rebuilds the tagged-hash set from existing outcomes.jsonl on startup', async () => {
    // Arrange: pre-seed outcomes.jsonl with one record.
    // Act: construct a new tagger pointing at the same directory.
    // Assert: feeding a matching requestHash again emits nothing new.
  });

  it('never blocks, throws, or propagates errors into the proxy path', async () => {
    // Arrange: point tagger at an unreadable file / malformed line.
    // Assert: tagger emits a warning via the logger and continues.
  });

  it('uses fake timers for the idle sweep (no real wall-clock sleeps in tests)', () => {
    // Convention check — all timing-sensitive tests use vi.useFakeTimers().
  });
});
```

Follow AAA layout. Use `vi.useFakeTimers()` for all time-based tests. Inject the clock and the file-system surface as constructor dependencies so tests do not touch real files except in the single end-to-end case.

## Implementation stubs

`src/decisions/outcome.ts`:

```ts
/** Outcome tag values written to outcomes.jsonl. First tag wins per requestHash. */
export type OutcomeTag = 'continued' | 'retried' | 'frustration_next_turn' | 'abandoned';

export interface OutcomeTaggerConfig {
  readonly retryWindowSec: number;   // default 60
  readonly idleTtlSec: number;       // default 900
  readonly tailIntervalMs: number;   // default 2000
  readonly logDir: string;           // XDG-resolved, same dir as decisions.jsonl
}

export interface DecisionRecord {
  readonly ts: string;               // ISO
  readonly requestHash: string;      // 32 hex
  readonly sessionId: string;
  readonly signals: { readonly frustration: boolean | null };
  // ...other fields ignored by the tagger
}

export interface OutcomeTagger {
  /** Seed in-memory tagged set from existing outcomes.jsonl; idempotent. */
  start(): Promise<void>;
  /** Feed a single decision record (used by tail watcher and in tests). */
  ingest(record: DecisionRecord): void;
  /** Stop timers and flush the write buffer. */
  stop(): Promise<void>;
}

/** Construct a tagger. Inject clock + writer for tests. */
export function createOutcomeTagger(
  config: OutcomeTaggerConfig,
  deps: {
    now(): number;
    appendLine(path: string, line: string): Promise<void>;
    readLines(path: string): AsyncIterable<string>;
    logger: { warn(msg: string, meta?: unknown): void };
  }
): OutcomeTagger {
  throw new Error('not implemented');
}
```

## Correctness requirements

- Tagger MUST NOT block or delay the proxy's request/response path. All work happens on timers or on tail-watcher callbacks.
- Tagger MUST NEVER throw into its caller. Internal errors become warnings via the injected logger.
- Tagger MUST be idempotent across restarts — re-reading the same `decisions.jsonl` on boot must not produce duplicate tags.
- Tagger MUST record the **actual forwarded model** via the existing decision record only — it does not itself know or infer models.
- Tagger MUST NOT read message content, tool inputs, or auth headers. It only consumes fields already extracted into the decision record.

## Out of scope for this section

- Consuming outcome tags (that's `ccmux tune` and dashboard sections).
- Changes to routing, classifier, or decision-log writer.
- Any UI surface. Sidecar file is the entire output.
- Privacy-mode handling — the tagger reads already-redacted signals; there is nothing further to redact here.

## Definition of done

- `tests/decisions/outcome.test.ts` passes all nine cases.
- `src/decisions/outcome.ts` exports `createOutcomeTagger` and the `OutcomeTag` type.
- No changes to any file outside `src/decisions/outcome.ts` and its test file.
- `outcomes.jsonl` is written next to `decisions.jsonl` with one line per tagged `requestHash`, first-write-wins.
- Coverage on the new file is at least 80%.

---

## Implementation Outcome (2026-04-18)

Status: ✅ Implemented (10 tests passing).

### Deviations from plan

- **Public API gained `flush()`** — needed by tests so the in-memory store
  can be inspected after `ingest()` queues an async write. Production code
  ignores it; only tests await it.
- **Sidecar rotation** — left as a single `outcomes.jsonl` for now. The spec
  calls for mirroring decision-log rotation, but no rotation events are
  plumbed yet. Defer until the wiring section that owns the lifecycle.
- **Recent-hash store carries `{tsMs, sessionId}`**, not just `tsMs` — the
  `retried` tag attaches to the *prior* decision, so the tag's `sessionId`
  must come from the prior occurrence (per code review).
- **Test "uses fake timers" meta-check** from the spec was dropped as a
  no-op convention assertion; instead, every timing-sensitive test in the
  file uses `vi.useFakeTimers()` directly via the `beforeEach` hook.

### Code-review fixes applied

1. **Retry tag attribution** — uses prior occurrence's `sessionId` so cross-
   session retries are correctly labeled.
2. **readLines failure test** — added a case where the seed iterator throws;
   `start()` resolves with a `outcome_seed_failed` warn.

### Test count

10 tests, all green.
