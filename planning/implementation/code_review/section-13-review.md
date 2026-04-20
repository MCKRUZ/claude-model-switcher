# Section 13 Code Review

## Summary
Section 13 lands a clean, well-tested decision-log writer that meets most spec contracts (no hot-path stat, bounded queue, fsync off, forwarded/chosen separation, chronological reader, filename-based retention, Windows rename fallback). Two correctness issues warrant fixes: an infinite-retry loop on size-rotation rename failure, and a spec/impl drift on the daily-rollover timezone. One test mislabels what it actually covers.

## Critical Issues

- [CRITICAL] Infinite rotation retry when rotateRename fails
  File: src/decisions/log.ts:287-293
  Issue: When rotateRename throws, the catch at line 289 only logs and then calls openStream(oldPath). Because the source file was not renamed and not truncated, bytes = statSize(p) in openStream re-seeds the counter to the same >= maxBytes value, so the next performWrite immediately re-enters the rotation branch and retries the same failing rename on every subsequent append.
  Fix: Reset bytes = 0 (or set a cooldown flag) after logging the failure so we stop retrying. Alternatively, retry with a fresh nextSizeFilename suffix.

- [CRITICAL] Daily rollover uses local date; spec says UTC
  File: src/decisions/rotate.ts:674-679, src/decisions/log.ts:217, src/decisions/log.ts:256
  Issue: Spec (section-13 Implementation Details #2) says compare clock().toISOString().slice(0,10) which is UTC. dateStamp uses getFullYear/getMonth/getDate (local). Two users on the same UTC day in different timezones will produce different filenames, and a server in non-UTC TZ will roll at local midnight, not UTC. The daily-rotation test at decision-log.test.ts:1101 constructs local-time Dates, so the drift is masked.
  Fix: Use getUTCFullYear/getUTCMonth/getUTCDate in dateStamp, or update the spec (and comment at rotate.ts:654-666) to say "local date" explicitly.

## Important Suggestions

- [HIGH] Test mislabels queue-full overflow; never exercises the bounded-queue drop path
  File: tests/decisions/decision-log.test.ts:1125-1146
  Issue: Titled "drops records and logs the drop when the bounded queue overflows," but the test calls writer.close() first and then append, which exits via the closed branch at log.ts:335 with reason: 'closed'. The MAX_QUEUE overflow branch at log.ts:339 is never hit. Spec acceptance item #2 explicitly calls out queue_full.
  Fix: Add a test that saturates the queue synchronously (e.g. 1500 appends before awaiting any flush), then assert at least one append returned false with reason: 'queue_full'.

- [MEDIUM] Ambiguity in redactSignals scope vs spec "messages/tool input" requirement
  File: src/decisions/redaction.ts:594-634, src/decisions/record.ts:525-543
  Issue: Spec (Redaction table) says hashed mode hashes "each message string and each tool input object" and none drops "messages, tool input, and any content fields." redactSignals only touches fields on the Signals type. Message bodies and tool-call inputs live in the request body and are not handled here, so their redaction is implicitly section-04's responsibility. No integration test or JSDoc asserts that boundary.
  Fix: Add a JSDoc contract comment on buildDecisionRecord/redactSignals stating that section-04 must pre-redact any body/tool-input content before passing it as extractedSignals.

- [MEDIUM] ensureNoAuth only inspects top-level keys
  File: src/decisions/redaction.ts:586-592
  Issue: Spec #7 is absolute: auth headers must never appear, even in full mode. Nested objects like { headers: { authorization: ... } } would pass through. Pino at section-02 is the backstop, but the spec says "enforced both here and at the pino layer."
  Fix: Recurse through nested objects/arrays, or explicitly document at line 575 that nested auth headers are delegated to pino.

- [MEDIUM] enqueue chain silently swallows write errors; append reports accepted but work may fail
  File: src/decisions/log.ts:322-331
  Issue: The .catch at line 329 logs a structured error but the chain continues resolving, so flush() never rejects and callers cannot learn that a record was accepted-but-not-written.
  Fix: Track a droppedPostAccept counter and expose it, or surface an error hook so shutdown code can detect persistent failure.

## Nitpicks

- rotate.ts:785-788: touchFile is exported but unused in the diff. Either wire it in or drop it.
- rotation.test.ts:1588-1589: void renameSync is a workaround for an unused import; remove the import instead.
- types.ts:823-826: DecisionPolicyResult with two optional fields allows {} as a valid value. Use a discriminated union to enforce the spec wording at compile time.
- log.ts:368-372: let reconcileTimer is declared after close() references it. Harmless but reads oddly; hoist above close.
- redaction.ts:582-583: json ?? '' handles JSON.stringify(undefined) === undefined; add a brief comment so a future simplifier does not remove it.
- cost.ts:56: raw === null is required because typeof null === 'object'. A one-line comment would prevent a later refactor from dropping it.
- log.ts:339-341: when the queue fills, the structured warn does not include record.request_hash. Adding it would let operators correlate which requests were dropped.

## What Looks Good

- Clean separation of concerns: _fs.ts indirection for spyable fs (the only viable ESM pattern), rotate.ts is pure/stateless, log.ts owns serialization and the byte counter, reader.ts is a standalone async iterator.
- Spec #1 (no hot-path stat) is provable and tested via spy at decision-log.test.ts:1042-1061.
- Spec #3 (fsync OFF default) is covered by a spy test at decision-log.test.ts:1148-1164.
- Spec #4 (forwarded vs chosen) is covered explicitly at decision-log.test.ts:1020-1040 and in the shadow-mode test at record.test.ts:1349-1366.
- Spec #9 (retention by filename date, not mtime) is covered at rotation.test.ts:1563-1579.
- Spec #10 (Windows rename EBUSY fallback) is covered at rotation.test.ts:1531-1547; EIO rethrow case also tested.
- Reader chronological ordering with suffix-0 sorted last is a subtle invariant, both implemented (reader.ts:422-429) and tested (decision-log.test.ts:1166-1188).
- Cost math correctly distinguishes "unknown model" (null + warn-once) from "all-fields-null usage" (null), matching spec #5.
- Config-only privacy enforced by a grep-style test at redaction.test.ts:1473-1481.
