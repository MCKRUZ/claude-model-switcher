# Configuration Reference

ccmux reads its config from `~/.config/ccmux/config.yaml` (or `%APPDATA%\ccmux\config.yaml` on Windows). Override with `CCMUX_HOME` or `XDG_CONFIG_HOME`.

Unknown top-level keys emit a warning but do not crash (forward-compatible).

## Top-Level Keys

### port

```yaml
port: 8787
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `port` | number | 8787 | Proxy listen port. CLI `--port` overrides. |

### mode

```yaml
mode: live
```

| Value | Description |
|-------|-------------|
| `live` | Route requests through the policy engine (default) |
| `shadow` | Forward all requests unchanged; log what *would* have been routed |

### security

```yaml
security:
  requireProxyToken: false
```

| Field | Type | Default |
|-------|------|---------|
| `security.requireProxyToken` | boolean | false |

When true, requests must include an `x-ccmux-token` header matching the token set via environment variable.

### logging

```yaml
logging:
  content: hashed
  fsync: false
  rotation:
    strategy: daily
    maxFiles: 30
    maxSizeMb: 10
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `logging.content` | `hashed` \| `full` \| `none` | `hashed` | See [Privacy](privacy.md) |
| `logging.fsync` | boolean | false | fsync after each write |
| `logging.rotation.strategy` | `daily` | `daily` | Log rotation strategy |
| `logging.rotation.maxFiles` | number | 30 | Files to retain |
| `logging.rotation.maxSizeMb` | number | 10 | Max size per file |

### classifier

```yaml
classifier:
  enabled: true
  model: claude-haiku-4-5-20251001
  timeoutMs: 800
  confidenceThresholds:
    haiku: 0.6
    heuristic: 0.4
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `classifier.enabled` | boolean | true | Enable the Haiku classifier fallback |
| `classifier.model` | string | `claude-haiku-4-5-20251001` | Model for classification calls |
| `classifier.timeoutMs` | number | 800 | Timeout for classifier; heuristic used on timeout |
| `classifier.confidenceThresholds.haiku` | number | 0.6 | Minimum confidence for Haiku classifier |
| `classifier.confidenceThresholds.heuristic` | number | 0.4 | Minimum confidence for heuristic classifier |

### stickyModel

```yaml
stickyModel:
  enabled: true
  sessionTtlMs: 7200000
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `stickyModel.enabled` | boolean | true | Reuse model for same session |
| `stickyModel.sessionTtlMs` | number | 7200000 | Session TTL (2 hours) |

### rules

```yaml
rules:
  - id: plan-mode-opus
    when:
      planMode: true
    then:
      model: opus
```

Array of routing rules. See [Rule DSL](rule-dsl.md).

### dashboard

```yaml
dashboard:
  port: 8788
```

| Field | Type | Default |
|-------|------|---------|
| `dashboard.port` | number | 8788 |

### modelTiers

```yaml
modelTiers:
  claude-opus-4-20250514: opus
  claude-sonnet-4-20250514: sonnet
  claude-haiku-4-5-20251001: haiku
```

Maps model IDs to tier names (`haiku`, `sonnet`, `opus`). Used by the policy engine to compare cost tiers.

### pricing

```yaml
pricing:
  claude-opus-4-20250514:
    input: 15
    output: 75
    cacheRead: 1.5
    cacheCreate: 18.75
```

Per-model pricing in dollars per million tokens. Used by the report and tune commands.
