# section-21-release-ci

GitHub Actions workflows that produce and smoke-test all four ccmux distribution artifacts (npm, standalone binary, bun-compile fallback, Docker) on every tag RC. This section ships release automation only; it does not modify runtime behavior.

## Dependencies

This section requires the following to exist before work starts:

- **section-05-cli-start-and-ports** — `ccmux start`, `ccmux status`, `ccmux version` commands (used by smoke tests).
- **section-10-wrapper** — `ccmux run -- <cmd>` wrapper (smoke tests exercise the wrapper path).
- **section-15-report-cli** — `ccmux report` (included in the CLI surface the npm tarball and binaries must expose).
- **section-16-tune** — `ccmux tune` (same).
- **section-18-dashboard-spa** — built SPA assets the Docker image and binary must embed; CI must assert zero outbound URLs in the built bundle.
- **section-19-init-and-recipes** — `ccmux init` (smoke-tested on each binary).
- **section-20-explain** — `ccmux explain` (same).

Downstream, **section-22-docs** documents the artifacts produced here.

## Background

From the plan:

- Node 20+ runtime, TypeScript strict, Fastify + undici.
- The npm package is **dual-export**: ESM main for `npx ccmux` / library use, CJS for `pkg` input.
- Binary builds use `pkg` with **CommonJS output** (pkg has sharp edges on ESM). Documented fallback: `bun build --compile`, toggled via a flag on `scripts/build-binaries.ts`.
- Docker base: `node:20-alpine`, multi-stage.
- Four artifacts ship per tag:
  1. **npm** — `npm publish`, dual export.
  2. **Standalone binaries** — linux/macos/win × x64/arm64 via `pkg` (CJS entry).
  3. **bun-compile fallback** — same matrix, invoked when `pkg` fails.
  4. **Docker** — `ghcr.io/<owner>/ccmux:<tag>`, multi-stage, alpine.
- **Smoke test every artifact in CI.** If any binary fails its smoke test, the release fails.
- Cross-cutting CI checks enforced on every release:
  - SPA bundle has zero outbound URLs except `localhost:*` (scan `src/dashboard/frontend/dist/`).
  - Zero outbound network from the backend to any host other than `api.anthropic.com` (network-stub assertion).
  - No auto-update check on startup.
  - `CCMUX_RECORD=1` required for fixture recording, default off.
  - Config loader works on linux, macos, windows (matrix).

## Files to Create

- `.github/workflows/ci.yml` — PR + push CI: lint, typecheck, `vitest run`, OS matrix (ubuntu-latest, macos-latest, windows-latest), Node 20.
- `.github/workflows/release.yml` — tag-triggered (`v*.*.*`): builds all four artifacts, runs smoke tests, publishes on success.
- `scripts/build-binaries.ts` — wrapper that invokes `pkg` by default, falls back to `bun build --compile` when `--bun` is passed or `pkg` exits non-zero. Produces artifacts under `dist/binaries/<os>-<arch>/ccmux[.exe]`. Runs the binary smoke test inline.
- `scripts/smoke/healthz.ts` — starts a ccmux binary on a free port, awaits `/healthz` → 200, sends SIGINT, asserts clean exit. Reused across all four artifacts.
- `scripts/smoke/sse-roundtrip.ts` — boots a mock upstream (serves a canned SSE stream), runs the artifact with `ANTHROPIC_BASE_URL` pointed at it, issues a `/v1/messages` request, asserts byte-for-byte SSE output matches the golden file. (The golden file is owned by section-04; this script only consumes it.)
- `scripts/smoke/outbound-stub.ts` — runs under a network namespace / DNS stub that blackholes anything except `api.anthropic.com`; boots the artifact and asserts it makes zero outbound requests on startup (no telemetry, no auto-update).
- `scripts/check-spa-bundle.ts` — greps `src/dashboard/frontend/dist/**` for `https?://` references, allowlists `localhost`, `127.0.0.1`, and the schema placeholders used by Recharts. Non-zero exit on any unexpected URL.
- `Dockerfile` — multi-stage (builder on `node:20-alpine` → final on `node:20-alpine`), copies built JS + SPA dist, exposes `CMD ["node", "dist/cli/index.js", "start", "--foreground"]`. Non-root user.
- `.dockerignore` — excludes `tests/`, `node_modules/`, `.github/`, source maps.
- `package.json` — add `bin.ccmux`, `exports` map with both `import` (ESM) and `require` (CJS), `files` allowlist, `prepublishOnly` runs the full build + smoke.

