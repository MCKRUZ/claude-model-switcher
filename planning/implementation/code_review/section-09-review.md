# Code Review — section-09-sticky-model

Reviewer: code-reviewer subagent
Date: 2026-04-18

## Blockers
None.

## Important

### 1. `store.get` mutates during abstain path (eviction-on-read)
`policy.ts` calls `store.get(...)` when a sticky exists. If TTL-expired, `get` deletes the entry as a side effect. Spec's "abstain never mutates" is in tension with ttl-expired returning abstain + deleting. Tests assert the deletion is intentional (size drops to 0). **Recommended:** add a one-line comment clarifying eviction-on-read is the one allowed mutation on abstain.

### 2. `turnCount` semantics documentation
`writeSticky` always calls `store.set` on chosen outcomes, bumping turnCount. `touch` (sticky-hit) also increments. Net: turnCount is "times a chosen outcome touched this session." The plan is ambiguous ("incremented each time the session routes a request"). **Recommended:** inline comment clarifying.

### 3. Non-null assertion `input.explicitModel!` in `handleExplicit`
TS cannot narrow through a function boundary. Safe today (guarded at the call site), but fragile. **Recommended:** pass `explicitModel: string` as a parameter to `handleExplicit`.

## Minor

### 4. `fallbackFamilyModelId` returns invalid model names
`claude-{tier}-latest` is not a real Anthropic alias; if forwarded, upstream 404s. Called from a `chosen` path, so it IS reached if `config.modelTiers` is empty and an escalate/tier-shorthand fires. Options: throw (fails loudly early), keep with warning, or abstain instead. **Requires user decision.**

### 5. `tierOf` substring match is order-sensitive
Iterates `TIER_FAMILIES` (haiku→sonnet→opus). Compound hypothetical name like `claude-opus-sonnet-eval` would resolve to whichever substring matches first. Safe today; override map guards against it. **Recommended:** comment.

### 6. `StickyChosenBy` re-exported twice
`policy.ts` has `export type { StickyChosenBy }` at the end, but `index.ts` already re-exports from `types.ts`. Dead code. **Recommended:** delete the dead re-export in policy.ts.

### 7. `firstModelIdForTier` insertion-order contract
Depends on `Map` insertion order, which depends on how section-03 builds the map. **Recommended:** pin the contract via comment in `tiers.ts`.

## Section-10 / section-13 contract check
- `ResolveInput` matches spec.
- `StickyStore` adds `peek` and `delete` beyond spec — additive, non-breaking.
- `StickyDecision` shape matches spec exactly.
- No issues blocking downstream sections.

## Verdict
Approve with important #3 and decision on minor #4 before section-10.
