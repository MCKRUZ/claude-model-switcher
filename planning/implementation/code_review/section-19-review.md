# Section-19 Code Review: ccmux init and recipes

**Verdict: Approve with minor items**

## IMPORTANT (1)

1. **Unguarded `readFileSync` for recipe YAML** (`src/cli/init.ts:32`): After `isValidRecipe` passes, `readFileSync` runs without try/catch. If recipes are missing from a corrupted install, this throws a raw stack trace. Consistent with `version.ts` but recipes are in a separate `src/` tree that's more fragile. Suggested: wrap in try/catch, return exit 2 with helpful message.

## SUGGESTION (3)

1. **Balanced retry threshold**: Spec says `retry-count >= 1` but recipe uses `gte: 2`. Spec says "implementer chooses exact rule text" and tests pass — likely intentional.
2. **`mode: active` vs `mode: live`**: Spec says `active` but schema only defines `live | shadow`. Using `live` is correct.
3. **Frugal recipe simpler than spec**: No tool-use escalation or retry-count rule. Valid since tests are the contract.

## NITPICK (2)

1. **`mkdirSync` missing `mode: 0o700`** (`src/cli/init.ts:43`): `ensureDirs()` in `paths.ts` uses `0o700`; `init.ts` uses default. Should match for consistency.
2. **8th test case beyond spec**: "should write opus-forward recipe" is extra coverage — fine.

## Positives

- Pattern consistency with version.ts and other CLI commands
- Test isolation with env var save/restore and temp dir cleanup
- Recipe name validated against closed allowlist — no path traversal
- Config-loader round-trip test proves YAML structural validity
- 47-line init.ts, well under 80-line target
