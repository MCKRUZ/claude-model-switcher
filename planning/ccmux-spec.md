# ccmux — Intelligent Claude Code Model Router

## One-line summary

A local HTTPS API proxy that sits between Claude Code and `api.anthropic.com` and intelligently routes each request to the optimal Anthropic model (Opus / Sonnet / Haiku) per-turn — a smarter, configurable, learning replacement for Claude Code's built-in `opusplan`.

## Motivation

Claude Code's `opusplan` is a hardcoded binary switch: plan mode → Opus, execute mode → Sonnet. It has two structural weaknesses:

1. It **never considers Haiku** for trivial work (typos, one-line fixes, simple questions), so users overpay.
2. It **has no notion of task complexity** — a one-line refactor and a cross-file architectural change both route to Sonnet.

`ccmux` replaces that heuristic with a three-layer decision system:

- **Policy layer** — user-configurable signal-based rules (authoritative).
- **Classifier layer** — task-complexity scoring when policy abstains.
- **Feedback layer** — outcome logging + offline tuning to improve routing over time.

## Architectural decision: local API proxy

**Pattern:** Claude Code is pointed at `ANTHROPIC_BASE_URL=http://localhost:<PORT>`. `ccmux` intercepts every `/v1/messages` call, inspects the request, rewrites the `model` field according to routing logic, forwards to `https://api.anthropic.com`, and streams the response back faithfully.

**Why this pattern (alternatives rejected):**

- **SDK wrapper (rejected):** would require rebuilding Claude Code's harness — losing plugin marketplace, IDE extensions, built-in slash commands, statusline. Projects like claude-code-router (that build a full SDK wrapper) solve a different problem.
- **Hooks + settings.json edits (rejected):** hooks cannot set the model (feature request pending, not implemented). `settings.json` is read once at startup. Unreliable.
- **Pre-flight router (rejected):** only gives per-session routing. Loses parity with `opusplan`'s per-turn switching.
- **Local API proxy (chosen):** preserves 100% of Claude Code. Gives full per-turn control. Full request visibility. Language-agnostic. Proven pattern (claude-code-router uses the same mechanism for a different purpose).

**Auth:** transparent passthrough. `ccmux` forwards all auth headers (`x-api-key`, `Authorization`, `anthropic-version`, `anthropic-beta`, AWS sigv4, GCP tokens) untouched. `ccmux` owns zero credentials. Whatever auth mechanism Claude Code uses (API key, OAuth/Claude Max, Bedrock, Vertex) works automatically.

## Explicit non-goals

- Non-Anthropic providers (OpenAI, DeepSeek, Ollama). **Anthropic-only.**
- Replacing Claude Code or the Agent SDK. We sit beside Claude Code.
- Auth management / credential storage.
- A graphical rule builder. YAML config is the UX.
- Distributed / multi-user mode. Single-user localhost only.

## Runtime & stack

- **Language:** TypeScript (strict mode).
- **Runtime:** Node.js 20+.
- **HTTP framework:** Fastify.
- **Logging:** pino (structured JSON).
- **Config format:** YAML (`~/.config/ccmux/config.yaml`).
- **Testing:** Vitest.
- **Cross-platform:** must work on Windows 11 (primary), macOS, Linux. No bash-only tooling in the runtime path.

## Four-phase architecture

Build in strict order — each layer depends on the previous.

### Phase 0 — Transparent Proxy (must be bulletproof before anything else)

Acceptance: user sets `ANTHROPIC_BASE_URL=http://localhost:<PORT>` and experiences **zero observable difference** from hitting Anthropic directly.

Requirements:

