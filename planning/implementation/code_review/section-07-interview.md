# Section 07 — Code Review Interview

## User decisions

### session.ts `__resetLocalSaltForTests` export
- **Chosen:** Keep as-is.
- **Rationale:** Consistent with existing test-reset patterns in the codebase; the underscore prefix already signals "private".
- **Action:** No change.

## Auto-fixes applied

1. **`extract.ts:extractSignals` headers parameter** — widened to `| undefined` so malformed-input test no longer needs `as never`; removes a future footgun.
2. **`canonical.ts:stableStringify`** — defensive branch for `undefined` returning `'null'` (was unreachable, kept for parity).
3. **`extract.ts` EMPTY_FROZEN constant** — hoist `Object.freeze([])` to a module constant; reused for `tools` and `betaFlags` fallbacks.
4. **`messages.ts:contentBlocks`** — widened parameter to `unknown`, removed three `as never` casts at call sites (`extract.ts`, `tools.ts` x2).
5. **`extract.ts:isAbsolutePath`** — added a one-line comment clarifying the POSIX + drive-letter heuristic scope (no UNC).

## Items let go

- **`frustration.ts` aggressive `\bno\b` trigger** — spec-faithful; tuning is section-08/16's domain.
- **`tokens.ts` cold-start 50–150ms** — proxy-startup warmup is section-04's concern.
- **`tools.ts` FILE_REF_TOOL_NAMES hardcoded** — YAGNI until a later section adds override config.
- **Test file 369 lines** — under the 400 limit; splitting would add churn without clear gain.
- **`retry.ts` warn on NaN coercion** — retry has no logger passed today; adding one for an unreachable path is not worth it.
- **`extract.ts` fallback `canonical.userMessagesPrefix: []` freeze** — marginal; the array is not mutated downstream.
