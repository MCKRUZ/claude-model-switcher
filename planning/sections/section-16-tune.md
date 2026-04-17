# section-16-tune

## Goal

Implement `ccmux tune`: an offline analyzer that reads the decision log + outcomes sidecar, detects weak policy rules, and emits a **unified diff** against `config.yaml`. It never auto-edits the file. It exits `0` even when there is nothing to suggest.

This closes the feedback loop described in the plan's three-layer decision system (Policy → Classifier → Feedback).

## Dependencies

- **section-13-decision-log** — provides `decisions.jsonl` entries (schema below) and the JSONL reader.
- **section-14-outcome-tagger** — provides the `outcomes.jsonl` sidecar keyed by `request_hash` with tags `continued | retried | frustration_next_turn | abandoned`.
- **section-02-logging-paths** — provides the path helpers that resolve the log directory (`~/.config/ccmux/logs/`) and the `config.yaml` path (`~/.config/ccmux/config.yaml`).

Do **not** reimplement any of these — import them.

## Inputs the analyzer consumes

Each decision-log record (from §9.1 of the plan) contains:

```json
{
  "timestamp": "...",
  "session_id": "...",
  "request_hash": "...",
  "extracted_signals": { ... },
  "policy_result": { "rule_id": "short-simple-haiku" } | { "abstain": true },
  "classifier_result": { "source": "haiku" | "heuristic", ... } | null,
  "sticky_hit": true | false,
  "chosen_model": "...",
  "chosen_by": "policy" | "classifier" | "fallback" | "sticky" | "explicit" | "shadow",
  "forwarded_model": "...",
  "upstream_latency_ms": ...,
  "usage": { ... } | null,
  "cost_estimate_usd": ... | null,
  "mode": "live" | "shadow"
}
```

Each outcome record: `{ request_hash, tag }`.

Outcomes are joined to decisions by `request_hash`. Missing outcomes are treated as "no signal" (not as a failure).

## Files to create

```
src/tune/
  analyze.ts    # stream decisions + outcomes, aggregate per-rule stats
  suggest.ts    # turn per-rule stats into concrete rule-change proposals
  diff.ts       # render proposals as a unified diff against config.yaml

src/cli/
  tune.ts       # CLI wiring: `ccmux tune [--since <iso>] [--log-dir <path>] [--config <path>]`
```

Wire `tune.ts` into the existing CLI dispatcher (alongside `report.ts`, `explain.ts`, etc.). The command-line flags mirror `ccmux report` where they overlap.

## Behavior

### `analyze.ts`

Stream `decisions.jsonl` line-by-line (do **not** load the whole file). Build a `Map<rule_id, RuleStats>` where `RuleStats` tracks:

- `fires` — how many decisions invoked this rule
- `outcomeCounts` — counts per outcome tag, including `unknown`
- `costSum`, `costCount` — for average cost
- `latencySum`, `latencyCount` — for average upstream latency
- `chosenModels` — `Map<model, count>` — which models this rule actually routed to

Skip records where `policy_result.abstain === true` (those fall through to the classifier and belong to a different analysis). Also skip `mode === "shadow"` records — they did not influence user-visible routing.

Join outcomes by `request_hash`. Use a streaming second pass or an in-memory `Map<request_hash, tag>` bounded to the `--since` window.

### `suggest.ts`

A rule is flagged as **weak** when all of:

1. `fires >= MIN_FIRES` (default `20`) — avoid noise on low sample size.
2. `(frustration_next_turn + retried) / fires >= WEAK_THRESHOLD` (default `0.5`).

For each weak rule, emit a `Suggestion`:

- `ruleId`
- `kind`: `"escalate-target"` — current routed tier looks too low given outcomes (most common case).
- `currentTarget` — most common `chosen_model` under this rule.
- `proposedTarget` — one tier up in `haiku < sonnet < opus` ordering (use the same tier table that §7.2 uses; do not redefine it).
- `rationale` — human-readable one-liner including fire count, frustration%, and average cost.