- Fastify server on configurable port (default 11434 or similar).
- Binds localhost only by default, never `0.0.0.0`.
- SSE passthrough that forwards chunks **as they arrive** — no buffering, no reordering, no chunk boundary changes.
- Forward all request headers verbatim (including unknown headers).
- Forward unknown request body fields verbatim (do NOT reserialize through a strict schema — Anthropic ships new fields constantly, we must be forward-compatible).
- Forward unknown response fields verbatim.
- Faithfully propagate upstream status codes, error bodies, rate-limit headers.
- Config file at `~/.config/ccmux/config.yaml` (Windows: `%APPDATA%\ccmux\config.yaml`).
- CLI: `ccmux start`, `ccmux stop`, `ccmux status`, `ccmux version`.
- Health check endpoint (`/healthz`).
- Structured JSON request/response logging to `~/.config/ccmux/logs/` (sanitize auth headers — never log credentials).
- Test suite:
  - Proxy-faithfulness tests (golden-file comparison vs. direct Anthropic calls, non-streaming + streaming).
  - Auth-passthrough tests (API key, Bearer token).
  - Forward-compat tests (inject unknown fields, confirm passthrough).
  - SSE integrity tests (chunk timing, ordering).
  - Error propagation tests (4xx, 5xx, rate limits).

### Phase 1 — Policy Layer (signal-based user-configurable rules)

Rule engine over extracted signals. Rules are **always authoritative** — if any rule fires, later layers don't run.

Signals to extract:

- Plan-mode marker in system prompt.
- Message count in conversation.
- Tool types declared in the request.
- Tool-use pattern in message history (which tools, how many calls).
- Estimated input tokens.
- File / path count referenced in messages.
- Retry count (per-session in-memory map keyed on first-message fingerprint).
- User-frustration markers in latest user message ("no", "stop", "why did you", "that's wrong").
- Explicit model hint in the request (what Claude Code asked for).
- Project-path markers (cwd inferred from tool calls — which repo is the user in).
- Session duration.
- Beta headers / feature flags present.

Rule DSL in YAML:

- Declarative conditions with composable boolean logic (`all`, `any`, `not`).
- Each rule returns either a model choice or `abstain` (falls through).
- Rules evaluated in config order; first match wins.
- Hot-reload on file change.
- `ccmux explain <request.json>`: dry-run a rule set against a sample request and show which rule fired and why.

Example rule shapes:

- `if plan_mode: opus`
- `if message_count < 3 and tool_use_count == 0: haiku`
- `if retry_count >= 2: escalate(opus)`
- `if project_path matches "research": default(opus)`
- `if frustration_marker: escalate_one_tier`

Sticky-model option: once a session picks a model, stay with it unless a rule explicitly allows escalation. Prevents prompt-cache thrashing.

### Phase 2 — Classifier Layer (complexity scoring when policy abstains)

Runs only when no Phase 1 rule fired.

- **Primary:** Haiku-backed complexity classifier. Input: `{system_prompt, last N messages, tool list}`. Output: complexity score + suggested model + confidence. Uses prompt caching. Hard timeout (default 800ms).
- **Fallback:** local heuristic scorer. Zero-latency. Inputs: token counts, tool breadth, code-block density, imperative-vs-question detection, file-path count.
- Both run **in parallel**. Whichever returns a valid result first within the latency budget wins. If Haiku times out, fallback result is used.
- Pluggable interface (`Classifier` TypeScript interface) — future classifiers (fine-tuned model, embedding-based, etc.) slot in without refactoring.
- Results cached per message-hash (invalidated on TTL) to skip re-classifying repeated inputs.
- Test suite: labeled fixture set, timeout/fallback behavior, cache semantics.

### Phase 3 — Feedback Loop (decision logging + outcome tagging + offline tuning)

Every decision logged to `~/.config/ccmux/decisions.jsonl` with this shape:

```
{
  timestamp, session_id, request_hash,
  extracted_signals,
  policy_result, classifier_result,
  chosen_model,
  upstream_latency_ms, cost_estimate_usd,
  input_tokens, output_tokens, cache_read_tokens
}
```

**Outcome tagging** (observed passively, no user action required):

- Session continued successfully (no retries, no frustration markers).
- Same prompt retried (user unhappy with response).
- User followed up with a frustration marker in the next turn.
- Session abandoned (no follow-up turn within a window).

