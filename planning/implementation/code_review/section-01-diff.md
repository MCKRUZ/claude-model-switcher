# Section-01 Code Review — Diff Summary

## Scope
Repository skeleton only: config files + test fixture. 60+ src/tests/scripts stub files were created with the body `// Populated in section-NN. Do not import.\nexport {};` — these are intentionally empty placeholders and are excluded from this diff to keep the review focused.

## Files of interest
- `package.json` — scripts + dependency declarations (declared, unused)
- `tsconfig.json` — strict TS compiler settings
- `tsconfig.eslint.json` — widened project for type-aware lint
- `vitest.config.ts` — test config with coverage thresholds
- `.eslintrc.cjs` — custom size rules (400 lines / 50 lines-per-function)
- `.eslintignore`, `.gitignore`
- `README.md`, `LICENSE`, `Dockerfile` — placeholders
- `tests/lint/size-limits.test.ts` — the only test file with real logic

See `section-01-diff.patch` for the raw patch and `section-01-diffstat.txt` for the stat.
