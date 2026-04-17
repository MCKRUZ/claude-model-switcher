# section-01-repo-skeleton

## Purpose

Bootstrap the `ccmux` repository as a single-package TypeScript project (not a monorepo). This section produces the project scaffold only: `package.json`, `tsconfig.json` (strict), `vitest.config.ts`, ESLint config with custom size rules, the full `src/` directory tree, the `tests/` directory tree, and the `scripts/` directory. **No runtime code is added in this section** — only empty directories (with `.gitkeep` where needed) and config files.

Subsequent sections (02 onward) fill in code files within this skeleton.

## Dependencies

None. This is the root of the dependency graph. Blocks sections 02 and 03.

## Background Context

- Runtime target: **Node 20+**, TypeScript strict mode, ESM + CJS dual-export via build.
- Test framework: **Vitest**.
- Linter: **ESLint** (TypeScript). Must enforce a **400-line cap per `src/` file** and a **50-line cap per function** as lint rules (not merely documentation).
- CLI arg parser: `commander` (declared as dep, not used yet).
- Fastify, undici, pino, chokidar, js-yaml, react, vite, recharts — declared as deps/devDeps, but NOT imported anywhere yet.
- Binary strategy later: `pkg` (CJS) with `bun build --compile` fallback. This section only needs to ensure the TypeScript build config is compatible with both.

## Tests (write first)

All tests go under `tests/lint/`. Only two test cases are required in this section; everything else is validated by the lint command itself.

File: `tests/lint/size-limits.test.ts`

```ts
import { describe, it, expect } from 'vitest';
// Stubs only — implementer fleshes out fixture files and spawns the ESLint API
// programmatically against them.

describe('repo lint — file size cap', () => {
  it('rejects a new src/ file above 400 lines', async () => {
    // Arrange: write a 401-line fixture into a tmp dir configured as src/
    // Act: invoke ESLint API with the repo config
    // Assert: at least one error with rule id matching `max-lines` (or the
    //         local custom rule id) and file path equal to the fixture.
    expect.fail('implement');
  });

  it('rejects a new function above 50 lines', async () => {
    // Arrange: write a fixture with a single 51-line function body
    // Act: invoke ESLint API with the repo config
    // Assert: at least one error with rule id matching
    //         `max-lines-per-function` and line count 51.
    expect.fail('implement');
  });
});
```

These two tests correspond to the TDD stubs from §4 of the plan:
- *repository lint check rejects a new `src/` file above 400 lines*
- *repository lint check rejects a new function above 50 lines*

Additionally, add a CI script invocation so `npm test` runs both Vitest and `eslint .` — the lint failure itself is also a test signal.

## Files to Create

### Root

