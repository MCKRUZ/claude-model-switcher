# section-04-proxy-phase0

## Purpose

Phase 0 of ccmux: a **transparent Fastify proxy** for `api.anthropic.com`. Claude Code must see zero observable difference from hitting the upstream directly — no body rewrites, no decompression, no header reordering beyond RFC 7230 hop-by-hop stripping and the `host` rewrite. This section delivers the full hot path for `/v1/messages` and the generic passthrough for all other `/v1/*` paths, plus `/healthz`. **No policy engine, no classifier, no decision log yet** — this is pure identity passthrough with the instrumentation hooks in place for later phases.

## Dependencies

- **section-02-logging-paths** — pino logger factory with auth-header redaction (`req.headers.authorization`, `req.headers['x-api-key']`, `req.headers['x-ccmux-token']`).
- **section-03-config** — YAML config loader (read `port`, `mode`, `security.requireProxyToken`, `bodyLimit`). This section only consumes the loaded config object.

## Non-Goals (deferred to later sections)

- Rule engine, signal extraction, sticky-model policy (sections 07, 08, 09).
- Decision log (section 13).
- Port-picking CLI (`ccmux start`) and collision loop wiring (section 05) — this section exposes a `bindWithFallback()` helper but CLI wiring lives in 05.
- Config hot-reload (section 06).
- Classifier outbound (section 12).

## Files to Create

```
src/proxy/
  server.ts            # Fastify app factory, binds 127.0.0.1 only
  hot-path.ts          # POST /v1/messages handler (reply.hijack + undici stream)
  pass-through.ts      # All other /v1/* paths (any method, no body parse)
  body-splice.ts       # parseForSignals + re-serialize (Phase 0: identity)
  headers.ts           # RFC 7230 hop-by-hop filter + host rewrite + raw-header preservation
  upstream.ts          # undici Agent + dispatcher.stream() helper
  abort.ts             # client-socket-close → AbortController wiring
  errors.ts            # synthetic SSE-error emitter (the sole permitted synthetic SSE output)
  health.ts            # GET /healthz
  token-gate.ts        # optional x-ccmux-token check (off by default)
  lifecycle/ports.ts   # bindWithFallback(startPort, maxAttempts) → { port }

tests/proxy/
  faithfulness.non-streaming.test.ts
  faithfulness.streaming.test.ts
  headers.test.ts
  body.test.ts
  streaming.test.ts
  health.test.ts
  errors.test.ts
  token.test.ts
  passthrough.test.ts
  http2-reject.test.ts
  expect-continue.test.ts
  forward-compat.test.ts
  abort.test.ts

tests/fixtures/
  sse/basic.jsonl              # captured SSE session (event+data chunks + timing)
  sse/with-tool-use.jsonl
  sse/unknown-event-type.jsonl
  non-streaming/200-simple.json
  non-streaming/400-validation.json
  non-streaming/429-rate-limit.json
```

Per repo rules: every file ≤ 400 lines, every function ≤ 50 lines, one class per file.

## Implementation Details

### Invariants (MUST hold for every test and every code path)

1. **The only semantic change to the request body is the `model` field.** Phase 0 does not rewrite it — but the re-serialization path must go through `JSON.parse` → `JSON.stringify` to prove the plumbing is in place. Byte-diff tests are scoped to **response bodies and SSE streams**; request-side tests assert `parsed(upstreamSentBody) === parsed(originalBody)`.
2. **Forward-compat by default.** No strict schemas on request/response bodies. Unknown fields round-trip.
3. **SSE chunks are byte-for-byte** on the response hot path. The ONE explicit carve-out: upstream streaming fails mid-stream after we've begun writing → we MAY emit a single synthetic Anthropic-shaped SSE error event (`event: error\ndata: {...}\n\n`) and close. Documented and tested.
4. **No middleware decompresses or recompresses responses.** `accept-encoding` is forwarded verbatim from client to upstream; the response body is streamed untouched. No `@fastify/compress`, no gzip/br anywhere on the response path.
5. **Auth headers are passthrough-only.** ccmux never generates, caches, or reissues `x-api-key` / `authorization`. They are forwarded untouched and redacted in logs.

