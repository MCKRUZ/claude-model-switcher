# ccmux — Consolidated Specification

**Source of truth for the implementation plan.** This document merges:
- The initial spec at `planning/ccmux-spec.md`
- Research findings in `planning/claude-research.md`
- Interview answers in `planning/claude-interview.md`

When the three conflict, this document wins.

---

## 1. One-Line Summary

A local HTTPS API proxy that sits between Claude Code and `api.anthropic.com` and intelligently routes each request to the optimal Anthropic model (Opus / Sonnet / Haiku) per-turn — a configurable, learning replacement for Claude Code's built-in `opusplan`.

## 2. Motivation

`opusplan` is a binary switch: plan → Opus, execute → Sonnet. It never routes to Haiku, and it has no notion of task complexity. `ccmux` replaces that with a three-layer decision system:

1. **Policy layer** — user-configurable signal-based rules (authoritative).
2. **Classifier layer** — LLM + heuristic complexity scoring when policy abstains.
3. **Feedback layer** — outcome logging + offline `ccmux tune` suggestions.

## 3. Architectural Decision: Local API Proxy

Pattern: Claude Code is pointed at `ANTHROPIC_BASE_URL=http://localhost:<PORT>`. `ccmux` intercepts every `/v1/messages` call, inspects the request, rewrites the `model` field per routing logic, and forwards to `https://api.anthropic.com` via `undici.dispatcher.stream()`. SSE chunks are byte-for-byte forwarded with zero buffering.

Alternatives rejected (SDK wrapper, hooks, pre-flight router). See original spec for rejection reasoning.

**Auth:** transparent passthrough. `ccmux` owns zero credentials.

## 4. Explicit Non-Goals

- Non-Anthropic providers.
- Replacing Claude Code or the Agent SDK.
- Auth management / credential storage.
- Graphical rule builder (YAML is the UX).
- Distributed / multi-user mode.

## 5. Runtime & Stack

- **Language:** TypeScript strict.
- **Runtime:** Node.js 20+.
- **HTTP framework:** Fastify.
- **Upstream HTTP client:** `undici` (`dispatcher.stream()` for the hot path; `fetch` for auxiliary classifier calls).
- **Logging:** pino (structured JSON).
- **Config format:** YAML at `~/.config/ccmux/config.yaml` (**XDG-style cross-platform** — same path on Windows/macOS/Linux).
- **Testing:** Vitest with record/replay fixtures; live integration gated behind `CCMUX_LIVE=1`.
- **Dashboard stack:** TypeScript dashboard server + Vite + React + Recharts SPA frontend.

## 6. v1 Scope and Shipping

- **v1.0 ships all four phases together.** Phase 0 is still independently testable and could be cut as v0.1 if schedule demands.
- **Distribution (all four):**
  1. `npx ccmux@latest` — zero-install.
  2. `npm install -g ccmux` — npm global.
  3. Standalone binary via `pkg` or `bun build` — single executable, no Node required. Linux x64/arm64, macOS x64/arm64, Windows x64.
  4. Docker image — `ghcr.io/<owner>/ccmux:<tag>`.
- CI must produce all four artifacts on tagged releases.

## 7. CLI Surface

Wrapper pattern — no long-lived daemon. The wrapper process owns the proxy lifecycle.

| Command | Purpose |
|---|---|
| `ccmux run -- <command> [args...]` | Start proxy, set `ANTHROPIC_BASE_URL` + forwarded auth env vars, exec `<command>` (typically `claude`), tear down on exit. |
| `ccmux init [--recipe frugal\|balanced\|opus-forward]` | Write a starter `config.yaml` with the chosen recipe. |
| `ccmux status` | Reports whether a `ccmux run` is active and on which port. |
| `ccmux explain <request.json>` | Dry-run the rule set against a sample request and print which rule fired and why. |
| `ccmux report [--since 7d\|24h\|...]` | Print decision-log tables to terminal (routing distribution, cost breakdown, cache-hit rate, latency percentiles). |
| `ccmux dashboard` | Launch the SPA dashboard (local HTTP server, opens browser). |
| `ccmux tune` | Analyze decision log, surface poorly-performing rules, output a unified diff of suggested config changes. **Never auto-edits.** |
| `ccmux version` | Print version. |

