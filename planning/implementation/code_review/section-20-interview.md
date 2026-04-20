# Section-20 Code Review Interview

## Auto-fixes applied

1. **Added `sessionId` and `requestHash` to signal table** (`src/cli/explain.ts`): These fields are deterministic per-request and useful for correlating with decision logs.

2. **Added "does not write to decision log" test** (`tests/cli/explain.test.ts`): Creates a decision log directory, runs explain, verifies no files were written. Env var save/restore with try/finally for isolation.

## Let go (no action)

- `stubSession` comment — dry-run behavior is self-evident
- `renderChoice` exhaustive check — defensive fallback is fine
- `import.meta.dirname ?? ''` — consistent with other tests
- Output padding inconsistency — cosmetic
