# Section 03 Code Review — Interview & Decisions

## User decisions

1. **YAML schema:** User chose YAML 1.2 (CORE_SCHEMA). Avoids `yes`/`no` booleans and octal quirks.

## Auto-fixes (apply without asking — low-risk, obvious wins)

2. **Rule leak on invalid shape:** In `validate-rules.ts:validateRules`, skip pushing rules whose `id` or `then.choice` is empty. Errors are still surfaced; the malformed rule no longer leaks into `config.rules` when a caller inspects `validateConfig()` output independent of the loader's error short-circuit.
3. **Coverage gap — null root YAML:** Add test that `validateConfig(null)` returns defaults and empty errors/warnings.
4. **Coverage gap — duplicate rule id:** Add test asserting the collector emits an error at `/rules/1/id` when two rules share an id.
5. **Coverage gap — `CCMUX_HOME` env override:** Add test that `resolvePaths({ CCMUX_HOME: '/x' }, 'linux')` resolves `configFile` under `/x`.

## Let-go

- **"Empty-base JSON pointer" readability note** — behavior is correct; path `/telemetry` matches the documented contract. No code change.
- **validate.ts density (311 lines)** — under the 400-line cap. Revisit if section-04 adds more section validators.
- **PricingEntry partial-map concern** — errors are always surfaced; loader rejects. No change.
- **Rule `then` type tightening** — deferred to section-08 where the rule DSL is fully fleshed out.