Plus a debug convenience: `ccmux start [--foreground]` for running the proxy without the exec wrapper (useful in tests and for users who prefer the classic daemon pattern).

## 8. Four-Phase Architecture

Build in order.

### Phase 0 — Transparent Proxy

Zero observable difference from hitting Anthropic directly.

- Fastify on configurable port (default **8787**).
- Port collision: auto-pick next free port, print the chosen port prominently. Wrapper propagates to `ANTHROPIC_BASE_URL`.
- Localhost-only bind (`127.0.0.1`), never `0.0.0.0`.
- `reply.hijack()` + `undici.dispatcher.stream()` for `/v1/messages`. SSE byte-for-byte forwarding.
- **Non-`/v1/messages` endpoints:** pass through unchanged. No 404s, no transformations. Forward-compat by default.
- Forward all headers verbatim (minus hop-by-hop per RFC 7230).
- Forward unknown request/response fields verbatim — no typed schema validation.
- Faithful propagation of status codes, error bodies, rate-limit headers (`anthropic-ratelimit-*`, `retry-after`, `request-id`).
- Config at `~/.config/ccmux/config.yaml`.
- `/healthz` endpoint.
- Structured pino logs to `~/.config/ccmux/logs/`; auth headers sanitized.

**Tests required in Phase 0:**
- Proxy-faithfulness (golden-file, non-streaming + streaming).
- Auth passthrough (API key, Bearer/OAuth).
- Forward-compat (inject unknown fields).
- SSE integrity (chunk ordering, `ping` events preserved).
- Error propagation (4xx, 5xx, mid-stream errors).

### Phase 1 — Policy Layer

Rule engine over extracted signals. Rules authoritative — if any rule fires, classifier doesn't run.

**Signals extracted per request:**
- Plan-mode marker in system prompt.
- Message count.
- Tool types declared.
- Tool-use pattern in history.
- Estimated input tokens.
- File/path count referenced in messages.
- Retry count (per-session map).
- User-frustration markers ("no", "stop", "why did you", "that's wrong").
- Explicit model hint (what Claude Code asked for).
- Project path (inferred from tool calls).
- Session duration.
- Beta headers / feature flags.

**Rule DSL in YAML:**
- Composable boolean logic (`all`, `any`, `not`).
- Each rule returns a model choice or `abstain`.
- First match wins.
- **File watcher hot-reload** (500ms debounce). Validation errors logged, old config stays active on failure.

**Sticky-model session behavior:**
- Session identity: `metadata.user_id` if present, else hash of `system` + first user message.
- Once a session picks a model, stay unless an escalation rule explicitly allows a switch.
- Asymmetric escalation: cheap → expensive is free; expensive → cheap requires a strong signal.
- In-memory `Map<sessionId, {model, createdAt, lastSeenAt, turnCount}>` with TTL eviction (default 2h).

**Default policy: opinionated baseline rules ship enabled.** Ships three named recipes:
- `frugal` — aggressive Haiku usage.
- `balanced` (default from `ccmux init`) — middle ground.
- `opus-forward` — prefer Opus for anything non-trivial.

**`mode: shadow`** config setting — when `shadow`, ccmux logs what it *would* route but forwards the user's originally-requested model. No CLI flag for this (prevents accidental use).

### Phase 2 — Classifier Layer

Runs only when no Phase 1 rule fires.

- **Primary:** Haiku-backed classifier. Model configurable in YAML (default `claude-haiku-4-5-20251001`). Input: `{system, last N messages, tool list}`. Output: `{score, suggestedModel, confidence}`. Uses prompt caching on the classifier's own call. Hard timeout (default 800ms).
- **Fallback:** local heuristic scorer. Zero latency. Inputs: token counts, tool breadth, code-block density, imperative-vs-question detection, file-path count.
- Both run **in parallel**. Whichever returns first within the latency budget wins.
- Pluggable `Classifier` TypeScript interface.
- Results cached per message-hash (TTL invalidated) to skip repeats.
- Classifier cost tagged separately in decision log and shown both "with overhead" and "without" in the dashboard.