## Tests FIRST

All tests live under `tests/release/` (vitest). Where "smoke" is called out, it runs as a CI job step, not under vitest — but each smoke script has a unit-test stub that validates its argument parsing and exit-code handling.

### 12.1 Distribution artifact smoke (CI-only, scripted)

- Test: `pkg` CJS bundle smoke — packaged binary starts, responds to `/healthz`, exits cleanly on SIGINT. Runs on every tag RC.
- Test: `bun build --compile` fallback produces a working binary; same smoke passes.
- Test: `npx ccmux@latest --version` works against the packed tarball (uses `npm pack` output, then `npx <tarball> --version` in a scratch dir).
- Test: Docker image smoke — `docker run --rm ghcr.io/<owner>/ccmux:<tag> --version` prints a semver and exits 0.
- Test: all four artifacts are produced on a tagged release — workflow asserts the presence of each in the GitHub Release assets before marking the job successful.

### 12.2 SPA bundle network-purity (vitest, runs in `ci.yml` too)

- Test: `scripts/check-spa-bundle.ts` over the built `dist/` directory exits 0 when all URLs are local.
- Test: `scripts/check-spa-bundle.ts` exits non-zero when a stray `https://cdn.example.com` reference is injected into a fixture bundle.

### 12.3 Backend network purity

- Test: on startup, the proxy makes zero outbound requests to hosts other than `api.anthropic.com`. Use an outbound-request stub (undici `MockAgent` installed globally) that fails the test on any non-allowlisted host. Assert zero invocations for a cold start + 5s idle.
- Test: no auto-update check — grep the built JS and the running process's outbound calls for any reference to `github.com/releases`, `registry.npmjs.org`, or `update`; none may appear.

### 12.4 Cross-OS config resolution

- Test: config file at `~/.config/ccmux/config.yaml` is loaded on linux, macos, and windows CI runners. On Windows, the XDG-style helper resolves to `%APPDATA%\ccmux\config.yaml` and the test confirms the loader finds it. (Path helpers come from section-02; this is a CI matrix assertion, not new logic.)

### 12.5 Build-binaries script

- Test: `scripts/build-binaries.ts` invokes `pkg` with the CJS entry by default.
- Test: with `--bun`, it invokes `bun build --compile` instead.
- Test: on `pkg` non-zero exit, it automatically retries with the bun fallback and emits a warning log line.
- Test: output path layout is `dist/binaries/<os>-<arch>/ccmux[.exe]` for all five targets (linux-x64, linux-arm64, macos-x64, macos-arm64, win-x64).

### 12.6 Release workflow assertions (meta-tests)

- Test: parsing `.github/workflows/release.yml` yields exactly four artifact jobs: `npm`, `binary`, `docker`, `bun-fallback`. (Guards against someone silently removing one.)
- Test: every binary job step includes a `smoke` sub-step that runs both `healthz.ts` and `sse-roundtrip.ts`.
- Test: the workflow's `on` trigger matches `v*.*.*` tags only; pushes to branches do not trigger a release.
- Test: the workflow's `permissions` block grants `contents: write` + `packages: write` and nothing else.

## Implementation Notes

### `ci.yml` (non-release CI)