### `server.ts` — Fastify factory

```ts
// Stub signature only — implementer fills body.
export interface ProxyServerOptions {
  port: number;
  logger: Logger;                  // from section-02
  config: LoadedConfig;            // from section-03
  requireProxyToken?: boolean;     // default false
  proxyToken?: string;             // required iff requireProxyToken
  bodyLimit?: number;              // default 20 * 1024 * 1024
}

export async function createProxyServer(
  opts: ProxyServerOptions
): Promise<FastifyInstance>;
```

Requirements:
- `Fastify({ logger, bodyLimit, http2: false })`.
- Bind address **always** `127.0.0.1`. Refuse to bind `0.0.0.0`; assert in a test.
- Register a **raw-body content-type parser** for `application/json` on `POST /v1/messages` that keeps the original `Buffer` intact and also produces a parsed object for later signal extraction. Do NOT globally install a JSON body parser — passthrough routes might carry streaming uploads in the future.
- Register routes: `POST /v1/messages` → `hot-path.ts`; `ALL /v1/*` (except `/v1/messages`) → `pass-through.ts`; `GET /healthz` → `health.ts`.
- `onRequest` hook rejects HTTP/2 prior-knowledge requests with **505**.
- `onRequest` hook calls `token-gate.ts` when `requireProxyToken` is true.
- No compression plugin. No reply serializer on the hijacked routes.

### `hot-path.ts` — `/v1/messages` request lifecycle

Steps (in order):
1. (If `requireProxyToken`) validate `x-ccmux-token` header constant-time compare; mismatch → 401 JSON `{error: "unauthorized"}`. Token stripped from outbound headers.
2. Reject HTTP/2 prior-knowledge → 505 (handled in `onRequest`, re-asserted here).
3. If `content-type` does not include `application/json` → delegate to passthrough handler (no body parse, no routing).
4. Call `reply.hijack()` **before any body byte is written**. Tests spy on this.
5. `headers.filterRequestHeaders(req.raw.rawHeaders)` → outbound `RawHeaders` array. `host` rewritten to `api.anthropic.com`. `content-length` dropped (undici will recompute). `x-ccmux-token` dropped. `accept-encoding` preserved verbatim.
6. `body-splice.parseForSignals(rawBuffer)` → `{ parsed, buffer }`. In Phase 0 the outbound body is `Buffer.from(JSON.stringify(parsed))` — **not** the original buffer. This is deliberate: exercises the re-serialize path so Phase 1 inherits tested plumbing. The invariant is **semantic equivalence**, not byte equality, for the request body.
7. `upstream.streamRequest({ method: 'POST', path: '/v1/messages', headers, body, signal })` using `undici.dispatcher.stream()`. The factory callback:
   - Reads upstream status + headers.
   - Calls `headers.filterResponseHeaders(upstreamRawHeaders)`.
   - Writes status + filtered headers to `reply.raw` via `reply.raw.writeHead(status, headers)` then `reply.raw.flushHeaders()`.
   - Calls `reply.raw.socket.setNoDelay(true)`.
   - Returns `reply.raw` as the Writable destination. undici pipes upstream body chunks directly into the client socket — zero copy, zero buffering.
8. Wire `abort.ts`: `req.raw.on('close', () => { if (!responseComplete) abortController.abort(); })`. Target: upstream abort within **100ms** of client disconnect.
9. Mid-stream exception caught by `stream()` promise → `errors.emitSseError(reply.raw, upstreamErr)` writes the single synthetic Anthropic-shaped `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed: <redacted>"}}\n\n` and calls `reply.raw.end()`. The redacted message **never** contains auth data or raw upstream reason strings that could leak tokens.
10. Upstream 4xx/5xx **before any response byte is written** → forward status + body verbatim (including `request-id` header).

