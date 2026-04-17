# Code Review — section-03-config

**Verdict: Approve with minor fixes.** Tests pass, types are tight, forward-compat policy is correctly implemented. A few small correctness issues and one YAML-safety concern.

## Must-fix

**[HIGH] YAML loader accepts prototype-polluting / unsafe types**
`src/config/loader.ts:36` uses `yaml.load()` which supports the full YAML 1.1 spec including custom tags. For a config file under the user's own home dir this is low risk, but the spec says "hand-rolled validation" — prefer `yaml.load(contents, { schema: yaml.FAILSAFE_SCHEMA })` or at minimum `JSON_SCHEMA`. This also avoids surprises like `yes`/`no` becoming booleans under YAML 1.1. Minimum change: switch to `CORE_SCHEMA` (YAML 1.2 behavior) for predictability.

**[MED] Unknown-top-level JSON pointer uses empty base**
`src/config/validate.ts:297` calls `warnUnknown(raw, KNOWN_TOP, '', issues)`. Combined with `${base}/${k}` on line 71, this yields `/telemetry` — which matches the test, good. But for consistency with other paths that start at `/security`, `/classifier`, etc., consider documenting that `''` is the root base. Not a bug; just a readability foot-gun for future maintainers.

**[MED] `readRuleThen` leaks when `choice` is invalid**
`src/config/validate-rules.ts:46-47` returns `{ choice: '', rest: raw }` then `base.then = { ...rest, choice: '' }` at line 86. The resulting rule has empty `id` and empty `choice` but is still pushed into `out` on line 115. Since the validator still surfaces errors and the loader rejects on `errors.length > 0`, the bad rule never reaches callers — but `validateConfig()` alone (used in `schema.test.ts`) returns a `config` containing a malformed rule. Guard: skip pushing when `id.length === 0 || choice.length === 0`.

## Nice-to-have

- **validate.ts is 311 lines** — under the 400 cap but dense. Consider extracting section validators into a `sections/` subdir if section-04 adds more. Defer.
- **`PricingEntry` silently drops invalid entries** — emits an error; partial map only visible if caller ignores errors. Acceptable.
- **Rule `then` type** — consider discriminated approach in section-08.

## Coverage gaps

- No test for **`null` root** YAML (empty file parses to `null`). `validateConfig(null)` returns defaults.
- No test for **duplicate rule id** detection.
- No test for **`CCMUX_HOME` env override** in `resolvePaths`.
