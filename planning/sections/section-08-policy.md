# section-08-policy — Rule Engine & Recipes

## Scope

Implement the YAML-driven rule engine that runs over extracted request signals to produce a routing decision. This section covers the DSL evaluator, the rule loader/validator, and the three shipped recipe files. It does **not** cover sticky-model policy (section-09), signal extraction (section-07), or `ccmux explain` (section-20).

## Dependencies (already in place)

- **section-03-config** — YAML config loader with permissive forward-compat; Result-style validation errors with JSON-pointer paths; config schema already accepts unknown top-level keys with a warning.
- **section-06-config-watcher** — chokidar watcher (500ms debounce) that atomically hot-swaps the rule set; on invalid YAML keeps previous config and logs.
- **section-07-signals** — `Signals` frozen object with `null` for any extractor that threw. Actual shipped fields: `planMode`, `messageCount`, `tools`, `toolUseCount`, `estInputTokens`, `fileRefCount`, `retryCount`, `frustration`, `explicitModel`, `projectPath`, `sessionDurationMs`, `betaFlags`, `sessionId`, `requestHash`. (Earlier spec drafts used `toolNames`/`filePathCount`; renamed to `tools`/`fileRefCount` in section-07. `signals-schema.ts` allow-list matches the shipped names.)

This section publishes a pure function — `evaluate(rules, signals) -> PolicyResult` — that section-09 will consume.

## Files to Create

```
src/policy/dsl.ts              # types: Rule, Condition, RuleResult, PolicyResult
src/policy/evaluate.ts         # pure rule evaluator (first-match-wins)
src/policy/predicates.ts       # leaf predicate matcher {lt,lte,eq,gte,gt,ne,in,matches}
src/policy/load.ts             # YAML → validated Rule[]; emits pointer-annotated errors
src/policy/signals-schema.ts   # allow-list of known signal names (validation)
src/policy/recipes/frugal.yaml
src/policy/recipes/balanced.yaml
src/policy/recipes/opus-forward.yaml
src/policy/index.ts            # barrel

tests/policy/dsl.test.ts
tests/policy/evaluate.test.ts
tests/policy/predicates.test.ts
tests/policy/load.test.ts
tests/policy/recipes.test.ts
tests/policy/fixtures/         # small request+signals fixtures for recipe routing tests
```

Each file stays under 150 lines; keep predicates and evaluate in separate files to honor the cohesion rule.

## Types (stubs)

```ts
// src/policy/dsl.ts
export type Tier = 'haiku' | 'sonnet' | 'opus';
export type ModelChoice = Tier | { modelId: string };

export type LeafOp =
  | { lt: number } | { lte: number }
  | { gt: number } | { gte: number }
  | { eq: unknown } | { ne: unknown }
  | { in: readonly unknown[] }
  | { matches: string };            // RegExp source, compiled once at load time

export type Leaf = boolean | LeafOp;          // `true` means "signal is truthy"
export type FieldCond = Record<string, Leaf>; // e.g. { planMode: true }

export type Condition =
  | FieldCond
  | { all: readonly Condition[] }
  | { any: readonly Condition[] }
  | { not: Condition };

export type RuleResult =
  | { choice: ModelChoice; allowDowngrade?: boolean }
  | { escalate: number }           // relative tier bump; clamped at 'opus'
  | { abstain: true };

export interface Rule {
  readonly id: string;             // unique within rules[]
  readonly when: Condition;
  readonly then: RuleResult;
}

export type PolicyResult =
  | { kind: 'matched'; ruleId: string; result: Exclude<RuleResult, { abstain: true }> }
  | { kind: 'abstain' };           // no rule fired or the matched rule was explicit abstain
```

## Evaluator Semantics (non-negotiable)

