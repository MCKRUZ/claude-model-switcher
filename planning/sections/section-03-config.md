# section-03-config

## Purpose

Implement the YAML configuration loader for ccmux with permissive forward-compatibility, Result-style validation errors (with JSON-pointer paths), and typed access to all configuration sections consumed by later stages (proxy, policy, classifier, decision log, dashboard, wrapper).

This section delivers the schema, loader, validator, and default-merge logic only. Hot-reload / file-watching is deferred to `section-06-config-watcher`. Rule-engine semantics live in `section-08-policy`. Pricing-table usage lives in `section-13-decision-log`.

## Dependencies

- **Depends on:** `section-01-repo-skeleton` (directory layout, `tsconfig.json` strict, vitest wiring).
- **Parallelizable with:** `section-02-logging-paths`.
- **Blocks:** `section-04-proxy-phase0`, `section-06-config-watcher`, `section-08-policy`, `section-11-classifier-heuristic`, `section-12-classifier-haiku`.

## Files to create

All paths are project-relative.

- `src/config/schema.ts` — TypeScript types + zod (or hand-rolled) validator describing every documented key.
- `src/config/loader.ts` — reads YAML from a given path, parses, validates, returns `Result<CcmuxConfig, ConfigError[]>`.
- `src/config/defaults.ts` — shipped default values (used to fill optional sections).
- `src/config/paths.ts` — resolves the default config path (`~/.config/ccmux/config.yaml`) cross-platform. If `section-02-logging-paths` has already landed a shared XDG helper, import it from there instead of duplicating.
- `src/config/index.ts` — public barrel: `loadConfig`, `CcmuxConfig`, `ConfigError`.
- `src/types/result.ts` — shared `Result<T, E>` type if not already created in section 01.
- `tests/config/loader.test.ts` — validation + forward-compat tests.
- `tests/config/schema.test.ts` — per-section schema tests.
- `tests/fixtures/config/` — golden YAML fixtures (`minimal.yaml`, `full.yaml`, `unknown-key.yaml`, `invalid-rule.yaml`, `bad-pricing.yaml`).

## Runtime dependencies to add

- `yaml` — parser (already listed as the decided format).
- `zod` (recommended) — schema with JSON-pointer-ish error paths. Any validator that yields path arrays is fine; avoid Joi.

## Canonical configuration reference

The loader must accept every documented key below. Unknown *top-level* keys emit a warning via the logger (from section-02) and do not fail the load. Unknown *nested* keys under a known section likewise warn, not crash.

```yaml
# ~/.config/ccmux/config.yaml

port: 8787
mode: live                      # or "shadow"

security:
  requireProxyToken: false      # proxy only accepts requests with x-ccmux-token when true

rules:
  - id: plan-mode-opus
    when: { planMode: true }
    then: { choice: opus }

classifier:
  enabled: true
  model: claude-haiku-4-5-20251001
  timeoutMs: 800
  confidenceThresholds:
    haiku: 0.6
    heuristic: 0.4

stickyModel:
  enabled: true
  sessionTtlMs: 7200000

modelTiers:                     # required for any custom modelId
  claude-opus-4-7: opus
  claude-sonnet-4-6: sonnet
  claude-haiku-4-5-20251001: haiku

logging:
  content: hashed               # hashed | full | none
  fsync: false
  rotation:
    strategy: daily             # daily | size | none
    keep: 30
    maxMb: 10

dashboard:
  port: 8788

pricing:
  claude-opus-4-7: { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
  # ... more models
```

## Schema rules

- `port`, `dashboard.port` — integers in `[1, 65535]`. Default port: `8787`, dashboard: `8788`.
- `mode` — literal `"live" | "shadow"`. Default `"live"`.
- `security.requireProxyToken` — boolean, default `false`.
- `rules` — array. Each rule must have `id: string` (unique within the file) and `then: { choice: "haiku" | "sonnet" | "opus" | "abstain" | string /* custom modelId */ }`. `when` is an arbitrary object — do NOT enforce rule-body shape here; full rule validation lives in `section-08-policy`. At load time only validate that `id`, `when` (object), and `then.choice` (string) exist. Optional `allowDowngrade: boolean` on the rule object.
- `classifier` — all fields optional; defaults `{ enabled: true, model: "claude-haiku-4-5-20251001", timeoutMs: 800, confidenceThresholds: { haiku: 0.6, heuristic: 0.4 } }`.
- `stickyModel` — optional; defaults `{ enabled: true, sessionTtlMs: 7_200_000 }`.
- `modelTiers` — `Record<string, "haiku" | "sonnet" | "opus">`. Empty by default. Consumers warn on unmapped custom modelIds.
- `logging.content` — `"hashed" | "full" | "none"`, default `"hashed"`.
- `logging.fsync` — boolean, default `false`.
- `logging.rotation.strategy` — `"daily" | "size" | "none"`, default `"daily"`. `keep` default `30`. `maxMb` default `10`.
- `pricing` — `Record<modelId, { input: number; output: number; cacheRead: number; cacheCreate: number }>`. Empty by default; cost math falls back to `null` when missing.

## Result + error shape

