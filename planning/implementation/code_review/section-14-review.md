# Section 14 Code Review

## Summary
Implementation is largely spec-compliant and the invariants (no-throw, first-write-wins, restart idempotence, injected I/O) hold. A few correctness edges around retry-vs-session interaction and test hygiene are worth addressing.

## Critical Issues

None. No spec violations that break an invariant, no security issues, no data leaks of message content / tool inputs / auth headers (the `OutcomeTaggerInput` projection at `src/decisions/outcome.ts:32-37` enforces invariant #5).

## Important Suggestions

- `src/decisions/outcome.ts:101-113` — when a `retried` is emitted, the session branch is skipped entirely, so the prior same-session turn never gets `continued` / `frustration_next_turn`. It will only ever be tagged by the idle sweep as `abandoned`. Spec §Algorithm orders retry above session, so this is defensible, but the effect (a retried turn permanently orphans its predecessor from session-based tagging until `idleTtlSec` elapses) is worth a one-line comment or an explicit decision. If desired, run the session-prior logic in addition to the retry tag, since first-write-wins on `emitTag` keeps it safe.

- `src/decisions/outcome.ts:101-103` — retry tag is emitted with `record.sessionId` and `record.ts`, not the prior occurrence's. Spec says "tag the earlier record only if not already tagged." If the retry crossed sessions (same canonical hash, different session), the sidecar will record the later session's id against an earlier record's hash. Store `{sessionId, ts}` in `recentHashes` (not just `ts`) and emit with those.

- `src/decisions/outcome.ts:126-141` — `sweepIdle` compares `prior.tsMs` (parsed from record `ts`) against `deps.now()` (injected wall-clock ms). If a test advances `vi.advanceTimersByTimeAsync` without also advancing `deps.now`, the sweep will not fire as expected. The abandoned test at `tests/decisions/outcome.test.ts:316-331` handles this correctly by overriding `deps.now`, but the coupling is a foot-gun for future tests. Consider documenting that `deps.now()` is the sole clock the sweep consults.

- `tests/decisions/outcome.test.ts:365-380` — the "never throws" test only exercises `appendLine` failure. Spec test #8 calls out "unreadable file / malformed line" as well. The seeding-side error path (`readLines` throwing) at `src/decisions/outcome.ts:156` is untested, which is the one most likely to be hit in prod.

## Nitpicks

- `tests/decisions/outcome.test.ts:256, 272, 287, ...` — every test calls `mkdtempSync` even though only the e2e test at `:382` touches real fs. Dead dirs pile up in `tmpdir()`. Use a dummy string path (e.g. `/ccmux-test`) for the in-memory tests; the path is just a map key there.

- `src/decisions/outcome.ts:107` — `prior.frustration !== true` is equivalent to the spec's "false/null" only because `frustration` is typed `boolean | null`. Fine, but a literal `(prior.frustration === false || prior.frustration === null)` matches the spec wording 1:1 and survives a future type widening.

- `src/decisions/outcome.ts:68` — `NodeJS.Timeout` leaks a Node global into a TS interface. `ReturnType<typeof setInterval>` is marginally cleaner.

- `src/decisions/outcome.ts:143-161` — `start()` swallows re-entry silently via the `started` flag but `stop()` checks `stopped` the same way. If `start()` is called after `stop()`, the timer is never created and the tagger is a no-op with no warning. Low-probability misuse, but one `logger.warn` would surface it.

- `tests/decisions/outcome.test.ts:204` — `rec()` spreads `over` after the `frustration: false` default, but the param type already requires `ts/requestHash/sessionId`. The `Partial<...>` intersection is redundant with the explicit required fields — `Omit<OutcomeTaggerInput, 'frustration'> & { frustration?: boolean | null }` reads cleaner.

## What Looks Good

- No-throw discipline is uniformly enforced: every external boundary (`ingest`, `sweepIdle`, `start`, `emitTag`'s `.catch`) funnels into `logger.warn`.
- First-write-wins is a single check at `src/decisions/outcome.ts:74`, and it gates both live tagging and restart-seeded tags through the same `tagged` set — clean.
- Injection surface (`now`, `appendLine`, `readLines`, `logger`) matches the spec exactly and is honored by the tests.
- `timer.unref?.()` at `src/decisions/outcome.ts:160` correctly avoids holding the process open.
- Restart-rebuild test at `tests/decisions/outcome.test.ts:349-363` proves invariant #2 end-to-end.
- Projected `OutcomeTaggerInput` prevents the tagger from ever touching message content, tool inputs, or headers (invariant #5 is structurally guaranteed).
