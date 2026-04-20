# ccmux Usage Guide

## Quick Start

```bash
# Install globally
npm i -g ccmux

# Scaffold a config with the balanced recipe
ccmux init --recipe balanced

# Run Claude CLI through the proxy
ccmux run -- claude

# Check what happened
ccmux report --since 1h
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `ccmux start [--foreground] [--port N]` | Start the proxy server |
| `ccmux run -- <cmd> [args...]` | Start proxy + run child command |
| `ccmux status` | Check proxy status (PID, port, uptime) |
| `ccmux version` | Print version |
| `ccmux init [--recipe name] [--force]` | Scaffold config from recipe |
| `ccmux report [--since dur] [--group-by model\|project] [--format ascii\|json]` | Summarize decision log |
| `ccmux tune [--since dur]` | Suggest rule improvements |
| `ccmux explain <json> [--config path] [--classifier]` | Dry-run routing pipeline |

## Configuration

Config lives at `~/.config/ccmux/config.yaml`. Key sections:

- **port** — proxy listen port (default: 8787)
- **mode** — `live` (route) or `shadow` (log-only passthrough)
- **rules** — first-match-wins policy rules using `all`/`any`/`not` composition
- **classifier** — Haiku-based fallback when no rule matches (800ms timeout)
- **stickyModel** — cache model choice per session (2h TTL)
- **logging.content** — `hashed` (default), `full`, or `none`

## Policy Recipes

Three built-in presets via `ccmux init --recipe <name>`:

- **balanced** — Haiku for trivial, Opus for planning, Sonnet for everything else (40-60% savings)
- **frugal** — Haiku by default, Opus only for planning (60-80% savings)
- **opus-forward** — Opus by default, Haiku only for trivial openers (5-15% savings)

## Example Output

```
$ ccmux report --since 1h
┌──────────┬──────────┬──────────┬────────────┐
│ Model    │ Requests │ Tokens   │ Est. Cost  │
├──────────┼──────────┼──────────┼────────────┤
│ haiku    │       12 │   18,400 │ $0.018     │
│ sonnet   │        8 │   45,200 │ $0.271     │
│ opus     │        3 │   22,100 │ $0.663     │
├──────────┼──────────┼──────────┼────────────┤
│ Total    │       23 │   85,700 │ $0.952     │
└──────────┴──────────┴──────────┴────────────┘
```

## Key Architecture

```
Client → ccmux (127.0.0.1:8787) → api.anthropic.com
              │
              ├─ Extract signals (tokens, tools, plan mode, etc.)
              ├─ Evaluate policy rules (first-match-wins)
              ├─ Classifier fallback (heuristic + optional Haiku)
              ├─ Splice model into request
              └─ Log decision to ~/.config/ccmux/logs/decisions/
```

## Documentation

Full docs in `docs/`:
- [Quickstart](../docs/quickstart.md)
- [CLI Reference](../docs/cli.md)
- [Configuration](../docs/config-reference.md)
- [Rule DSL](../docs/rule-dsl.md)
- [Recipes](../docs/recipes.md)
- [Privacy](../docs/privacy.md)
- [Architecture](../docs/architecture.md)
- [Threat Model](../docs/threat-model.md)
- [Troubleshooting](../docs/troubleshooting.md)
