# Section 16 — Code Review Interview

## Triage summary

| ID | Severity | Item | Disposition |
|----|----------|------|-------------|
| W1 | Low | setFlag mutates out parameter | Let go — same pattern as report.ts parseFlags, mutation scoped to local variable |
| W2 | Low | ISO string comparison fragile | Let go — pre-existing convention from decision reader |
| W3 | Medium | findRuleIdLine regex misses quoted YAML ids | **Auto-fixed** |
| W4 | Medium | choice: replacement regex misses quoted values | **Auto-fixed** |
| W5 | Low | analyze.ts is 155 lines (5 over 150-line budget) | Let go — 150 is a soft budget, hard limit is 400 |
| S1 | Suggestion | tierOf with empty Map is hidden contract | Let go — try/catch handles failures gracefully |
| S2 | Suggestion | Deterministic tie-breaking in mostCommon | No action — already good |
| S3 | Suggestion | Missing multi-hunk test | **Auto-fixed** — added test + quoted YAML test |
| S4 | Suggestion | Missing --since default test | Let go — low risk |
| S5 | Suggestion | latencySum/latencyCount never consumed by suggest | Let go — section spec mandates tracking in RuleStats |

## Auto-fixes applied

### W3/W4 — Quoted YAML value support

Added optional `["']?` matching to all three regex patterns in `src/tune/diff.ts`:
- `findRuleIdLine`: now matches `id: "trivial-to-haiku"` and `id: 'trivial-to-haiku'`
- `findChoiceLine`: now matches `choice: "haiku"` and `choice: 'haiku'`
- `hunkFor` replacement: now matches and replaces quoted choice values

Added test `handles quoted YAML values` to `tests/tune/diff.test.ts`.

### S3 — Multi-hunk test

Added test `produces separate hunks for multiple suggestions` to `tests/tune/diff.test.ts`.

## Test results after fixes

- `tests/tune/**` — 19/19 pass
- Full suite — 413/413 pass (54 files)
- Typecheck: clean
- Lint: clean