Triggers: `push` to any branch, `pull_request`. Matrix: `{os: [ubuntu-latest, macos-latest, windows-latest], node: [20]}`. Steps: checkout → setup-node → `npm ci` → `npm run lint` → `npm run typecheck` → `npm test` → `npm run build` → `npm run check:spa` (invokes `scripts/check-spa-bundle.ts` against the dashboard build). No publishing, no tagging.

### `release.yml` (tag-triggered)

Triggered only on tags matching `v*.*.*`. Jobs:

1. **build** — single ubuntu-latest runner, `npm ci` + `npm run build` + `npm pack`. Uploads the tarball and `dist/` as workflow artifacts for downstream jobs.
2. **npm** — needs `build`; runs `npm publish` using `NODE_AUTH_TOKEN` (org-scoped, not `GITHUB_TOKEN`). Publishes public.
3. **binary** — matrix over `{os: [ubuntu-latest, macos-latest, windows-latest], arch: [x64, arm64]}` (skip `win-arm64` for v1); downloads the `dist/` artifact; runs `node scripts/build-binaries.ts --target <os>-<arch>`; runs `scripts/smoke/healthz.ts` and `scripts/smoke/sse-roundtrip.ts` against the produced binary; uploads the binary to the GitHub Release.
4. **bun-fallback** — same matrix, runs only if the `binary` job fails for that matrix cell (`if: failure()` + job dependency). Uses `bun build --compile`.
5. **docker** — needs `build`; buildx multi-arch (`linux/amd64`, `linux/arm64`); pushes to `ghcr.io/${{ github.repository_owner }}/ccmux:${{ github.ref_name }}` and `:latest`. Runs `docker run --rm <image> --version` as the smoke step before pushing the final tag.
6. **assert-artifacts** — needs all of the above; queries the GitHub Release API and fails unless the tarball, five binaries (or four if win-arm64 is excluded), and Docker tags are all present.

Every job uses `timeout-minutes: 20` and pins action SHAs (not floating tags) for supply-chain hygiene.

### `scripts/build-binaries.ts`

```ts
// Stub surface only; implementation is small.
interface BuildOptions {
  readonly target: `${'linux' | 'macos' | 'win'}-${'x64' | 'arm64'}`;
  readonly useBun?: boolean;
  readonly outDir: string;
}

/** Builds a standalone ccmux binary and runs inline smoke tests against it. */
export async function buildBinary(opts: BuildOptions): Promise<Result<{ path: string }>>;
```

On `pkg` failure, log the stderr, then retry with bun if `useBun !== false`. The smoke tests run in-process against the produced binary path.

### `scripts/smoke/*.ts`

Each is a standalone Node CLI (`node scripts/smoke/healthz.ts <binary-path>`). Exit code 0 = pass, non-zero = fail with a one-line reason on stderr. They must not depend on any dev dependency not already shipped with the runtime package, so they can also run inside the Docker image.

### `Dockerfile` sketch

```
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup -S ccmux && adduser -S -G ccmux ccmux
COPY --from=build --chown=ccmux:ccmux /app/dist ./dist
COPY --from=build --chown=ccmux:ccmux /app/package.json ./
USER ccmux
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start", "--foreground"]
```

### `package.json` exports map

```jsonc
{
  "bin": { "ccmux": "./dist/cli/index.js" },
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.cjs",
      "types": "./dist/types/index.d.ts"
    }
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

The CJS build is what `pkg` consumes via `scripts/build-binaries.ts`.

## Acceptance Criteria

- Tag `v0.1.0-rc.1` produces all four artifacts, each passing smoke.
- Any smoke failure aborts the release and leaves no partial assets on the Release page (use `softprops/action-gh-release` with `draft: true` until `assert-artifacts` promotes it).
- `npm audit --production` and `npm list --depth=0` outputs are captured in the release run logs.
- Zero outbound URLs in the SPA bundle (enforced by `scripts/check-spa-bundle.ts`).
- Zero outbound backend requests on cold start to anything other than `api.anthropic.com` (enforced by `scripts/smoke/outbound-stub.ts`).
- All workflow actions pinned to commit SHAs.
