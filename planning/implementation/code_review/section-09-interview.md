# Code Review Interview — section-09-sticky-model

## User-approved decisions

### #4. Fallback model behavior (minor)
**Decision:** Throw (fail loudly) when `config.modelTiers` has no entry for a resolved tier.
**Action:** Remove `fallbackFamilyModelId` entirely. `resolveChoiceModelId` and `handleEscalate` throw with a clear error message when no modelId is available for the target tier.
**Rationale:** Surfaces config errors early. Section-03 validation is the right place to warn on sparse modelTiers; sticky layer should not invent fake upstream-invalid model IDs.

## Auto-fixes (applied without asking)

### #3. Remove non-null assertion on `explicitModel` (important)
Change `handleExplicit` to take `explicitModel: string` as a parameter; remove `!` assertion.

### #1. Clarifying comment on eviction-on-read
Add one-line comment in `policy.ts` noting that `store.get`'s internal TTL-eviction is the one allowed mutation during an abstain-ttl-expired outcome.

### #2. `turnCount` semantics comment
Add inline comment in `writeSticky` / `types.ts` clarifying turnCount increments on every chosen/touch, not on abstain.

### #5. `tierOf` substring iteration-order comment
Add comment in `tiers.ts` noting TIER_FAMILIES is iterated in order haiku→sonnet→opus; override map is the escape hatch for ambiguous compound names.

### #6. Remove duplicate `StickyChosenBy` re-export
Delete the dangling `export type { StickyChosenBy }` at the bottom of `policy.ts`.

### #7. `firstModelIdForTier` insertion-order contract comment
Add comment in `tiers.ts` pinning the Map-insertion-order contract that section-03 must preserve.
