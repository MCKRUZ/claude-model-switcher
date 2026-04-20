# Section 14 — Code Review Interview

No user-facing tradeoffs. All findings auto-fixable.

## Auto-fixes

### A. Retry tag attribution (review IMPORTANT #1)
**Issue:** `retried` was emitted with the *current* record's sessionId/ts. Conceptually the tag annotates the *prior* (already-logged) decision, so it should carry the prior occurrence's sessionId. Cross-session retries previously mislabeled.
**Fix:** Store `{tsMs, sessionId}` in `recentHashes` instead of just `tsMs`. When emitting `retried`, use the prior occurrence's sessionId. Use the current record's `ts` for the sidecar timestamp (when the tag was decided).

### B. readLines seed failure test (review NIT)
**Issue:** The "never throws" test only exercises `appendLine` failure. The seed-from-sidecar path (`readLines` throwing) was untested.
**Fix:** Add a test where `deps.readLines` throws; assert `tagger.start()` resolves and emits a warn.

## Items intentionally not addressed

- "Retry short-circuits session branch" — spec algorithm is structured as `If retried | Else if session-branch | Else nothing`. Current impl matches. Adding both tags for the same record would change semantics; punt unless the user requests.
- `mkdtempSync` in every test — minor verbosity, no risk; not worth churn.
