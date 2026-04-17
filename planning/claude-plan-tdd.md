# ccmux — TDD Plan (companion to `claude-plan.md`)

Test stubs to write **before** implementing each section of the plan. Mirrors the structure of `claude-plan.md`. Framework: **Vitest** with record/replay fixtures (see `claude-research.md` §5). Live integration tests gated behind `CCMUX_LIVE=1`; fixture recording gated behind `CCMUX_RECORD=1`.

**Stubs only** — prose descriptions or one-line test names. The implementer fleshes out fixtures, mocks, and assertions.

---

## 1. Product Overview

No tests. Prose-only section.

## 2. Non-Negotiable Properties

These are global invariants tested by suites below (response byte-equality in §6.9, auth passthrough, cache-control preservation, etc.). No separate tests here — tracked as acceptance criteria in PR descriptions.

## 3. Technology Choices

No tests.

## 4. Directory Structure

- Test: repository lint check rejects a new `src/` file above 400 lines.
- Test: repository lint check rejects a new function above 50 lines.

## 5. Core Types

- Test: `Tier` ordering helper returns `haiku < sonnet < opus` for known model IDs.
- Test: `Tier` helper returns `undefined` for a custom model ID without an explicit tier mapping in config.
- Test: `ContentBlock` type guard accepts both `string` and `ContentBlock[]` shapes for `messages[].content`.
- Test: `Result<T>` success and failure factories produce the expected discriminated union.

## 6. Phase 0 — Transparent Proxy

### 6.1 Request lifecycle (`/v1/messages`)

- Test: POST `/v1/messages` with `model: "claude-sonnet-4-6"` forwards to upstream with the same model when no rule fires (Phase 0 baseline — no policy engine yet).
- Test: upstream 200 non-streaming JSON response is returned byte-for-byte identical to the fixture capture (golden file).
- Test: upstream 200 SSE response chunks are written to the client socket in the **exact order and bytes** captured in the fixture (no reassembly, no buffering).
- Test: `reply.hijack()` is called before any body byte is written (spy on Fastify reply).
- Test: client `AbortSignal` fires when the client socket closes mid-request, and upstream request is aborted (observed via upstream server spy).

### 6.2 Non-`/v1/messages` passthrough

- Test: `GET /v1/models` is proxied unchanged (status, headers, body).
- Test: `POST /v1/messages/count_tokens` with a query string preserves the query string on the upstream URL.
- Test: an unknown future path `POST /v1/foo` is proxied with no 404, preserving method, headers, body.
- Test: non-JSON content type (e.g. `application/octet-stream`) is proxied without body mutation.

### 6.3 Hop-by-hop and proxy-specific header handling

