# Section 07 Code Review

## Critical

None. All eight stated invariants hold: orchestrator is try/catch-wrapped per extractor; returned Signals + `tools` + `betaFlags` are frozen; `requestHash` excludes `model`/request IDs/timestamps/`metadata.user_id`, is stable across key reordering via `stableStringify`, and yields 32-char hex; session salt is a module-local `let` initialized via `randomBytes(32)`; no auth-header access anywhere; TypeScript strict with `unknown` at boundaries; all files under 400 lines.

## Important

- **`extract.ts:218` — `headers` typed non-optional but test passes `undefined as never`.** The orchestrator's test `orchestrator never throws even on fully-malformed input` calls `extractSignals(null, undefined as never, ...)`. `extractBetaFlags` handles `undefined` internally, so runtime is safe, but the public contract should match: change the `headers` parameter to `headers: Readonly<Record<string, ...>> | undefined` so callers don't need an `as never` cast.

- **`extract.ts:229` — fallback `canonical` object violates readonly contract.** The `safe()` fallback literal `{ systemPrefix: '', userMessagesPrefix: [], toolNames, betaFlags }` matches `CanonicalFields` structurally but `userMessagesPrefix: []` is a mutable array handed into `stableStringify` via `requestHash`. Low-risk (nothing mutates it downstream), but for consistency freeze it: `Object.freeze({ ... userMessagesPrefix: Object.freeze([]) })`.

- **`session.ts:30` — `__resetLocalSaltForTests` is exported on the public surface.** The comment says "NOT exported publicly outside tests" but the `export` makes it reachable from any importer. Gate with a runtime check (`if (process.env.NODE_ENV === 'test')`) or move to a sibling `session.internal.ts` and re-export only in a test barrel.

- **`extract.ts:169` — `isAbsolutePath` Windows regex is narrow.** Accepts `C:\` / `C:/` but not UNC paths (`\\server\share`). For a routing heuristic this is fine, but worth a `// heuristic: POSIX + drive-letter only` comment so someone doesn't later "fix" it by broadening.

- **`frustration.ts:12` — `/\bno\b/i` is a very aggressive trigger.** A user message "no worries, keep going" trips frustration. Spec explicitly lists this phrase, so the implementation is faithful — but flag it for section-08 tuning. No code change here.

- **`tokens.ts:10` — `getEncoding('cl100k_base')` runs synchronously at first call and can take 50–150ms.** First request on a cold process pays this cost inside the hot path. Consider a warmup call at module import or during proxy startup (section-04 concern, but worth a note).

## Nits

- **`canonical.ts:15` — `JSON.stringify(value)` for primitives returns `undefined` when `value === undefined`.** Guarded by the preceding null check for objects, but `stableStringify(undefined)` returns the string `"undefined"` which isn't valid JSON. Not reachable via current callers; add `if (value === undefined) return 'null';` for defensive parity.

- **`extract.ts:225` — `Object.freeze<string[]>([])` repeated inline.** Pull a module-level `const EMPTY_FROZEN: readonly string[] = Object.freeze([])` and reuse.

- **`messages.ts:56` — `contentBlocks` casts via `as never` at call sites (`extract.ts:193`, `tools.ts:33`, `tools.ts:44`).** Widen the parameter to `content: unknown` and narrow inside — removes three `as never` casts.

- **`retry.ts:8` — `Number.isFinite(n) && n >= 0 ? Math.floor(n)` silently swallows NaN/negative.** Fine, but log a `warn` when coercing so a broken store surfaces.

- **`tools.ts:8` — `FILE_REF_TOOL_NAMES` list is hardcoded.** Consider accepting an override via config in a later section; note as YAGNI for now.

- **Test file `tests/signals/extract.test.ts` is 369 lines** — under the 400 limit but approaching it. Splitting by extractor (one file per concern, matching src layout) would improve navigability.

## Positive

- Clean separation: each extractor one concern, orchestrator owns the try/catch, matches spec exactly.
- `stableStringify` is a tight, correct canonical JSON implementation — sorted keys, recursive, no whitespace.
- `session.ts:32` printable-ASCII validation correctly anchors the regex; newline/control rejection test covers it.
- Test coverage is strong: 36 tests exercise every spec bullet including the "extractor throws → degrades" invariant via a throwing `retrySeen`.
- No auth-header access anywhere in the diff — invariant 8 held cleanly.
- `ContentBlock` / `AnthropicRequestBody` use `readonly [k: string]: unknown` index signatures — unknown fields round-trip as promised.

**Verdict: Approve.** No critical or high blockers; the Important items are polish.
