# ccmux Research Report

Research conducted for the planning phase of `ccmux` — a local HTTPS proxy that sits between Claude Code and `api.anthropic.com` and rewrites the `model` field per-request to route between Opus / Sonnet / Haiku.

Stack: TypeScript strict, Node.js 20+, Fastify, pino, Vitest, YAML config.

Scope: **Anthropic-only** proxy. Claude Code points at it via `ANTHROPIC_BASE_URL=http://localhost:<PORT>`.

---

## 1. Anthropic Messages API + SSE Passthrough

### Request / response shape
- `POST /v1/messages`. Body fields: `model`, `max_tokens`, `messages[]`, optional `system`, `tools[]`, `tool_choice`, `metadata`, `stream`, `stop_sequences`, `temperature`, `top_p`, `top_k`, `thinking`, `cache_control` markers on blocks.
- `ccmux` only needs to mutate `model`. Everything else is pass-through.

### SSE event sequence (canonical order)
```
message_start → (content_block_start → [ping]* → content_block_delta* → content_block_stop)+
 → message_delta → message_stop
```
- Content block deltas include `text_delta`, `input_json_delta` (tool use — partial JSON strings), `thinking_delta`, `signature_delta`.
- `ping` events are interleaved — keep-alive, **MUST be forwarded** as-is.
- `error` event can arrive mid-stream: `event: error\ndata: {"type":"error","error":{"type":"overloaded_error",...}}`. Treat any event terminally if `error` arrives.
- Docs explicitly say: "new event types may be added, and your code should handle unknown event types gracefully." Forward-compat is mandatory.

Source: https://docs.anthropic.com/en/api/messages-streaming

### Transparent-proxy rules
- Byte-for-byte forward each SSE chunk the moment it arrives. No line-buffering, no JSON reserialization, no event reassembly.
- Preserve `text/event-stream` content-type; do NOT let any middleware set `Content-Length`; rely on chunked transfer-encoding.
- Do not compress (no gzip/br middleware on the response path) — Anthropic's stream isn't compressed and buffering breaks the UX.

### Headers that matter
- **Request:** `x-api-key` **or** `authorization: Bearer …` (OAuth / Claude Max), `anthropic-version` (required, e.g. `2023-06-01`), `anthropic-beta` (comma-separated feature flags — forward untouched, they gate response shape), `user-agent`, `x-request-id`.
- **Response:** `anthropic-ratelimit-requests-*`, `anthropic-ratelimit-tokens-*`, `anthropic-ratelimit-input-tokens-*`, `anthropic-ratelimit-output-tokens-*`, `retry-after`, `request-id`. All must round-trip verbatim — Claude Code inspects rate-limit headers for backoff.
- Strip only hop-by-hop headers per RFC 7230: `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-*`. Never rewrite `anthropic-*`.

### Forward-compat (critical)
- Anthropic ships new fields on a near-monthly cadence (thinking blocks, citations, server-tool usage sub-fields in `usage`, new content block types, new `event` types).
- **Do not validate request/response bodies against a typed schema.** Parse what you need (`model`, `system`, `messages`, `tools`) with a permissive reader; serialize the rest verbatim.
- For SSE, never parse `data:` frames on the response path — opaque byte forwarding only, except optionally parse `message_start` / `message_delta` for `usage` telemetry **after** forwarding the chunk downstream.

### Gotchas
- Tool-use streams emit `partial_json` deltas — never truncate or reorder mid-chunk.
- `fine-grained-tool-streaming` beta changes shape; don't assume.

---

## 2. claude-code-router / ANTHROPIC_BASE_URL Patterns

Sources:
- https://github.com/musistudio/claude-code-router
- https://github.com/0xrdan/claude-router

