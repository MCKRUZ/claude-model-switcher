# Quickstart

Get ccmux running in under two minutes.

## 1. Install

```bash
npm i -g ccmux
```

Or use `npx ccmux` to run without installing, or download a [standalone binary](https://github.com/MCKRUZ/claude-model-switcher/releases/latest).

## 2. Scaffold a config

```bash
ccmux init --recipe balanced
```

This creates `~/.config/ccmux/config.yaml` with the `balanced` recipe. The recipe routes trivial questions to Haiku, complex planning to Opus, and everything else to Sonnet.

Open the config to see what was generated:

```bash
cat ~/.config/ccmux/config.yaml
```

## 3. Run Claude through the proxy

```bash
ccmux run -- claude
```

This starts the proxy on `127.0.0.1:8787`, sets `ANTHROPIC_BASE_URL` in the child environment, and launches Claude CLI. Every API request now flows through ccmux.

## 4. Check routing decisions

While the session is running (or after), inspect the decision log:

```bash
ccmux report --since 1h
```

Decision log entries are written to `~/.config/ccmux/logs/decisions/YYYY-MM-DD.jsonl`. Each entry records the request signals, matched rule, chosen model, and cost.

## 5. Tune your rules

After a session, let ccmux suggest rule improvements:

```bash
ccmux tune --since 24h
```

This analyzes your decision log and suggests policy changes to reduce cost without degrading quality.

## 6. What happened

ccmux extracted signals from each request (token count, tool usage, retry count, etc.), matched them against your policy rules, and picked the cheapest model that satisfied the rule constraints. No request bodies were modified. Your API key passed through unchanged.

## 7. Next steps

- [Configuration Reference](config-reference.md) - every config key explained
- [Rule DSL](rule-dsl.md) - write custom routing rules
- [Recipes](recipes.md) - pre-built policy presets
- [CLI Reference](cli.md) - all commands and flags
