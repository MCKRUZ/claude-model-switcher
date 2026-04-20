# Section 13 — Code Review Interview

## User-decided fixes

### 1. Daily rollover timezone (CRITICAL #2)
**Decision:** Switch impl to UTC. Spec wins.
**Action:** `dateStamp` uses `getUTCFullYear/getUTCMonth/getUTCDate`. Update `decision-log.test.ts` daily-rotation test to construct UTC dates.

### 2. ensureNoAuth nested recursion (MEDIUM #5)
**Decision:** Recurse into nested objects/arrays.
**Action:** Rewrite `ensureNoAuth` to walk the value tree and throw on any `authorization` / `x-api-key` / `x-ccmux-token` key at any depth.

### 3. Surface async write failures (MEDIUM #6)
**Decision:** Track `droppedPostAccept` counter.
**Action:** Add `droppedPostAccept` field to writer, expose via `writer.droppedPostAccept()`. Increment in the enqueue catch.

## Auto-fixes (no user input needed)

### A. Infinite rotation retry (CRITICAL #1)
**Action:** In the size-rotation catch block, reset `bytes = 0` after logging the failure so we stop re-entering the rotation branch on every append. The active stream keeps writing into the un-rotated file; next append's rotation check won't fire until we cross maxBytes again with fresh data.

### B. Queue-full test mislabel (HIGH #3)
**Action:** Replace the test that closes-then-appends with one that synchronously enqueues 1500 records before awaiting flush, asserts at least one returned `false` with reason `queue_full`.

### C. Redaction scope JSDoc (MEDIUM #4)
**Action:** Add a JSDoc contract on `redactSignals` and `buildDecisionRecord` saying section-04 is responsible for redacting message bodies / tool inputs before passing them as `extractedSignals`.

### D. Drop unused exports (Nitpicks)
- `rotate.ts`: remove unused `touchFile` export.
- `rotation.test.ts`: remove unused `import { renameSync }` (and the trailing `void renameSync` workaround).

## Items intentionally not addressed

- Nitpicks on inline comments (`json ?? ''`, `raw === null` rationale) — code is clear enough on read.
- DecisionPolicyResult discriminated union — defer; type rewrite would ripple through section-04 callers and isn't a correctness bug.
- `reconcileTimer` declaration order — harmless ordering; not worth churn.
- `request_hash` in queue-full warn payload — operator-facing log polish; punt to observability pass.