**`ccmux tune` offline script:**

- Analyzes the decision log.
- Surfaces rules with poor outcomes.
- Suggests threshold adjustments.
- Optionally proposes new rules based on observed patterns.
- **Never auto-edits user config.** Outputs a unified diff for human review.

**Privacy:** log content hashes by default. Full message content only if the user opts in via `config.yaml`.

### Phase 4 — Observability

- `ccmux dashboard`: local web UI (localhost-only), showing:
  - Per-decision audit trail (which signals, which rule fired, which model chosen, outcome).
  - Cost-per-model-per-project breakdown.
  - Cache-hit rate.
  - Routing distribution (what % of requests went to each model).
  - Latency percentiles (p50, p95, p99 for proxy overhead + upstream).
- Prometheus-compatible `/metrics` endpoint.
- Cost calculator using configurable Anthropic pricing table.
- Per-project grouping based on detected cwd signals.

## Cross-cutting concerns

All phases must respect these:

1. **SSE streaming correctness.** Chunks pass through without buffering or reordering. Test against real Anthropic streaming responses.
2. **Forward-compatibility.** Unknown request/response fields pass through verbatim. Permissive proxy pattern, not a strict typed schema.
3. **Prompt-cache invalidation.** Switching models mid-conversation breaks cache. Policy engine has a sticky-model mode to avoid thrashing.
4. **Beta headers.** `anthropic-beta` forwarded untouched and may imply feature flags the classifier should respect.
5. **Performance budget.** End-to-end added latency from proxy + routing decision < 50ms p95 (excluding Haiku classifier which runs async).
6. **Windows support.** Cross-platform paths, line endings, process management. No bash-only tooling in the runtime path.
7. **Security.** Localhost-only binding. No credentials persisted. Logs sanitize auth headers. No telemetry sent anywhere by default.

## Engineering standards (from user's global CLAUDE.md)

- 80% test coverage minimum on new code.
- Files under 400 lines, functions under 50.
- TypeScript strict mode, no `any` except at JSON boundaries (commented).
- No `console.log` — pino only.
- Immutability: never mutate objects/arrays; spread operators.
- Errors: Result-style for expected failures, exceptions only for truly exceptional.
- Validate at system boundaries only (inbound HTTP, user config). Trust internal code.
- No hardcoded secrets. No scope creep beyond the four phases.

## Success criteria

- A user can `export ANTHROPIC_BASE_URL=http://localhost:<PORT>` and run `claude` with zero perceived difference in behavior, speed, or feature availability.
- Given a realistic workload, `ccmux` routes > 30% of requests to Haiku (previously routed to Sonnet by `opusplan`) with no measurable quality regression.
- Decision log + `ccmux tune` can surface at least one actionable rule-tuning suggestion from a week of real usage.
- All four phases are independently testable and deployable; Phase 0 is shippable as a v0.1 with no intelligence, serving as a stable foundation for later phases.

## Reference projects (study, do not fork)

- [claude-code-router](https://github.com/musistudio/claude-code-router) — proves the `ANTHROPIC_BASE_URL` proxy pattern. Different problem (multi-provider), not a foundation.
- [claude-router](https://github.com/0xrdan/claude-router) — similar pattern.
- [openclaw](https://github.com/Enderfga/openclaw-claude-code) — full harness replacement.

## Open questions for the interview phase

- Default port selection (collision avoidance with common dev tools).
- Config file location strategy on Windows (XDG-style `~/.config/ccmux/` vs. `%APPDATA%\ccmux\`).
- How aggressively should the policy layer ship with default rules (opinionated vs. empty default).
- Whether to ship a small library of "recipes" (pre-built rule sets for common workflows) in v1 or defer.
- How to scope the dashboard in Phase 4 — minimal local HTML vs. a real SPA.
- Testing against Anthropic's API: record-and-replay fixtures vs. live integration tests vs. a mock server.
