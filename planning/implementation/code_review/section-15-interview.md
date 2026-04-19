# Section 15 — Code Review Interview

## Triage summary

| ID | Severity | Item | Disposition |
|----|----------|------|-------------|
| B1 | Blocking | Commander subcommand declared `.option('--since …')` etc., which consumed the flags before `runReport` ever saw them. Unit tests bypassed Commander. | **Auto-fixed** |
| B2 | Blocking | Cost invariant `with − without = sum(classifier)` breaks when every record has null `cost_estimate_usd` but some have `classifier_cost_usd`. Result is `NaN` on subtraction. | **User decision (A): Accept + document** |
| S1 | Should-fix | `parseFlags` / `largestRemainder` mutate local state | Let go — local non-exported state, not public surface |
| S2 | Should-fix | Classifier overhead attributed to serving-model bucket may mislead `--group-by model` | Let go — column header already disambiguates ("With overhead") |
| N1 | Nit | Inconsistent sort order between routing (by count) and cost (alpha) | Let go — intentional; routing shows popularity, cost shows deterministic alpha ordering |
| N2 | Nit | `tables.test.ts` first-3-percentages regex is fragile | Let go — good enough for now |
| N3 | Nit | `duration.ts` silently accepts `0d` | Let go — `0d` is a valid "no window" duration |

## Interview decisions

### B2 — Null-cost invariant (user answered A)

**User:** Accept + document. Renderer already prints "—" when columns are null; add a code comment stating the invariant holds only when both totals are numeric.

**Applied:** Added block comment to the top of `src/report/aggregate.ts` documenting the null-cost semantics and the bounds of the invariant.

### Integration test coverage (user answered yes)

**User:** Add an integration test that exercises the full `run(['report', ...])` → commander → `runReport` path so the wiring bug in B1 can't silently recur.

**Applied:** Created `tests/cli/report.test.ts` with 3 tests:
1. `--format json` reaches `runReport` (would fail if commander ate the flag).
2. `--since 30d --group-by project` reaches `runReport`.
3. Invalid `--since` exits non-zero via commander dispatch.

All 3 pass on the fixed implementation.

## Auto-fixes applied

### B1 — Commander flag wiring

**Root cause:** `.option('--since <v>')` on the report subcommand taught commander to parse `--since`, populating `cmd.opts()` and leaving `cmd.args` empty. The internal `runReport` parser then ran on `[]` and applied defaults, silently ignoring every user flag.

**Fix:** Removed the `.option(...)` declarations. With `.allowUnknownOption(true)` (already present), commander now passes the entire flag tail (`--since 7d --format json`) through to `cmd.args`. Added a block comment explaining why the options are intentionally NOT declared.

**File:** `src/cli/main.ts`

## Test results after fixes

- `tests/report/**` — 22/22 pass
- `tests/cli/report.test.ts` — 3/3 pass (new)
- Total: 25/25 in the report scope
- Lint and typecheck: clean on all files touched by this section