- Test: the exact hop-by-hop header list (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-authenticate`, `proxy-authorization`) is removed from both request and response.
- Test: `host` is rewritten to `api.anthropic.com` on the upstream request.
- Test: `accept-encoding` is dropped on the upstream request (we never want compression on the SSE path).
- Test: duplicate-valued headers are preserved via undici raw-header arrays (e.g. two `set-cookie` values both reach the client).
- Test: `anthropic-*` headers on both directions are passed verbatim.
- Test: `x-request-id`, `retry-after`, `anthropic-ratelimit-*` all round-trip verbatim.
- Test: `Authorization: Bearer …` and `x-api-key` are both forwarded untouched (auth passthrough).

### 6.4 Body handling

- Test: the forwarded request body is **byte-identical** to the original when no model rewrite occurs.
- Test: with a rewrite, the **only** JSON semantic diff between original and forwarded body is `model`.
- Test: unknown top-level fields in the request body survive round-trip (forward-compat).
- Test: `cache_control` markers on message blocks are never stripped or reordered.
- Test: body > `bodyLimit` is rejected with a clear error (not silently truncated).

### 6.5 Streaming correctness

- Test: `ping` SSE events are forwarded verbatim (not consumed).
- Test: `content_block_delta` events arrive in the same order and quantity as the fixture.
- Test: `message_delta` and `message_stop` terminate the client stream; no trailing bytes.
- Test: `reply.raw.socket.setNoDelay(true)` is set on the socket (spy).
- Test: no `Content-Length` is set on SSE responses (chunked encoding only).
- Test: no gzip/br middleware is registered on response path (property assertion on Fastify instance).

### 6.6 Health + port binding

- Test: `/healthz` returns 200 with `{ok: true}`.
- Test: server binds to `127.0.0.1`, never `0.0.0.0` (assert listener address).
- Test: port collision: when 8787 is in use, proxy selects next free port via sequential try-and-catch-`EADDRINUSE` and prints it.
- Test: Expect: 100-continue request from a client still works end-to-end.
- Test: HTTP/2 prior-knowledge request is rejected with a clear error (proxy is HTTP/1.1-only).

### 6.7 Error propagation

- Test: upstream 4xx error body is returned verbatim (including `request-id`).
- Test: upstream 5xx error body is returned verbatim.
- Test: upstream disconnect mid-stream produces a synthetic Anthropic-shaped SSE `event: error` then closes the client socket (the documented §2.3 carve-out).
- Test: pino log emitted for each failure mode includes `request-id` when available, never raw auth headers.

### 6.8 Proxy token (optional local auth)

- Test: when `CCMUX_PROXY_TOKEN` env is set, requests missing the matching `x-ccmux-token` header are rejected with 401.
- Test: when `CCMUX_PROXY_TOKEN` is unset (debug mode via `ccmux start`), requests without the header are accepted.
- Test: `ccmux run -- claude …` always sets a random token and injects it into the child env.
- Test: the token never appears in any log line (sanitized).

### 6.9 Phase 0 tests

Umbrella acceptance suite:
- Test: **proxy-faithfulness non-streaming** — captured request → captured response diffed byte-for-byte.
- Test: **proxy-faithfulness streaming** — captured SSE session diffed chunk-for-chunk.
- Test: **forward-compat** — inject unknown fields at every known nesting level, verify round-trip.
- Test: **performance smoke** — added latency vs. direct upstream p95 < 50ms (measured after body fully received; moved to soft-gate suite per §15).

## 7. Phase 1 — Policy Layer

### 7.1 Signal extraction

- Test: plan-mode marker detected in `system` string.
- Test: plan-mode marker detected when `system` is a `ContentBlock[]`.
- Test: message count extractor tolerates both `content: string` and `content: ContentBlock[]`.
- Test: tool-types extractor returns the distinct set of tool names from `tools[]`.
- Test: estimated-input-tokens returns a value within ±5% of the upstream `usage.input_tokens` on recorded fixtures.
- Test: file/path count detects `read_file`, `write`, `edit` tool-use patterns in history.
- Test: retry count increments when the same `requestHash` repeats within a session.
- Test: frustration markers detected in the most recent user message ("no", "stop", "why did you", "that's wrong") — case-insensitive.
- Test: explicit `model` in request captured as a signal.
- Test: project path inferred from any file path present in recent tool calls.
- Test: session duration computed from `createdAt`.
- Test: beta headers array populated from `anthropic-beta` comma-split.
- Test: any extractor that throws degrades to `null`/`undefined` for that signal — **never fails the request**.

### 7.2 Canonical request hashing

- Test: `sessionId = HMAC_SHA256(localSalt, systemPrefix + firstUserMsgPrefix)` is stable across re-orderings of unrelated fields.
- Test: `localSalt` is regenerated on each proxy startup (two startups → different hashes for the same input).
- Test: `requestHash` is 32 hex chars (128 bits).
- Test: canonical form excludes `model` and volatile fields (timestamps, request IDs).
- Test: JSON serialization uses sorted keys.
- Test: `metadata.user_id`, when present, takes precedence over the HMAC-derived sessionId.
- Test: hashing never throws on unexpected content-block shapes (degrades to a random-per-connection session).

### 7.3 Rule DSL

- Test: `all`, `any`, `not` composition evaluates correctly against fixture signals.
- Test: first-match-wins: later rules do not run once an earlier rule returns a concrete model.
- Test: `abstain` causes the engine to fall through to the next rule.
- Test: YAML with an invalid rule shape is rejected at load time with a pointer to the bad rule.
- Test: hot-reload (500ms debounce): editing `config.yaml` swaps the rule set without restart.
- Test: hot-reload with invalid YAML keeps the previous config active and logs a validation error.
- Test: rule referencing an unknown signal fails validation.

### 7.4 Sticky-model policy

- Test: tier order `haiku < sonnet < opus` enforced by `compareTiers()`.
- Test: cheap → expensive escalation allowed with no rule signal required.
- Test: expensive → cheap downgrade requires a matching escalation rule; otherwise sticky model wins.
- Test: when the client's request explicitly names a model, the classifier may never downgrade below that tier unless a rule fires.
- Test: custom `modelId` without an explicit `tier` mapping is rejected at config-load time.
- Test: TTL eviction: entry older than 2h is removed on next lookup.
- Test: `turnCount` increments on each matched session lookup.

### 7.5 Recipes

- Test: `ccmux init --recipe frugal` writes a YAML file parseable by the config loader.
- Test: `balanced` recipe produces a config that routes a mixed fixture set with ≥30% Haiku.
- Test: `opus-forward` recipe routes ≥60% of non-trivial fixtures to Opus.

### 7.6 `mode: shadow`

- Test: in shadow mode, the forwarded `model` equals the original request's `model` (no rewrite).
- Test: in shadow mode, decision log still records the would-have-been model under a `shadow_choice` field.
- Test: no CLI flag toggles shadow mode (assert `--shadow` not accepted).

### 7.7 `ccmux explain <request.json>`

- Test: given a fixture request and config, prints the winning rule ID (or "abstain → classifier").
- Test: prints extracted signals in a stable, human-readable table.
- Test: exits non-zero when the request JSON is malformed.

## 8. Phase 2 — Classifier Layer

### 8.1 Interface

- Test: `Classifier` interface contract: `classify(signals, req) → Promise<{score, suggestedModel, confidence} | null>`.
- Test: a classifier that throws is treated as returning `null` (never fails the request).

### 8.2 Haiku classifier

- Test: outbound host allowlist: classifier call to any host other than `https://api.anthropic.com/v1/messages` throws at build time.
- Test: classifier reuses the intercepted request's `x-api-key`/`authorization`, `anthropic-version`, `anthropic-beta` headers.
- Test: classifier hard-timeout (default 800ms) resolves to `null` without cancelling upstream.
- Test: classifier call uses prompt caching on its own prompt (verify `cache_control` marker in outbound body).
- Test: cost returned by classifier tagged as `classifier_cost_usd` separate from request cost.

### 8.3 Heuristic classifier

- Test: zero-latency: synchronous call returns in < 1ms on fixture inputs.
- Test: large token count + broad tool set → suggests Opus.
- Test: small token count + single tool → suggests Haiku.
- Test: imperative vs. question detection correctly classifies fixture phrasing.

### 8.4 Result cache

- Test: repeat call with the same message-hash within TTL returns the cached verdict (no upstream call).
- Test: message-hash changes → cache miss → upstream call.
- Test: parallel-race: whichever of Haiku/heuristic returns first within the latency budget wins.

## 9. Phase 3 — Feedback Loop

### 9.1 Decision log writer

- Test: one JSONL line per decision, matching the documented schema.
- Test: chosen model recorded is the **actual** forwarded model, not inferred from the request.
- Test: in-process byte counter triggers rotation at configured size without calling `stat` on every append.
- Test: startup stats the current log file to resume the byte counter accurately.
- Test: daily rotation (default) creates a new file at local midnight.
- Test: retention (default 30d) deletes files older than the window on rotation.
- Test: backpressure: a single write stream handles bursts without losing lines.
- Test: durability: no `fsync` on each append (documented as best-effort).

### 9.2 Cost accounting

- Test: parses `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Test: streaming path accumulates `message_delta.usage` at stream end.
- Test: when usage fields are absent (or the stream errored before `message_delta`), cost is left `null` and logged as `cost_unavailable`.
- Test: pricing table loaded from `config.yaml` drives per-model cost math.

### 9.3 Outcome tagging

- Test: "session continued successfully" tag when next turn is not a retry.
- Test: "same prompt retried" tag when `requestHash` repeats within N seconds.
- Test: "frustration marker" tag when a follow-up user message contains a marker.
- Test: "session abandoned" tag when no follow-up within idle TTL.

### 9.4 Privacy

- Test: `content: hashed` (default) replaces message content with a 32-char hex digest.
- Test: `content: full` logs raw content (opt-in via config only).
- Test: `content: none` drops content/tool-input fields entirely.
- Test: no CLI flag toggles any privacy mode.
- Test: auth headers never written to any log regardless of mode.

### 9.5 `ccmux tune`

- Test: given a log file with a rule that fired on 100 turns with 80% frustration follow-ups, surfaces the rule as weak.
- Test: outputs a **unified diff** against `config.yaml`, never edits in place.
- Test: exits 0 even when no suggestions are found.

## 10. Phase 4 — Observability

### 10.1 `ccmux report` CLI

- Test: `--since 7d` filters log entries by timestamp.
- Test: `--group-by project` aggregates cost by inferred project path.
- Test: routing-distribution table sums to 100%.
- Test: "with overhead" vs "without overhead" totals differ by the sum of `classifier_cost_usd`.
- Test: exits non-zero when the log directory is missing.

### 10.2 SPA dashboard

- Test: dashboard HTTP server binds to `127.0.0.1`.
- Test: `/api/decisions?limit=2000` is clamped to max 1000.
- Test: `/api/decisions` with no `limit` defaults to 100.
- Test: SPA bundle has zero outbound CDN URLs (CI check that parses built `index.html` + bundled assets).
- Test: SPA bundle has no remote source-map URLs.
- Test: Recharts components render without a network connection.

### 10.3 Metrics

- Test: `/metrics` endpoint returns Prometheus text format.
- Test: includes counters for routing decisions per model, cache-hit rate, p50/p95/p99 latency.

## 11. Wrapper Process (`ccmux run`)

- Test: `ccmux run -- claude --version` sets `ANTHROPIC_BASE_URL` in the child env.
- Test: wrapper propagates `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` if present in parent env.
- Test: SIGINT on wrapper → child receives SIGINT → proxy tears down cleanly → log stream flushes.
- Test: SIGTERM: same as above.
- Test: child non-zero exit propagates to wrapper exit code.
- Test: when port 8787 is busy, wrapper injects the chosen port into child env.
- Test: `NO_PROXY=127.0.0.1` is set in child env (Windows-safe, see edge case).
- Test: `CCMUX_PROXY_TOKEN` is generated and injected.

## 12. Distribution

- Test: `pkg` CJS bundle smoke test — packaged binary starts, responds to `/healthz`, exits on SIGINT. Runs in CI on every tag RC.
- Test: `bun build --compile` fallback produces a working binary (same smoke test).
- Test: `npx ccmux@latest --version` works against the packed tarball.
- Test: Docker image smoke test — `docker run --rm ghcr.io/.../ccmux:<tag> --version`.
- Test: all four artifacts produced on a tagged release (CI workflow assertion).

## 13. Configuration Reference

- Test: every documented YAML key is accepted by the loader.
- Test: unknown top-level keys produce a warning, not a crash (forward-compat for future keys).
- Test: schema validator produces a pointer to the bad path on invalid input.
- Test: config file at `~/.config/ccmux/config.yaml` is loaded on all three OSes (CI matrix: linux, macos, windows).

## 14. Error Handling Strategy

- Test: expected failures use `Result<T>`; exceptions only for truly exceptional conditions.
- Test: no `console.log` in the codebase (lint rule).
- Test: no `any` without a `// boundary` comment (lint rule).

## 15. Performance Budget

**Soft-gate suite** — runs on a separate workflow, not a PR blocker:
- Test: end-to-end added latency (proxy + routing, excl. classifier) p95 < 50ms.
- Test: regression gate: fail only when p95 > 1.5× rolling baseline.
- Test: measurement starts after body fully received (not `onRequest`).

## 16. Cross-Cutting Requirements

- Test: Windows path handling — no hardcoded forward slashes in path joins.
- Test: zero outbound requests from the ccmux backend to any host other than `api.anthropic.com` (CI network-stub assertion).
- Test: no auto-update check on startup.
- Test: fixture recording requires `CCMUX_RECORD=1`; disabled by default.

## 17. Testing Strategy

### 17.1 Record/replay

- Test: record-mode captures an SSE session to `tests/fixtures/<name>.jsonl` with full byte contents.
- Test: replay-mode serves the fixture with realistic inter-chunk delays (delta timestamps preserved).
- Test: live integration suite (`CCMUX_LIVE=1`) is excluded from default `vitest` runs.

### 17.2 Test groupings

- Test: each grouping (`proxy`, `policy`, `classifier`, `feedback`, `dashboard`, `cli`) runs as an independent Vitest project.
- Test: 80% line coverage floor enforced on new code via `vitest --coverage`.

## 18. Implementation Order (Section Split Plan)

No tests. Meta section.

## 19. Risks & Open Items

No tests. Meta section.

---

## Coverage target

80% line coverage minimum on every new file. Per `claude-research.md` §5, SSE suites must run against a real listening socket (not `@fastify/inject`).
