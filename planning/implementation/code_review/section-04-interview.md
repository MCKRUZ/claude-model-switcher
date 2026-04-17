# Section-04 Code Review Interview

## User Decisions

| # | Finding | Decision |
|---|---------|----------|
| C1 | clientError replaces all Fastify listeners | Auto-fix: use `prependListener` + early return on non-H2 |
| C2 | reject-h2.ts dead code | **Delete entirely** (+ remove import/hook in server.ts) |
| C3 | SSRF via `new URL(req.url, ...)` | Auto-fix: guard `req.url.startsWith('/')` in buildUpstreamPath |
| C4 | writeResponseHead destroy swallows errors | **Both: emit SSE-if-sent, then raw.destroy(err)** |
| I1 | token length leak | Let go — tokens are fixed-length generated, length leak is negligible |
| I2 | abort.ts socket-only listener | Auto-fix: add `req.raw.once('close')` as belt-and-braces |
| I3 | resetUpstreamAgent swallows errors | Let go — defensive teardown is fine |
| I4 | monkey-patch app.listen | Let go — works, has tests |
| I5 | body-splice rejects non-object JSON | **Drop the type check** |
| I6 | Expect: 100-continue stripped | **Leave stripped (pragmatic)** — document it |
| M1 | no-op FastifyInstance cast | Auto-fix: delete |
| M2 | UPSTREAM_HOST_NAME unused export | Auto-fix: delete |
| Nits | `_err` catches, inline deps, AbortError kind | Let go |

## Fixes to Apply

1. **server.ts**: Replace `removeAllListeners('clientError')` + handler with `prependListener` that only handles H2 preface and lets other errors fall through to Fastify's default. Ensure 505 response includes `Content-Length` header (test reviewer's point).
2. **server.ts**: Remove `import { rejectHttp2 } from './reject-h2.js'` and the hook call; drop the no-op `as unknown as FastifyInstance` cast.
3. **reject-h2.ts**: Delete file. Also delete the test file `tests/proxy/http2-reject.test.ts`? No — the test still validates 505 behavior via the clientError path, keep it.
4. **hot-path.ts** + **pass-through.ts**: In `buildUpstreamPath`, reject paths that don't start with `/` by returning `'/'` or erroring. Simpler: slice req.url directly after validating start char.
5. **hot-path.ts**: `writeResponseHead`'s Writable `destroy(err, cb)` — emit SSE error if headers sent, then call `raw.destroy(err ?? undefined)`; `cb(err)`.
6. **abort.ts**: Add `req.raw.once('close', onAbort)` + dispose off.
7. **body-splice.ts**: Remove the `parsed === null || typeof parsed !== 'object'` check; pass `parsed` through as-is.
8. **headers.ts**: Delete `export const UPSTREAM_HOST_NAME`.
9. **headers.ts**: Add one-line comment explaining why `expect` is stripped.

## Auto-Applied (no user input needed)
- All items marked "Auto-fix" above.

## Deviations During Apply
- **abort.ts req.raw.close**: Attempted to add, but regressed 28 tests. IncomingMessage fires 'close' when body is fully read — long streaming responses spuriously aborted. Reverted; TCP socket listener remains authoritative. Updated inline comment to document why.
- **server.ts FastifyInstance cast**: Attempted to delete the `as unknown as FastifyInstance` no-op, but typecheck failed: Fastify default Logger generic doesn't match our pino Logger's extended generics. Restored cast with a comment explaining the type friction.

## Let-Go
- Nits (`_err`, `catch {}` style), inline deps, AbortError kind, `logger.ts` commit-scoping, test helpers using process.env (vi.stubEnv refactor is bigger than section-04 scope).
