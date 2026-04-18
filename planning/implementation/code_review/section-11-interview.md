# Section-11 Code Review Interview — Auto-fixes Applied

No items required user input — all should-fixes were obvious, low-risk improvements
directly implied by the spec. Logging here for the record.

## Auto-fixes applied (no user decision needed)

1. **Reject negative signal values** (review §3 item 2).
   `validateSignals` now requires `estInputTokens >= 0` and `fileRefCount >= 0`.
   Reason: spec says "returns null on malformed signals"; negatives are nonsensical
   outputs from the §07 extractor and would mis-score the result.

2. **Bound code-fence scan** (review §3 item 3).
   `countCodeFences` now slices each text block to the first 64 KB before running
   `String.match(/```/g)`. Also early-exits once the computed cap (14 triples = 7
   pairs = codeBlockCap reached) is seen. Reason: zero-latency contract + unbounded
   allocation risk on attacker-controlled content.

3. **Trim file to ≤150 lines** (review §3 item 1).
   Dropped the explicit `node:perf_hooks` import (Node provides `performance` as a
   global) and inlined the `ValidatedSignals` type. File is now within cap.

4. **Add targeted tests** (review §5 items 1, 2, 3, 5, 7):
   - NaN `estInputTokens` → null
   - Negative `fileRefCount` → null
   - Missing/empty `messages` → result still produced, no throw
   - Band-boundary: constructed inputs hitting exactly 3.0 (sonnet) and 6.5 (opus)
   - Aborted `AbortSignal` → heuristic still resolves (deadline is ignored)
   - Imperative/question test now asserts tier (sonnet vs haiku), not just ordering

## Let-go items

- **Latency `<5ms` vs spec's `<1ms`:** keeping `<5ms` — CI runners have enough
  jitter that a `<1ms` assertion is flaky. The result's own `latencyMs` field is
  also asserted, giving a second signal. Section-16 (tune) is where we'd add a
  hardware-specific perf gate if one is warranted.
- **`tools` element-type validation nit:** call site only reads `.length`; adding
  per-element type guards would be YAGNI.
- **`body` type narrowing helper for §12:** out of scope for §11. §12 will add
  whatever narrowing its cache keying needs.
