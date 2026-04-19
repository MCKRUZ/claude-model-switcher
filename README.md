# ccmux

ccmux is a local, zero-telemetry routing proxy for Anthropic's API that picks the cheapest model that will still do the job.

[![CI](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ccmux)](https://www.npmjs.com/package/ccmux)
[![Docker](https://img.shields.io/badge/ghcr.io-ccmux-blue)](https://ghcr.io/mckruz/ccmux)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What ccmux does NOT do

- **No telemetry.** ccmux makes zero outbound calls except to `api.anthropic.com`. No auto-update checks, no background telemetry, no analytics.
- **No body modification.** Message content passes through byte-for-byte. ccmux only reads signals (token count, tool count, etc.) to make routing decisions.
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

ccmux sits between your client and `api.anthropic.com`. On each `/v1/messages` request it:

1. Extracts signals (token count, tool usage, plan mode, retry count, etc.)
2. Evaluates your policy rules (first-match-wins, `all`/`any`/`not` composition)
3. If no rule matches, runs a fast heuristic or Haiku-based classifier
4. Splices the chosen model into the request and forwards it
5. Logs the decision for later analysis

All of this happens locally on `127.0.0.1`. See [docs/architecture.md](docs/architecture.md).

## Documentation

| Guide | Description |
|-------|-------------|
| [Quickstart](docs/quickstart.md) | First-run walkthrough |
| [CLI Reference](docs/cli.md) | All commands and flags |
| [Configuration](docs/config-reference.md) | Every config key explained |
| [Rule DSL](docs/rule-dsl.md) | Writing routing rules |
| [Recipes](docs/recipes.md) | Batteries-included policy presets |
| [Privacy](docs/privacy.md) | Logging modes and zero-telemetry stance |
| [Architecture](docs/architecture.md) | Proxy flow, classifier, decision log |
| [Threat Model](docs/threat-model.md) | Security scope and limitations |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |

## License

[MIT](LICENSE)