### `pass-through.ts` — generic `/v1/*` passthrough

- Any method, any path other than `/v1/messages`.
- No body parsing. Stream `req.raw` directly into the undici request body.
- Same header filter, same hijack, same error-propagation rules.
- Path + method + query string forward verbatim.
- One structured log line per request: `{ method, path, upstreamStatus, durationMs }`.

### `body-splice.ts` — Phase 0 identity splice

```ts
export function parseForSignals(
  raw: Buffer
): Result<{ parsed: unknown; buffer: Buffer }, SpliceError>;
```

- Single `JSON.parse`. On parse failure, return `Result.fail` → hot-path responds 400 with a passthrough-shaped error (we are not Anthropic, but a parse error means we cannot proceed).
- Phase 0 returns `Buffer.from(JSON.stringify(parsed))`.
- Phase 1 will hang model rewriting off the same call site — do NOT abstract prematurely.

### `headers.ts` — hop-by-hop filter

Strip list (both directions, per RFC 7230):

```
connection
keep-alive
transfer-encoding
te
trailer
upgrade
proxy-authenticate
proxy-authorization
```

Plus: any token listed in the incoming `connection:` header value is also stripped. `content-length` is dropped on the outbound request only.

Additional request rules:
- `host` rewritten to `api.anthropic.com` outbound.
- `x-ccmux-token` stripped outbound.
- `accept-encoding` forwarded verbatim.

Additional response rules:
- Same strip list.
- `set-cookie`, all `anthropic-*` (including `anthropic-ratelimit-*`), `x-request-id`, `retry-after` pass through untouched.

**Duplicate-header preservation**: use undici's `RawHeaders` array form `[name, value, name, value, ...]`. Do NOT use the flattened `IncomingHttpHeaders` object for outbound — multi-valued headers (future `set-cookie`, duplicated custom headers) must round-trip both values. Tests assert this explicitly.

### `upstream.ts` — undici configuration

- Single shared `undici.Agent` for `https://api.anthropic.com`, keep-alive enabled, reused across requests.
- `autoSelectFamily: false`.
- **No decompression**: ensure undici's default decompression is disabled on the dispatcher.
- Configurable via `UPSTREAM_ORIGIN` env for test fixtures pointing at a local HTTP listener (live integration fixtures only).

### `abort.ts`

```ts
export function wireAbort(
  req: FastifyRequest,
  controller: AbortController
): void;
```

- Attach `req.raw.once('close', …)` before upstream request kicks off.
- Guard with a `responseComplete` flag set after final upstream chunk flushed, so post-completion socket-close does not trigger a spurious abort.

### `errors.ts` — the sole synthetic SSE

```ts
export function emitSseError(
  socket: Writable,
  cause: unknown,
  logger: Logger
): void;
```

- Called **only** when upstream throws / socket errors **after** the first response byte has been written.
- Body template:
  ```
  event: error
  data: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}

  ```
  (trailing blank line per SSE framing). The `message` field is static — no upstream error text interpolated, no auth leakage.
- Logs a pino line with `{ requestId, cause: String(cause) }` (auth redaction already applied by the logger config from section-02).

### `health.ts`

```ts
// GET /healthz → 200
{ status: 'ok', version: string, uptimeMs: number, mode: 'passthrough' | 'enforce' | 'shadow', port: number }
```

Phase 0 `mode` is always `'passthrough'`. The field exists for forward-compat.

### `token-gate.ts`

- `requireProxyToken: false` by default in `config.yaml`.
- When true: compare `req.headers['x-ccmux-token']` to configured token with constant-time equality. Mismatch → 401 JSON `{error: "unauthorized"}`. Never logged.
- The token itself is in `CCMUX_PROXY_TOKEN` env, never in config.yaml.
- Defense-in-depth only; the primary defense is the 127.0.0.1 bind.

