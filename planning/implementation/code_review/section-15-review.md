# section-15 Code Review — `ccmux report`

Overall: good shape. Clean pure-pipeline split (duration → aggregate → render), streaming via section-13's `readDecisions`, Result-style error handling, no stack-trace leaks, no `console.log`, files comfortably under 400 lines. Tests are real-fs based and cover the plan's required cases.

Two real bugs to fix before merge, plus a handful of should-fixes and nits.

---

## Blocking

### B1. Commander subcommand flag wiring is broken for real CLI invocations

`src/cli/main.ts:19-30` declares `--since`, `--group-by`, `--format` via Commander's `.option(...)` on the `report` subcommand, *and* sets `allowUnknownOption(true) / helpOption(false)`, *and* then passes `cmd.args` (positionals) to `runReport`. Commander consumes known options into its options store, so `cmd.args` will be empty for the exact flags the user typed — `runReport` then runs `parseFlags([])` and silently uses defaults.

Tests don't catch this because `tests/report/report-cli.test.ts` calls `runReport(argv, opts)` directly, completely bypassing Commander. End-to-end via `buildProgram` would never see the user's flags.

**Fix options (pick one):**
- Drop the `.option()` declarations on the subcommand; use `.argument('[args...]')` or rely purely on unknown-option passthrough, then forward `cmd.args` to `runReport`. Add a CLI-level integration test that invokes `buildProgram` with `['report', '--since', '1d', '--format', 'json']`.
- Or, remove the custom `parseFlags` and read Commander's parsed options via `cmd.opts()` inside the action handler, passing them as a typed object to `runReport`.

The second option is simpler and lets Commander own validation messaging.

### B2. "with overhead − without overhead = sum(classifier_cost_usd)" invariant breaks when `cost_estimate_usd` is null

`src/report/aggregate.ts:271-276` adds `classifier_cost_usd` into `withOverhead` regardless of whether `cost_estimate_usd` was present. Combined with the null-propagation logic in `finalize`, this means:

- Record A: `cost=null, classifier=0.01` → `totalWithOverhead += 0.01, totalWithoutOverhead` stays null-track.
- Record B: `cost=0.10, classifier=0.01` → both get `+0.11` / `+0.10`.
- Final: `totalWithOverhead=0.12`, `totalWithoutOverhead=0.10`. Diff = 0.02, but `sum(classifier_cost_usd) = 0.02` — OK here.

But consider all `cost` null, some `classifier` set: `anyWithout=false → totalWithoutOverhead=null`, `totalWithOverhead=sum(classifier)`. `null - number` is `NaN`. The plan's invariant (section-15 line 44, test #4) assumes records where `cost_estimate_usd` is present. The test only verifies the all-cost-present path.

**Fix:** either (a) document the invariant as "holds when all records have `cost_estimate_usd`" and guard against the NaN case in the renderer/JSON, or (b) treat `withOverhead` as null whenever `cost_estimate_usd` is null for that record (so both totals track the same subset). Option (b) is semantically cleaner — a bucket's "overhead cost" without a "base cost" is meaningless for the diff to be meaningful.

Add a test for the mixed-null case to lock behaviour down.

---

## Should fix

### S1. `parseFlags` mutates its `Flags` accumulator
`src/cli/report.ts:117-140` declares `Flags` with mutable fields and assigns via `out[key] = value`. Per `rules/coding-style.md` ("Immutability first") prefer spread accumulation or a `Record<string, string>` that's frozen at the end. Low-risk (local scope) but inconsistent with the rest of the codebase.

### S2. `largestRemainder` mutates the sorted copies' `floor` in place
`src/report/aggregate.ts:345-348` mutates `target.floor += 1` on elements of `sorted`, which share references with `entries`. Works, but it's the kind of aliasing the project's immutability rule exists to avoid. A small map/reduce over `sorted` returning a new array would be clearer.

### S3. `aggregate.ts:247` — `sinceIso` is computed as `new Date(now - opts.since).toISOString()` and passed as the `since` filter to `readDecisions`
This couples the aggregator to `readDecisions`'s lexicographic ISO comparison. That's correct for full ISO-8601 UTC timestamps with `Z`, but if anyone ever logs a timezone-offset variant (e.g., `+00:00`), the comparison silently misfires. Worth a one-line comment pinning the assumption, or a defensive `Date.parse` compare in the reader (out of scope here but flag it for the reader's owner).

### S4. Routing distribution uses `forwarded_model` — OK, but the docstring in `section-15-report-cli.md` still says `chosen_model`
The implementation (correctly) uses `forwarded_model` per the real schema. The section plan is stale. Either update the plan doc or leave a one-line comment at `aggregate.ts:257` explaining why `forwarded_model` is the right axis. Since this review specifically flags the schema-naming mismatch, a comment is sufficient.

### S5. `classifier_cost_usd` in "cost breakdown" is only associated with the bucket that served the request, not with the classifier model
Aggregation attributes classifier cost to whatever model/project the request ultimately routed to. For `--group-by model` this can be misleading — Haiku-classifier overhead shows up under Sonnet when Sonnet served the request. Not a bug per the plan, but worth documenting in the renderer header (e.g., `"With overhead (incl. classifier cost attributed to serving model)"`) so users don't misread the column.

---

## Nits

- `src/report/aggregate.ts:287` — `costBreakdown` sorts alphabetically; the routing distribution sorts by count desc. Consistent sort-by-count desc across both would read better.
- `src/report/duration.ts:394` — `RE` doesn't accept zero (`0d` is a valid "no window"). Probably intentional but worth a test either way.
- `src/report/tables.ts:474` — `widths[i] ?? 0` guards an impossible case; can be simplified.
- `tests/report/tables.test.ts:946` — "first N percentages" heuristic is fragile; if the cache-hit rate ever renders above the routing table, the test passes spuriously. Scope the regex to within the "Routing distribution" section.
- `tests/report/aggregate.test.ts:503` — `chosen_model` + `forwarded_model` are both set explicitly; consider a single helper constant to avoid drift if fixtures expand.
- `src/cli/report.ts:85-93` — three near-identical `stderr.write` + `return 2` blocks; a tiny `invalid(msg)` helper would read cleaner. Borderline YAGNI.

---

## Approval

**Block** pending B1 and B2. B1 is a correctness bug at the user-facing seam; B2 is a silent math hazard once real-world null-cost rows flow through. Both have straightforward fixes.
