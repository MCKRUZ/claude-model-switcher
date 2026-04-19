# Architecture

ccmux is a local HTTP/1.1 proxy that sits between your API client and `api.anthropic.com`.

## Request flow

```
Client (Claude CLI, SDK, etc.)
    |
    |  POST /v1/messages
    v
+---------------------------+
|        ccmux proxy        |
|  127.0.0.1:8787           |
|                           |
|  1. Parse raw body        |
|  2. Extract signals       |
|  3. Evaluate policy rules |
|  4. Classifier fallback   |
|  5. Splice model header   |
|  6. Forward to upstream   |
|  7. Stream response back  |
|  8. Log decision          |
+---------------------------+
    |
    |  POST /v1/messages
    v
api.anthropic.com
```

## Components

### Proxy server (Fastify)

Binds to `127.0.0.1` only. Handles:

- `POST /v1/messages` — the hot path (routing + forwarding)
- `GET /healthz` — health check (uptime, version, mode)
- All other paths — pass-through to upstream unchanged

HTTP/2 prior-knowledge is rejected at the connection level.

### Signal extraction

Before routing, ccmux parses the request body to extract signals without modifying it:

- `planMode` — detected from system prompt or beta headers
- `messageCount` — number of messages in the conversation
- `toolUseCount` — tool-use blocks in the request
- `estInputTokens` — estimated via tiktoken
- `fileRefCount` — file paths in content
- `retryCount` — from retry headers
- `frustration` — markers like "that's wrong", repeated corrections
- `explicitModel` — if the client specified a model preference
- `sessionDurationMs`, `projectPath`, `betaFlags`

### Policy engine

First-match-wins rule evaluation. Rules use `all`/`any`/`not` composition over extracted signals. If no rule matches, the engine returns `abstain` and the classifier runs.

### Classifier (two-stage)

When policy abstains:

1. **Heuristic** (zero-latency) — deterministic scorer based on token bands, tool breadth, code fences, file references, and phrasing. Score bands: < 3 = Haiku, 3-6.5 = Sonnet, > 6.5 = Opus. Confidence clamped to [0.2, 0.85].

2. **Haiku classifier** (if enabled, ~800ms budget) — sends a lightweight classification request to Haiku. Races against the timeout; heuristic result used on timeout.

The classifier with the highest confidence wins.

### Sticky model

To avoid mid-conversation model switches, ccmux caches the chosen model per session (keyed by HMAC of session signals). Default TTL: 2 hours.

### Decision log

Every routing decision is appended to `~/.config/ccmux/logs/decisions/YYYY-MM-DD.jsonl`. Each entry records: timestamp, signals, matched rule, chosen model, confidence, and cost estimate. Content is sanitized according to the `logging.content` mode.

### Dashboard

A React SPA served by a separate Fastify instance on port 8788. Shows real-time routing decisions, cost breakdown by model, and session history. The SPA makes zero external network requests — all data comes from the local decision log via the dashboard API.

## Key design decisions

- **127.0.0.1 only** — ccmux never binds to `0.0.0.0`. It is a local-only proxy.
- **No body modification** — the request body is read for signal extraction but forwarded unchanged. Model selection is spliced into headers/query.
- **Streaming passthrough** — SSE events are forwarded byte-for-byte. ccmux does not buffer the full response.
- **Zero outbound on startup** — no update checks, no telemetry, no DNS lookups beyond what the OS resolver does for `api.anthropic.com`.