### `lifecycle/ports.ts`

```ts
export async function bindWithFallback(
  fastify: FastifyInstance,
  startPort: number,
  maxAttempts: number  // default 20
): Promise<{ port: number }>;
```

- Try `fastify.listen({ host: '127.0.0.1', port: startPort })`. On `EADDRINUSE`, increment and retry. Any other error rethrows.
- **Do NOT** use the `net.createServer().listen().close().listen()` check-then-bind pattern — that has a TOCTOU race. Bind directly and catch the error.
- Exported for section-05's CLI wiring; this section only needs the helper + its unit test.

### Fastify `bodyLimit`

- Default `20 * 1024 * 1024` (20 MiB). Configurable via `config.bodyLimit`.
- Over-limit → clear error response (not silent truncation). Fastify emits `FST_ERR_CTP_BODY_TOO_LARGE`; map to a JSON error body with status 413.

### `Expect: 100-continue`

- Fastify's default behavior handles this correctly with the raw-body parser. Write one explicit test confirming a client sending `Expect: 100-continue` completes successfully end-to-end.

### HTTP/2 prior-knowledge rejection

- Registered Fastify with `http2: false`. Any request arriving via HTTP/2 prior-knowledge → respond 505. Confirm via test using a raw socket sending the HTTP/2 connection preface.

## Tests (TDD — write these FIRST, each must fail before implementation)

Per repo rules: xUnit-style naming adapted for Vitest; each test is a single `it('should …')`. Real listening socket required for SSE tests — no `@fastify/inject` for streaming.

### `tests/proxy/faithfulness.non-streaming.test.ts`
- `it('forwards POST /v1/messages with model: claude-sonnet-4-6 to upstream with the same model when no rule fires')`
- `it('returns upstream 200 non-streaming JSON response byte-for-byte identical to fixture')`
- `it('calls reply.hijack() before any body byte is written')` — spy on Fastify reply.
- `it('returns upstream 4xx error body verbatim including request-id')`
- `it('returns upstream 5xx error body verbatim')`
- `it('returns upstream 429 body and rate-limit headers verbatim')`

### `tests/proxy/faithfulness.streaming.test.ts`
Run against a real local HTTP listener serving the fixture JSONL files with preserved inter-chunk delays (±10ms tolerance).
- `it('writes upstream SSE chunks to client socket in exact order and bytes captured in fixture')`
- `it('forwards ping SSE events verbatim')`
- `it('forwards content_block_delta events in the same order and quantity as the fixture')`
- `it('terminates client stream on message_stop with no trailing bytes')`
- `it('forwards unknown SSE event types (event: weird-new-type) byte-equal')`

### `tests/proxy/headers.test.ts`
- `it('strips hop-by-hop headers from request: connection, keep-alive, transfer-encoding, te, trailer, upgrade, proxy-authenticate, proxy-authorization')`
- `it('strips hop-by-hop headers from response (same list)')`
- `it('rewrites host to api.anthropic.com on upstream request')`
- `it('forwards accept-encoding verbatim (no decompression)')`
- `it('preserves duplicate-valued headers via undici raw-header arrays')` — inject two `set-cookie` values from upstream, assert both reach the client.
- `it('passes anthropic-* headers verbatim in both directions')`
- `it('round-trips x-request-id, retry-after, anthropic-ratelimit-* verbatim')`
- `it('forwards Authorization: Bearer untouched')`
- `it('forwards x-api-key untouched')`
- `it('strips tokens listed in connection: header value')`
- `it('drops content-length on outbound request')`

### `tests/proxy/body.test.ts`
- `it('produces a forwarded body with JSON parsed-then-stringified semantic equivalence (original model field unchanged in Phase 0)')`
- `it('preserves unknown top-level fields in the request body through round-trip')`
- `it('never strips or reorders cache_control markers on message blocks')`
- `it('rejects body > bodyLimit with 413 and a clear error (no silent truncation)')`
- `it('non-application/json content-type falls through to passthrough path without crashing')`