```ts
// src/types/result.ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

```ts
// src/config/schema.ts (excerpt)
export interface ConfigError {
  readonly path: string;   // JSON pointer, e.g. "/rules/0/then/choice"
  readonly message: string;
  readonly severity: "error" | "warning";
}
```

Loader returns `Result<CcmuxConfig, ConfigError[]>`. Warnings do NOT fail the load; they are returned alongside a successful `value` via a separate channel — suggested signature:

```ts
export interface LoadedConfig {
  readonly config: CcmuxConfig;
  readonly warnings: readonly ConfigError[];
}
export function loadConfig(path?: string): Promise<Result<LoadedConfig, ConfigError[]>>;
```

## Loader behavior

1. Resolve path. If `path` omitted, default to `~/.config/ccmux/config.yaml` (Linux/macOS) or `%APPDATA%\ccmux\config.yaml` (Windows) — use `os.homedir()` + `path.join`, never hardcode separators.
2. If the file does not exist: return `Result.ok({ config: defaults(), warnings: [] })`. (This supports "ccmux runs with no config" paths; `ccmux init` is the user-facing seeder, separate section.)
3. Read UTF-8, parse with `yaml` package. YAML parse error → `Result.fail([{ path: "/", message, severity: "error" }])`.
4. Run schema validation. Collect errors vs. warnings.
5. Merge parsed values over `defaults()` deeply (only for known fields — don't leak unknown keys into the typed config).
6. Return `LoadedConfig` with warnings array (unknown-top-level-key warnings live here).

## Forward-compat rule (critical)

- Unknown top-level keys: warning `{ path: "/<key>", message: "unknown top-level key (forward-compat)", severity: "warning" }`. Load still succeeds.
- Unknown nested keys inside a recognized section: same treatment.
- Type mismatches on known keys: error, load fails.
- Missing required keys (`rules[].id`, `rules[].then.choice`): error.

## Tests (FIRST — TDD)

All tests go under `tests/config/`. Keep bodies small; prefer fixtures over inline YAML strings for anything > ~5 lines.

### `tests/config/loader.test.ts`

- `loadConfig_missingFile_returnsDefaults` — no file at path → `ok` with default config and zero warnings.
- `loadConfig_minimalValid_returnsDefaultsMerged` — fixture `minimal.yaml` (just `port: 9000`) → port is `9000`, all other sections default.
- `loadConfig_fullExample_acceptsEveryDocumentedKey` — fixture mirrors the §13 canonical YAML above. All keys accepted, no warnings. Guards against docs drift.
- `loadConfig_unknownTopLevelKey_warnsButSucceeds` — fixture with `telemetry: { … }` at root → `ok`, warnings length 1, warning path `/telemetry`.
- `loadConfig_unknownNestedKey_warnsButSucceeds` — fixture with `classifier.futureFlag: true` → warning, not error.
- `loadConfig_invalidYaml_returnsError` — malformed YAML → `Result.fail` with single error at path `/`.
- `loadConfig_invalidRuleShape_pointsToBadPath` — fixture with a rule missing `then.choice` → error with `path === "/rules/0/then/choice"`.
- `loadConfig_invalidEnum_pointsToBadPath` — `mode: weird` → error path `/mode`.
- `loadConfig_crossPlatformPath_resolves` — stub `os.homedir()` and verify the default path resolves correctly on win32 vs posix (use `process.platform` mock or parametrize).
- `loadConfig_badPricing_pointsToModel` — fixture with `pricing.claude-opus-4-7.input: "oops"` → error path `/pricing/claude-opus-4-7/input`.

### `tests/config/schema.test.ts`

- `schema_portOutOfRange_fails` (0 and 70000 both).
- `schema_loggingContent_enumEnforced`.
- `schema_rotationStrategy_enumEnforced`.
- `schema_modelTiers_valueEnumEnforced`.
- `schema_stickyModel_ttlNonNegative`.
- `schema_rule_withOnlyIdAndThen_isValid` — confirms we don't over-validate `when` at this layer.

Test-naming convention is `MethodName_Scenario_ExpectedResult` (reuse globally). Vitest `describe` grouping by behavior (loader, forward-compat, schema) is fine.

## Implementation notes

- Keep `src/config/schema.ts` under 150 lines. If zod definitions blow that budget, split per-section (`schema/rules.ts`, `schema/logging.ts`, etc.) under `src/config/schema/` and re-export.
- JSON-pointer builder: walk the zod (or equivalent) issue `path: (string | number)[]` and join with `/`, prefixing with `/`. Root is `/`.
- Do NOT log directly from the loader. Return warnings; callers (CLI, proxy bootstrap) decide how to surface them. This keeps tests deterministic.
- No `console.log`. Lint rule from section 01 enforces this.
- The loader MUST be pure-async (no top-level IO at import time). Use `fs/promises.readFile`.
- `any` is forbidden except at the `yaml.parse` boundary with a `// anthropic-forward-compat: yaml returns unknown` comment, immediately narrowed by the validator.

## Out of scope for this section

- Hot-reload / file watching (section-06).
- Rule-body DSL validation beyond shape (section-08).
- Recipe templates (`src/policy/recipes/*.yaml`) and `ccmux init` (section-19).
- Writing a default config file to disk (section-19).
- Any usage of the loaded pricing table (section-13).

## Acceptance checklist

- [ ] `npm test tests/config` passes.
- [ ] `CcmuxConfig` exported from `src/config/index.ts` with readonly fields throughout.
- [ ] `loadConfig` returns `Result<LoadedConfig, ConfigError[]>` exactly as specified.
- [ ] Unknown top-level keys produce warnings, not errors.
- [ ] All validation errors carry a JSON-pointer-style `path`.
- [ ] CI matrix (linux, macos, windows) all green for config tests.
- [ ] No file exceeds 400 lines; no function exceeds 50 lines.
