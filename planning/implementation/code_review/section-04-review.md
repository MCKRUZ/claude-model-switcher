# Section-04 Proxy Phase 0 — Code Review

## Critical

**[CRITICAL] `clientError` handler drops legitimate non-H2 error responses and corrupts shared Fastify/Node behavior**
File: `src/proxy/server.ts:47-68`
`app.server.removeAllListeners('clientError')` nukes Fastify's own handler, then the replacement only inspects `err.rawPacket` — which is not populated for every parser error (e.g. `HPE_HEADER_OVERFLOW` on a second pipelined request, socket timeouts). Any non-H2 error gets a hand-rolled `400` with no `Content-Type` and no `Content-Length`, which violates HTTP/1.1 framing and can desync clients. Fix: keep Fastify's listener, sniff H2 with `prependListener`, and return early only on match:
```ts
app.server.prependListener('clientError', (err, socket) => {
  const raw = (err as {rawPacket?: Buffer}).rawPacket;
  if (!raw?.subarray(0, 12).equals(h2PrefacePrefix)) return;
  socket.end(/* 505 */);
});
```

**[CRITICAL] `reject-h2.ts` is dead code**
File: `src/proxy/reject-h2.ts`; registered at `server.ts:105-116`.
`req.raw.httpVersionMajor >= 2` can never fire because Fastify is constructed with `http2:false` — the Node HTTP/1 parser rejects `PRI *` at the socket level before this hook runs. `req.method === 'PRI'` likewise never reaches the hook. Either remove the file or make it do something (e.g. guard against `Upgrade: h2c`). Keeping it hides the fact that the real defense lives in the `clientError` shim.

**[CRITICAL] SSRF via `URL(req.url, 'http://placeholder')` — path injection**
Files: `src/proxy/hot-path.ts:59-62`, `src/proxy/pass-through.ts:46-49`.
Fastify's `req.url` can contain a full absolute-form URI (`GET http://evil/... HTTP/1.1`) or CRLF artefacts. `new URL('http://evil/x', 'http://placeholder')` returns `http://evil/x` and `pathname+search` becomes `/x`, so origin isn't swapped — but upstream *headers* still carry the original `host`. The real risk: an attacker-controlled `host` header combined with `connection: close` header-smuggling. Validate that `req.url` starts with `/` and reject otherwise; do not use `new URL` for path extraction when you only need `req.url` slice.

**[CRITICAL] `hot-path.ts` `writeResponseHead` destroy-override breaks error propagation**
File: `src/proxy/hot-path.ts:85-88`.
`destroy(err, cb) { cb(err); }` silently drops the error and does *not* destroy `raw`. If undici destroys the pipe (upstream RST mid-stream), the client socket is left hanging until TCP keepalive. The comment claims the catch block handles it, but `agent.stream()`'s promise does not reject when the `factory`-returned Writable is destroyed — undici considers that consumer-initiated. Result: silent hang + leaked socket. Fix: `destroy(err, cb){ raw.destroy(err ?? undefined); cb(err); }` and ensure the outer `try` actually rethrows.

## Important

**[IMPORTANT] Token timing-safe compare still leaks length**
File: `src/proxy/token.ts`. Returning early on length mismatch defeats the purpose. Normalize both to a fixed-size hash (`createHash('sha256').update(x).digest()`) then `timingSafeEqual`.

**[IMPORTANT] AbortHandle listens on `socket.close` but never on `req.raw.on('close')`**
File: `src/proxy/abort.ts`. On some keepalive paths the TCP socket is pooled and doesn't emit `close` per request; `'aborted'` is deprecated on Node 18+. Listen on `req.raw.once('close')` as the spec prescribes (section-04 step 8), plus `socket.once('close')` as a belt-and-braces.

**[IMPORTANT] Upstream Agent lifecycle: `resetUpstreamAgent` swallows errors and leaks during tests**
File: `src/proxy/upstream.ts`. `.close().catch(()=>undefined)` hides teardown failures; combined with `lastOutboundHeaders` being module-scoped global mutable state, parallel tests will race. Remove `__getLastOutboundHeaders` or put it behind the factory.

**[IMPORTANT] `registerHostGuard` monkey-patches `app.listen` via `as unknown as`**
File: `src/proxy/server.ts:71-82`. This breaks overload signatures (Fastify's `listen` has 4+ overloads, including positional). Use Fastify's `onReady` + inspection of `app.server.address()` after bind, or a plugin `preListen` — don't re-assign the method.

**[IMPORTANT] `pass-through.ts` passes `req.raw` as body but Fastify's JSON parser has already consumed it for `application/json` on hot-path fallback**
File: `src/proxy/hot-path.ts:19-23` → `passThrough`. When `hot-path` delegates on non-JSON content-type, the body parser registered at `server.ts:91` (`'*'`) sets body to `undefined`, so the stream is still readable — but if a future change adds a parser, this breaks silently. Document the contract or pass `raw` explicitly.

**[IMPORTANT] `Expect: 100-continue` is stripped but never honored**
File: `src/proxy/headers.ts`. The filter drops `expect` outbound, which means undici won't send it upstream, so the client sent a body it wasn't told to send yet. For correctness, either forward `expect` to undici (which supports it) or reply 100 locally before reading the body.

**[IMPORTANT] `body-splice.ts` fails non-object JSON with 400**
File: `src/proxy/body-splice.ts`. Anthropic's API accepts JSON arrays / primitives in some endpoints in the future; Phase 0 invariant #2 says "forward-compat by default." Restriction to objects violates that. Drop the check.

## Minor

- `src/proxy/errors.ts` logger argument type `Logger` forces callers to import pino; a `Pick<Logger,'error'>` would be enough.
- `src/proxy/health.ts` `makeHealthHandler` uses `req.server.server.address()` — wrong API surface when behind a reverse proxy test harness. Inject `port` via deps instead.
- `src/proxy/upstream.ts` — `as unknown as { rawHeaders?: Buffer[] }` is hiding the fact that undici's `stream` doesn't expose raw headers in its typed surface. Verify against undici version; if unavailable, `toRawHeaders` fallback silently loses duplicates (violates spec for `set-cookie`).
- `src/proxy/server.ts:31` `app as unknown as FastifyInstance` is a no-op cast; delete.
- `src/logging/logger.ts` change from `Level` to `LevelWithSilent` is correct, but unrelated to section-04 scope — should be a separate commit.
- `tests/proxy/helpers/build-proxy.ts` mutates `process.env.UPSTREAM_ORIGIN` — parallel vitest workers will race. Use `vi.stubEnv`.
- `tests/proxy/helpers/http-client.ts` `decodeChunked` ignores trailer and chunk extensions; fine for tests, but document it.
- `tests/proxy/http2-reject.test.ts` asserts only `/505/` — does not assert `Content-Length` framing or body JSON. Given the critical finding above, strengthen it.

## Nit

- `src/proxy/abort.ts` — `new Error('client disconnected')` as abort reason is fine but non-standard; use a `DOMException('AbortError')` for consumer compatibility.
- `src/proxy/headers.ts` `export const UPSTREAM_HOST_NAME = UPSTREAM_HOST` is unused; remove.
- `src/proxy/errors.ts` empty catches with `_err` — prefer `catch {}`.
- `src/proxy/hot-path.ts:17` `makeHotPathHandler` deps has one field; inline it.

## Verdict

Block. Four critical findings must be resolved before merge. Everything else can follow in fixup commits.
