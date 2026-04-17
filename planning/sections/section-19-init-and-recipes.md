# section-19-init-and-recipes

## Purpose

Ship the `ccmux init [--recipe <name>]` CLI command and the three embedded YAML recipe templates (`frugal`, `balanced`, `opus-forward`). `init` scaffolds a starter `config.yaml` in the user's config directory so a fresh install has a working, opinionated routing policy with zero hand-editing.

## Dependencies

- **section-08-policy** (blocks this section): rule engine, recipe loading, and the `Policy` DSL must be in place so that the YAML recipes we ship are guaranteed-parseable by the same loader a user will run at startup.
- **section-03-config** (transitively): the config loader / schema defines what a valid `config.yaml` looks like; the shipped recipes must validate cleanly against it.
- **section-02-logging-paths** (transitively): the XDG-style path helpers (`~/.config/ccmux/…`) determine where `init` writes.

Do **not** re-implement any of the above here — only consume them.

## Scope

1. Three recipe YAML files, embedded as build-time assets.
2. An `init` CLI subcommand wired into the commander router.
3. Tests that each recipe loads cleanly and that the three fixture-set behavioral claims hold.

Out of scope: classifier wiring, sticky-model behavior, report/dashboard output. `init` is a pure file-writing command.

## Files to Create

| Path | Purpose |
|------|---------|
| `src/policy/recipes/frugal.yaml` | Aggressive Haiku, permissive escalation. |
| `src/policy/recipes/balanced.yaml` | Default for `ccmux init`. Plan→Opus, tiny→Haiku, retries→escalate, otherwise sticky-sonnet. |
| `src/policy/recipes/opus-forward.yaml` | Default Opus, only trivially-short → Haiku. |
| `src/cli/init.ts` | `ccmux init` command implementation. |
| `tests/cli/init.test.ts` | Unit tests for the CLI command. |
| `tests/policy/recipes.test.ts` | Behavioral tests for each shipped recipe against a fixture request set. |
| `tests/fixtures/recipes/mixed-requests.json` | Fixture set of ~20 representative `/v1/messages` bodies used to measure routing distribution per recipe. |

## Files to Modify

- `src/cli/main.ts` — register the `init` subcommand on the commander router.
- `package.json` — ensure recipe YAML files under `src/policy/recipes/` ship in the `files` array (or are included by the build step) so they're present in the published npm package and the `pkg`/`bun` binaries.

## Behavior Spec

### `ccmux init [--recipe <name>] [--force]`