### What ccr does well
- Ships a `ccr code` wrapper that sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`, `ANTHROPIC_AUTH_TOKEN`, `API_TIMEOUT_MS`, `NO_PROXY=127.0.0.1`, then execs `claude`. **ccmux should ship the same `ccmux run -- claude …` convenience.**
- Named routing buckets: `default`, `background`, `think` (plan mode), `longContext` (triggered by `longContextThreshold`, default 60K tokens), `webSearch`, `image`. Good signal→rule taxonomy ccmux can mirror.
- Custom routing: `CUSTOM_ROUTER_PATH` → JS module exporting `async (req, config) => "provider,model" | null`. Null falls back to default. **ccmux's YAML rules should fall back to classifier exactly this way.**
- Auth posture: `APIKEY` config field requires clients to send `Authorization: Bearer` or `x-api-key`. If unset, host is forced to `127.0.0.1` — copy this default.
- Logging: pino under `~/.claude-code-router/logs/` — same convention ccmux spec already adopts.

### What ccr does poorly / ccmux must avoid
- **ccr normalizes requests to an OpenAI-ish shape then re-serializes** — a lossy path that breaks forward-compat. ccmux is Anthropic-only → keep the body as an opaque buffer whenever possible, parse only the fields needed for routing (`model`, `system[]`, `messages[]`, `tools[]`, `metadata.user_id`), splice the new `model` into the JSON via a minimal object edit (not a full reserialize).
- **ccr's `cleancache` transformer strips `cache_control`** — would devastate Claude Code's cache hit rate. ccmux must never do this.
- **ccr's `tooluse` transformer** forces XML-wrapped tool calls and, per their own docs, "cause the tool call information to no longer be streamed." A cautionary tale: transforming SSE breaks streaming. ccmux must never transform SSE events.
- ccr startup UX requires two processes (router daemon + claude). ccmux should ship as a single `ccmux start` background service with a foreground `ccmux run -- claude …` convenience.

### OAuth / Claude Max vs API key
- Neither reference project treats OAuth specially — they just forward whichever `Authorization` header Claude Code sends. Claude Code (when logged in via Claude Max) sends a short-lived OAuth bearer and refreshes it out-of-band. As long as the proxy forwards `Authorization` untouched and doesn't strip/rewrite `x-api-key`, both auth modes work.
- **ccmux's "own zero credentials" stance is correct and sufficient.**
- Pitfall: some proxies force-rewrite `Authorization` when an `APIKEY` is configured on the proxy itself. ccmux should keep proxy-auth (if ever added) entirely separate from upstream auth, never clobbering the client's header.

---

## 3. Prompt Caching Across Model Switches

Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

### Semantics
- `cache_control: { type: "ephemeral" }` — default 5-min TTL, or `ttl: "1h"` for 1-hour (more expensive).
- Up to 4 explicit breakpoints per request; Claude Code typically marks `tools`, `system`, and the last message.
- Cache is currently org-scoped; moving to workspace-scoped Feb 5, 2026.
- Min cacheable prefix: 1024 tokens (Sonnet 4.5), 2048 (Sonnet 4.6, Opus 4.5/4.6/4.7), 4096 (Haiku 4.5). Sub-threshold prompts silently skip caching.
- Usage fields: `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens` (= tokens after last breakpoint).

### What invalidates cache

| Change | Tools | System | Messages |
|---|---|---|---|
| **Model change** | ✘ | ✘ | ✘ (full invalidation) |
| Tool definitions changed | ✘ | ✘ | ✘ |
| `tool_choice` change | ✓ | ✓ | ✘ |
| Add/remove image | ✓ | ✓ | ✘ |
| Thinking param change | ✓ | ✓ | ✘ |
| Web search / citations toggle | ✓ | ✘ | ✘ |

**Model change is a full cache invalidation across all three scopes.** This is the single most important fact driving ccmux's routing policy.

### Implications for per-turn routing
- **Per-turn thrash = worst case.** Routing turn N to Sonnet (cache warm), turn N+1 to Haiku, turn N+2 back to Sonnet = three cache-creation charges, zero reads. For a Claude Code session with 20K-token system+tools prefix this is massive cost inflation, easily wiping out Haiku savings.
- Cache entries are **per-model**. Multiple concurrent warm caches per session are only valuable if you revisit that model.

### Recommendations for ccmux
- **Default to sticky-per-session.** Pick a model on turn 1 (or first turn a rule doesn't abstain), stick until an explicit escalation rule fires.
- **Escalation asymmetry.** Cheap → expensive is fine (Haiku → Sonnet when complexity rises). Expensive → cheap should require strong signal because you lose the warm cache.
- **Classifier amortization.** Run the Haiku classifier at most once per N turns per session, not every turn; cache its verdict per-signal-hash.
- **Opt-in "aggressive" mode** where the user accepts cache thrash for max cost optimization — surface the tradeoff in docs.
- **Record cache metrics** in the decision log (`cache_read_input_tokens`, `cache_creation_input_tokens`) so `ccmux tune` can quantify thrash cost.

### Gotchas
- Don't touch `cache_control` markers — passthrough only.
- 20-block lookback window: inserting or reordering messages mid-history breaks cache even if `cache_control` markers are identical.

---

## 4. Fastify Streaming Proxy Implementation

Sources:
- https://fastify.dev/docs/latest/Reference/Reply/
- https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md

### Recommended pattern: `reply.hijack()` + `undici.stream`

```ts
app.post('/v1/messages', async (req, reply) => {
  const { rewrittenBody } = prepareUpstreamRequest(req);

  reply.hijack(); // take over raw response, skip Fastify serializer

  await dispatcher.stream(
    {
      origin: 'https://api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: filterHopByHop(req.headers),
      body: rewrittenBody,
      opaque: reply.raw,
    },
    ({ statusCode, headers, opaque }) => {
      const res = opaque as ServerResponse;
      res.writeHead(statusCode, filterHopByHop(headers));
      return res; // Writable — undici pipes response body directly
    }
  );
});
```

### Why this shape
- `reply.hijack()` disables Fastify's serializer, onSend hooks, and schema validation — you own the socket.
- `undici.Dispatcher.stream()` avoids an intermediate Readable — fastest path from upstream socket to client socket.
- Passing `reply.raw` as `opaque` and returning it as the Writable sink is idiomatic.
- `writeHead(status, headers)` writes status + headers in one syscall and forces chunked transfer unless upstream provides `Content-Length`.

### Why NOT `reply.send(stream)`
- Runs the Fastify serializer path, may buffer, may set a `Content-Type` you didn't want. For SSE you need explicit control + zero buffering.

### Why NOT native `fetch` / `node:http`
- Native `fetch` wraps response in a WHATWG `ReadableStream` → `Readable.fromWeb(...).pipe(res)` = extra copy per chunk + awkward error propagation.
- `node:http` lacks undici's keep-alive pool tuning.
- **Verdict: undici `dispatcher.stream()` for the hot path; undici `fetch` only for auxiliary calls (classifier Haiku invocation).**

### Headers and pitfalls
- Strip hop-by-hop headers both directions: `connection`, `transfer-encoding`, `keep-alive`, `proxy-*`, `te`, `trailer`, `upgrade`. Keep everything else, including unknown headers.
- Do NOT set `Content-Length` on the response. If upstream sent one (non-streaming JSON), preserve it; if not (SSE), omit it → chunked encoding automatically.
- Call `reply.raw.flushHeaders()` immediately after `writeHead` for SSE so the client gets 200 + `content-type: text/event-stream` before any body byte.
- Disable Nagle via `reply.raw.socket.setNoDelay(true)` for lowest per-chunk latency on localhost.

### Request body handling
- Register Fastify with `bodyLimit` ~10-20 MB (large codebase contexts).
- Use a raw content-type parser that keeps the original buffer, edit `model` via `{ ...body, model: newModel }` → `JSON.stringify`. Don't run the request body through a strict schema. Unknown top-level fields must survive.
- Forward `AbortSignal`: `req.raw.on('close', () => controller.abort())` so upstream cancels when Claude Code disconnects (common during `Esc` interrupts).

### Error propagation mid-stream
Three failure modes:
1. Upstream returns 4xx/5xx before streaming starts → write status + body verbatim.
2. Upstream throws mid-stream → write an SSE `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream disconnected"}}\n\n` and end. Claude Code understands Anthropic-shaped errors.
3. Client disconnects → abort upstream via AbortSignal, don't write anything further.