Thresholds live in `src/tune/suggest.ts` as named exports so tests can override them. **Do not** expose them as CLI flags in this section — YAGNI.

If no rule crosses the thresholds, return an empty suggestion list.

### `diff.ts`

Read `config.yaml` as raw text. For each suggestion, locate the matching rule block by `id:` key and produce a targeted change to the `target:` / `model:` field of that rule. Render a unified diff (standard `---`/`+++`/`@@` format) using a small utility — either a tiny hand-rolled line-diff against the located block, or the `diff` npm package if already in the dependency tree from another section. Do **not** add a new dependency just for this.

Never write to the file. Never rename, reorder, or re-emit the whole YAML — only the minimal hunk around each changed line. Preserve original indentation, comments, and trailing whitespace in unchanged context lines.

When there are zero suggestions, print nothing to stdout, print a one-line status to stderr (`"ccmux tune: no suggestions"`), and exit `0`.

### `cli/tune.ts`

```ts
// signature only — implementer fills in
export async function runTune(argv: {
  since?: string;         // ISO timestamp, default: 7 days ago
  logDir?: string;        // override; defaults to resolved log path
  config?: string;        // override; defaults to ~/.config/ccmux/config.yaml
}): Promise<number>;      // process exit code
```

Exit codes:

- `0` — ran successfully (whether or not suggestions were produced)
- `1` — IO failure (log dir missing, config.yaml unreadable)
- `2` — invalid `--since` flag

The unified diff, if any, goes to **stdout** so it can be piped into `patch` or `git apply --check`. Status/progress messages go to **stderr**.

## Tests (write FIRST, TDD)

Place under `tests/tune/`. Use Vitest. Fixtures under `tests/tune/fixtures/`: at minimum one `decisions.jsonl`, one `outcomes.jsonl`, one `config.yaml`.

Required tests (from `claude-plan-tdd.md §9.5`):

1. **Weak-rule detection** — given a log file where rule `R` fired on 100 turns with 80% `frustration_next_turn` follow-ups, `analyze` + `suggest` surfaces `R` as weak with the expected `proposedTarget` one tier above its current routed tier.
2. **Unified-diff output, no in-place edit** — running `runTune` against a fixture config.yaml prints a valid unified diff to stdout and leaves the file byte-identical on disk. Assert both: diff header lines present (`--- `, `+++ `, `@@`), and `fs.readFileSync` before/after checksum matches.
3. **Zero suggestions → exit 0** — with a log where every rule has clean outcomes, `runTune` resolves to `0`, stdout is empty, stderr contains the no-suggestions message.

Additional edge-case tests worth adding (keep minimal):

4. **Sample-size floor** — a rule with `fires = 5` and 100% frustration is **not** flagged (below `MIN_FIRES`).
5. **Abstain and shadow records are ignored** by the analyzer.
6. **Missing outcomes** — decisions with no matching `request_hash` in outcomes are counted in `fires` but only under `unknown` — they never inflate the frustration ratio.

Use stub fixtures; do not fully specify rule-engine internals. Import real `analyze` / `suggest` / `diff` functions. Mock nothing except the filesystem when convenient (prefer real tmp dirs via `os.tmpdir()` + `fs.mkdtempSync`).

## Non-goals for this section

- No auto-applying diffs. Ever.
- No learning/ML — this is pure descriptive statistics.
- No new CLI flags beyond `--since`, `--log-dir`, `--config`.
- No integration with the dashboard SPA (section-18 owns any visualization).
- No streaming from a live proxy — this is strictly offline against on-disk logs.

## File-size budget

Each of `analyze.ts`, `suggest.ts`, `diff.ts`, `cli/tune.ts` should stay under 150 lines. If `diff.ts` threatens to grow past that because of YAML hunk location logic, split the "find rule block by id" helper into `src/tune/locate.ts`.