### Phase 3 — Feedback Loop

Per-decision log to `~/.config/ccmux/decisions/<rotation>.jsonl`:

```json
{
  "timestamp": "...",
  "session_id": "...",
  "request_hash": "...",
  "extracted_signals": { ... },
  "policy_result": { "rule_id": "...", "choice": "opus" } | null,
  "classifier_result": { "score": ..., "suggested": "haiku", "confidence": 0.82 } | null,
  "chosen_model": "...",
  "chosen_by": "policy" | "classifier" | "fallback" | "sticky",
  "upstream_latency_ms": ...,
  "cost_estimate_usd": ...,
  "input_tokens": ...,
  "output_tokens": ...,
  "cache_read_input_tokens": ...,
  "cache_creation_input_tokens": ...
}
```

**Log retention:** configurable in `config.yaml`. Default: daily rotation, 30-day retention. User can override rotation strategy + retention.

**Outcome tagging** (observed passively):
- Session continued successfully.
- Same prompt retried.
- User followed up with frustration marker.
- Session abandoned.

**`ccmux tune`:** analyzes log, surfaces weak rules, outputs a unified diff. Never auto-edits.

**Privacy:** default hashes message content and tool arguments. Opt-in full logging via `config.yaml`. No CLI flag (prevents accidental full-content logs).

### Phase 4 — Observability

Two surfaces:

**CLI: `ccmux report`** — prints ASCII tables. `--since 7d`, `--group-by project`, etc. Handles ~80% of day-to-day usage.

**SPA dashboard: `ccmux dashboard`** — Vite + React + Recharts.
- Localhost-only HTTP server, opens browser.
- Per-decision audit trail (signals → rule fired → chosen model → outcome).
- Cost-per-model-per-project breakdown.
- Cache-hit rate.
- Routing distribution.
- Latency percentiles (p50, p95, p99) — proxy overhead + upstream separately.
- Prometheus `/metrics` endpoint.
- Pricing table sourced from `config.yaml` (user-updatable as Anthropic prices change).

## 9. Cross-Cutting Concerns

1. **SSE correctness** — chunks pass through byte-for-byte. Tested against real Anthropic fixtures.
2. **Forward-compat** — unknown fields pass verbatim. No strict schemas on bodies.
3. **Prompt-cache invalidation** — sticky-model is the default to avoid thrashing.
4. **Beta headers** — `anthropic-beta` forwarded untouched; classifier respects flags present there.
5. **Performance budget** — end-to-end added latency from proxy + routing decision < 50ms p95 (excl. async Haiku classifier).
6. **Windows support** — cross-platform paths (forward slashes in code, `path.join` at boundaries). Same XDG config path on all OSes. No bash-only tooling in runtime.
7. **Security** — localhost-only bind. No credentials persisted. Sanitized logs. **Zero telemetry**, ever.

## 10. Engineering Standards

- 80% test coverage minimum on new code.
- Files under 400 lines, functions under 50.
- TypeScript strict, no `any` except at JSON boundaries (commented).
- No `console.log` — pino only.
- Immutability — no mutation; spread operators.
- Errors: Result-style for expected failures.
- Validate at system boundaries only.
- No hardcoded secrets.

## 11. Success Criteria

- `ANTHROPIC_BASE_URL=http://localhost:<PORT>` → Claude Code feels identical.
- On realistic workloads, > 30% of requests route to Haiku (previously going to Sonnet) with no measurable quality regression.
- `ccmux tune` surfaces at least one actionable suggestion from a week of real use.
- Phase 0 is independently shippable; later phases slot on top without refactoring Phase 0.
- All four distribution artifacts produced by CI on each tagged release.