Never throw inside the undici factory — it leaks the connection. Use `try/finally` to guarantee `reply.raw.end()` in terminal cases.

---

## 5. Testing Approach

Per user decision: **Vitest with record/replay fixtures**, plus a live integration suite gated behind an env var.

- **Record mode:** run tests against real Anthropic with `CCMUX_RECORD=1` → capture SSE byte streams + headers → store in `tests/fixtures/`.
- **Replay mode (default):** mock upstream with a local Node HTTP server that serves captured fixtures with realistic inter-chunk delays.
- **Golden-file proxy-faithfulness tests:** diff `ccmux` output vs. direct Anthropic byte-for-byte using the same input.
- **Live integration tests** gated behind `CCMUX_LIVE=1` — run nightly / on-demand, not on every PR.
- SSE tests need a real listening socket — `@fastify/inject` does NOT model streaming faithfully. Spin up Fastify on an ephemeral port for those.
- Separate unit suites for: policy rule engine, classifier fallback heuristic, signal extraction, config loader, dependency graph of signals.

---

## 6. Summary of Constraints for Implementation

1. **Model field is the ONLY mutation.** Everything else on the request/response/SSE path is opaque passthrough.
2. **Forward-compat by design.** Zero strict schemas on request/response bodies. Parse for routing signals only, never validate.
3. **Sticky model per session by default** — prompt caching is the dominant cost factor, routing policy must respect it.
4. **`reply.hijack()` + `undici.dispatcher.stream()` is the blessed hot path.** Don't deviate.
5. **Auth passthrough, zero credential ownership.** Copy claude-code-router's "force 127.0.0.1 when no APIKEY" security default.
6. **Record/replay fixtures** for deterministic SSE tests; live integration as a separate opt-in suite.

---

## Citations
- Messages streaming: https://docs.anthropic.com/en/api/messages-streaming
- Prompt caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- claude-code-router: https://github.com/musistudio/claude-code-router
- claude-router: https://github.com/0xrdan/claude-router
- Fastify Reply: https://fastify.dev/docs/latest/Reference/Reply/
- Undici Dispatcher: https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md