1. `package.json`
   - `"name": "ccmux"`, `"type": "module"`, `"engines": { "node": ">=20" }`.
   - Scripts: `build` (tsc), `test` (`vitest run`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `test:all` (runs lint + typecheck + vitest).
   - Dependencies (declared, not yet used): `fastify`, `undici`, `pino`, `pino-pretty`, `commander`, `js-yaml`, `chokidar`.
   - DevDependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `@types/node`, `@types/js-yaml`.
   - Pin major versions only per global supply-chain rule.

2. `tsconfig.json`
   - `"strict": true`, `"noImplicitAny": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
   - `"target": "ES2022"`, `"module": "ES2022"`, `"moduleResolution": "bundler"`.
   - `"rootDir": "src"`, `"outDir": "dist"`, `"declaration": true`, `"sourceMap": true`.
   - `"types": ["node", "vitest/globals"]`.

3. `vitest.config.ts`
   - `environment: 'node'`, `globals: true`.
   - `include: ['tests/**/*.test.ts']`.
   - Coverage provider `v8`, threshold 80% on `src/` (global rule).

4. `.eslintrc.cjs` (CJS to work without extra config)
   - Parser: `@typescript-eslint/parser`, `project: './tsconfig.json'`.
   - Rules (all **error**-level):
     - `max-lines`: `{ max: 400, skipBlankLines: true, skipComments: true }` scoped to `src/**/*.ts`.
     - `max-lines-per-function`: `{ max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }`.
     - `max-depth`: `4` (global nesting cap).
     - `no-console`: `error` (use the logger from section-02 instead).
     - `@typescript-eslint/no-floating-promises`: `error`.
     - `@typescript-eslint/no-explicit-any`: `error`.
   - Overrides: `tests/**/*.ts` relaxes `max-lines-per-function` (set to 200) since AAA test bodies can be long.

5. `.eslintignore`
   - `dist/`, `node_modules/`, `coverage/`, `src/dashboard/frontend/` (SPA has its own config later).

6. `.gitignore`
   - `node_modules/`, `dist/`, `coverage/`, `*.log`, `.env*`, `.DS_Store`.

7. `README.md` — one-paragraph placeholder ("Full docs land in section-22").

8. `LICENSE` — MIT template (or project-preferred). Placeholder acceptable.

9. `Dockerfile` — empty placeholder comment file; real contents land in section-21.

### `src/` skeleton (empty files or `.gitkeep`)

Create every directory from the plan. Each directory gets a `.gitkeep` unless a stub file is listed. **Do not add any implementation** — just empty modules with a top-of-file comment `// Populated in section-NN`.

```
src/
├── index.ts                         # export {} — populated in section-22
├── cli/           {main,run,start,init,status,explain,report,dashboard,tune,version}.ts
├── proxy/         {server,hot-path,pass-through,body-splice,headers,upstream,abort,errors,token,reject-h2}.ts
├── signals/       {extract,plan-mode,frustration,tokens,session,canonical,types}.ts
├── policy/        {engine,dsl,conditions,tiers}.ts
│   └── recipes/   # directory only; YAML lands in section-19
├── classifier/    {index,haiku,heuristic,cache,types}.ts
├── sticky/        {store,policy}.ts
├── config/        {schema,load,watch,paths,defaults}.ts
├── decisions/     {log,rotate,outcome,cost,types}.ts
├── tune/          {analyze,suggest,diff}.ts
├── dashboard/     {server,api,metrics}.ts
│   └── frontend/  # .gitkeep only — SPA scaffolded in section-18
├── report/        tables.ts
├── lifecycle/     {ports,wrapper,signals}.ts
├── logging/       logger.ts
├── privacy/       redact.ts
└── types/         anthropic.ts
```

Each stub file contains exactly:

```ts
// Populated in section-NN. Do not import.
export {};
```

Use the correct section number per the index manifest (e.g. `src/proxy/server.ts` → section-04, `src/logging/logger.ts` → section-02).

### `tests/` skeleton

```
tests/
├── fixtures/        .gitkeep
├── replay-server.ts # populated in section-04
├── proxy/           .gitkeep
├── policy/          .gitkeep
├── classifier/      .gitkeep
├── decisions/       .gitkeep
├── cli/             .gitkeep
├── dashboard/       .gitkeep
├── e2e/             .gitkeep
├── live/            .gitkeep        # CCMUX_LIVE=1 only
├── perf/            .gitkeep
└── lint/
    └── size-limits.test.ts          # see Tests section above
```

### `scripts/`

```
scripts/
├── record.ts              # stub: export {} — populated alongside section-04 fixtures
└── build-binaries.ts      # stub: export {} — populated in section-21
```

### `.github/workflows/`

Create the directory with a `.gitkeep` only. The three workflows (`ci.yml`, `release.yml`, `perf.yml`) are authored in section-21.

## Verification Checklist (implementer runs before marking done)

1. `npm install` completes with no `ERESOLVE` or peer-dep errors.
2. `npm run typecheck` succeeds (all stub files compile).
3. `npm run lint` succeeds on the empty skeleton.
4. `npm test` runs Vitest and executes the two `size-limits.test.ts` cases. Both should be implemented against the ESLint JS API and pass (they assert violations against in-memory fixtures, not against real `src/` files).
5. Adding a throwaway 401-line file under `src/` and running `npm run lint` produces a `max-lines` error. Delete the file afterward.
6. Adding a throwaway 51-line function and running `npm run lint` produces a `max-lines-per-function` error. Delete afterward.
7. No file in `src/` exceeds the 400-line limit (trivially true — all are empty stubs).
8. No runtime dependency is imported anywhere in `src/` yet (grep confirms).

## Out of Scope

- Any runtime logic (proxy, policy, classifier, logging, CLI commands) — handled by later sections.
- GitHub Actions workflow contents — section-21.
- SPA scaffold inside `src/dashboard/frontend/` — section-18.
- Docker image — section-21.
- Recipe YAML files under `src/policy/recipes/` — section-19.
- `README.md` and `docs/` content — section-22.

---

## Actual Implementation Notes (post-build)

Deviations from and additions to the original plan, made during implementation:

1. **Added `tsconfig.eslint.json`** — a widened companion tsconfig (`rootDir: "."`, `noEmit: true`, include covers `src/`, `tests/`, `scripts/`). Required because the main `tsconfig.json` sets `rootDir: "src"` (correct for build output) but ESLint's type-aware rules need a project that includes the test and script files too. The `typecheck` script now runs `tsc --noEmit && tsc -p tsconfig.eslint.json --noEmit` so that tests and scripts are also typechecked in CI.
2. **Added `@types/eslint` (devDep, pinned to `^8.56.0`).** ESLint v8 does not ship its own types, so `import { ESLint } from 'eslint'` in `tests/lint/size-limits.test.ts` needs this. Pinned to the v8 major to match `eslint@^8.57.0`; the v9 types are flat-config only and are not API-compatible with v8.
3. **ESLint extends list trimmed.** Dropped `plugin:@typescript-eslint/recommended-requiring-type-checking` (which was not spec-required) because it flagged the ESLint API surface as unsafe inside the test fixture. The spec-required rule `@typescript-eslint/no-floating-promises` is still enabled explicitly and still works because `parserOptions.project` is configured.
4. **Added stricter tsconfig flags beyond spec:** `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`. Matches the project-global coding-style rules.
5. **`src/dashboard/frontend/` is lint-ignored** via both `.eslintignore` and the `ignorePatterns` field in `.eslintrc.cjs` (belt-and-braces). The SPA's own lint config lands in section-18.
6. **Stub file section-tags** were assigned per the index dependency graph (e.g. `src/config/watch.ts` → section-06; `src/decisions/outcome.ts` → section-14). These are informational comments only; subsequent sections may re-home files as needed.
7. **Verification run (all passing):** `npm install` (348 pkgs + 48 type pkgs), `npm run typecheck` (both tsconfigs), `npm run lint`, `npm test` (2/2 size-limits cases).

Code review artifacts: `planning/implementation/code_review/section-01-*.md`.
