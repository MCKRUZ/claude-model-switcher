<!-- PROJECT_CONFIG
runtime: typescript-npm
test_command: npm test
END_PROJECT_CONFIG -->

<!-- SECTION_MANIFEST
section-01-repo-skeleton
section-02-logging-paths
section-03-config
section-04-proxy-phase0
section-05-cli-start-and-ports
section-06-config-watcher
section-07-signals
section-08-policy
section-09-sticky-model
section-10-wrapper
section-11-classifier-heuristic
section-12-classifier-haiku
section-13-decision-log
section-14-outcome-tagger
section-15-report-cli
section-16-tune
section-17-dashboard-server
section-18-dashboard-spa
section-19-init-and-recipes
section-20-explain
section-21-release-ci
section-22-docs
END_MANIFEST -->

# ccmux Implementation Sections Index

Derived from `claude-plan.md` §18 and `claude-plan-tdd.md`. Each section is a self-contained unit of work with its own tests (TDD stubs in the companion file). Implementation is TypeScript strict (Node 20+), Fastify, undici, Vitest.

## Dependency Graph

| Section | Depends On | Blocks | Parallelizable with |
|---------|------------|--------|---------------------|
| section-01-repo-skeleton | - | 02, 03 | - |
| section-02-logging-paths | 01 | 04, 13, 17 | 03 |
| section-03-config | 01 | 04, 06, 08, 11, 12 | 02 |
| section-04-proxy-phase0 | 02, 03 | 05, 06, 07 | - |
| section-05-cli-start-and-ports | 04 | 21 | 06, 07 |
| section-06-config-watcher | 03, 04 | 08 | 05, 07 |
| section-07-signals | 04 | 08 | 05, 06 |
| section-08-policy | 03, 06, 07 | 09, 19, 20 | - |
| section-09-sticky-model | 08 | 10, 11, 12, 13 | - |
| section-10-wrapper | 09 | 21 | 11, 12, 13 |
| section-11-classifier-heuristic | 03, 09 | 15 | 10, 12, 13 |
| section-12-classifier-haiku | 03, 09 | 15 | 10, 11, 13 |
| section-13-decision-log | 02, 09 | 14, 15, 16, 17 | 10, 11, 12 |
| section-14-outcome-tagger | 13 | 16 | 15, 17 |
| section-15-report-cli | 11, 12, 13 | 21 | 14, 16, 17 |
| section-16-tune | 13, 14 | 21 | 15, 17 |
| section-17-dashboard-server | 02, 13 | 18 | 14, 15, 16 |
| section-18-dashboard-spa | 17 | 21 | 19, 20 |
| section-19-init-and-recipes | 08 | 21 | 18, 20 |
| section-20-explain | 08 | 21 | 18, 19 |
| section-21-release-ci | 05, 10, 15, 16, 18, 19, 20 | 22 | - |
| section-22-docs | 21 | - | - |

## Execution Order (batched for parallel subagent runs)

Each batch is launched in parallel; all sections in a batch must complete before the next batch starts.

1. **Batch 1:** section-01-repo-skeleton
2. **Batch 2:** section-02-logging-paths, section-03-config (parallel)
3. **Batch 3:** section-04-proxy-phase0
4. **Batch 4:** section-05-cli-start-and-ports, section-06-config-watcher, section-07-signals (parallel)
5. **Batch 5:** section-08-policy
6. **Batch 6:** section-09-sticky-model
7. **Batch 7:** section-10-wrapper, section-11-classifier-heuristic, section-12-classifier-haiku, section-13-decision-log (parallel)
8. **Batch 8:** section-14-outcome-tagger, section-15-report-cli, section-17-dashboard-server (parallel)
9. **Batch 9:** section-16-tune, section-18-dashboard-spa, section-19-init-and-recipes, section-20-explain (parallel)
10. **Batch 10:** section-21-release-ci
11. **Batch 11:** section-22-docs

## Section Summaries

### section-01-repo-skeleton
Monorepo-free TypeScript project: `package.json`, `tsconfig.json` (strict), `vitest.config.ts`, `.eslintrc`, directory layout per plan §4 (`src/proxy`, `src/policy`, `src/classifier`, `src/feedback`, `src/dashboard`, `src/cli`, `src/config`, `src/signals`, `src/types`, `tests/`). Lint rules for 400-line / 50-line limits. No runtime code yet.

### section-02-logging-paths
pino logger factory, cross-platform XDG-style path helpers (`~/.config/ccmux/…`), log directory bootstrap, auth-header sanitizer. Used by every subsequent section.