1. **First-match-wins.** `evaluate` iterates `rules` in declaration order. The first rule whose `when` evaluates truthy returns its `then`. If that `then` is `{ abstain: true }`, the engine **continues** to the next rule (abstain is fall-through, not a verdict).
2. **Null signals never match.** If a leaf compares against a signal value of `null` or `undefined`, the leaf is `false`. `null == null` is `false`. `not` of a null-leaf is **also `false`** (null poisons both polarities — documented). `all`/`any` treat their null-leaf children as `false` normally.
3. **`escalate: N` is relative.** The evaluator returns the raw `{ escalate: N }`; resolving it against current tier is section-09's job.
4. **Boolean leaf shorthand.** `{ planMode: true }` means "signal is strictly `true`". `{ planMode: false }` means "signal is strictly `false`" (not "falsy", not "null").
5. **`matches`** compiles regex at load time, not per request. Anchor behavior is the author's responsibility (no implicit `^$`).
6. **Unknown signal names fail at load time**, not at evaluate time. See `signals-schema.ts`.

## Loader & Validation

`load.ts` parses `config.yaml`'s `rules:` array and returns `Result<readonly Rule[], ValidationErrors>`. Errors carry JSON-pointer paths per section-03 conventions (e.g. `/rules/2/when/all/1/messageCount`).

