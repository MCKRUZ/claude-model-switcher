# Section-19 Code Review Interview

## Auto-fixes applied

1. **Guarded `readFileSync` for recipe YAML** (`src/cli/init.ts`): Wrapped recipe file read in try/catch. Returns exit code 2 with a message pointing to the recipe directory on failure.

2. **Added `mode: 0o700` to `mkdirSync`** (`src/cli/init.ts`): Consistent with `ensureDirs()` in `paths.ts` which creates all ccmux directories with restrictive permissions.

## Let go (no action)

- Recipe content deviations from spec (balanced retry threshold, frugal simplicity) — spec says "implementer chooses exact rule text" and behavioral tests are the contract.
- Extra 8th test case — more coverage is welcome.
- `mode: active` vs `mode: live` — schema only defines `live | shadow`, so `live` is correct.