### `tests/proxy/streaming.test.ts`
- `it('sets reply.raw.socket.setNoDelay(true)')` — spy.
- `it('does not set Content-Length on SSE responses (chunked encoding only)')`
- `it('registers no gzip/br middleware on the response path')` — property assertion on the Fastify instance.

### `tests/proxy/health.test.ts`
- `it('GET /healthz returns 200 with ok status')`
- `it('binds to 127.0.0.1 only')` — assert the listener's address.
- `it('refuses to bind 0.0.0.0')`
- `it('bindWithFallback picks the next free port when startPort is in use')` — occupy `startPort` with a stub listener, assert the helper returns `startPort + 1`.

### `tests/proxy/errors.test.ts`
- `it('emits a single synthetic Anthropic-shaped SSE event: error when upstream disconnects mid-stream, then closes client socket')`
- `it('synthetic SSE error message never contains auth data or raw upstream reason strings')`
- `it('logs via pino on each failure mode with request-id when available and no raw auth headers')`

### `tests/proxy/token.test.ts`
- `it('rejects requests missing matching x-ccmux-token with 401 when CCMUX_PROXY_TOKEN is set')`
- `it('accepts requests without the header when CCMUX_PROXY_TOKEN is unset (debug mode)')`
- `it('redacts x-ccmux-token from every log line')`

### `tests/proxy/passthrough.test.ts`
- `it('GET /v1/models?foo=bar preserves foo=bar on upstream request')`
- `it('forwards path, method, and query string verbatim for non-/v1/messages routes')`
- `it('does not parse request body on passthrough routes')`
- `it('emits one structured log line per passthrough request')`

### `tests/proxy/http2-reject.test.ts`
- `it('rejects HTTP/2 prior-knowledge request with 505')`

### `tests/proxy/expect-continue.test.ts`
- `it('handles Expect: 100-continue end-to-end without hang')`

### `tests/proxy/forward-compat.test.ts`
- `it('injects unknown fields at every known nesting level and verifies round-trip to upstream')` — parametrized: top-level, inside `messages[].content[]`, inside `tools[]`, inside `metadata`.

### `tests/proxy/abort.test.ts`
- `it('fires client AbortSignal when the client socket closes mid-request')` — observe via upstream server spy.
- `it('aborts upstream request within 100ms of client disconnect')`

### Fixtures

- `tests/fixtures/sse/*.jsonl` — each line is `{ ts: number, event: string, data: string }`. A tiny local HTTP listener replays them with `setTimeout` honoring `ts` deltas.
- `tests/fixtures/non-streaming/*.json` — captured upstream response body + headers + status.
- Record-mode (exposed by env `CCMUX_RECORD=1`) is out of scope here; replay-mode is all that's needed for Phase 0.
- Live integration suite (`CCMUX_LIVE=1`) is excluded from default `vitest` runs.

## Acceptance Criteria