Reject at load time:
- Duplicate `id` values.
- Unknown top-level condition keys (anything other than `all`/`any`/`not` at a node that isn't a `FieldCond`).
- `FieldCond` referencing a signal name not in `signals-schema.ts`'s allow-list. (Extend the allow-list when signals change — typos must not silently never-match.)
- Leaf ops with wrong value type (e.g., `{ lt: "2000" }`).
- `matches` whose regex does not compile.
- `then.choice.modelId` referring to a model not present in `config.modelTiers` when `choice` is a `{ modelId }` form — because section-09 cannot tier-compare otherwise. (Bare-tier choices skip this check.)
- `escalate` that is not a positive integer.

Permissive forward-compat is a **config-loader** stance (unknown top-level YAML keys warn), NOT a rule-DSL stance — the DSL is strict, because typos in a rule are silent failures otherwise.

## Shipped Recipes

All three live under `src/policy/recipes/` and are copied by `ccmux init --recipe <name>` (section-19). They must be parseable by the section-03 config loader and produce non-empty `Rule[]`.

- **`frugal.yaml`** — aggressive Haiku. Rules: plan-mode → Opus; any request with `messageCount < 6` AND `toolUseCount == 0` → Haiku; `frustration` → `escalate: 1`; otherwise abstain (sticky/classifier decides, which will tend Haiku given recipe intent).
- **`balanced.yaml`** — the `ccmux init` default. Rules: plan-mode → Opus; `all: [messageCount < 5, toolUseCount == 0, estInputTokens < 2000]` → Haiku; `retryCount >= 2` → `escalate: 1`; `frustration: true` → `escalate: 1`; otherwise abstain (downstream sticky → Sonnet). (Threshold widened from the draft `< 3` to `< 5` to match the canonical fixture-set routing intent — `tests/policy/fixtures/mixed.json` asserts ≥30% haiku for balanced.)
- **`opus-forward.yaml`** — default Opus. Rules: `all: [messageCount < 2, estInputTokens < 500, toolUseCount == 0]` → Haiku; everything else → `choice: opus`.

Keep each recipe ≤ 40 lines of YAML. Include a `# Recipe: <name>` header comment and one-line rationale per rule.

## Tests (TDD — write these first)

Tests live under `tests/policy/`. Use real YAML strings and real `Signals` objects — no mocks. Vitest.

### `predicates.test.ts`
- `lt / lte / gt / gte / eq / ne` against numbers and strings where meaningful.
- `in` with primitive arrays.
- `matches` compiles regex once; regex is applied to string signals only (non-string → `false`).
- Boolean leaf shorthand: `true` matches only `true`, `false` matches only `false`.
- Null signal against every leaf op returns `false`.

### `dsl.test.ts`
- `all` over mixed-truth leaves — short-circuits, returns correct truthy/falsy.
- `any` over mixed-truth leaves — short-circuits on first truthy.
- `not` inverts; but `not` wrapping a null-leaf returns `false` (documented null-poison).
- Deeply nested composition (`all` containing `any` containing `not`) evaluates correctly against a single fixture.

### `evaluate.test.ts`
- First-match-wins: two rules both truthy, only the first's `then` is returned with its `id`.
- `abstain` fall-through: rule 1 matches with `{abstain: true}`, rule 2 matches with `{choice: haiku}` → result is rule 2.
- No rule matches → `{ kind: 'abstain' }`.
- `escalate: N` passes through untouched (no tier math in this section).
- Null signals do not fire rules that reference them (e.g., `{planMode: true}` with `planMode: null` → no match).

### `load.test.ts`
- Valid minimal YAML → `Result.ok`.
- Duplicate rule `id` → validation error, pointer identifies the second occurrence.
- Unknown signal name → validation error with pointer `/rules/<i>/when/...`.
- Malformed leaf (`{lt: "x"}`) → validation error.
- Unparseable `matches` regex → validation error.
- `choice: { modelId: "custom-x" }` with no `modelTiers["custom-x"]` → validation error.
- Unknown top-level YAML keys pass through (permissive config-level) but unknown keys **inside** a rule are rejected.

### `recipes.test.ts`
- All three recipe files load cleanly via the section-03 loader.
- Provide ~20 synthesized `Signals` fixtures (`tests/policy/fixtures/mixed.json`) spanning plan-mode, tiny-request, tool-heavy, frustrated, long-context cases.
- `balanced` routes ≥30% of the mixed set to Haiku (directly via a rule, not via abstain).
- `opus-forward` routes ≥60% of non-trivial fixtures (i.e., not matched by its Haiku rule) to Opus.
- `frugal` emits Haiku for every fixture with `messageCount < 6 && toolUseCount == 0`.
- Every recipe's rules all pass `load.ts` strict validation (no duplicate ids, all signals in allow-list).

The recipe-ratio tests use the evaluator's output only — they do not invoke sticky or classifier paths.

## Implementation Notes (post-build)

- Files shipped exactly as listed in **Files to Create** above. Biggest file: `src/policy/load.ts` (~300 lines).
- `evaluate.ts` includes a defensive throw in `evalCondition`: composite nodes with a sibling field leaf (e.g., `{ all: [...], messageCount: true }`) crash instead of silently dropping the leaf. Protects the in-memory rule path that section-09 introduces.
- `load.ts` rejects unknown keys inside `{ modelId }` choice objects for consistency with other composite/leaf rejections.
- Tests: 54 assertions across `predicates`, `dsl`, `evaluate`, `load`, and `recipes` — all green. Recipe ratio tests lean on `tests/policy/fixtures/mixed.json` (20 synthesized signal sets).
- `src/config/schema.ts` relaxed `CcmuxRule.then` from `{ choice: string; ... }` to `Readonly<Record<string, unknown>>` so config-level validation admits `choice | escalate | abstain` rule variants.
- `src/config/validate-rules.ts` now accepts all three `then` variants while preserving the legacy `/rules/0/then/choice` error path (when `then` has none of the known keys) for the section-03 fixture `invalid-rule.yaml`.
- Deleted empty skeleton files not listed in plan: `src/policy/conditions.ts`, `engine.ts`, `tiers.ts`.

## Notes for the Implementer

- `evaluate` is a pure function. No logging, no I/O, no `Date.now()`. Section-09 composes it with sticky state and the decision log writer.
- Freeze returned `PolicyResult` objects (`Object.freeze`) — downstream mutates nothing.
- Do not import anything from `src/sticky/`, `src/classifier/`, or `src/proxy/` here. Keep the policy module leaf-level.
- Follow coding-style: `IReadOnlyList`-equivalents (`readonly` arrays), init-only object shapes, one exported class/function per file, no `console.log`, file ≤ 400 lines, functions ≤ 50 lines.
- This section unblocks sections 09, 19, 20.
