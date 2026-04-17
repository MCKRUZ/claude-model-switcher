# ccmux Interview Transcript

Interview conducted during `/deep-plan` workflow to extract implementation decisions not covered by the initial spec or web research.

---

## Pre-Interview — Research Decisions

### Q0a. Codebase research?
**A:** No existing code — fresh project, only the spec exists.

### Q0b. Web research topics?
**A:** All four:
- Anthropic Messages API + SSE passthrough
- claude-code-router / ANTHROPIC_BASE_URL proxy patterns
- Anthropic prompt caching & model-switch invalidation
- Fastify streaming proxy implementation patterns

### Q0c. Testing approach?
**A:** Vitest with record/replay fixtures; live integration gated behind env var.

---

## Round 1 — v1 Scope, Shipping, Process Model

### Q1. v1 scope?
**A:** All four phases ship together as v1.0.

### Q2. Distribution channels?
**A:** All four:
- `npx ccmux@latest` (zero install)
- Standalone binary via `pkg` / `bun build`
- `npm i -g ccmux` (npm global)
- Docker image

### Q3. Process model?
**A:** `ccmux run -- claude ...` wrapper that manages lifecycle. Wrapper spawns the proxy, sets `ANTHROPIC_BASE_URL` + auth env, execs `claude`, tears down proxy on exit. No long-lived daemon.

---

## Round 2 — Policy, Recipes, Sticky Sessions, Classifier Costs

### Q4. How opinionated should the default policy be?
**A:** Ship opinionated baseline rules **enabled** by default. User can edit/disable in config.

### Q5. Recipe library?
**A:** Yes, ship recipes: `frugal` / `balanced` / `opus-forward`. `ccmux init --recipe <name>` seeds config.

### Q6. Sticky-session detection?
**A:** Use `metadata.user_id` if the request contains it; fall back to a hash of system prompt + first user message.

### Q7. Classifier (Haiku) cost accounting?
**A:** Include classifier cost in total. Dashboard shows **both** "with routing overhead" and "without" so user can see the tradeoff of the decision itself.

---

## Round 3 — Config Reload, Ports, Log Retention, Dry-Run

### Q8. Config hot-reload trigger?
**A:** File watcher with debounce (500ms). Validation errors logged, old config stays active on failure — never crashes the proxy.

### Q9. Port conflict behavior?
**A:** Auto-pick next free port and print the chosen port prominently. The wrapper pattern (`ccmux run -- claude`) makes `ANTHROPIC_BASE_URL` automatically match.

### Q10. Decision log retention policy?
**A:** Configurable in `config.yaml`. Sensible defaults (to be chosen by author), but user can override rotation strategy + retention window.

### Q11. Dry-run / shadow mode?
**A:** Yes, implemented as a `mode: shadow` setting in `config.yaml` (not a CLI flag — reduces accidental usage). In shadow mode ccmux logs what it *would have* routed but forwards everything unchanged.

---

## Round 4 — Dashboard, PII, Config Location

### Q12. Phase 4 dashboard scope?
**A:** Both:
- `ccmux report` CLI that prints tables (handles 80% of usage — `ccmux report --since 7d`, etc.)
- Vite + React + Recharts SPA for exploration/drill-down

### Q13. PII handling in decision log?
**A:** Hash message content + tool arguments by default. Opt-in full logging via config. Matches the spec's stated "hashes by default" posture.

### Q14. Config file location on Windows?
**A:** `~/.config/ccmux/config.yaml` XDG-style, cross-platform. Simpler for users who dotfile-sync.

---

## Round 5 — Port, Other Endpoints, Classifier Model, Telemetry

### Q15. Default port?
**A:** `8787` — neutral dev port with no known collisions.

### Q16. Non-`/v1/messages` endpoints behavior?
**A:** Pass through unchanged. `/v1/complete`, `/v1/messages/count_tokens`, future endpoints all forward as-is. Safest for forward-compatibility.

### Q17. Classifier model?
**A:** Latest Haiku (currently `claude-haiku-4-5-20251001`), configurable via YAML. Ship with latest as default; user can pin a specific version.

### Q18. Telemetry / crash reporting?
**A:** **Zero telemetry, ever.** Users who want to share data do so manually via GitHub issues.

---

## Summary of Derived Requirements

Requirements surfaced during the interview that must make it into the plan:

1. **CLI surface:** `ccmux run -- <command>` wrapper; `ccmux init --recipe <name>`; `ccmux report [--since ...]`; `ccmux dashboard` (launches SPA); `ccmux explain <request.json>`; `ccmux tune`; `ccmux version`; `ccmux status` (reports on a running run-wrapper if any).
2. **Lifecycle:** Proxy is owned by the wrapper process. When the wrapper exits (or gets SIGINT/SIGTERM), tear down proxy cleanly, flush logs, close upstream connections.
3. **Sticky session storage:** In-memory `Map<sessionId, stickyModelChoice>` with TTL eviction. Session ID derived from `metadata.user_id` or hash(system + first_user_message).
4. **Config schema:** Must support rules, mode (`live`/`shadow`), log rotation settings, content logging opt-in, classifier model pin, port override, default recipe.
5. **Four distribution targets** — package layout and CI must produce all four artifacts.
6. **Dashboard stack:** TypeScript server-side + React SPA frontend. The SPA reads pre-computed aggregates from a small HTTP endpoint on the dashboard process (not from the proxy).
7. **Zero telemetry** — no network calls out of the user's machine except to `api.anthropic.com`.