- All tests listed above are written and fail before implementation, then pass after.
- ≥ 80% line coverage on every new file in `src/proxy/`.
- Zero compression middleware on the response path (property assertion in `streaming.test.ts`).
- Byte-for-byte response fidelity for streaming and non-streaming fixtures.
- Added latency vs. direct upstream p95 < 50ms (soft gate; deferred to CI perf suite per plan §15, not required for this section's merge).
- `/healthz` responsive immediately after `bindWithFallback` resolves.
- Every log line involving auth headers shows `[Redacted]` (verified by the existing section-02 redaction tests; re-assert in `token.test.ts`).

## Handoff Notes for Downstream Sections

- `hot-path.ts` exposes the call site where `body-splice` will grow model rewriting in section-09. Keep the signature of `parseForSignals` stable; Phase 1 only adds a mutation step between parse and stringify.
- `bindWithFallback` is consumed by `section-05-cli-start-and-ports` to implement `ccmux start --port`.
- The undici Agent in `upstream.ts` is reused by the Haiku classifier in section-12 (same connection pool).
- The decision-log hook point is the return value of the hot-path handler. Section-13 will wrap it; do not add that wrapper here.

## Actual Implementation Notes

**Status:** 99/99 tests passing, typecheck clean, lint clean.

**Deviations from plan:**

- **`token-gate.ts` renamed to `token.ts`** — simpler path, no behavior change.
- **`reject-h2.ts` removed after code review** — the file existed during initial implementation but was dead code: Node's HTTP/1.1 parser rejects `PRI * HTTP/2.0` at the socket level before any Fastify hook runs, so `req.method === 'PRI'` was never reachable. Defense lives in `server.ts:registerHttp2PrefaceGuard` via a `clientError` `prependListener` that sniffs `err.rawPacket` for the H2 preface prefix and returns a framed 505 (with Content-Length). Non-H2 errors fall through to Fastify's default handler.
- **`abort.ts` listens on TCP socket `close`, not IncomingMessage `close`** — IncomingMessage fires 'close' as soon as the request body is fully read, which spuriously aborts long streaming responses. We attempted belt-and-braces (both listeners) during code review but reverted after 28 tests regressed. TCP socket is the authoritative signal. The `'aborted'` event is also hooked for older Node compatibility.
- **`hot-path.ts` Writable `destroy()` override** — on mid-stream upstream error, emits a synthetic SSE `event: error` frame if headers have already been sent, then calls `raw.destroy(err)` to free the client socket. This is the sole permitted synthetic SSE output.
- **`body-splice.ts` accepts any JSON value** — the initial implementation rejected non-object bodies with 400. Code review (forward-compat invariant) removed that check; parsed is passed through as-is. Phase 1 model rewriting will only act on object-shaped bodies.
- **`headers.ts` strips `Expect: 100-continue` outbound** — pragmatic: Claude SDKs don't send it, undici handles its own framing, and forwarding would require matching 100-continue semantics. Documented inline.
- **Path construction in `hot-path.ts` / `pass-through.ts`** — originally used `new URL(req.url, 'http://placeholder')` for path extraction. Code review flagged SSRF surface; replaced with a guard that returns `'/'` if `req.url` doesn't start with `/`, then returns `req.url` verbatim (Node's parser already normalizes to origin-form).
- **`server.ts` uses `as unknown as FastifyInstance` cast** — Fastify's default `Logger` generic doesn't match our pino Logger's extended generics. The cast is load-bearing; removing it breaks typecheck on `app.route({...})` overloads.
- **`logging/logger.ts` changed `Level` → `LevelWithSilent`** — tests use `{ level: 'silent' }` which isn't part of pino's narrow `Level` type. Incidental to this section but committed together.

**Files actually created/modified (35 files, 2124 insertions):**

- src: proxy/{server,hot-path,pass-through,body-splice,headers,upstream,abort,errors,health,token}.ts, lifecycle/ports.ts, logging/logger.ts, config/{schema,defaults}.ts, privacy/redact.ts, types/result.ts, main .eslintrc.cjs/tsconfig.eslint.json/tsconfig.json/vitest.config.ts/package.json
- tests: proxy/{faithfulness.non-streaming,faithfulness.streaming,headers,body,streaming,health,errors,token,passthrough,http2-reject,expect-continue,forward-compat,abort}.test.ts + helpers/{build-proxy,http-client,upstream-mock}.ts + replay-server.ts
- fixtures: sse/{basic,with-tool-use,unknown-event-type}.jsonl + non-streaming/{200-simple,400-validation,429-rate-limit}.json

**Code review artifacts:** `planning/implementation/code_review/section-04-{diff,review,interview}.md`
