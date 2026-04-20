diff --git a/README.md b/README.md
index bb9040c..733124c 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,81 @@
 # ccmux
 
-Claude model switcher / routing proxy. Full documentation lands in section-22.
+ccmux is a local, zero-telemetry routing proxy for Anthropic's API that picks the cheapest model that will still do the job.
+
+[![CI](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml/badge.svg)](https://github.com/MCKRUZ/claude-model-switcher/actions/workflows/ci.yml)
+[![npm version](https://img.shields.io/npm/v/ccmux)](https://www.npmjs.com/package/ccmux)
+[![Docker](https://img.shields.io/badge/ghcr.io-ccmux-blue)](https://ghcr.io/mckruz/ccmux)
+[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
+
+## What ccmux does NOT do
+
+- **No telemetry.** ccmux makes zero outbound calls except to `api.anthropic.com`. No auto-update checks, no background telemetry, no analytics.
+- **No body modification.** Message content passes through byte-for-byte. ccmux only reads signals (token count, tool count, etc.) to make routing decisions.
+- **Auth passthrough.** Your `x-api-key` header goes directly to Anthropic unchanged. ccmux is not an auth broker.
+
+## Install
+
+```bash
+# npm (recommended)
+npx ccmux
+
+# global install
+npm i -g ccmux
+
+# standalone binary (Linux x64)
+curl -fsSL https://github.com/MCKRUZ/claude-model-switcher/releases/latest/download/ccmux-linux-x64 -o ccmux
+chmod +x ccmux
+
+# Docker
+docker run --rm -p 8787:8787 ghcr.io/mckruz/ccmux
+```
+
+Binaries available for: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `win-x64`.
+
+## Quickstart (60 seconds)
+
+```bash
+# 1. Scaffold config with a balanced cost/quality recipe
+ccmux init --recipe balanced
+
+# 2. Run Claude CLI through the proxy
+ccmux run -- claude
+
+# 3. Check routing decisions
+ccmux report --since 1h
+
+# 4. Open the dashboard
+ccmux dashboard
+```
+
+See [docs/quickstart.md](docs/quickstart.md) for a full walkthrough.
+
+## How it works
+
+ccmux sits between your client and `api.anthropic.com`. On each `/v1/messages` request it:
+
+1. Extracts signals (token count, tool usage, plan mode, retry count, etc.)
+2. Evaluates your policy rules (first-match-wins, `all`/`any`/`not` composition)
+3. If no rule matches, runs a fast heuristic or Haiku-based classifier
+4. Splices the chosen model into the request and forwards it
+5. Logs the decision for later analysis
+
+All of this happens locally on `127.0.0.1`. See [docs/architecture.md](docs/architecture.md).
+
+## Documentation
+
+| Guide | Description |
+|-------|-------------|
+| [Quickstart](docs/quickstart.md) | First-run walkthrough |
+| [CLI Reference](docs/cli.md) | All commands and flags |
+| [Configuration](docs/config-reference.md) | Every config key explained |
+| [Rule DSL](docs/rule-dsl.md) | Writing routing rules |
+| [Recipes](docs/recipes.md) | Batteries-included policy presets |
+| [Privacy](docs/privacy.md) | Logging modes and zero-telemetry stance |
+| [Architecture](docs/architecture.md) | Proxy flow, classifier, decision log |
+| [Threat Model](docs/threat-model.md) | Security scope and limitations |
+| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |
+
+## License
+
+[MIT](LICENSE)
diff --git a/docs/architecture.md b/docs/architecture.md
new file mode 100644
index 0000000..748f626
--- /dev/null
+++ b/docs/architecture.md
@@ -0,0 +1,88 @@
+# Architecture
+
+ccmux is a local HTTP/1.1 proxy that sits between your API client and `api.anthropic.com`.
+
+## Request flow
+
+```
+Client (Claude CLI, SDK, etc.)
+    |
+    |  POST /v1/messages
+    v
++---------------------------+
+|        ccmux proxy        |
+|  127.0.0.1:8787           |
+|                           |
+|  1. Parse raw body        |
+|  2. Extract signals       |
+|  3. Evaluate policy rules |
+|  4. Classifier fallback   |
+|  5. Splice model header   |
+|  6. Forward to upstream   |
+|  7. Stream response back  |
+|  8. Log decision          |
++---------------------------+
+    |
+    |  POST /v1/messages
+    v
+api.anthropic.com
+```
+
+## Components
+
+### Proxy server (Fastify)
+
+Binds to `127.0.0.1` only. Handles:
+
+- `POST /v1/messages` — the hot path (routing + forwarding)
+- `GET /healthz` — health check (uptime, version, mode)
+- All other paths — pass-through to upstream unchanged
+
+HTTP/2 prior-knowledge is rejected at the connection level.
+
+### Signal extraction
+
+Before routing, ccmux parses the request body to extract signals without modifying it:
+
+- `planMode` — detected from system prompt or beta headers
+- `messageCount` — number of messages in the conversation
+- `toolUseCount` — tool-use blocks in the request
+- `estInputTokens` — estimated via tiktoken
+- `fileRefCount` — file paths in content
+- `retryCount` — from retry headers
+- `frustration` — markers like "that's wrong", repeated corrections
+- `explicitModel` — if the client specified a model preference
+- `sessionDurationMs`, `projectPath`, `betaFlags`
+
+### Policy engine
+
+First-match-wins rule evaluation. Rules use `all`/`any`/`not` composition over extracted signals. If no rule matches, the engine returns `abstain` and the classifier runs.
+
+### Classifier (two-stage)
+
+When policy abstains:
+
+1. **Heuristic** (zero-latency) — deterministic scorer based on token bands, tool breadth, code fences, file references, and phrasing. Score bands: < 3 = Haiku, 3-6.5 = Sonnet, > 6.5 = Opus. Confidence clamped to [0.2, 0.85].
+
+2. **Haiku classifier** (if enabled, ~800ms budget) — sends a lightweight classification request to Haiku. Races against the timeout; heuristic result used on timeout.
+
+The classifier with the highest confidence wins.
+
+### Sticky model
+
+To avoid mid-conversation model switches, ccmux caches the chosen model per session (keyed by HMAC of session signals). Default TTL: 2 hours.
+
+### Decision log
+
+Every routing decision is appended to `~/.config/ccmux/logs/decisions/YYYY-MM-DD.jsonl`. Each entry records: timestamp, signals, matched rule, chosen model, confidence, and cost estimate. Content is sanitized according to the `logging.content` mode.
+
+### Dashboard
+
+A React SPA served by a separate Fastify instance on port 8788. Shows real-time routing decisions, cost breakdown by model, and session history. The SPA makes zero external network requests — all data comes from the local decision log via the dashboard API.
+
+## Key design decisions
+
+- **127.0.0.1 only** — ccmux never binds to `0.0.0.0`. It is a local-only proxy.
+- **No body modification** — the request body is read for signal extraction but forwarded unchanged. Model selection is spliced into headers/query.
+- **Streaming passthrough** — SSE events are forwarded byte-for-byte. ccmux does not buffer the full response.
+- **Zero outbound on startup** — no update checks, no telemetry, no DNS lookups beyond what the OS resolver does for `api.anthropic.com`.
diff --git a/docs/cli.md b/docs/cli.md
new file mode 100644
index 0000000..ec245cc
--- /dev/null
+++ b/docs/cli.md
@@ -0,0 +1,110 @@
+# CLI Reference
+
+All ccmux commands. Run `ccmux <command> --help` for details.
+
+## ccmux start
+
+Start the proxy server.
+
+```
+ccmux start [--foreground] [--port <n>]
+```
+
+| Flag | Description |
+|------|-------------|
+| `--foreground` | Block on SIGINT instead of daemonizing; skip PID file |
+| `--port <n>` | Override the port from config (default: 8787) |
+
+In foreground mode, the proxy logs to stderr and exits on SIGINT/SIGTERM. Without `--foreground`, it writes a PID file to `~/.config/ccmux/state/ccmux.pid`.
+
+## ccmux run
+
+Start the proxy and run a child command against it.
+
+```
+ccmux run -- <cmd> [args...]
+```
+
+Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` in the child's environment. The proxy shuts down when the child exits.
+
+## ccmux status
+
+Report proxy status.
+
+```
+ccmux status
+```
+
+Reads the PID file and pings `/healthz`. Reports: running/stopped, port, uptime, mode.
+
+## ccmux version
+
+Print ccmux version and exit.
+
+```
+ccmux version
+```
+
+## ccmux init
+
+Scaffold a config file from a recipe.
+
+```
+ccmux init [--recipe <name>] [--force]
+```
+
+| Flag | Description |
+|------|-------------|
+| `--recipe <name>` | Recipe to use: `frugal`, `balanced`, `opus-forward` (default: `balanced`) |
+| `--force` | Overwrite existing config |
+
+Creates `~/.config/ccmux/config.yaml`. See [Recipes](recipes.md).
+
+## ccmux report
+
+Summarize the decision log.
+
+```
+ccmux report [--since <duration>] [--group-by <model|project>] [--format <ascii|json>]
+```
+
+| Flag | Description |
+|------|-------------|
+| `--since <duration>` | Time window: `1h`, `24h`, `7d`, etc. |
+| `--group-by` | Group results by `model` or `project` |
+| `--format` | Output format: `ascii` (table) or `json` |
+
+## ccmux tune
+
+Suggest policy-rule changes based on decision history.
+
+```
+ccmux tune [--since <duration>] [--log-dir <path>] [--config <path>]
+```
+
+Analyzes the decision log and prints suggested rule additions or threshold adjustments.
+
+## ccmux explain
+
+Dry-run a request through the routing pipeline.
+
+```
+ccmux explain <request-json> [--config <path>] [--classifier]
+```
+
+| Flag | Description |
+|------|-------------|
+| `--config <path>` | Config file to use (default: auto-resolved) |
+| `--classifier` | Also run the heuristic classifier if policy abstains |
+
+Prints: matched rule, chosen model, extracted signals, confidence score.
+
+## ccmux dashboard
+
+Open the local dashboard UI.
+
+```
+ccmux dashboard
+```
+
+Opens `http://127.0.0.1:8788` in your default browser. The dashboard shows real-time routing decisions, cost breakdown by model, and session history.
diff --git a/docs/config-reference.md b/docs/config-reference.md
new file mode 100644
index 0000000..3f51b21
--- /dev/null
+++ b/docs/config-reference.md
@@ -0,0 +1,142 @@
+# Configuration Reference
+
+ccmux reads its config from `~/.config/ccmux/config.yaml` (or `%APPDATA%\ccmux\config.yaml` on Windows). Override with `CCMUX_HOME` or `XDG_CONFIG_HOME`.
+
+Unknown top-level keys emit a warning but do not crash (forward-compatible).
+
+## Top-Level Keys
+
+### port
+
+```yaml
+port: 8787
+```
+
+| Field | Type | Default | Notes |
+|-------|------|---------|-------|
+| `port` | number | 8787 | Proxy listen port. CLI `--port` overrides. |
+
+### mode
+
+```yaml
+mode: live
+```
+
+| Value | Description |
+|-------|-------------|
+| `live` | Route requests through the policy engine (default) |
+| `shadow` | Forward all requests unchanged; log what *would* have been routed |
+
+### security
+
+```yaml
+security:
+  requireProxyToken: false
+```
+
+| Field | Type | Default |
+|-------|------|---------|
+| `security.requireProxyToken` | boolean | false |
+
+When true, requests must include an `x-ccmux-token` header matching the token set via environment variable.
+
+### logging
+
+```yaml
+logging:
+  content: hashed
+  fsync: false
+  rotation:
+    strategy: daily
+    maxFiles: 30
+    maxSizeMb: 10
+```
+
+| Field | Type | Default | Notes |
+|-------|------|---------|-------|
+| `logging.content` | `hashed` \| `full` \| `none` | `hashed` | See [Privacy](privacy.md) |
+| `logging.fsync` | boolean | false | fsync after each write |
+| `logging.rotation.strategy` | `daily` | `daily` | Log rotation strategy |
+| `logging.rotation.maxFiles` | number | 30 | Files to retain |
+| `logging.rotation.maxSizeMb` | number | 10 | Max size per file |
+
+### classifier
+
+```yaml
+classifier:
+  enabled: true
+  model: claude-haiku-4-5-20251001
+  timeoutMs: 800
+  confidenceThresholds:
+    haiku: 0.6
+    heuristic: 0.4
+```
+
+| Field | Type | Default | Notes |
+|-------|------|---------|-------|
+| `classifier.enabled` | boolean | true | Enable the Haiku classifier fallback |
+| `classifier.model` | string | `claude-haiku-4-5-20251001` | Model for classification calls |
+| `classifier.timeoutMs` | number | 800 | Timeout for classifier; heuristic used on timeout |
+| `classifier.confidenceThresholds.haiku` | number | 0.6 | Minimum confidence for Haiku classifier |
+| `classifier.confidenceThresholds.heuristic` | number | 0.4 | Minimum confidence for heuristic classifier |
+
+### stickyModel
+
+```yaml
+stickyModel:
+  enabled: true
+  sessionTtlMs: 7200000
+```
+
+| Field | Type | Default | Notes |
+|-------|------|---------|-------|
+| `stickyModel.enabled` | boolean | true | Reuse model for same session |
+| `stickyModel.sessionTtlMs` | number | 7200000 | Session TTL (2 hours) |
+
+### rules
+
+```yaml
+rules:
+  - id: plan-mode-opus
+    when:
+      planMode: true
+    then:
+      model: opus
+```
+
+Array of routing rules. See [Rule DSL](rule-dsl.md).
+
+### dashboard
+
+```yaml
+dashboard:
+  port: 8788
+```
+
+| Field | Type | Default |
+|-------|------|---------|
+| `dashboard.port` | number | 8788 |
+
+### modelTiers
+
+```yaml
+modelTiers:
+  claude-opus-4-20250514: opus
+  claude-sonnet-4-20250514: sonnet
+  claude-haiku-4-5-20251001: haiku
+```
+
+Maps model IDs to tier names (`haiku`, `sonnet`, `opus`). Used by the policy engine to compare cost tiers.
+
+### pricing
+
+```yaml
+pricing:
+  claude-opus-4-20250514:
+    input: 15
+    output: 75
+    cacheRead: 1.5
+    cacheCreate: 18.75
+```
+
+Per-model pricing in dollars per million tokens. Used by the report and tune commands.
diff --git a/docs/privacy.md b/docs/privacy.md
new file mode 100644
index 0000000..6515ad9
--- /dev/null
+++ b/docs/privacy.md
@@ -0,0 +1,67 @@
+# Privacy
+
+ccmux is a zero-telemetry local proxy. This page documents how your data is handled.
+
+## Zero-telemetry stance
+
+ccmux makes no outbound calls other than to `api.anthropic.com`. Specifically:
+
+- No auto-update checks
+- No background telemetry or analytics
+- No fixture capture unless explicitly enabled (`CCMUX_RECORD=1`)
+- No phone-home on startup, shutdown, or error
+- The dashboard opened by `ccmux dashboard` runs in your browser on localhost; ccmux does not serve it to external networks
+
+The SPA bundle is checked in CI for zero external URLs. The backend is tested to make zero outbound requests on cold start.
+
+## Logging content modes
+
+The `logging.content` key controls how message content appears in decision logs.
+
+### hashed (default)
+
+Message strings and tool `input` fields are replaced with `sha256(content).slice(0, 12)`.
+
+**Equality linkable:** two identical messages produce the same 12-character hash and are linkable across log entries. With `hashed`, someone with access to your log files can determine that the same content appeared in multiple requests, even though they cannot recover the original text. Use `none` on shared machines.
+
+### full
+
+Everything is logged verbatim. Auth headers (`x-api-key`, `authorization`, `x-ccmux-token`) are still redacted by the sanitizer and appear as `[REDACTED]`.
+
+Use this mode only on personal machines where you want complete request/response logs for debugging.
+
+### none
+
+Messages and tool inputs are dropped entirely. Only routing signals (token counts, tool counts, etc.) and metadata (timestamp, chosen model, matched rule) remain in the decision log.
+
+This is the most private mode. Use it on shared machines or when logging content is not acceptable.
+
+## What is logged
+
+Regardless of content mode, the decision log always records:
+
+- Timestamp
+- Chosen model and tier
+- Matched rule ID (or "classifier"/"heuristic")
+- Extracted signals (token count, tool count, plan mode, etc.)
+- Confidence score
+- Cost estimate
+
+## What is never logged
+
+- Full API keys (always redacted)
+- Proxy tokens (always redacted)
+- Response bodies (only signals extracted from responses)
+
+## Auth passthrough
+
+Your `x-api-key` header passes through to Anthropic unchanged. ccmux reads it only to forward it. ccmux is not an auth broker and does not store, cache, or validate your API key.
+
+## File permissions
+
+Log files and config are written with mode `0700` (directory) / `0600` (files) on POSIX systems. On Windows, standard user-only ACLs apply. These files are readable by the same user account that runs ccmux.
+
+## See also
+
+- [Threat Model](threat-model.md) for security scope and limitations
+- [Configuration Reference](config-reference.md) for the `logging` config block
diff --git a/docs/quickstart.md b/docs/quickstart.md
new file mode 100644
index 0000000..64b1a74
--- /dev/null
+++ b/docs/quickstart.md
@@ -0,0 +1,72 @@
+# Quickstart
+
+Get ccmux running in under two minutes.
+
+## 1. Install
+
+```bash
+npm i -g ccmux
+```
+
+Or use `npx ccmux` to run without installing, or download a [standalone binary](https://github.com/MCKRUZ/claude-model-switcher/releases/latest).
+
+## 2. Scaffold a config
+
+```bash
+ccmux init --recipe balanced
+```
+
+This creates `~/.config/ccmux/config.yaml` with the `balanced` recipe. The recipe routes trivial questions to Haiku, complex planning to Opus, and everything else to Sonnet.
+
+Open the config to see what was generated:
+
+```bash
+cat ~/.config/ccmux/config.yaml
+```
+
+## 3. Run Claude through the proxy
+
+```bash
+ccmux run -- claude
+```
+
+This starts the proxy on `127.0.0.1:8787`, sets `ANTHROPIC_BASE_URL` in the child environment, and launches Claude CLI. Every API request now flows through ccmux.
+
+## 4. Check routing decisions
+
+While the session is running (or after), inspect the decision log:
+
+```bash
+ccmux report --since 1h
+```
+
+Decision log entries are written to `~/.config/ccmux/logs/decisions/YYYY-MM-DD.jsonl`. Each entry records the request signals, matched rule, chosen model, and cost.
+
+## 5. Open the dashboard
+
+```bash
+ccmux dashboard
+```
+
+This opens a local web UI at `http://127.0.0.1:8788` showing real-time routing decisions, cost breakdown, and model distribution.
+
+## 6. Tune your rules
+
+After a session, let ccmux suggest rule improvements:
+
+```bash
+ccmux tune --since 24h
+```
+
+This analyzes your decision log and suggests policy changes to reduce cost without degrading quality.
+
+## What happened
+
+ccmux extracted signals from each request (token count, tool usage, retry count, etc.), matched them against your policy rules, and picked the cheapest model that satisfied the rule constraints. No request bodies were modified. Your API key passed through unchanged.
+
+## Next steps
+
+- [Configuration Reference](config-reference.md) - every config key explained
+- [Rule DSL](rule-dsl.md) - write custom routing rules
+- [Recipes](recipes.md) - pre-built policy presets
+- [CLI Reference](cli.md) - all commands and flags
diff --git a/docs/recipes.md b/docs/recipes.md
new file mode 100644
index 0000000..cacb756
--- /dev/null
+++ b/docs/recipes.md
@@ -0,0 +1,97 @@
+# Recipes
+
+ccmux ships three policy presets. Use `ccmux init --recipe <name>` to scaffold one.
+
+## balanced (default)
+
+One-line philosophy: Haiku for trivial requests, Opus for planning, Sonnet for everything else. Escalate on retries or frustration.
+
+```yaml
+rules:
+  - id: plan-mode-opus
+    when:
+      planMode: true
+    then:
+      model: opus
+  - id: trivial-haiku
+    when:
+      all:
+        - messageCount:
+            lt: 5
+        - toolUseCount:
+            eq: 0
+        - estInputTokens:
+            lt: 2000
+    then:
+      model: haiku
+  - id: retry-escalate
+    when:
+      any:
+        - retryCount:
+            gte: 2
+        - frustration: true
+    then:
+      model: opus
+```
+
+**Expected cost profile:** 40-60% cheaper than always-Opus for typical Claude Code sessions. Most short Q&A goes to Haiku, planning stays on Opus, and the middle ground uses Sonnet via the classifier.
+
+**When to pick it:** General-purpose daily use. Good starting point if you are unsure.
+
+## frugal
+
+One-line philosophy: Minimize cost aggressively. Haiku by default, Opus only for explicit planning.
+
+```yaml
+rules:
+  - id: plan-mode-opus
+    when:
+      planMode: true
+    then:
+      model: opus
+  - id: short-haiku
+    when:
+      all:
+        - messageCount:
+            lt: 6
+        - toolUseCount:
+            eq: 0
+    then:
+      model: haiku
+  - id: frustration-bump
+    when:
+      frustration: true
+    then:
+      model: sonnet
+```
+
+**Expected cost profile:** 60-80% cheaper than always-Opus. Trades some response quality on medium-complexity requests for significant savings.
+
+**When to pick it:** Budget-constrained usage, exploratory sessions, or when you do not need Opus quality for most interactions.
+
+## opus-forward
+
+One-line philosophy: Opus by default, Haiku only for trivial openers. Maximum quality.
+
+```yaml
+rules:
+  - id: trivial-opener-haiku
+    when:
+      all:
+        - messageCount:
+            lt: 2
+        - estInputTokens:
+            lt: 500
+        - toolUseCount:
+            eq: 0
+    then:
+      model: haiku
+```
+
+**Expected cost profile:** 5-15% cheaper than always-Opus. Only the most trivial requests get downgraded.
+
+**When to pick it:** When quality is paramount and you want marginal savings on throwaway requests.
+
+## Custom recipes
+
+Create your own by editing `~/.config/ccmux/config.yaml` directly. See [Rule DSL](rule-dsl.md) for the full condition syntax and [Configuration Reference](config-reference.md) for all available options.
diff --git a/docs/rule-dsl.md b/docs/rule-dsl.md
new file mode 100644
index 0000000..6733fcd
--- /dev/null
+++ b/docs/rule-dsl.md
@@ -0,0 +1,146 @@
+# Rule DSL
+
+ccmux uses a first-match-wins rule engine. Rules live in the `rules` array of your config. Each rule has a `when` condition and a `then` action.
+
+## Structure
+
+```yaml
+rules:
+  - id: my-rule
+    when:
+      planMode: true
+    then:
+      model: opus
+```
+
+| Field | Required | Description |
+|-------|----------|-------------|
+| `id` | yes | Unique identifier for logging |
+| `when` | yes | Condition object (see below) |
+| `then` | yes | Action: `model` (haiku/sonnet/opus) or `abstain` |
+| `allowDowngrade` | no | If false, never route to a cheaper tier than requested |
+
+## Conditions
+
+### Simple conditions
+
+Match directly on extracted signals:
+
+```yaml
+when:
+  planMode: true
+  messageCount:
+    gte: 10
+  toolUseCount:
+    gt: 0
+```
+
+All fields in a `when` block are ANDed together.
+
+### Composition: all, any, not
+
+Combine conditions with `all`, `any`, and `not`:
+
+```yaml
+when:
+  any:
+    - planMode: true
+    - retryCount:
+        gte: 2
+    - frustration: true
+```
+
+```yaml
+when:
+  all:
+    - messageCount:
+        gte: 5
+    - not:
+        toolUseCount:
+          gt: 0
+```
+
+### Available signals
+
+| Signal | Type | Description |
+|--------|------|-------------|
+| `planMode` | boolean | Client is in plan/architect mode |
+| `messageCount` | number | Messages in the conversation |
+| `tools` | string[] | Tool names available |
+| `toolUseCount` | number | Number of tool-use blocks in the request |
+| `estInputTokens` | number | Estimated input token count |
+| `fileRefCount` | number | File paths referenced in content |
+| `retryCount` | number | Retry attempts (from headers) |
+| `frustration` | boolean | Frustration markers detected |
+| `explicitModel` | string | Model explicitly requested by client |
+| `projectPath` | string | Project path from headers |
+| `sessionDurationMs` | number | Session duration in milliseconds |
+| `betaFlags` | string[] | Beta feature flags |
+
+### Numeric comparisons
+
+```yaml
+estInputTokens:
+  gt: 5000
+  lt: 50000
+  gte: 1000
+  lte: 10000
+```
+
+## First-match-wins
+
+Rules are evaluated top-to-bottom. The first rule whose `when` matches wins. If no rule matches, the classifier runs (heuristic first, then Haiku if enabled).
+
+A rule can `abstain` to explicitly pass to the next rule:
+
+```yaml
+then:
+  abstain: true
+```
+
+## Worked examples
+
+### Plan mode goes to Opus
+
+```yaml
+rules:
+  - id: plan-mode-opus
+    when:
+      planMode: true
+    then:
+      model: opus
+```
+
+### High tool count goes to Sonnet
+
+```yaml
+rules:
+  - id: many-tools-sonnet
+    when:
+      toolUseCount:
+        gte: 3
+    then:
+      model: sonnet
+```
+
+### Short questions go to Haiku
+
+```yaml
+rules:
+  - id: short-question-haiku
+    when:
+      all:
+        - messageCount:
+            lt: 3
+        - estInputTokens:
+            lt: 2000
+        - toolUseCount:
+            eq: 0
+    then:
+      model: haiku
+```
+
+## See also
+
+- [Recipes](recipes.md) for batteries-included rule sets
+- [Configuration Reference](config-reference.md) for the full config schema
diff --git a/docs/threat-model.md b/docs/threat-model.md
new file mode 100644
index 0000000..47f9855
--- /dev/null
+++ b/docs/threat-model.md
@@ -0,0 +1,59 @@
+# Threat Model
+
+ccmux is a **local** proxy. This page documents what it protects against and what it does not.
+
+## Scope
+
+ccmux binds to `127.0.0.1` only. It is designed to run on a single-user developer workstation. It is not a network service, not a multi-tenant proxy, and not an auth broker.
+
+## What ccmux protects
+
+### Cost optimization
+
+ccmux routes requests to cheaper models when quality requirements allow. The policy engine and classifier prevent unnecessary Opus usage, reducing API costs.
+
+### Privacy modes
+
+Decision logs can use `hashed` or `none` content modes to avoid storing raw message content on disk. See [Privacy](privacy.md).
+
+### No telemetry
+
+ccmux makes zero outbound requests except to `api.anthropic.com`. No usage data leaves your machine. This is enforced by CI smoke tests.
+
+## What ccmux does NOT protect against
+
+### Compromised local user account
+
+If an attacker has access to your user account, they can read ccmux config, logs, and API keys. ccmux files use mode 0600/0700 but are readable by the owning user.
+
+### Network-level attacks on localhost
+
+ccmux uses plain HTTP on `127.0.0.1`. Any process on the same machine can connect to the proxy port. This is standard for local development proxies.
+
+### API key theft
+
+Your `x-api-key` passes through ccmux to Anthropic unchanged. ccmux does not encrypt, rotate, or scope the key. If your key is compromised, that is outside ccmux's scope.
+
+### Model output quality
+
+ccmux picks a model tier based on signals and rules, but it cannot guarantee the chosen model produces correct output. A request routed to Haiku may produce lower-quality results than Opus would have.
+
+## Hashed-log linkability
+
+With `logging.content: hashed`, message content is replaced with `sha256(content).slice(0, 12)`. This is a deterministic hash:
+
+- Two identical messages produce the same hash
+- An attacker with log access can determine that the same content appeared in multiple requests
+- An attacker who can guess the content can verify their guess against the hash
+
+This is **equality linkable**. If linkability is unacceptable, use `logging.content: none`.
+
+The 12-character truncated hash is not brute-force resistant for short messages. Do not rely on it as a security mechanism. It is a privacy convenience, not a cryptographic guarantee.
+
+## Recommendations
+
+- Use `logging.content: none` on shared machines
+- Keep ccmux config directory permissions at 0700
+- Do not expose the proxy port to the network (ccmux refuses to bind `0.0.0.0`, but a reverse proxy could expose it)
+- Rotate your Anthropic API key periodically
+- Review decision logs for unexpected routing patterns
diff --git a/docs/troubleshooting.md b/docs/troubleshooting.md
new file mode 100644
index 0000000..407b078
--- /dev/null
+++ b/docs/troubleshooting.md
@@ -0,0 +1,99 @@
+# Troubleshooting
+
+## EADDRINUSE on start
+
+**Symptom:** `Error: listen EADDRINUSE :::8787`
+
+**Cause:** Port 8787 is already in use (another ccmux instance, or another service).
+
+**Fix:** ccmux tries sequential ports automatically. If that fails, override with `--port`:
+
+```bash
+ccmux start --port 9090
+```
+
+Or kill the existing process: check `ccmux status` for the PID.
+
+## Claude CLI hangs after setting up proxy
+
+**Symptom:** `ccmux run -- claude` starts but Claude never connects.
+
+**Cause:** `ANTHROPIC_BASE_URL` not set in the child environment, or set to the wrong value.
+
+**Fix:** Verify with `ccmux status` that the proxy is running and note the port. Then check:
+
+```bash
+echo $ANTHROPIC_BASE_URL
+# Should be http://127.0.0.1:8787
+```
+
+If using `ccmux run`, the env var is set automatically. If starting the proxy separately, set it manually.
+
+## Costs show null in report
+
+**Symptom:** `ccmux report` shows `null` for cost columns.
+
+**Cause:** The upstream response is missing `usage.input_tokens` or `usage.output_tokens` fields. This happens when streaming responses do not include the final usage event.
+
+**Fix:** Check that your classifier model and streaming configuration produce usage data. Non-streaming responses always include usage. For streaming, Anthropic includes usage in the `message_delta` event.
+
+## Config change not picked up
+
+**Symptom:** You edited `config.yaml` but the proxy behavior did not change.
+
+**Cause:** ccmux debounces config file changes by 500ms. If your YAML has a syntax error, the previous valid config stays active.
+
+**Fix:** Check the proxy logs for lines like `config reload failed: invalid YAML`. Fix the syntax error. The next save will trigger a reload.
+
+```bash
+# Validate your config
+ccmux explain '{"messages":[{"role":"user","content":"test"}]}' --config ~/.config/ccmux/config.yaml
+```
+
+## Dashboard shows no data
+
+**Symptom:** `ccmux dashboard` opens but all charts are empty.
+
+**Cause:** Decision log path mismatch, or no requests have been routed yet.
+
+**Fix:** Confirm the decision log directory exists:
+
+```bash
+ls ~/.config/ccmux/logs/decisions/
+```
+
+If empty, route a request through the proxy first. If the directory does not exist, check that ccmux has write permissions to the config directory.
+
+## HTTP/2 client error
+
+**Symptom:** Client gets a connection error or `ERR_HTTP2_PROTOCOL_ERROR`.
+
+**Cause:** ccmux rejects HTTP/2 prior-knowledge connections. It only supports HTTP/1.1.
+
+**Fix:** Configure your client to use HTTP/1.1. Most HTTP clients default to HTTP/1.1 for `http://` URLs. If your client forces h2, disable it.
+
+## Classifier timeout
+
+**Symptom:** Logs show `classifier timeout` and the heuristic is used instead.
+
+**Cause:** The Haiku classifier call took longer than `classifier.timeoutMs` (default: 800ms).
+
+**Fix:** This is expected behavior. The heuristic provides a fallback result. If it happens frequently, increase the timeout:
+
+```yaml
+classifier:
+  timeoutMs: 1500
+```
+
+## Proxy token rejected
+
+**Symptom:** `403 Forbidden` on all requests.
+
+**Cause:** `security.requireProxyToken` is true but the client is not sending `x-ccmux-token`.
+
+**Fix:** Either set the token header on your client, or disable the requirement:
+
+```yaml
+security:
+  requireProxyToken: false
+```
diff --git a/scripts/docs-check.ts b/scripts/docs-check.ts
new file mode 100644
index 0000000..30d806b
--- /dev/null
+++ b/scripts/docs-check.ts
@@ -0,0 +1,126 @@
+// Documentation validation: link checker, YAML lint, required strings, no placeholders.
+
+import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
+import { join, dirname, resolve } from 'node:path';
+import { CORE_SCHEMA, load as yamlLoad } from 'js-yaml';
+import { fileURLToPath } from 'node:url';
+
+const __dirname = dirname(fileURLToPath(import.meta.url));
+const ROOT = resolve(__dirname, '..');
+
+export interface CheckResult {
+  readonly ok: boolean;
+  readonly errors: readonly string[];
+}
+
+function collectMarkdownFiles(dir: string): string[] {
+  const results: string[] = [];
+  if (!existsSync(dir)) return results;
+  for (const entry of readdirSync(dir, { withFileTypes: true })) {
+    const full = join(dir, entry.name);
+    if (entry.isDirectory()) results.push(...collectMarkdownFiles(full));
+    else if (entry.name.endsWith('.md')) results.push(full);
+  }
+  return results;
+}
+
+function checkRelativeLinks(file: string, content: string): string[] {
+  const errors: string[] = [];
+  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
+  for (const match of content.matchAll(linkPattern)) {
+    const target = match[2]!;
+    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) continue;
+    const anchor = target.indexOf('#');
+    const path = anchor >= 0 ? target.slice(0, anchor) : target;
+    if (!path) continue;
+    const resolved = resolve(dirname(file), path);
+    if (!existsSync(resolved)) {
+      errors.push(`${file}: broken link [${match[1]}](${target}) -> ${resolved}`);
+    }
+  }
+  return errors;
+}
+
+function checkYamlFences(file: string, content: string): string[] {
+  const errors: string[] = [];
+  const fencePattern = /```ya?ml\n([\s\S]*?)```/g;
+  let idx = 0;
+  for (const match of content.matchAll(fencePattern)) {
+    idx++;
+    try {
+      yamlLoad(match[1]!, { schema: CORE_SCHEMA });
+    } catch (err) {
+      const msg = err instanceof Error ? err.message : String(err);
+      errors.push(`${file}: YAML fence #${idx} invalid: ${msg}`);
+    }
+  }
+  return errors;
+}
+
+function checkRequiredStrings(file: string, content: string, required: readonly string[]): string[] {
+  const errors: string[] = [];
+  for (const str of required) {
+    if (!content.includes(str)) {
+      errors.push(`${file}: missing required string "${str}"`);
+    }
+  }
+  return errors;
+}
+
+function checkNoPlaceholders(file: string, content: string): string[] {
+  const errors: string[] = [];
+  const forbidden = ['TODO', 'TBD', 'FIXME', '<placeholder>'];
+  for (const term of forbidden) {
+    if (content.includes(term)) {
+      errors.push(`${file}: contains forbidden placeholder "${term}"`);
+    }
+  }
+  return errors;
+}
+
+export async function checkDocs(): Promise<CheckResult> {
+  const errors: string[] = [];
+
+  const readmePath = join(ROOT, 'README.md');
+  const docsDir = join(ROOT, 'docs');
+  const privacyPath = join(docsDir, 'privacy.md');
+
+  const allFiles = [readmePath, ...collectMarkdownFiles(docsDir)].filter(f => existsSync(f));
+
+  for (const file of allFiles) {
+    const content = readFileSync(file, 'utf-8');
+    errors.push(...checkRelativeLinks(file, content));
+    errors.push(...checkNoPlaceholders(file, content));
+  }
+
+  const configRef = join(docsDir, 'config-reference.md');
+  const recipesDoc = join(docsDir, 'recipes.md');
+  for (const file of [configRef, recipesDoc]) {
+    if (existsSync(file)) {
+      errors.push(...checkYamlFences(file, readFileSync(file, 'utf-8')));
+    }
+  }
+
+  if (existsSync(readmePath)) {
+    const readme = readFileSync(readmePath, 'utf-8');
+    errors.push(...checkRequiredStrings(readmePath, readme, ['zero-telemetry', 'api.anthropic.com']));
+  }
+
+  if (existsSync(privacyPath)) {
+    const privacy = readFileSync(privacyPath, 'utf-8');
+    errors.push(...checkRequiredStrings(privacyPath, privacy, ['zero-telemetry', 'api.anthropic.com']));
+  }
+
+  return { ok: errors.length === 0, errors };
+}
+
+if (process.argv[1] === fileURLToPath(import.meta.url)) {
+  checkDocs().then(result => {
+    if (!result.ok) {
+      console.error('Documentation check failed:');
+      for (const err of result.errors) console.error(`  ${err}`);
+      process.exit(1);
+    }
+    console.log('Documentation check passed.');
+  });
+}
diff --git a/tests/release/docs-check.test.ts b/tests/release/docs-check.test.ts
new file mode 100644
index 0000000..fe797f4
--- /dev/null
+++ b/tests/release/docs-check.test.ts
@@ -0,0 +1,13 @@
+import { describe, it, expect } from 'vitest';
+import { checkDocs } from '../../scripts/docs-check.js';
+
+describe('docs-check', () => {
+  it('passes on the actual project docs', async () => {
+    const result = await checkDocs();
+    if (!result.ok) {
+      console.error('Doc check errors:', result.errors);
+    }
+    expect(result.ok).toBe(true);
+    expect(result.errors).toHaveLength(0);
+  });
+});
