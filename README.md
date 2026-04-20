# ccmux

A local, zero-telemetry routing proxy for Anthropic's API that picks the cheapest model that will still do the job.

[![CI](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ccmux)](https://www.npmjs.com/package/ccmux)
[![Docker](https://img.shields.io/badge/ghcr.io-ccmux-blue)](https://ghcr.io/mckruz/ccmux)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What ccmux does NOT do

- **No telemetry.** Zero outbound calls except to `api.anthropic.com`. No update checks, no analytics, no DNS lookups beyond the OS resolver.
- **No body modification.** Message content passes through byte-for-byte. ccmux only reads the request to extract routing signals.
- **Auth passthrough.** Your `x-api-key` header goes directly to Anthropic unchanged. ccmux is not an auth broker.

## Install

```bash
# npm (recommended)
npx ccmux

# global install
npm i -g ccmux

# standalone binary (Linux x64)
curl -fsSL https://github.com/MCKRUZ/claude-model-switcher/releases/latest/download/ccmux-linux-x64 -o ccmux
chmod +x ccmux

# Docker
docker run --rm -p 8787:8787 ghcr.io/mckruz/ccmux
```

Binaries available for: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `win-x64`.

Requires **Node.js >= 20** and an `ANTHROPIC_API_KEY` environment variable.

## Quickstart (60 seconds)

```bash
# 1. Scaffold config with a balanced cost/quality recipe
ccmux init --recipe balanced

# 2. Run Claude CLI through the proxy
ccmux run -- claude

# 3. Check routing decisions
ccmux report --since 1h
```

See [docs/quickstart.md](docs/quickstart.md) for a full walkthrough.

## How it works

ccmux is a Fastify HTTP reverse proxy that binds to `127.0.0.1:8787` and sits between your client (Claude CLI, SDK, etc.) and `api.anthropic.com`. Every `POST /v1/messages` request passes through a five-stage decision pipeline before being forwarded. All other API paths are passed through unchanged.

### Stage 1: Signal extraction

ccmux parses the request body (without modifying it) to extract routing signals:

| Signal | Source | Description |
|--------|--------|-------------|
| `planMode` | System prompt / beta headers | Whether the request is in plan mode |
| `messageCount` | `messages` array length | Conversation depth |
| `toolUseCount` | Tool-use content blocks | How many tools have been invoked |
| `estInputTokens` | tiktoken estimation | Approximate input token count |
| `fileRefCount` | File paths in content | Number of file references |
| `retryCount` | Retry headers + request hash tracking | How many times this request has been retried |
| `frustration` | User message analysis | Markers like "that's wrong", repeated corrections |
| `explicitModel` | `model` field in body | Whether the client specified a model preference |
| `projectPath` | Longest common prefix of tool-use file paths | Inferred project directory |
| `sessionDurationMs` | Time since session start | How long the session has been running |
| `betaFlags` | Beta headers | Active beta feature flags |

Each extractor is wrapped in try/catch — a single failing extractor degrades one signal field, not the entire request.

### Stage 2: Policy rules (first-match-wins)

Your YAML config defines an ordered list of rules. The engine evaluates them top-to-bottom against the extracted signals. The first rule whose `when` condition matches determines the model. Rules support `all`, `any`, and `not` composition over signal fields.

Example from the `balanced` recipe:

```yaml
rules:
  # Plan mode deserves Opus
  - id: plan-to-opus
    when: { planMode: true }
    then: { choice: opus }

  # Trivial turns: short, no tools, small context → Haiku
  - id: trivial-to-haiku
    when:
      all:
        - { messageCount: { lt: 5 } }
        - { toolUseCount: { eq: 0 } }
        - { estInputTokens: { lt: 2000 } }
    then: { choice: haiku }

  # Retries suggest the first tier couldn't cope
  - id: retry-escalate
    when: { retryCount: { gte: 2 } }
    then: { escalate: 1 }

  # Frustration signal → bump a tier
  - id: frustration-escalate
    when: { frustration: true }
    then: { escalate: 1 }
```

If no rule matches, the engine returns `abstain` and the classifier takes over.

### Stage 3: Classifier fallback (two-stage)

When policy abstains, a classifier picks the model:

1. **Heuristic classifier** (zero-latency, deterministic) — scores the request based on weighted factors:
   - Token count bands (0-500 → 0pts, 500-2k → 1pt, 2k-8k → 2pts, 8k+ → 3pts)
   - Tool breadth (0.5pts per unique tool, capped at 3pts)
   - Code fence count (0.3pts per fenced block, capped at 2pts)
   - File path references (0.4pts per ref, capped at 2pts)
   - Phrasing analysis (+1pt for imperative verbs like "write/build/refactor", -1pt for questions)
   
   Score bands: **< 3 → Haiku**, **3–6.5 → Sonnet**, **> 6.5 → Opus**. Confidence is derived from distance to band boundaries, clamped to [0.2, 0.85].

2. **Haiku classifier** (optional, ~800ms budget) — sends a lightweight classification prompt to Haiku itself. Races against a timeout; the heuristic result is used if Haiku doesn't respond in time.

The classifier with the highest confidence wins.

### Stage 4: Model splice and forward

ccmux splices the chosen model into the request and forwards it to `api.anthropic.com`. The request body is forwarded byte-for-byte unchanged. SSE streaming responses are passed through without buffering.

### Stage 5: Decision logging

Every routing decision is appended to `~/.config/ccmux/logs/decisions/YYYY-MM-DD.jsonl`. Each entry records: timestamp, extracted signals, matched rule (or classifier result), chosen model, confidence score, and cost estimate. Content is sanitized according to your `logging.content` mode (`hashed`, `full`, or `none`).

### Sticky model

To avoid jarring mid-conversation model switches, ccmux caches the chosen model per session (keyed by HMAC of session signals). Default TTL: 2 hours.

## Claude Code integration

When you run `ccmux run -- claude`, ccmux:

1. Loads your config from `~/.ccmux/config.yml`
2. Starts the proxy on `127.0.0.1` (with port fallback if the configured port is busy)
3. Waits for `/healthz` to confirm the proxy is ready
4. Spawns `claude` as a child process with these environment variables injected:
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` — redirects all API calls to the local proxy
   - `NO_PROXY=127.0.0.1,localhost` — prevents any system proxy from intercepting local traffic
   - `CCMUX_PROXY_TOKEN=<random>` — defense-in-depth token (not enforced on the proxy since Claude Code can't set custom outbound headers)
5. Forwards SIGINT/SIGTERM to the child process
6. On child exit, tears down the proxy and propagates the exit code

No modification to your Claude Code installation is required. Your `ANTHROPIC_API_KEY` flows through unchanged.

## Configuration

Config lives at `~/.ccmux/config.yml`. Key sections:

```yaml
port: 7879                    # Proxy listen port (fallback tries +1 through +20)
mode: live                    # 'live' (routes) or 'shadow' (logs decisions but doesn't change model)

rules: [...]                  # Policy rules (see above)

classifier:
  enabled: true               # Enable Haiku classifier fallback
  model: claude-haiku-4-5-20251001
  timeoutMs: 800              # Max time to wait for Haiku classification
  confidenceThresholds:
    haiku: 0.6                # Min confidence to accept Haiku classifier result
    heuristic: 0.4            # Min confidence to accept heuristic result

stickyModel:
  enabled: true               # Cache model choice per session
  sessionTtlMs: 7200000       # 2 hours

logging:
  content: hashed              # 'hashed' (privacy-safe), 'full', or 'none'
  rotation:
    strategy: daily            # 'daily', 'size', or 'none'
    keep: 30                   # Days/files to retain
    maxMb: 100                 # Max log size (for 'size' strategy)

dashboard:
  port: 8788                   # Dashboard UI port

security:
  requireProxyToken: false     # Require token header on proxy requests

pricing:                       # Per-model cost rates for decision log estimates
  claude-opus-4-7:     { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
  claude-sonnet-4-6:   { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 }
  claude-haiku-4-5-20251001: { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 }
```

Three built-in recipes are available via `ccmux init --recipe <name>`:

| Recipe | Strategy |
|--------|----------|
| `balanced` | Default. Opus for plan mode, Haiku for trivial turns, escalate on retries/frustration |
| `aggressive` | Maximum cost savings. Haiku by default, Sonnet for tools, Opus only for plan mode |
| `conservative` | Maximum quality. Opus by default, Sonnet for simple questions |

See [docs/config-reference.md](docs/config-reference.md) for every config key.

## CLI commands

| Command | Description |
|---------|-------------|
| `ccmux init [--recipe <name>]` | Scaffold `~/.ccmux/config.yml` with a recipe |
| `ccmux run -- <cmd> [args...]` | Start proxy, run command through it, tear down on exit |
| `ccmux start` | Start the proxy as a standalone server |
| `ccmux status` | Show proxy health, model availability, config validation |
| `ccmux report [--since <duration>] [--group-by model\|project] [--format ascii\|json]` | Summarize routing decisions from the decision log |
| `ccmux explain <request.json>` | Dry-run a JSON request through the routing pipeline |
| `ccmux dashboard` | Launch the analytics dashboard (React SPA on port 8788) |
| `ccmux tune` | Suggest policy changes based on decision log patterns |
| `ccmux version` | Show ccmux version |

See [docs/cli.md](docs/cli.md) for full flag reference.

## Architecture

```
Client (Claude CLI, SDK, etc.)
    │
    │  POST /v1/messages
    ▼
┌─────────────────────────────────┐
│         ccmux proxy             │
│    127.0.0.1:8787               │
│                                 │
│  1. Parse request body          │
│  2. Extract signals (tiktoken)  │
│  3. Evaluate policy rules       │
│  4. Classifier fallback         │
│  5. Splice model + forward      │
│  6. Stream response back        │
│  7. Log decision to JSONL       │
└─────────────────────────────────┘
    │
    │  POST /v1/messages
    ▼
api.anthropic.com
```

Key design decisions:

- **127.0.0.1 only** — refuses to bind to `0.0.0.0`. Local-only by design.
- **Streaming passthrough** — SSE events are forwarded byte-for-byte, never buffered.
- **Config hot-reload** — file watcher (chokidar) picks up config changes without restart.
- **Graceful degradation** — each signal extractor fails independently. A broken extractor logs a warning and falls back to a default value.
- **No HTTP/2** — H2 prior-knowledge connections are rejected at the connection level.

See [docs/architecture.md](docs/architecture.md) for the full design document.

## Project structure

```
src/
├── cli/            # CLI commands (init, run, start, status, report, explain, dashboard, tune)
├── classifier/     # Model selection: heuristic scorer + Haiku classifier + cache
├── config/         # YAML loader, schema types, validation, path resolution, hot-reload watcher
├── dashboard/      # Analytics dashboard: Fastify API + React SPA (recharts)
├── lifecycle/      # Proxy lifecycle: wrapper orchestrator, port fallback, token generation
├── logging/        # Pino logger factory, privacy-aware redaction
├── policy/         # Rule DSL types, first-match-wins evaluator, predicate matching, recipes
├── privacy/        # Auth header redaction, telemetry audit
├── proxy/          # Fastify server factory, hot-path handler, pass-through, health endpoint
├── signals/        # Signal extraction: plan mode, frustration, tokens, tools, files, sessions
└── types/          # Shared types (Result<T,E>, Anthropic request/response shapes)
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Quickstart](docs/quickstart.md) | First-run walkthrough |
| [CLI Reference](docs/cli.md) | All commands and flags |
| [Configuration](docs/config-reference.md) | Every config key explained |
| [Rule DSL](docs/rule-dsl.md) | Writing routing rules |
| [Recipes](docs/recipes.md) | Batteries-included policy presets |
| [Architecture](docs/architecture.md) | Proxy flow, classifier, decision log |
| [Privacy](docs/privacy.md) | Logging modes and zero-telemetry stance |
| [Threat Model](docs/threat-model.md) | Security scope and limitations |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |

## License

[MIT](LICENSE)
