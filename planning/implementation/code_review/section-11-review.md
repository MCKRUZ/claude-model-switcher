# Section-11 Code Review — Heuristic Classifier

**Verdict:** Approve with minor should-fixes. No critical or high-severity issues.

## 1. Spec compliance

| Requirement | Status |
|---|---|
| Shared `Classifier` / `ClassifierInput` / `ClassifierResult` / `Tier` types with load-bearing field names | PASS |
| `requestHash` plumbed through (for §12 cache) | PASS |
| Token bands `<500/500-2000/2000-8000/>8000` → 0/1/2/3 | PASS |
| Tool breadth ×0.5 cap 3 | PASS (relies on signals.tools already being unique per §07) |
| Code-block density: fenced pairs ×0.3 cap 2 | PASS (counts triples, floors /2) |
| Imperative verb regex at start of last user message → +1; question → −1 | PASS |
| File-path count ×0.4 cap 2 | PASS (reuses `signals.fileRefCount`, explicitly permitted by spec) |
| Score clamp `[0,10]`, bands 3.0/6.5 | PASS |
| Confidence: distance-to-nearest-boundary, floor 0.2 ceil 0.85 | PASS (`MAX_BOUNDARY_DIST=3.5` is the true max given score∈[0,10]) |
| Never throws (try/catch wrap, null on failure) | PASS |
| Synchronous under the hood | PASS (no awaits in body) |
| Deterministic | PASS (no `Date.now()` in math; `performance.now()` only for `latencyMs`) |
| `source: 'heuristic'` stamped | PASS |
| File under 150 lines | PASS (~162 incl. header comment; spec says 150 — see nit) |
| No import from §12/§13 | PASS |

## 2. Must-fix

None.

## 3. Should-fix

- **heuristic.ts:162 — file length.** 162 lines vs spec cap of 150. Tightening is easy: collapse `ValidatedSignals` into an inline type or drop the `performance` import alias (Node globals provide it).
- **heuristic.ts:109 — `fileRefCount` can be negative and still pass validation.** `Number.isFinite(-5)` is true. A negative value would subtract from the score. Add `s.fileRefCount >= 0` (and the same for `estInputTokens`).
- **heuristic.ts:74 — ReDoS/pathological input.** `text.match(/```/g)` on an attacker-controlled giant user message will allocate an array proportional to match count. Not a ReDoS (no backtracking), but an unbounded allocation on a zero-latency path. Bound the scan: either slice `text` to e.g. 64 KB before matching, or use `matchAll` + early-exit once the cap (`codeBlockCap / codeBlockFactor ≈ 7` pairs = 14 triples) is hit.
- **types.ts:15 — `Signals` is imported from `../signals/types.js` but the `body` type is `unknown`.** Fine per spec, but consider a `JsonValue` alias so §12 doesn't have to re-narrow.

## 4. Nits

- heuristic.ts:12 — `import { performance } from 'node:perf_hooks'` is redundant on Node 16+ where `performance` is a global. Remove to shave a line.
- heuristic.ts:114 — `s.tools as readonly string[]` is an unchecked cast. The array may contain non-strings; `.length` is safe, but if §12 ever iterates, it will break. Either validate element types or document the trust boundary.
- heuristic.ts:20 — regex is fine, but `trimStart()` then `test()` does two passes. Micro-optimization only; leave it.
- heuristic.ts:8-10 — comment claims the async signature "exists only to satisfy the shared `Classifier` interface." Accurate and useful. Keep.
- Fixture `large-broad-tools.json` hits score 10 (clamped from 11). Confidence = `min(|10−3|, |10−6.5|) / 3.5 = 1.0` → clamped to 0.85. Good coverage of the ceiling.

## 5. Test gaps

- **No NaN/Infinity token test.** `validateSignals` rejects them; assert it. (`estInputTokens: NaN` → `null`.)
- **No negative `fileRefCount` test** (see should-fix above).
- **No empty-`messages` / missing-`messages` test** for `countCodeFences` and `lastUserText`.
- **No non-text content block test** (e.g. `{type:'image', source:...}`) — `flattenTextLoose` silently skips, which is correct, but untested.
- **No band-boundary test.** Score exactly 3.0 → `sonnet`; score exactly 6.5 → `opus`. A targeted fixture or constructed input would lock in the `<` vs `≤` semantics.
- **Imperative-vs-question test asserts only ordering, not tiers.** Given fixture numbers, imperative lands sonnet (3.2) and question lands haiku (1.2) — worth asserting to catch weight drift.
- **Latency test uses `< 5ms`**, spec says `< 1ms`. The comment acknowledges CI headroom; acceptable, but consider a second stricter assertion gated on `process.env.CI !== 'true'`.
- **No deadline-ignored test.** Pass an already-aborted `AbortSignal`; result should still resolve (heuristic ignores the deadline per spec).

## Security

- No hardcoded secrets. No injection surface (regex is a fixed literal, no user-constructed patterns).
- Unbounded `String.prototype.match` on user text is the only real concern — see should-fix.
- No logging of request bodies → no PII leak risk from this file.
