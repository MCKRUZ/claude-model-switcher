# section-20-explain

## Purpose

Implement `ccmux explain <request.json>` — a CLI dry-run diagnostic command that loads a JSON request fixture, runs the full signal extraction + rule engine + (optionally) classifier pipeline entirely offline, and prints a human-readable report of which rule fired, the extracted signals, sticky state, and the final routing decision. The command never makes network calls and never writes to the decision log.

This is a developer/operator tool for answering "why did ccmux route this request the way it did?" — essential for debugging rule configurations and iterating on recipes.

## Dependencies

- **section-08-policy** (blocker): provides the rule engine, `all`/`any`/`not` composition, first-match-wins semantics, and the `abstain` fallthrough that this command must faithfully replay.
- Transitively requires signal extractors (section-07), config loader (section-03), and logger (section-02) — all already available once section-08 is complete.

## Files to Create

- `src/cli/explain.ts` — command handler
- `tests/cli/explain.test.ts` — Vitest specs
- `tests/fixtures/explain/` — sample request JSON fixtures (valid small, valid with tools, malformed)

Wire the command into the CLI entrypoint alongside `start`, `init`, `status`, `report`, etc. (the entrypoint dispatch table lives in `src/cli/index.ts` established by earlier sections — add one more case for `explain`).

## Behavior Specification

### Input

- Positional argument: path to a JSON file containing an Anthropic Messages API request body (same shape the proxy would receive on `/v1/messages`).
- Optional flag `--classifier`: when set, run the classifier layer (heuristic-only in explain; never call Haiku from this command — network is forbidden here) and show its suggested model alongside policy output.
- Optional flag `--config <path>`: override the default config location. Defaults to the standard `~/.config/ccmux/config.yaml` resolved via the path helpers from section-02.

### Processing

1. Load and parse config via the section-03 loader. Surface validation errors with their JSON-pointer paths and exit non-zero.
2. Read `<request.json>` from disk. If the file is missing or not valid JSON, print a clear error to stderr and exit non-zero.
3. Run the signal extractors (section-07) against the parsed request. Extractors that fail degrade to `null` — surface the `null`s in the output, do not crash.
4. Invoke the rule engine (section-08) with `(signals, request, config.rules)`. Capture either the winning rule (id + resolved target model) or `abstain`.
5. If `--classifier` was provided and the policy abstained, invoke only the heuristic classifier (section-11 when available; if this section runs before 11, guard with a feature check and print "classifier not available in this build"). Never call the Haiku classifier from explain.
6. Compute the sticky state that *would* apply: show what the session hash would be (using the HMAC salt logic from section-09) and note "no prior sticky state in dry-run" — explain is stateless and does not read or write the sticky map.

### Output

Stable, human-readable, deterministic (no timestamps, no random IDs in the rendered output). Intended for diffing across config changes. Structure:

```
Request:          <file path>
Config:           <resolved config path>
Mode:             <active | shadow>

Signals
-------
plan_mode                 false
message_count             7
tool_count                2
tools                     [Read, Grep]
token_estimate            4821
file_path_count           3
retry_count               0
frustration_markers       0
explicit_model_hint       null
project_path              /home/user/proj
session_duration_sec      142
beta_headers              []

Policy
------
Evaluated rules: 4
Winning rule:    rule id="code-heavy-to-opus"  →  claude-opus-4-5
  matched:       all(tool_count >= 2, token_estimate >= 4000)

Classifier (--classifier)
-------------------------
(not invoked — policy matched)

Final decision:  claude-opus-4-5 via rule "code-heavy-to-opus"
```

When the policy abstains, the "Winning rule" line reads `abstain → classifier` and the Classifier section shows either the heuristic's suggested model or "classifier not available". When `--classifier` is not supplied and policy abstains, the final decision line reads `abstain (no classifier requested)`.

### Exit Codes

- `0` — successfully rendered a report (including abstain cases).
- Non-zero — malformed request JSON, missing file, or config validation failure. Stderr carries the human-readable reason.

## Tests (Vitest)

Extract test intent from `claude-plan-tdd.md` §7.7. Use stubs only — full bodies are unnecessary beyond what's needed to pin the contract.

```ts
// tests/cli/explain.test.ts

describe('ccmux explain', () => {
  it('prints the winning rule id for a matching fixture', async () => {
    // Arrange: config with a rule that matches a known fixture.
    // Act: run explain on the fixture.
    // Assert: stdout contains the rule id and the resolved target model.
  });

  it('prints "abstain → classifier" when no rule matches', async () => {
    // Fixture request with signals that match no configured rule.
  });

  it('renders extracted signals in a stable human-readable table', async () => {
    // Snapshot test against a checked-in fixture; output must be deterministic
    // (no timestamps, no random ids).
  });

  it('exits non-zero when the request JSON is malformed', async () => {
    // Fixture is invalid JSON; expect non-zero exit and a stderr message.
  });

  it('exits non-zero when the request file does not exist', async () => {
    // Pass a bogus path; expect ENOENT-style error surfaced cleanly.
  });

  it('never performs network I/O', async () => {
    // Spy on undici / global fetch; assert zero calls across all paths,
    // including --classifier.
  });

  it('does not write to the decision log', async () => {
    // Spy on the log writer (section-13 — inject a mock writer);
    // assert zero writes.
  });

  it('honors --classifier by invoking only the heuristic', async () => {
    // Configure an abstaining rule set, pass --classifier, assert
    // heuristic classifier was consulted and Haiku classifier was NOT.
  });
});
```

Fixtures live in `tests/fixtures/explain/`:

- `valid-minimal.json` — small request, no tools.
- `valid-with-tools.json` — multi-turn with a tool_use block to exercise tolerant `content: string | ContentBlock[]` handling.
- `malformed.json` — not valid JSON (e.g. trailing comma) to drive the error-path test.

## Implementation Notes

- Keep `explain.ts` under 150 lines. Rendering is the bulk — factor the signal table renderer into a small pure function (`renderSignalTable(signals): string`) so it is snapshot-testable in isolation.
- The command is a thin composition of existing modules. Do not re-implement signal extraction or rule evaluation here — import and reuse. If you find yourself duplicating logic from section-07 or section-08, stop and import instead.
- Deterministic output is a feature, not a convenience. No `Date.now()`, no `process.pid`, no `randomUUID` in the rendered string.
- Localhost-only posture is automatically satisfied because explain performs no I/O beyond `fs.readFile`. Add an assertion in tests (spy on `undici` / `fetch`) to prove it.
- The command must work before `ccmux start` has ever been run — no running proxy, no prior sticky state, no running dashboard required.

## Done When

- `ccmux explain tests/fixtures/explain/valid-minimal.json` prints a deterministic report and exits 0.
- `ccmux explain tests/fixtures/explain/malformed.json` prints a clear error to stderr and exits non-zero.
- All tests in `tests/cli/explain.test.ts` pass.
- The command makes zero network calls and zero decision-log writes, proven by test spies.
- Snapshot for the signal table is stable across repeated runs.