### section-03-config
YAML config loader with permissive forward-compat (unknown top-level keys warn, not crash). Schema for rules, mode, log rotation, classifier pin, port override, recipes, pricing table. Result-style validation errors with JSON-pointer paths.

### section-04-proxy-phase0
Fastify server, `reply.hijack()` + `undici.dispatcher.stream()` hot path for `/v1/messages`. Exact hop-by-hop list (§6.3), `host` rewrite, `accept-encoding` drop, undici raw-header duplicate preservation. `/healthz`. Byte-for-byte golden-file SSE tests. No policy engine yet — identity passthrough.

### section-05-cli-start-and-ports
`ccmux start [--foreground]`, `ccmux status`, `ccmux version`. Sequential port bind with `EADDRINUSE` catch. Localhost-only bind. HTTP/2-prior-knowledge rejection.

### section-06-config-watcher
chokidar-based file watcher with 500ms debounce. Invalid YAML keeps previous config active and logs. Hot-swaps the rule set and pricing table atomically.

### section-07-signals
Signal extractors (plan-mode, message count, tools, token estimate, file/path count, retry count, frustration markers, explicit model hint, project path, session duration, beta headers). Tolerant of `content: string | ContentBlock[]`. Failing extractors degrade to `null`.

### section-08-policy
Rule engine: `all`/`any`/`not` composition, first-match-wins, `abstain` fallthrough. Ships three recipes (`frugal`, `balanced`, `opus-forward`). Validation of rule shapes at load time.

### section-09-sticky-model
In-memory `Map<sessionId, {model, createdAt, lastSeenAt, turnCount}>` with 2h TTL eviction. HMAC-salted session hashing (§7.2). Tier ordering (`haiku < sonnet < opus`) with custom-model tier mapping required. Asymmetric escalation enforcement.

### section-10-wrapper
`ccmux run -- <cmd>`: spawn child with `ANTHROPIC_BASE_URL`, `NO_PROXY=127.0.0.1`, optional `CCMUX_PROXY_TOKEN`, forwarded auth env. SIGINT/SIGTERM propagation, teardown on child exit, exit-code propagation.

### section-11-classifier-heuristic
Zero-latency local scorer: token counts, tool breadth, code-block density, imperative-vs-question detection, file-path count. Synchronous; pluggable via `Classifier` interface.

### section-12-classifier-haiku
Haiku-backed classifier via undici fetch. Outbound host allowlist (`api.anthropic.com/v1/messages` only). Auth-header forwarding from intercepted request. Prompt-cached on its own prompt. 800ms hard timeout → `null`. Races the heuristic in parallel.

### section-13-decision-log
JSONL writer with in-process byte counter, startup-only stat, configurable rotation + retention. Cost parser (`usage.*` fields including cache read/creation). Records the actual forwarded model, never the requested one.

### section-14-outcome-tagger
Tags sessions passively: continued, retried, frustration follow-up, abandoned. Runs asynchronously against the tail of the decision log.

### section-15-report-cli
`ccmux report [--since …] [--group-by …]`. ASCII tables for routing distribution, cost breakdown (with/without classifier overhead), cache-hit rate, latency percentiles.

### section-16-tune
Analyzes the decision log, surfaces weak rules, emits a unified diff against `config.yaml`. Never auto-edits. Exits 0 on no suggestions.

### section-17-dashboard-server
TypeScript HTTP server bound to `127.0.0.1`. `/api/decisions` (paginated, max 1000), `/metrics` Prometheus endpoint, pricing-table served from config. Reads from the decision log directory.

### section-18-dashboard-spa
Vite + React + Recharts SPA. Fully self-contained — no CDN, no remote fonts, no remote source maps. CI asserts zero outbound URLs in the built bundle.

### section-19-init-and-recipes
`ccmux init [--recipe …]` writes a starter `config.yaml` to `~/.config/ccmux/`. Recipes shipped as embedded YAML templates.

### section-20-explain
`ccmux explain <request.json>`: dry-run rule set against a fixture, print extracted signals + winning rule (or abstain → classifier).

### section-21-release-ci
GitHub Actions workflows for all four artifacts: `npx`/npm publish, `pkg` CJS binary build (Linux x64/arm64, macOS x64/arm64, Windows x64), `bun build --compile` fallback, Docker `ghcr.io/<owner>/ccmux:<tag>`. Smoke tests on every artifact per tag RC.

### section-22-docs
`README.md`, `docs/` with: quickstart, config reference, rule DSL guide, recipe cookbook, privacy modes, troubleshooting. Zero-telemetry and auth-passthrough stances documented prominently.
