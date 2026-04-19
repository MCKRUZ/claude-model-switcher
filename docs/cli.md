# CLI Reference

All ccmux commands. Run `ccmux <command> --help` for details.

## ccmux start

Start the proxy server.

```
ccmux start [--foreground] [--port <n>]
```

| Flag | Description |
|------|-------------|
| `--foreground` | Block on SIGINT instead of daemonizing; skip PID file |
| `--port <n>` | Override the port from config (default: 8787) |

In foreground mode, the proxy logs to stderr and exits on SIGINT/SIGTERM. Without `--foreground`, it writes a PID file to `~/.config/ccmux/state/ccmux.pid`.

## ccmux run

Start the proxy and run a child command against it.

```
ccmux run -- <cmd> [args...]
```

Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` in the child's environment. The proxy shuts down when the child exits.

## ccmux status

Report proxy status.

```
ccmux status
```

Reads the PID file and pings `/healthz`. Reports: running/stopped, port, uptime, mode.

## ccmux version

Print ccmux version and exit.

```
ccmux version
```

## ccmux init

Scaffold a config file from a recipe.

```
ccmux init [--recipe <name>] [--force]
```

| Flag | Description |
|------|-------------|
| `--recipe <name>` | Recipe to use: `frugal`, `balanced`, `opus-forward` (default: `balanced`) |
| `--force` | Overwrite existing config |

Creates `~/.config/ccmux/config.yaml`. See [Recipes](recipes.md).

## ccmux report

Summarize the decision log.

```
ccmux report [--since <duration>] [--group-by <model|project>] [--format <ascii|json>]
```

| Flag | Description |
|------|-------------|
| `--since <duration>` | Time window: `1h`, `24h`, `7d`, etc. |
| `--group-by` | Group results by `model` or `project` |
| `--format` | Output format: `ascii` (table) or `json` |

## ccmux tune

Suggest policy-rule changes based on decision history.

```
ccmux tune [--since <duration>] [--log-dir <path>] [--config <path>]
```

Analyzes the decision log and prints suggested rule additions or threshold adjustments.

## ccmux explain

Dry-run a request through the routing pipeline.

```
ccmux explain <request-json> [--config <path>] [--classifier]
```

| Flag | Description |
|------|-------------|
| `--config <path>` | Config file to use (default: auto-resolved) |
| `--classifier` | Also run the heuristic classifier if policy abstains |

Prints: matched rule, chosen model, extracted signals, confidence score.

## Dashboard

The dashboard server module (`src/dashboard/`) provides a REST API and React SPA for viewing routing decisions, cost breakdown, and session history. It listens on `127.0.0.1:8788` by default (configurable via `dashboard.port`). The dashboard is available programmatically via `buildServer()` from `src/dashboard/index.ts`.