- `<name>` ∈ `{frugal, balanced, opus-forward}`. Default: `balanced`.
- Unknown recipe name → exit code 2, stderr message listing valid names.
- Target path: `~/.config/ccmux/config.yaml` (resolved via the path helper from section-02). On Windows this resolves under `%APPDATA%\ccmux\` per the same helper — do not hardcode POSIX paths.
- If the target directory does not exist, create it with `recursive: true`.
- If the target file already exists and `--force` is NOT passed: exit code 1 with a message that points the user at `--force`. Do not overwrite silently.
- If `--force` is passed: overwrite.
- On success: print the absolute path written to stdout, exit 0.
- The file contents are a byte-for-byte copy of the embedded recipe YAML (including its leading header comment — see Recipe Format). Do not templatize or string-interpolate; these are static assets.

### Recipe Format

Each recipe YAML must:
- Begin with a comment header identifying the recipe name and a one-sentence description.
- Be parseable by the config loader from section-03 with zero warnings.
- Only use rule DSL features defined in section-08 (`all` / `any` / `not`, `choice`, `escalate`, `allowDowngrade`, first-match-wins, `abstain` fallthrough).
- Include a `modelTiers` section if any custom model id is referenced (none of the three shipped recipes need this — they should stick to the canonical `haiku`/`sonnet`/`opus` family aliases).
- Set `mode: active` (not `shadow`) by default.

Concrete routing intent per recipe (implementer chooses exact rule text; the behavioral tests below are the contract):

- **frugal**: sticky default `haiku`; escalate to `sonnet` on tool-use or code-block density; escalate to `opus` on plan-mode OR retry-count ≥ 2.
- **balanced**: sticky default `sonnet`; plan-mode → `opus`; trivially-short single-turn message (heuristic: ≤ 40 tokens, no tools, no file refs) → `haiku`; retry-count ≥ 1 → `escalate: 1`.
- **opus-forward**: sticky default `opus`; trivially-short single-turn AND no tools → `haiku`; everything else abstains (falls through to sticky-opus).

## Tests

Write tests first. All test names use the global convention (`describe` blocks per area, `it('should …')` strings).

### `tests/cli/init.test.ts`

Stubs (bodies to be filled with the minimum assertions needed):

```ts
describe('ccmux init', () => {
  it('should write balanced recipe by default to the resolved config path');
  it('should write the named recipe when --recipe is passed');
  it('should exit non-zero with a helpful message on an unknown recipe name');
  it('should refuse to overwrite an existing config without --force');
  it('should overwrite when --force is passed');
  it('should create the target directory if missing');
  it('should produce output that the config loader parses without errors');
});
```

Use a tmp-dir fixture for the target path; do not touch the real `~/.config`. Override the path helper via DI or an env var (`CCMUX_CONFIG_HOME`) — whichever convention section-02 established. Do not introduce a new override mechanism here.

### `tests/policy/recipes.test.ts`

This is the section-7.5 TDD contract from the plan:

```ts
describe('shipped recipes', () => {
  it('should all parse cleanly via the config loader (no errors, no warnings)');

  describe('balanced', () => {
    it('should route ≥30% of a mixed fixture set to Haiku');
  });

  describe('opus-forward', () => {
    it('should route ≥60% of non-trivial fixtures to Opus');
  });

  describe('frugal', () => {
    it('should default to Haiku on a minimal single-turn fixture');
    it('should escalate to Opus when plan-mode is detected');
  });
});
```

The "mixed fixture set" lives at `tests/fixtures/recipes/mixed-requests.json` and must contain a realistic spread: a handful of plan-mode requests, a handful of trivially-short completions, a handful with heavy tool use, at least one retry/frustration case, and several "typical" coding prompts. "Non-trivial" for the opus-forward test means: any fixture that is NOT "trivially-short single-turn AND no tools". Implementer sizes the set so the thresholds are meaningful (≥ 20 entries is reasonable).

Run each recipe through the Policy engine (from section-08) with the signal extractor (from section-07) against every fixture; tally the tier chosen per fixture; assert the proportion.

## Implementation Notes

- **Embedding YAML assets:** since recipes ship both as npm files and inside the `pkg`/`bun --compile` binaries, resolve them via `path.join(__dirname, 'recipes', '<name>.yaml')` relative to the compiled `src/cli/init.ts` location, and ensure the build step copies `src/policy/recipes/*.yaml` into the distributed `dist/` tree. Verify this in CI (section-21 will add the smoke test; your job here is just to make it work locally with `npm test` and `node dist/cli/main.js init`).
- **No templating.** The recipe files are literal. Users can edit after `init`; `ccmux` never rewrites them.
- **Keep `init.ts` small.** File count beats line count. Target < 80 lines.
- **Exit codes:** 0 success, 1 refused-overwrite, 2 bad args. Don't throw exceptions out of the CLI entry; catch and map to exit codes.
- **No network, no telemetry.** `init` is purely local filesystem work.

## Done Criteria

- `npm test` green, including the recipe behavioral thresholds.
- `ccmux init --recipe frugal` and siblings each write a file that a subsequent `ccmux start` would accept without warnings.
- The three YAML files exist under `src/policy/recipes/` and are included in the npm `files` manifest.
- `ccmux init --help` lists the three valid recipe names.
