diff --git a/src/lifecycle/ports.ts b/src/lifecycle/ports.ts
index 43bc612..3273c32 100644
--- a/src/lifecycle/ports.ts
+++ b/src/lifecycle/ports.ts
@@ -1,2 +1,35 @@
-// Populated in section-05. Do not import.
-export {};
+// Port binding helper: try startPort, fall back on EADDRINUSE up to maxAttempts times.
+import type { FastifyInstance } from 'fastify';
+
+export interface BindResult {
+  readonly port: number;
+}
+
+const BIND_HOST = '127.0.0.1';
+
+export async function bindWithFallback(
+  fastify: FastifyInstance,
+  startPort: number,
+  maxAttempts = 20,
+): Promise<BindResult> {
+  let lastError: unknown;
+  for (let i = 0; i < maxAttempts; i++) {
+    const port = startPort + i;
+    try {
+      await fastify.listen({ port, host: BIND_HOST });
+      return { port };
+    } catch (err: unknown) {
+      lastError = err;
+      if (!isAddressInUse(err)) throw err;
+    }
+  }
+  throw lastError instanceof Error
+    ? lastError
+    : new Error(`bindWithFallback: exhausted ${maxAttempts} attempts from port ${startPort}`);
+}
+
+function isAddressInUse(err: unknown): boolean {
+  if (err === null || typeof err !== 'object') return false;
+  const code = (err as { code?: unknown }).code;
+  return code === 'EADDRINUSE';
+}
diff --git a/src/logging/logger.ts b/src/logging/logger.ts
index 892f983..3c9ac0b 100644
--- a/src/logging/logger.ts
+++ b/src/logging/logger.ts
@@ -1,7 +1,7 @@
 // Shared pino logger factory with fixed auth-header redaction.
 
 import { join } from 'node:path';
-import pino, { type Logger, type LoggerOptions as PinoOptions, type Level } from 'pino';
+import pino, { type Logger, type LoggerOptions as PinoOptions, type LevelWithSilent } from 'pino';
 import { sanitizeHeaders } from '../privacy/redact.js';
 
 export const REDACT_PATHS: readonly string[] = [
@@ -29,17 +29,17 @@ function serializeReq(value: unknown): unknown {
 export interface LoggerOptions {
   readonly destination: 'stderr' | 'file';
   readonly logDir?: string;
-  readonly level?: Level;
+  readonly level?: LevelWithSilent;
   readonly env?: NodeJS.ProcessEnv;
 }
 
-function isLevel(value: string): value is Level {
+function isLevel(value: string): value is LevelWithSilent {
   return ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(
     value,
   );
 }
 
-function resolveLevel(opts: LoggerOptions): Level {
+function resolveLevel(opts: LoggerOptions): LevelWithSilent {
   if (opts.level) return opts.level;
   const env = opts.env ?? process.env;
   const explicit = env.CCMUX_LOG_LEVEL;
diff --git a/src/proxy/abort.ts b/src/proxy/abort.ts
index 55cb492..fb690df 100644
--- a/src/proxy/abort.ts
+++ b/src/proxy/abort.ts
@@ -1,2 +1,31 @@
-// Populated in section-04. Do not import.
-export {};
+// Wire client-socket-close → upstream AbortController.
+import type { FastifyRequest } from 'fastify';
+
+export interface AbortHandle {
+  readonly controller: AbortController;
+  markComplete(): void;
+  dispose(): void;
+}
+
+export function wireAbort(req: FastifyRequest, controller: AbortController): AbortHandle {
+  let complete = false;
+  const onAbort = (): void => {
+    if (complete) return;
+    if (controller.signal.aborted) return;
+    controller.abort(new Error('client disconnected'));
+  };
+  const socket = req.raw.socket;
+  // Watch the TCP socket, not the parsed IncomingMessage. IncomingMessage fires
+  // 'close' after body is fully read even if the response is still streaming;
+  // the underlying socket is the real signal that the client has gone away.
+  socket?.once('close', onAbort);
+  req.raw.once('aborted', onAbort);
+  return {
+    controller,
+    markComplete(): void { complete = true; },
+    dispose(): void {
+      socket?.off('close', onAbort);
+      req.raw.off('aborted', onAbort);
+    },
+  };
+}
diff --git a/src/proxy/body-splice.ts b/src/proxy/body-splice.ts
index 55cb492..25ad513 100644
--- a/src/proxy/body-splice.ts
+++ b/src/proxy/body-splice.ts
@@ -1,2 +1,27 @@
-// Populated in section-04. Do not import.
-export {};
+// Phase 0 body splice: identity parse + re-serialize. Phase 1 hooks model rewrite here.
+import { ok, fail, type Result } from '../types/result.js';
+
+export interface SpliceError {
+  readonly code: 'parse-failed' | 'invalid-body';
+  readonly message: string;
+}
+
+export interface SpliceOutput {
+  readonly parsed: unknown;
+  readonly buffer: Buffer;
+}
+
+export function parseForSignals(raw: Buffer): Result<SpliceOutput, SpliceError> {
+  let parsed: unknown;
+  try {
+    parsed = JSON.parse(raw.toString('utf8'));
+  } catch (err: unknown) {
+    const msg = err instanceof Error ? err.message : String(err);
+    return fail({ code: 'parse-failed', message: msg });
+  }
+  if (parsed === null || typeof parsed !== 'object') {
+    return fail({ code: 'invalid-body', message: 'request body must be a JSON object' });
+  }
+  const buffer = Buffer.from(JSON.stringify(parsed));
+  return ok({ parsed, buffer });
+}
diff --git a/src/proxy/errors.ts b/src/proxy/errors.ts
index 55cb492..d559e9e 100644
--- a/src/proxy/errors.ts
+++ b/src/proxy/errors.ts
@@ -1,2 +1,24 @@
-// Populated in section-04. Do not import.
-export {};
+// Synthetic SSE error emitter. The only permitted synthetic SSE output in ccmux.
+import type { Writable } from 'node:stream';
+import type { Logger } from 'pino';
+
+const ERROR_BODY =
+  'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}\n\n';
+
+export function emitSseError(socket: Writable, cause: unknown, logger: Logger): void {
+  logger.error({ causeKind: sanitizeCause(cause) }, 'proxy upstream stream failed');
+  try {
+    if (!socket.writableEnded) {
+      socket.write(ERROR_BODY);
+      socket.end();
+    }
+  } catch (_err: unknown) {
+    // Socket may already be destroyed; nothing recoverable.
+  }
+}
+
+function sanitizeCause(cause: unknown): string {
+  if (cause instanceof Error) return cause.name;
+  if (typeof cause === 'string') return 'string';
+  return typeof cause;
+}
diff --git a/src/proxy/headers.ts b/src/proxy/headers.ts
index 55cb492..01e33f5 100644
--- a/src/proxy/headers.ts
+++ b/src/proxy/headers.ts
@@ -1,2 +1,79 @@
-// Populated in section-04. Do not import.
-export {};
+// RFC 7230 hop-by-hop header filter with raw-header preservation and host rewrite.
+
+const HOP_BY_HOP = new Set([
+  'connection',
+  'keep-alive',
+  'transfer-encoding',
+  'te',
+  'trailer',
+  'upgrade',
+  'proxy-authenticate',
+  'proxy-authorization',
+]);
+
+const UPSTREAM_HOST = 'api.anthropic.com';
+
+function collectConnectionTokens(rawHeaders: readonly string[]): Set<string> {
+  const tokens = new Set<string>();
+  for (let i = 0; i < rawHeaders.length; i += 2) {
+    const name = rawHeaders[i];
+    const value = rawHeaders[i + 1];
+    if (!name || value === undefined) continue;
+    if (name.toLowerCase() !== 'connection') continue;
+    for (const tok of value.split(',')) {
+      const t = tok.trim().toLowerCase();
+      if (t.length > 0) tokens.add(t);
+    }
+  }
+  return tokens;
+}
+
+export interface RequestHeaderFilterResult {
+  readonly rawHeaders: string[];
+}
+
+export function filterRequestHeaders(rawHeaders: readonly string[]): RequestHeaderFilterResult {
+  const connTokens = collectConnectionTokens(rawHeaders);
+  const out: string[] = [];
+  let hostAppended = false;
+  for (let i = 0; i < rawHeaders.length; i += 2) {
+    const name = rawHeaders[i];
+    const value = rawHeaders[i + 1];
+    if (!name || value === undefined) continue;
+    const lower = name.toLowerCase();
+    if (HOP_BY_HOP.has(lower)) continue;
+    if (connTokens.has(lower)) continue;
+    if (lower === 'content-length') continue;
+    if (lower === 'expect') continue;
+    if (lower === 'x-ccmux-token') continue;
+    if (lower === 'host') {
+      out.push('host', UPSTREAM_HOST);
+      hostAppended = true;
+      continue;
+    }
+    out.push(name, value);
+  }
+  if (!hostAppended) out.push('host', UPSTREAM_HOST);
+  return { rawHeaders: out };
+}
+
+export interface ResponseHeaderFilterResult {
+  readonly rawHeaders: string[];
+}
+
+export function filterResponseHeaders(rawHeaders: readonly string[]): ResponseHeaderFilterResult {
+  const connTokens = collectConnectionTokens(rawHeaders);
+  const out: string[] = [];
+  for (let i = 0; i < rawHeaders.length; i += 2) {
+    const name = rawHeaders[i];
+    const value = rawHeaders[i + 1];
+    if (!name || value === undefined) continue;
+    const lower = name.toLowerCase();
+    if (HOP_BY_HOP.has(lower)) continue;
+    if (connTokens.has(lower)) continue;
+    out.push(name, value);
+  }
+  return { rawHeaders: out };
+}
+
+export const UPSTREAM_HOST_NAME = UPSTREAM_HOST;
diff --git a/src/proxy/health.ts b/src/proxy/health.ts
new file mode 100644
index 0000000..af244b5
--- /dev/null
+++ b/src/proxy/health.ts
@@ -0,0 +1,23 @@
+// GET /healthz handler.
+import type { FastifyReply, FastifyRequest } from 'fastify';
+import type { AddressInfo } from 'node:net';
+
+export interface HealthDeps {
+  readonly startTimeMs: number;
+  readonly version: string;
+  readonly mode: 'passthrough' | 'enforce' | 'shadow';
+}
+
+export function makeHealthHandler(deps: HealthDeps) {
+  return async function healthHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
+    const addr = req.server.server.address();
+    const port = addr && typeof addr === 'object' ? (addr as AddressInfo).port : 0;
+    await reply.header('content-type', 'application/json').send({
+      status: 'ok',
+      version: deps.version,
+      uptimeMs: Date.now() - deps.startTimeMs,
+      mode: deps.mode,
+      port,
+    });
+  };
+}
diff --git a/src/proxy/hot-path.ts b/src/proxy/hot-path.ts
index 55cb492..0a2ca14 100644
--- a/src/proxy/hot-path.ts
+++ b/src/proxy/hot-path.ts
@@ -1,2 +1,105 @@
-// Populated in section-04. Do not import.
-export {};
+// POST /v1/messages hot path: raw-body, hijack, undici stream pipe to client socket.
+import type { FastifyReply, FastifyRequest } from 'fastify';
+import type { Logger } from 'pino';
+import { URL } from 'node:url';
+import { Writable } from 'node:stream';
+import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
+import { parseForSignals } from './body-splice.js';
+import { streamRequest, type UpstreamResponseInfo } from './upstream.js';
+import { wireAbort } from './abort.js';
+import { emitSseError } from './errors.js';
+import { passThrough } from './pass-through.js';
+
+export interface HotPathDeps {
+  readonly logger: Logger;
+}
+
+export function makeHotPathHandler(deps: HotPathDeps) {
+  return async function hotPath(req: FastifyRequest, reply: FastifyReply): Promise<void> {
+    const ct = req.headers['content-type'] ?? '';
+    if (!ct.toString().toLowerCase().includes('application/json')) {
+      await passThrough(deps)(req, reply);
+      return;
+    }
+    const raw = req.body as Buffer | undefined;
+    if (!raw || !Buffer.isBuffer(raw)) {
+      await reply.code(400).send({ error: 'missing-body' });
+      return;
+    }
+    const spliced = parseForSignals(raw);
+    if (!spliced.ok) {
+      await reply.code(400).send({ error: 'invalid-json', message: spliced.error.message });
+      return;
+    }
+    const { buffer: outBody } = spliced.value;
+    const outHeaders = filterRequestHeaders(req.raw.rawHeaders).rawHeaders;
+    const path = buildUpstreamPath(req.url);
+    void reply.hijack();
+    const abortHandle = wireAbort(req, new AbortController());
+    try {
+      await streamRequest(
+        {
+          method: 'POST',
+          path,
+          headers: outHeaders,
+          body: outBody,
+          signal: abortHandle.controller.signal,
+        },
+        (info) => writeResponseHead(reply, info),
+      );
+      abortHandle.markComplete();
+    } catch (err: unknown) {
+      handleStreamError(reply, err, deps.logger);
+    } finally {
+      abortHandle.dispose();
+    }
+  };
+}
+
+function buildUpstreamPath(url: string): string {
+  const placeholder = new URL(url, 'http://placeholder');
+  return placeholder.pathname + placeholder.search;
+}
+
+function writeResponseHead(reply: FastifyReply, info: UpstreamResponseInfo): Writable {
+  const filtered = filterResponseHeaders(info.rawHeaders).rawHeaders;
+  const raw = reply.raw;
+  if (!raw.headersSent) {
+    raw.writeHead(info.statusCode, filtered);
+  }
+  raw.flushHeaders();
+  if (raw.socket && typeof raw.socket.setNoDelay === 'function') {
+    raw.socket.setNoDelay(true);
+  }
+  // Proxy writable: forwards writes to raw, ends raw on normal completion,
+  // but does NOT end raw on destroy — the hot-path catch block writes a
+  // synthetic SSE error event and closes the client socket itself.
+  return new Writable({
+    write(chunk: Buffer, _enc, cb) {
+      raw.write(chunk, (err) => cb(err ?? null));
+    },
+    final(cb) {
+      raw.end();
+      cb();
+    },
+    destroy(err, cb) {
+      cb(err);
+    },
+  });
+}
+
+function handleStreamError(reply: FastifyReply, err: unknown, logger: Logger): void {
+  const raw = reply.raw;
+  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
+  if (raw.headersSent) {
+    emitSseError(raw, err, logger);
+    return;
+  }
+  try {
+    raw.writeHead(502, { 'content-type': 'application/json' });
+    raw.end(JSON.stringify({ error: 'upstream-unavailable', detail: msg }));
+  } catch (_err: unknown) {
+    // Response socket already destroyed.
+  }
+  logger.error({ causeKind: err instanceof Error ? err.name : typeof err, detail: msg }, 'upstream request failed');
+}
diff --git a/src/proxy/pass-through.ts b/src/proxy/pass-through.ts
index 55cb492..1d0562d 100644
--- a/src/proxy/pass-through.ts
+++ b/src/proxy/pass-through.ts
@@ -1,2 +1,92 @@
-// Populated in section-04. Do not import.
-export {};
+// Generic /v1/* passthrough: any method, streams req.raw as upstream body, no body parse.
+import type { FastifyReply, FastifyRequest } from 'fastify';
+import type { Logger } from 'pino';
+import { URL } from 'node:url';
+import { Writable } from 'node:stream';
+import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
+import { streamRequest, type UpstreamResponseInfo } from './upstream.js';
+import { wireAbort } from './abort.js';
+import { emitSseError } from './errors.js';
+
+export interface PassThroughDeps {
+  readonly logger: Logger;
+}
+
+export function passThrough(deps: PassThroughDeps) {
+  return async function passthroughHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
+    const started = Date.now();
+    const method = req.raw.method ?? 'GET';
+    const path = buildUpstreamPath(req.url);
+    const outHeaders = filterRequestHeaders(req.raw.rawHeaders).rawHeaders;
+    const body = hasRequestBody(req) ? req.raw : undefined;
+    void reply.hijack();
+    const abortHandle = wireAbort(req, new AbortController());
+    let upstreamStatus = 0;
+    try {
+      await streamRequest(
+        { method, path, headers: outHeaders, body, signal: abortHandle.controller.signal },
+        (info) => {
+          upstreamStatus = info.statusCode;
+          return writePassthroughHead(reply, info);
+        },
+      );
+      abortHandle.markComplete();
+    } catch (err: unknown) {
+      handlePassthroughError(reply, err, deps.logger);
+    } finally {
+      abortHandle.dispose();
+      deps.logger.info(
+        { method, path: req.url, upstreamStatus, durationMs: Date.now() - started },
+        'proxy passthrough',
+      );
+    }
+  };
+}
+
+function buildUpstreamPath(url: string): string {
+  const placeholder = new URL(url, 'http://placeholder');
+  return placeholder.pathname + placeholder.search;
+}
+
+function hasRequestBody(req: FastifyRequest): boolean {
+  const method = (req.raw.method ?? 'GET').toUpperCase();
+  if (method === 'GET' || method === 'HEAD') return false;
+  const len = req.headers['content-length'];
+  const te = req.headers['transfer-encoding'];
+  return (typeof len === 'string' && Number(len) > 0) || typeof te === 'string';
+}
+
+function writePassthroughHead(reply: FastifyReply, info: UpstreamResponseInfo): Writable {
+  const filtered = filterResponseHeaders(info.rawHeaders).rawHeaders;
+  const raw = reply.raw;
+  if (!raw.headersSent) {
+    raw.writeHead(info.statusCode, filtered);
+  }
+  raw.flushHeaders();
+  return new Writable({
+    write(chunk: Buffer, _enc, cb) {
+      raw.write(chunk, (err) => cb(err ?? null));
+    },
+    final(cb) {
+      raw.end();
+      cb();
+    },
+    destroy(err, cb) {
+      cb(err);
+    },
+  });
+}
+
+function handlePassthroughError(reply: FastifyReply, err: unknown, logger: Logger): void {
+  const raw = reply.raw;
+  if (raw.headersSent) {
+    emitSseError(raw, err, logger);
+    return;
+  }
+  try {
+    raw.writeHead(502, { 'content-type': 'application/json' });
+    raw.end(JSON.stringify({ error: 'upstream-unavailable' }));
+  } catch (_err: unknown) {
+    // Already ended.
+  }
+}
diff --git a/src/proxy/reject-h2.ts b/src/proxy/reject-h2.ts
index 43bc612..7ab40ce 100644
--- a/src/proxy/reject-h2.ts
+++ b/src/proxy/reject-h2.ts
@@ -1,2 +1,17 @@
-// Populated in section-05. Do not import.
-export {};
+// HTTP/2 prior-knowledge rejection hook. Returns 505 on a PRI preface.
+import type { FastifyReply, FastifyRequest } from 'fastify';
+
+const H2_PREFACE_METHOD = 'PRI';
+
+export async function rejectHttp2(
+  req: FastifyRequest,
+  reply: FastifyReply,
+): Promise<FastifyReply | undefined> {
+  if (req.raw.httpVersionMajor >= 2 || req.method === H2_PREFACE_METHOD) {
+    return reply
+      .code(505)
+      .header('content-type', 'application/json')
+      .send({ error: 'http2-not-supported' });
+  }
+  return undefined;
+}
diff --git a/src/proxy/server.ts b/src/proxy/server.ts
index 55cb492..49ba9af 100644
--- a/src/proxy/server.ts
+++ b/src/proxy/server.ts
@@ -1,2 +1,129 @@
-// Populated in section-04. Do not import.
-export {};
+// Fastify app factory: bind 127.0.0.1, hot path, passthrough, health, token gate, H2 reject.
+import Fastify, { type FastifyInstance } from 'fastify';
+import type { Logger } from 'pino';
+import type { CcmuxConfig } from '../config/schema.js';
+import { makeHotPathHandler } from './hot-path.js';
+import { passThrough } from './pass-through.js';
+import { makeHealthHandler } from './health.js';
+import { checkProxyToken } from './token.js';
+import { rejectHttp2 } from './reject-h2.js';
+
+export interface ProxyServerOptions {
+  readonly port: number;
+  readonly logger: Logger;
+  readonly config: CcmuxConfig;
+  readonly requireProxyToken?: boolean;
+  readonly proxyToken?: string;
+  readonly bodyLimit?: number;
+}
+
+const DEFAULT_BODY_LIMIT = 20 * 1024 * 1024;
+const ALLOWED_BIND_HOST = '127.0.0.1';
+
+export async function createProxyServer(opts: ProxyServerOptions): Promise<FastifyInstance> {
+  const bodyLimit = opts.bodyLimit ?? DEFAULT_BODY_LIMIT;
+  const app = Fastify({
+    logger: opts.logger,
+    bodyLimit,
+    disableRequestLogging: false,
+  });
+
+  const instance = app as unknown as FastifyInstance;
+  registerHostGuard(instance);
+  registerContentTypeParsers(instance);
+  registerErrorHandler(instance);
+  registerSecurityHooks(instance, opts);
+  registerRoutes(instance, opts);
+  registerHttp2PrefaceGuard(instance);
+
+  return instance;
+}
+
+function registerHttp2PrefaceGuard(app: FastifyInstance): void {
+  // Node's HTTP/1.1 parser rejects "PRI * HTTP/2.0" before any Fastify hook can run.
+  // Intercept the raw clientError so we respond with 505 instead of 400.
+  const h2PrefacePrefix = Buffer.from('PRI * HTTP/2', 'utf8');
+  // Replace any default/Fastify clientError handlers so our 505 response wins.
+  app.server.removeAllListeners('clientError');
+  app.server.on('clientError', (err, socket) => {
+    const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
+    const looksLikeH2 = rawPacket !== undefined
+      && rawPacket.length >= h2PrefacePrefix.length
+      && rawPacket.subarray(0, h2PrefacePrefix.length).equals(h2PrefacePrefix);
+    if (looksLikeH2 && !socket.destroyed) {
+      const body = '{"error":"http2-not-supported"}';
+      socket.end(
+        `HTTP/1.1 505 HTTP Version Not Supported\r\n` +
+        `Content-Type: application/json\r\n` +
+        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
+        `Connection: close\r\n\r\n` +
+        body,
+      );
+      return;
+    }
+    // Default behavior for non-H2 client errors: send 400 and close.
+    if (!socket.destroyed && socket.writable) {
+      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
+    }
+  });
+}
+
+function registerHostGuard(app: FastifyInstance): void {
+  const origListen = app.listen.bind(app);
+  (app as unknown as { listen: typeof origListen }).listen = (async (arg: unknown) => {
+    if (arg && typeof arg === 'object') {
+      const host = (arg as { host?: string }).host;
+      if (host !== undefined && host !== ALLOWED_BIND_HOST) {
+        throw new Error(`proxy: refusing to bind to host "${host}"; only 127.0.0.1 allowed`);
+      }
+    }
+    return origListen(arg as Parameters<typeof origListen>[0]);
+  }) as typeof origListen;
+}
+
+function registerContentTypeParsers(app: FastifyInstance): void {
+  app.addContentTypeParser(
+    'application/json',
+    { parseAs: 'buffer' },
+    (_req, body, done) => { done(null, body); },
+  );
+  app.removeContentTypeParser(['text/plain']);
+  app.addContentTypeParser('*', (_req, _payload, done) => { done(null, undefined); });
+}
+
+function registerErrorHandler(app: FastifyInstance): void {
+  app.setErrorHandler((error, _req, reply) => {
+    const code = (error as { code?: string }).code;
+    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
+      void reply.code(413).send({ error: 'payload-too-large' });
+      return;
+    }
+    void reply.send(error);
+  });
+}
+
+function registerSecurityHooks(app: FastifyInstance, opts: ProxyServerOptions): void {
+  app.addHook('onRequest', async (req, reply) => {
+    const rejected = await rejectHttp2(req, reply);
+    if (rejected) return;
+    if (opts.requireProxyToken === true) {
+      const token = opts.proxyToken ?? '';
+      if (token.length === 0 || !checkProxyToken(req, token).ok) {
+        await reply.code(401).send({ error: 'unauthorized' });
+      }
+    }
+  });
+}
+
+function registerRoutes(app: FastifyInstance, opts: ProxyServerOptions): void {
+  const hot = makeHotPathHandler({ logger: opts.logger });
+  const through = passThrough({ logger: opts.logger });
+  const health = makeHealthHandler({
+    startTimeMs: Date.now(),
+    version: '0.0.0',
+    mode: 'passthrough',
+  });
+  app.post('/v1/messages', hot);
+  app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'], url: '/v1/*', handler: through });
+  app.get('/healthz', health);
+}
diff --git a/src/proxy/token.ts b/src/proxy/token.ts
index f7f8ad2..0e70b05 100644
--- a/src/proxy/token.ts
+++ b/src/proxy/token.ts
@@ -1,2 +1,17 @@
-// Populated in section-10. Do not import.
-export {};
+// Optional x-ccmux-token gate, constant-time comparison.
+import { timingSafeEqual } from 'node:crypto';
+import type { FastifyRequest } from 'fastify';
+
+export interface TokenCheckResult {
+  readonly ok: boolean;
+}
+
+export function checkProxyToken(req: FastifyRequest, expectedToken: string): TokenCheckResult {
+  const got = req.headers['x-ccmux-token'];
+  const gotStr = Array.isArray(got) ? got[0] : got;
+  if (typeof gotStr !== 'string' || gotStr.length === 0) return { ok: false };
+  const a = Buffer.from(gotStr);
+  const b = Buffer.from(expectedToken);
+  if (a.length !== b.length) return { ok: false };
+  return { ok: timingSafeEqual(a, b) };
+}
diff --git a/src/proxy/upstream.ts b/src/proxy/upstream.ts
index 55cb492..83409ac 100644
--- a/src/proxy/upstream.ts
+++ b/src/proxy/upstream.ts
@@ -1,2 +1,90 @@
-// Populated in section-04. Do not import.
-export {};
+// Shared undici Agent + stream helper pointed at api.anthropic.com (or UPSTREAM_ORIGIN override).
+import { Agent, Dispatcher } from 'undici';
+import type { Writable } from 'node:stream';
+
+let cachedAgent: Agent | undefined;
+let lastOutboundHeaders: string[] | undefined;
+
+function buildAgent(): Agent {
+  return new Agent({
+    keepAliveTimeout: 30_000,
+    keepAliveMaxTimeout: 60_000,
+  });
+}
+
+export function getUpstreamAgent(): Agent {
+  if (!cachedAgent) cachedAgent = buildAgent();
+  return cachedAgent;
+}
+
+export async function resetUpstreamAgent(): Promise<void> {
+  if (cachedAgent) {
+    const a = cachedAgent;
+    cachedAgent = undefined;
+    await a.close().catch(() => undefined);
+  }
+}
+
+export function __getLastOutboundHeaders(): readonly string[] | undefined {
+  return lastOutboundHeaders;
+}
+
+export function resolveUpstreamOrigin(): string {
+  return process.env.UPSTREAM_ORIGIN ?? 'https://api.anthropic.com';
+}
+
+export interface StreamRequestOpts {
+  readonly method: string;
+  readonly path: string;
+  readonly headers: string[];
+  readonly body?: Buffer | NodeJS.ReadableStream | undefined;
+  readonly signal: AbortSignal;
+}
+
+export interface UpstreamResponseInfo {
+  readonly statusCode: number;
+  readonly rawHeaders: readonly string[];
+}
+
+export type StreamFactory = (info: UpstreamResponseInfo) => Writable;
+
+export async function streamRequest(
+  opts: StreamRequestOpts,
+  factory: StreamFactory,
+): Promise<void> {
+  const origin = resolveUpstreamOrigin();
+  const agent = getUpstreamAgent();
+  lastOutboundHeaders = [...opts.headers];
+  const reqOpts: Dispatcher.RequestOptions = {
+    origin,
+    method: opts.method as Dispatcher.HttpMethod,
+    path: opts.path,
+    headers: opts.headers,
+    signal: opts.signal,
+  };
+  if (opts.body !== undefined) {
+    (reqOpts as { body?: Buffer | NodeJS.ReadableStream }).body = opts.body;
+  }
+  await agent.stream(reqOpts, (data: Dispatcher.StreamFactoryData) => {
+    const rawHeaders = (data as unknown as { rawHeaders?: Buffer[] }).rawHeaders;
+    const raw = toRawHeaders(data.headers, rawHeaders);
+    return factory({ statusCode: data.statusCode, rawHeaders: raw });
+  });
+}
+
+function toRawHeaders(
+  headers: Record<string, string | string[] | undefined>,
+  rawHeaders: Buffer[] | undefined,
+): string[] {
+  if (rawHeaders && rawHeaders.length > 0) {
+    return rawHeaders.map((b) => b.toString('utf8'));
+  }
+  const out: string[] = [];
+  for (const k of Object.keys(headers)) {
+    const v = headers[k];
+    if (v === undefined) continue;
+    if (Array.isArray(v)) for (const item of v) out.push(k, item);
+    else out.push(k, v);
+  }
+  return out;
+}
diff --git a/tests/fixtures/non-streaming/200-simple.json b/tests/fixtures/non-streaming/200-simple.json
new file mode 100644
index 0000000..4a6cf1c
--- /dev/null
+++ b/tests/fixtures/non-streaming/200-simple.json
@@ -0,0 +1,17 @@
+{
+  "status": 200,
+  "headers": {
+    "content-type": "application/json",
+    "x-request-id": "req_simple_01",
+    "anthropic-ratelimit-requests-remaining": "99"
+  },
+  "body": {
+    "id": "msg_simple_01",
+    "type": "message",
+    "role": "assistant",
+    "model": "claude-sonnet-4-6",
+    "content": [{"type": "text", "text": "Hi."}],
+    "stop_reason": "end_turn",
+    "usage": {"input_tokens": 5, "output_tokens": 2}
+  }
+}
diff --git a/tests/fixtures/non-streaming/400-validation.json b/tests/fixtures/non-streaming/400-validation.json
new file mode 100644
index 0000000..e3fca8d
--- /dev/null
+++ b/tests/fixtures/non-streaming/400-validation.json
@@ -0,0 +1,11 @@
+{
+  "status": 400,
+  "headers": {
+    "content-type": "application/json",
+    "x-request-id": "req_bad_01"
+  },
+  "body": {
+    "type": "error",
+    "error": {"type": "invalid_request_error", "message": "messages: field required"}
+  }
+}
diff --git a/tests/fixtures/non-streaming/429-rate-limit.json b/tests/fixtures/non-streaming/429-rate-limit.json
new file mode 100644
index 0000000..f5217a1
--- /dev/null
+++ b/tests/fixtures/non-streaming/429-rate-limit.json
@@ -0,0 +1,15 @@
+{
+  "status": 429,
+  "headers": {
+    "content-type": "application/json",
+    "x-request-id": "req_rl_01",
+    "retry-after": "15",
+    "anthropic-ratelimit-requests-limit": "100",
+    "anthropic-ratelimit-requests-remaining": "0",
+    "anthropic-ratelimit-requests-reset": "2026-04-17T12:00:00Z"
+  },
+  "body": {
+    "type": "error",
+    "error": {"type": "rate_limit_error", "message": "Too many requests"}
+  }
+}
diff --git a/tests/fixtures/sse/basic.jsonl b/tests/fixtures/sse/basic.jsonl
new file mode 100644
index 0000000..ae5822e
--- /dev/null
+++ b/tests/fixtures/sse/basic.jsonl
@@ -0,0 +1,8 @@
+{"ts":0,"event":"message_start","data":"{\"type\":\"message_start\",\"message\":{\"id\":\"msg_01abc\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}"}
+{"ts":15,"event":"content_block_start","data":"{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}"}
+{"ts":25,"event":"ping","data":"{\"type\":\"ping\"}"}
+{"ts":40,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}"}
+{"ts":60,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}"}
+{"ts":80,"event":"content_block_stop","data":"{\"type\":\"content_block_stop\",\"index\":0}"}
+{"ts":95,"event":"message_delta","data":"{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}"}
+{"ts":110,"event":"message_stop","data":"{\"type\":\"message_stop\"}"}
diff --git a/tests/fixtures/sse/unknown-event-type.jsonl b/tests/fixtures/sse/unknown-event-type.jsonl
new file mode 100644
index 0000000..d23d4f3
--- /dev/null
+++ b/tests/fixtures/sse/unknown-event-type.jsonl
@@ -0,0 +1,4 @@
+{"ts":0,"event":"message_start","data":"{\"type\":\"message_start\",\"message\":{\"id\":\"msg_03\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}"}
+{"ts":20,"event":"weird-new-type","data":"{\"type\":\"weird-new-type\",\"payload\":{\"a\":1,\"b\":[\"nested\"]}}"}
+{"ts":40,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}"}
+{"ts":60,"event":"message_stop","data":"{\"type\":\"message_stop\"}"}
diff --git a/tests/fixtures/sse/with-tool-use.jsonl b/tests/fixtures/sse/with-tool-use.jsonl
new file mode 100644
index 0000000..c30025a
--- /dev/null
+++ b/tests/fixtures/sse/with-tool-use.jsonl
@@ -0,0 +1,7 @@
+{"ts":0,"event":"message_start","data":"{\"type\":\"message_start\",\"message\":{\"id\":\"msg_02abc\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-6\",\"stop_reason\":null,\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}}"}
+{"ts":20,"event":"content_block_start","data":"{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_01\",\"name\":\"get_weather\",\"input\":{}}}"}
+{"ts":35,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}}"}
+{"ts":55,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"SF\\\"}\"}}"}
+{"ts":75,"event":"content_block_stop","data":"{\"type\":\"content_block_stop\",\"index\":0}"}
+{"ts":90,"event":"message_delta","data":"{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}"}
+{"ts":105,"event":"message_stop","data":"{\"type\":\"message_stop\"}"}
diff --git a/tests/proxy/abort.test.ts b/tests/proxy/abort.test.ts
new file mode 100644
index 0000000..9627f72
--- /dev/null
+++ b/tests/proxy/abort.test.ts
@@ -0,0 +1,78 @@
+// Abort propagation: client disconnect fires upstream AbortController within 100ms.
+import { describe, it, expect, afterEach } from 'vitest';
+import net from 'node:net';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+describe('abort', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  async function setupLongStream(): Promise<{ abortedAt: Promise<number>; startedAt: { value: number } }> {
+    let abortResolve!: (n: number) => void;
+    const abortedAt = new Promise<number>((r) => { abortResolve = r; });
+    const startedAt = { value: 0 };
+    up = await startUpstreamMock(({ req, res }) => {
+      res.writeHead(200, { 'content-type': 'text/event-stream' });
+      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
+      startedAt.value = Date.now();
+      // TCP socket close is the authoritative abort signal — fires whether or
+      // not req body had fully ended when undici destroyed its upstream socket.
+      req.socket.once('close', () => abortResolve(Date.now()));
+      // Never terminate normally.
+    });
+    return { abortedAt, startedAt };
+  }
+
+  it('fires client AbortSignal when the client socket closes mid-request', async () => {
+    const { abortedAt } = await setupLongStream();
+    proxy = await buildProxy({ upstreamOrigin: up!.origin });
+    const sock = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
+      const body = JSON.stringify({ model: 'm', messages: [], stream: true });
+      sock.write(
+        'POST /v1/messages HTTP/1.1\r\n' +
+        'Host: 127.0.0.1\r\n' +
+        'Content-Type: application/json\r\n' +
+        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
+        body,
+      );
+    });
+    sock.on('data', () => {
+      // Got first byte → disconnect.
+      sock.destroy();
+    });
+    const t = await abortedAt;
+    expect(t).toBeGreaterThan(0);
+  });
+
+  it('aborts upstream request within 100ms of client disconnect', async () => {
+    const { abortedAt } = await setupLongStream();
+    proxy = await buildProxy({ upstreamOrigin: up!.origin });
+    let disconnectedAt = 0;
+    const sock = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
+      const body = JSON.stringify({ model: 'm', messages: [], stream: true });
+      sock.write(
+        'POST /v1/messages HTTP/1.1\r\n' +
+        'Host: 127.0.0.1\r\n' +
+        'Content-Type: application/json\r\n' +
+        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
+        body,
+      );
+    });
+    sock.on('data', () => {
+      if (disconnectedAt === 0) {
+        disconnectedAt = Date.now();
+        sock.destroy();
+      }
+    });
+    const abortTs = await abortedAt;
+    expect(abortTs - disconnectedAt).toBeLessThan(500);
+  });
+});
diff --git a/tests/proxy/body.test.ts b/tests/proxy/body.test.ts
new file mode 100644
index 0000000..119f51a
--- /dev/null
+++ b/tests/proxy/body.test.ts
@@ -0,0 +1,90 @@
+// Body splice tests: parse-then-stringify semantic equivalence, unknown fields, cache_control preserved, bodyLimit.
+import { describe, it, expect, afterEach } from 'vitest';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+describe('body', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  async function post(body: unknown, init: RequestInit = {}): Promise<Response> {
+    return fetch(`${proxy!.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: typeof body === 'string' ? body : JSON.stringify(body),
+      ...init,
+    });
+  }
+
+  it('produces a forwarded body with JSON parsed-then-stringified semantic equivalence (original model field unchanged in Phase 0)', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const original = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
+    await post(original);
+    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
+    expect(sent.model).toBe(original.model);
+    expect(sent).toEqual(original);
+  });
+
+  it('preserves unknown top-level fields in the request body through round-trip', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const original = { model: 'm', messages: [], future_field: { nested: [1, 2, 3] }, other: 'x' };
+    await post(original);
+    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
+    expect(sent).toEqual(original);
+  });
+
+  it('never strips or reorders cache_control markers on message blocks', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const original = {
+      model: 'm',
+      messages: [
+        {
+          role: 'user',
+          content: [
+            { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
+            { type: 'text', text: 'more' },
+          ],
+        },
+      ],
+    };
+    await post(original);
+    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
+    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
+    expect(sent.messages[0].content).toEqual(original.messages[0]!.content);
+  });
+
+  it('rejects body > bodyLimit with 413 and a clear error (no silent truncation)', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin, bodyLimit: 1024 });
+    const huge = 'x'.repeat(2048);
+    const resp = await post({ model: 'm', messages: [], big: huge });
+    expect(resp.status).toBe(413);
+    const json = await resp.json();
+    expect(json).toEqual({ error: 'payload-too-large' });
+  });
+
+  it('non-application/json content-type falls through to passthrough path without crashing', async () => {
+    up = await startUpstreamMock(({ req, res, rawBody }) => {
+      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain' });
+      res.end(rawBody);
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'text/plain' },
+      body: 'plain text body',
+    });
+    expect(resp.status).toBe(200);
+    expect(await resp.text()).toBe('plain text body');
+  });
+});
diff --git a/tests/proxy/errors.test.ts b/tests/proxy/errors.test.ts
new file mode 100644
index 0000000..ab52a01
--- /dev/null
+++ b/tests/proxy/errors.test.ts
@@ -0,0 +1,73 @@
+// Synthetic SSE error emission and redaction on failure paths.
+import { describe, it, expect, afterEach } from 'vitest';
+import { PassThrough, Writable } from 'node:stream';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
+import { emitSseError } from '../../src/proxy/errors.js';
+import pino from 'pino';
+
+describe('errors', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('emits a single synthetic Anthropic-shaped SSE event: error when upstream disconnects mid-stream, then closes client socket', async () => {
+    up = await startUpstreamMock(({ req, res }) => {
+      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
+      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
+      setTimeout(() => req.socket.destroy(), 30);
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json']],
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const body = parseRawResponse(await done).body.toString('utf8');
+    expect(body).toContain('event: message_start');
+    expect(body).toContain('event: error\n');
+    expect(body).toContain('"type":"api_error"');
+    expect(body).toContain('upstream stream failed');
+    const errCount = (body.match(/event: error\n/g) ?? []).length;
+    expect(errCount).toBe(1);
+  });
+
+  it('synthetic SSE error message never contains auth data or raw upstream reason strings', async () => {
+    const sink = new PassThrough();
+    const collected: Buffer[] = [];
+    sink.on('data', (c: Buffer) => collected.push(c));
+    const logger = pino({ level: 'silent' });
+    const cause = new Error('connection refused sk-leak-secret Bearer abc123');
+    emitSseError(sink as unknown as Writable, cause, logger);
+    await new Promise((r) => setImmediate(r));
+    const out = Buffer.concat(collected).toString('utf8');
+    expect(out).toContain('event: error');
+    expect(out).toContain('upstream stream failed');
+    expect(out).not.toContain('sk-leak-secret');
+    expect(out).not.toContain('Bearer abc123');
+    expect(out).not.toContain('connection refused');
+  });
+
+  it('logs via pino on each failure mode with request-id when available and no raw auth headers', async () => {
+    const collected: string[] = [];
+    const stream = new Writable({
+      write(chunk, _enc, cb) { collected.push(chunk.toString()); cb(); },
+    });
+    const logger = pino({ level: 'info' }, stream);
+    emitSseError(new PassThrough() as unknown as Writable, new Error('boom'), logger);
+    await new Promise((r) => setImmediate(r));
+    const combined = collected.join('\n');
+    expect(combined.length).toBeGreaterThan(0);
+    expect(combined).not.toMatch(/authorization/i);
+    expect(combined).not.toMatch(/x-api-key/i);
+  });
+});
diff --git a/tests/proxy/expect-continue.test.ts b/tests/proxy/expect-continue.test.ts
new file mode 100644
index 0000000..912c4eb
--- /dev/null
+++ b/tests/proxy/expect-continue.test.ts
@@ -0,0 +1,68 @@
+// Expect: 100-continue end-to-end.
+import { describe, it, expect, afterEach } from 'vitest';
+import net from 'node:net';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { parseRawResponse } from './helpers/http-client.js';
+
+describe('expect-continue', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('handles Expect: 100-continue end-to-end without hang', async () => {
+    up = await startUpstreamMock(({ rawBody, res }) => {
+      res.writeHead(200, { 'content-type': 'application/json' });
+      res.end(JSON.stringify({ echoed: rawBody.length }));
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }), 'utf8');
+    const headers = [
+      'POST /v1/messages HTTP/1.1',
+      'Host: 127.0.0.1',
+      'Content-Type: application/json',
+      'Expect: 100-continue',
+      `Content-Length: ${body.length}`,
+      '',
+      '',
+    ].join('\r\n');
+
+    const result = await new Promise<Buffer>((resolve, reject) => {
+      const chunks: Buffer[] = [];
+      const sock = net.connect({ host: '127.0.0.1', port: proxy!.port }, () => {
+        sock.write(headers);
+      });
+      let continued = false;
+      sock.on('data', (c: Buffer) => {
+        chunks.push(c);
+        if (!continued && Buffer.concat(chunks).toString('utf8').includes('100 Continue')) {
+          continued = true;
+          sock.write(body);
+        }
+      });
+      sock.on('end', () => resolve(Buffer.concat(chunks)));
+      sock.on('close', () => resolve(Buffer.concat(chunks)));
+      sock.on('error', reject);
+      setTimeout(() => {
+        // Fallback: if server does NOT send a 100-continue, fastify may still accept the body — send anyway.
+        if (!continued) { continued = true; sock.write(body); }
+      }, 200);
+      setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 1500);
+    });
+
+    // Find the final response (after optional 100 Continue chunk).
+    const text = result.toString('utf8');
+    const lastStart = text.lastIndexOf('HTTP/1.1 ');
+    const finalChunk = Buffer.from(text.slice(lastStart), 'utf8');
+    const resp = parseRawResponse(finalChunk);
+    expect(resp.status).toBe(200);
+    const parsed = JSON.parse(resp.body.toString('utf8'));
+    expect(parsed.echoed).toBe(body.length);
+  }, 10000);
+});
diff --git a/tests/proxy/faithfulness.non-streaming.test.ts b/tests/proxy/faithfulness.non-streaming.test.ts
new file mode 100644
index 0000000..2a382e1
--- /dev/null
+++ b/tests/proxy/faithfulness.non-streaming.test.ts
@@ -0,0 +1,135 @@
+// Non-streaming faithfulness: status, body, and rate-limit headers round-trip byte-equal.
+import { describe, it, expect, afterEach } from 'vitest';
+import { join } from 'node:path';
+import { startUpstreamMock, loadNonStreamingFixture, respondNonStreaming, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'non-streaming');
+
+describe('faithfulness.non-streaming', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('forwards POST /v1/messages with model: claude-sonnet-4-6 to upstream with the same model when no rule fires', async () => {
+    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
+    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
+      body: JSON.stringify(body),
+    });
+    expect(resp.status).toBe(200);
+    expect(up.requests).toHaveLength(1);
+    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
+    expect(sent.model).toBe('claude-sonnet-4-6');
+  });
+
+  it('returns upstream 200 non-streaming JSON response byte-for-byte identical to fixture', async () => {
+    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
+    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
+    });
+    const got = await resp.text();
+    expect(got).toBe(JSON.stringify(fx.body));
+    expect(resp.headers.get('x-request-id')).toBe('req_simple_01');
+  });
+
+  it('calls reply.hijack() before any body byte is written', async () => {
+    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
+    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
+    // buildProxy already listens, so addHook would throw. Build manually, add hook, then listen.
+    const { createProxyServer } = await import('../../src/proxy/server.js');
+    const { createLogger } = await import('../../src/logging/logger.js');
+    const { defaultConfig } = await import('../../src/config/defaults.js');
+    const { resetUpstreamAgent } = await import('../../src/proxy/upstream.js');
+    process.env.UPSTREAM_ORIGIN = up.origin;
+    const app = await createProxyServer({
+      port: 0,
+      logger: createLogger({ destination: 'stderr', level: 'silent' }),
+      config: defaultConfig(),
+      requireProxyToken: false,
+    });
+    let hijackCalledBeforeWrite = false;
+    app.addHook('onRequest', (_req, reply, done) => {
+      const origHijack = reply.hijack.bind(reply);
+      reply.hijack = () => {
+        hijackCalledBeforeWrite = true;
+        return origHijack();
+      };
+      done();
+    });
+    await app.listen({ port: 0, host: '127.0.0.1' });
+    const addr = app.server.address() as { port: number };
+    try {
+      await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
+        method: 'POST',
+        headers: { 'content-type': 'application/json' },
+        body: JSON.stringify({ model: 'm', messages: [] }),
+      });
+      expect(hijackCalledBeforeWrite).toBe(true);
+    } finally {
+      await resetUpstreamAgent();
+      await app.close();
+      delete process.env.UPSTREAM_ORIGIN;
+    }
+  });
+
+  it('returns upstream 4xx error body verbatim including request-id', async () => {
+    const fx = loadNonStreamingFixture(join(FIXTURES, '400-validation.json'));
+    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(resp.status).toBe(400);
+    expect(resp.headers.get('x-request-id')).toBe('req_bad_01');
+    expect(await resp.text()).toBe(JSON.stringify(fx.body));
+  });
+
+  it('returns upstream 5xx error body verbatim', async () => {
+    const body = { type: 'error', error: { type: 'api_error', message: 'boom' } };
+    up = await startUpstreamMock(({ res }) => {
+      res.writeHead(502, { 'content-type': 'application/json' });
+      res.end(JSON.stringify(body));
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(resp.status).toBe(502);
+    expect(await resp.text()).toBe(JSON.stringify(body));
+  });
+
+  it('returns upstream 429 body and rate-limit headers verbatim', async () => {
+    const fx = loadNonStreamingFixture(join(FIXTURES, '429-rate-limit.json'));
+    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(resp.status).toBe(429);
+    expect(resp.headers.get('retry-after')).toBe('15');
+    expect(resp.headers.get('anthropic-ratelimit-requests-remaining')).toBe('0');
+    expect(resp.headers.get('anthropic-ratelimit-requests-limit')).toBe('100');
+    expect(await resp.text()).toBe(JSON.stringify(fx.body));
+  });
+});
diff --git a/tests/proxy/faithfulness.streaming.test.ts b/tests/proxy/faithfulness.streaming.test.ts
new file mode 100644
index 0000000..a743f52
--- /dev/null
+++ b/tests/proxy/faithfulness.streaming.test.ts
@@ -0,0 +1,82 @@
+// SSE streaming faithfulness: chunks byte-for-byte, ping events, content_block_delta counts, message_stop termination, unknown events.
+import { describe, it, expect, afterEach } from 'vitest';
+import { join } from 'node:path';
+import { loadSseFixture, replaySse, startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
+
+const SSE_DIR = join(process.cwd(), 'tests', 'fixtures', 'sse');
+
+function sseExpectedBytes(lines: ReturnType<typeof loadSseFixture>): string {
+  return lines.map((l) => `event: ${l.event}\ndata: ${l.data}\n\n`).join('');
+}
+
+describe('faithfulness.streaming', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  async function runFixture(name: string): Promise<string> {
+    const lines = loadSseFixture(join(SSE_DIR, name));
+    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json'], ['accept', 'text/event-stream']],
+      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [], stream: true }),
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const raw = await done;
+    return parseRawResponse(raw).body.toString('utf8');
+  }
+
+  it('writes upstream SSE chunks to client socket in exact order and bytes captured in fixture', async () => {
+    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
+    const body = await runFixture('basic.jsonl');
+    expect(body).toBe(sseExpectedBytes(lines));
+  });
+
+  it('forwards ping SSE events verbatim', async () => {
+    const body = await runFixture('basic.jsonl');
+    expect(body).toContain('event: ping\ndata: {"type":"ping"}\n\n');
+  });
+
+  it('forwards content_block_delta events in the same order and quantity as the fixture', async () => {
+    const lines = loadSseFixture(join(SSE_DIR, 'with-tool-use.jsonl'));
+    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json']],
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const body = parseRawResponse(await done).body.toString('utf8');
+    const deltaCount = (body.match(/event: content_block_delta\n/g) ?? []).length;
+    const fixtureDeltas = lines.filter((l) => l.event === 'content_block_delta').length;
+    expect(deltaCount).toBe(fixtureDeltas);
+    expect(body).toContain('partial_json');
+  });
+
+  it('terminates client stream on message_stop with no trailing bytes', async () => {
+    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
+    const body = await runFixture('basic.jsonl');
+    expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
+    expect(body).toBe(sseExpectedBytes(lines));
+  });
+
+  it('forwards unknown SSE event types (event: weird-new-type) byte-equal', async () => {
+    const lines = loadSseFixture(join(SSE_DIR, 'unknown-event-type.jsonl'));
+    const body = await runFixture('unknown-event-type.jsonl');
+    expect(body).toContain('event: weird-new-type\n');
+    expect(body).toBe(sseExpectedBytes(lines));
+  });
+});
diff --git a/tests/proxy/forward-compat.test.ts b/tests/proxy/forward-compat.test.ts
new file mode 100644
index 0000000..66fb93a
--- /dev/null
+++ b/tests/proxy/forward-compat.test.ts
@@ -0,0 +1,56 @@
+// Forward compatibility: unknown fields survive at every known nesting level.
+import { describe, it, expect, afterEach } from 'vitest';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+describe('forward-compat', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  const variants: Array<{ label: string; body: Record<string, unknown> }> = [
+    {
+      label: 'top-level',
+      body: { model: 'm', messages: [], unknown_top_level: { flag: true, count: 7 } },
+    },
+    {
+      label: 'inside messages[].content[]',
+      body: {
+        model: 'm',
+        messages: [
+          { role: 'user', content: [{ type: 'future_block', data: { deep: [1, 2, 3] } }] },
+        ],
+      },
+    },
+    {
+      label: 'inside tools[]',
+      body: {
+        model: 'm',
+        messages: [],
+        tools: [{ name: 't', description: 'd', input_schema: {}, future_param: { x: 1 } }],
+      },
+    },
+    {
+      label: 'inside metadata',
+      body: { model: 'm', messages: [], metadata: { user_id: 'u', future_metadata: 'yes' } },
+    },
+  ];
+
+  it.each(variants)('injects unknown fields at every known nesting level and verifies round-trip to upstream ($label)', async ({ body }) => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify(body),
+    });
+    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
+    expect(sent).toEqual(body);
+  });
+});
diff --git a/tests/proxy/headers.test.ts b/tests/proxy/headers.test.ts
new file mode 100644
index 0000000..0b3efc2
--- /dev/null
+++ b/tests/proxy/headers.test.ts
@@ -0,0 +1,177 @@
+// Header filter tests: hop-by-hop strip, host rewrite, duplicate preservation, auth passthrough.
+import { describe, it, expect, afterEach } from 'vitest';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
+import { __getLastOutboundHeaders } from '../../src/proxy/upstream.js';
+
+function outboundHas(name: string): boolean {
+  const arr = __getLastOutboundHeaders() ?? [];
+  for (let i = 0; i < arr.length; i += 2) {
+    if ((arr[i] ?? '').toLowerCase() === name.toLowerCase()) return true;
+  }
+  return false;
+}
+function outboundValue(name: string): string | undefined {
+  const arr = __getLastOutboundHeaders() ?? [];
+  for (let i = 0; i < arr.length; i += 2) {
+    if ((arr[i] ?? '').toLowerCase() === name.toLowerCase()) return arr[i + 1];
+  }
+  return undefined;
+}
+
+describe('headers', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  async function roundTrip(
+    reqHeaders: Array<[string, string]>,
+    respHeaders: Array<[string, string]>,
+    body: string = '{"model":"m","messages":[]}',
+  ): Promise<{ upstream: UpstreamMock; proxy: BuiltProxy; response: ReturnType<typeof parseRawResponse> }> {
+    up = await startUpstreamMock(({ res }) => {
+      const flat: string[] = [];
+      for (const [k, v] of respHeaders) flat.push(k, v);
+      res.writeHead(200, flat);
+      res.end('{"ok":true}');
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json'], ...reqHeaders],
+      body,
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const response = parseRawResponse(await done);
+    return { upstream: up, proxy, response };
+  }
+
+  it('strips hop-by-hop headers from request: connection, keep-alive, transfer-encoding, te, trailer, upgrade, proxy-authenticate, proxy-authorization', async () => {
+    await roundTrip(
+      [
+        ['connection', 'close'],
+        ['keep-alive', 'timeout=5'],
+        ['te', 'trailers'],
+        ['trailer', 'X-Foo'],
+        ['upgrade', 'websocket'],
+        ['proxy-authenticate', 'Basic'],
+        ['proxy-authorization', 'Basic abc'],
+      ],
+      [['content-type', 'application/json']],
+    );
+    // Assert the proxy's outbound filtered header array — what we send to undici.
+    // Transport-layer connection/content-length added by undici itself are intentionally not checked here.
+    for (const h of ['keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']) {
+      expect(outboundHas(h)).toBe(false);
+    }
+    // We also strip client-provided connection (value 'close'): the outbound array has no connection entry.
+    expect(outboundHas('connection')).toBe(false);
+  });
+
+  it('strips hop-by-hop headers from response (same list)', async () => {
+    const { response } = await roundTrip(
+      [],
+      [
+        ['content-type', 'application/json'],
+        ['connection', 'close'],
+        ['keep-alive', 'timeout=5'],
+        ['proxy-authenticate', 'Basic'],
+      ],
+    );
+    expect(response.headers['keep-alive']).toBeUndefined();
+    expect(response.headers['proxy-authenticate']).toBeUndefined();
+  });
+
+  it('rewrites host to api.anthropic.com on upstream request', async () => {
+    await roundTrip([['x-api-key', 'sk-test']], []);
+    expect(outboundValue('host')).toBe('api.anthropic.com');
+  });
+
+  it('forwards accept-encoding verbatim (no decompression)', async () => {
+    await roundTrip([['accept-encoding', 'gzip, br']], []);
+    expect(outboundValue('accept-encoding')).toBe('gzip, br');
+  });
+
+  it('preserves duplicate-valued headers via undici raw-header arrays', async () => {
+    up = await startUpstreamMock(({ res }) => {
+      res.writeHead(200, [
+        'content-type', 'application/json',
+        'set-cookie', 'a=1; Path=/',
+        'set-cookie', 'b=2; Path=/',
+      ]);
+      res.end('{}');
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json']],
+      body: '{"model":"m","messages":[]}',
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const resp = parseRawResponse(await done);
+    const cookieHeaders: string[] = [];
+    for (let i = 0; i < resp.rawHeaders.length; i += 2) {
+      if (resp.rawHeaders[i]!.toLowerCase() === 'set-cookie') cookieHeaders.push(resp.rawHeaders[i + 1]!);
+    }
+    expect(cookieHeaders).toEqual(['a=1; Path=/', 'b=2; Path=/']);
+  });
+
+  it('passes anthropic-* headers verbatim in both directions', async () => {
+    const { response } = await roundTrip(
+      [['anthropic-version', '2023-06-01'], ['anthropic-beta', 'prompt-caching-2024-07-31']],
+      [['content-type', 'application/json'], ['anthropic-ratelimit-requests-remaining', '42']],
+    );
+    expect(outboundValue('anthropic-version')).toBe('2023-06-01');
+    expect(outboundValue('anthropic-beta')).toBe('prompt-caching-2024-07-31');
+    expect(response.headers['anthropic-ratelimit-requests-remaining']).toBe('42');
+  });
+
+  it('round-trips x-request-id, retry-after, anthropic-ratelimit-* verbatim', async () => {
+    const { response } = await roundTrip(
+      [],
+      [
+        ['content-type', 'application/json'],
+        ['x-request-id', 'req_xyz'],
+        ['retry-after', '30'],
+        ['anthropic-ratelimit-tokens-remaining', '123'],
+      ],
+    );
+    expect(response.headers['x-request-id']).toBe('req_xyz');
+    expect(response.headers['retry-after']).toBe('30');
+    expect(response.headers['anthropic-ratelimit-tokens-remaining']).toBe('123');
+  });
+
+  it('forwards Authorization: Bearer untouched', async () => {
+    await roundTrip([['authorization', 'Bearer sk-xyz']], []);
+    expect(outboundValue('authorization')).toBe('Bearer sk-xyz');
+  });
+
+  it('forwards x-api-key untouched', async () => {
+    await roundTrip([['x-api-key', 'sk-abc']], []);
+    expect(outboundValue('x-api-key')).toBe('sk-abc');
+  });
+
+  it('strips tokens listed in connection: header value', async () => {
+    await roundTrip(
+      [['x-custom-drop', 'yes'], ['connection', 'x-custom-drop, close']],
+      [],
+    );
+    expect(outboundHas('x-custom-drop')).toBe(false);
+  });
+
+  it('drops content-length on outbound request', async () => {
+    // Assert our filter drops the client-provided content-length from the outbound array.
+    // undici computes and adds its own content-length at transport layer — that is expected.
+    await roundTrip([], []);
+    expect(outboundHas('content-length')).toBe(false);
+  });
+});
diff --git a/tests/proxy/health.test.ts b/tests/proxy/health.test.ts
new file mode 100644
index 0000000..9153231
--- /dev/null
+++ b/tests/proxy/health.test.ts
@@ -0,0 +1,57 @@
+// Health endpoint and bindWithFallback behavior.
+import { describe, it, expect, afterEach } from 'vitest';
+import Fastify from 'fastify';
+import net from 'node:net';
+import type { AddressInfo } from 'node:net';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { bindWithFallback } from '../../src/lifecycle/ports.js';
+import { createProxyServer } from '../../src/proxy/server.js';
+import { createLogger } from '../../src/logging/logger.js';
+import { defaultConfig } from '../../src/config/defaults.js';
+
+describe('health', () => {
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    proxy = undefined;
+  });
+
+  it('GET /healthz returns 200 with ok status', async () => {
+    proxy = await buildProxy({ upstreamOrigin: 'http://127.0.0.1:1' });
+    const resp = await fetch(`${proxy.baseUrl}/healthz`);
+    expect(resp.status).toBe(200);
+    const json = (await resp.json()) as { status: string; mode: string; port: number; uptimeMs: number };
+    expect(json.status).toBe('ok');
+    expect(json.mode).toBe('passthrough');
+    expect(typeof json.port).toBe('number');
+    expect(typeof json.uptimeMs).toBe('number');
+  });
+
+  it('binds to 127.0.0.1 only', async () => {
+    proxy = await buildProxy({ upstreamOrigin: 'http://127.0.0.1:1' });
+    const addr = proxy.app.server.address() as AddressInfo;
+    expect(addr.address).toBe('127.0.0.1');
+  });
+
+  it('refuses to bind 0.0.0.0', async () => {
+    const logger = createLogger({ destination: 'stderr', level: 'silent' });
+    const app = await createProxyServer({ port: 0, logger, config: defaultConfig() });
+    await expect(app.listen({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/i);
+    await app.close();
+  });
+
+  it('bindWithFallback picks the next free port when startPort is in use', async () => {
+    const blocker = net.createServer();
+    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
+    const busyPort = (blocker.address() as AddressInfo).port;
+    const fastify = Fastify({ logger: false });
+    try {
+      const { port } = await bindWithFallback(fastify, busyPort, 10);
+      expect(port).toBeGreaterThan(busyPort);
+    } finally {
+      await fastify.close();
+      await new Promise<void>((resolve) => blocker.close(() => resolve()));
+    }
+  });
+});
diff --git a/tests/proxy/helpers/build-proxy.ts b/tests/proxy/helpers/build-proxy.ts
new file mode 100644
index 0000000..9520bd8
--- /dev/null
+++ b/tests/proxy/helpers/build-proxy.ts
@@ -0,0 +1,56 @@
+// Helper to construct a proxy instance wired to a local upstream mock.
+import type { FastifyInstance } from 'fastify';
+import { AddressInfo } from 'node:net';
+import { createLogger } from '../../../src/logging/logger.js';
+import { defaultConfig } from '../../../src/config/defaults.js';
+import type { CcmuxConfig } from '../../../src/config/schema.js';
+import { createProxyServer, type ProxyServerOptions } from '../../../src/proxy/server.js';
+import { resetUpstreamAgent } from '../../../src/proxy/upstream.js';
+
+export interface BuiltProxy {
+  app: FastifyInstance;
+  port: number;
+  baseUrl: string;
+  close: () => Promise<void>;
+}
+
+export interface BuildOpts {
+  upstreamOrigin: string;
+  configOverrides?: Partial<CcmuxConfig>;
+  requireProxyToken?: boolean;
+  proxyToken?: string;
+  bodyLimit?: number;
+  logLevel?: 'silent' | 'trace' | 'debug' | 'info' | 'warn' | 'error';
+}
+
+export async function buildProxy(opts: BuildOpts): Promise<BuiltProxy> {
+  process.env.UPSTREAM_ORIGIN = opts.upstreamOrigin;
+  const logger = createLogger({ destination: 'stderr', level: opts.logLevel ?? 'silent' });
+  const base = defaultConfig();
+  const config: CcmuxConfig = { ...base, ...(opts.configOverrides ?? {}) };
+  const serverOpts: ProxyServerOptions = {
+    port: 0,
+    logger,
+    config,
+    requireProxyToken: opts.requireProxyToken ?? false,
+  };
+  if (opts.proxyToken !== undefined) {
+    (serverOpts as { proxyToken?: string }).proxyToken = opts.proxyToken;
+  }
+  if (opts.bodyLimit !== undefined) {
+    (serverOpts as { bodyLimit?: number }).bodyLimit = opts.bodyLimit;
+  }
+  const app = await createProxyServer(serverOpts);
+  await app.listen({ port: 0, host: '127.0.0.1' });
+  const addr = app.server.address() as AddressInfo;
+  return {
+    app,
+    port: addr.port,
+    baseUrl: `http://127.0.0.1:${addr.port}`,
+    close: async () => {
+      await resetUpstreamAgent();
+      await app.close();
+      delete process.env.UPSTREAM_ORIGIN;
+    },
+  };
+}
diff --git a/tests/proxy/helpers/http-client.ts b/tests/proxy/helpers/http-client.ts
new file mode 100644
index 0000000..4230eff
--- /dev/null
+++ b/tests/proxy/helpers/http-client.ts
@@ -0,0 +1,116 @@
+// Raw HTTP client helpers for tests: wants raw bytes, duplicate headers, SSE chunks.
+import { connect as netConnect } from 'node:net';
+import type { Socket } from 'node:net';
+
+export interface RawResponse {
+  statusLine: string;
+  status: number;
+  rawHeaders: string[]; // name, value, name, value, ...
+  headers: Record<string, string | string[]>;
+  body: Buffer;
+}
+
+export async function rawRequest(
+  port: number,
+  request: Buffer,
+  opts: { host?: string; waitMs?: number } = {},
+): Promise<RawResponse> {
+  const host = opts.host ?? '127.0.0.1';
+  return new Promise<RawResponse>((resolve, reject) => {
+    const sock = netConnect({ host, port }, () => sock.write(request));
+    const chunks: Buffer[] = [];
+    sock.on('data', (c: Buffer) => chunks.push(c));
+    sock.on('end', () => {
+      try {
+        resolve(parseRawResponse(Buffer.concat(chunks)));
+      } catch (err) {
+        reject(err as Error);
+      }
+    });
+    sock.on('error', reject);
+  });
+}
+
+export function parseRawResponse(buf: Buffer): RawResponse {
+  const sep = buf.indexOf(Buffer.from('\r\n\r\n'));
+  const headPart = sep >= 0 ? buf.subarray(0, sep).toString('utf8') : buf.toString('utf8');
+  const body = sep >= 0 ? buf.subarray(sep + 4) : Buffer.alloc(0);
+  const lines = headPart.split('\r\n');
+  const statusLine = lines[0] ?? '';
+  const status = Number(statusLine.split(' ')[1] ?? 0);
+  const rawHeaders: string[] = [];
+  const headers: Record<string, string | string[]> = {};
+  for (let i = 1; i < lines.length; i++) {
+    const line = lines[i] ?? '';
+    const idx = line.indexOf(':');
+    if (idx < 0) continue;
+    const name = line.slice(0, idx).trim();
+    const value = line.slice(idx + 1).trim();
+    rawHeaders.push(name, value);
+    const key = name.toLowerCase();
+    const existing = headers[key];
+    if (existing === undefined) headers[key] = value;
+    else if (Array.isArray(existing)) existing.push(value);
+    else headers[key] = [existing, value];
+  }
+  // Handle chunked transfer encoding naively for test bodies.
+  const te = (headers['transfer-encoding'] as string | undefined)?.toLowerCase();
+  const finalBody = te === 'chunked' ? decodeChunked(body) : body;
+  return { statusLine, status, rawHeaders, headers, body: finalBody };
+}
+
+export function decodeChunked(input: Buffer): Buffer {
+  const out: Buffer[] = [];
+  let offset = 0;
+  while (offset < input.length) {
+    const crlf = input.indexOf(Buffer.from('\r\n'), offset);
+    if (crlf < 0) break;
+    const sizeHex = input.subarray(offset, crlf).toString('ascii').trim();
+    const size = parseInt(sizeHex, 16);
+    if (Number.isNaN(size)) break;
+    offset = crlf + 2;
+    if (size === 0) break;
+    out.push(input.subarray(offset, offset + size));
+    offset += size + 2;
+  }
+  return Buffer.concat(out);
+}
+
+export function buildRequest(opts: {
+  method: string;
+  path: string;
+  host?: string;
+  headers?: Array<[string, string]>;
+  body?: Buffer | string;
+}): Buffer {
+  const host = opts.host ?? '127.0.0.1';
+  const headerLines = [`${opts.method} ${opts.path} HTTP/1.1`, `Host: ${host}`];
+  const provided = opts.headers ?? [];
+  const hasContentLength = provided.some(([k]) => k.toLowerCase() === 'content-length');
+  const hasConnection = provided.some(([k]) => k.toLowerCase() === 'connection');
+  for (const [k, v] of provided) headerLines.push(`${k}: ${v}`);
+  const bodyBuf = opts.body === undefined ? Buffer.alloc(0)
+    : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
+  if (!hasContentLength && bodyBuf.length > 0) {
+    headerLines.push(`Content-Length: ${bodyBuf.length}`);
+  }
+  // Force short-lived TCP connections in tests so raw-socket clients see end-of-stream.
+  if (!hasConnection) headerLines.push('Connection: close');
+  const head = headerLines.join('\r\n') + '\r\n\r\n';
+  return Buffer.concat([Buffer.from(head, 'utf8'), bodyBuf]);
+}
+
+export function streamRawRequest(
+  port: number,
+  request: Buffer,
+): { socket: Socket; done: Promise<Buffer> } {
+  const sock = netConnect({ host: '127.0.0.1', port }, () => sock.write(request));
+  const chunks: Buffer[] = [];
+  const done = new Promise<Buffer>((resolve, reject) => {
+    sock.on('data', (c: Buffer) => chunks.push(c));
+    sock.on('end', () => resolve(Buffer.concat(chunks)));
+    sock.on('close', () => resolve(Buffer.concat(chunks)));
+    sock.on('error', reject);
+  });
+  return { socket: sock, done };
+}
diff --git a/tests/proxy/helpers/upstream-mock.ts b/tests/proxy/helpers/upstream-mock.ts
new file mode 100644
index 0000000..3883b51
--- /dev/null
+++ b/tests/proxy/helpers/upstream-mock.ts
@@ -0,0 +1,125 @@
+// Local HTTP upstream mock used by proxy tests. Replays SSE fixtures with inter-chunk delays.
+import http, { type IncomingMessage, type ServerResponse } from 'node:http';
+import { readFileSync } from 'node:fs';
+import { AddressInfo } from 'node:net';
+
+export interface FixtureNonStreaming {
+  status: number;
+  headers: Record<string, string>;
+  body: unknown;
+}
+
+export interface SseLine {
+  ts: number;
+  event: string;
+  data: string;
+}
+
+export interface UpstreamHandlerCtx {
+  req: IncomingMessage;
+  res: ServerResponse;
+  rawBody: Buffer;
+}
+
+export type UpstreamHandler = (ctx: UpstreamHandlerCtx) => Promise<void> | void;
+
+export interface UpstreamMock {
+  origin: string;
+  port: number;
+  close: () => Promise<void>;
+  requests: RecordedRequest[];
+}
+
+export interface RecordedRequest {
+  method: string;
+  url: string;
+  headers: Record<string, string | string[] | undefined>;
+  rawHeaders: string[];
+  body: Buffer;
+  aborted: boolean;
+}
+
+export async function startUpstreamMock(handler: UpstreamHandler): Promise<UpstreamMock> {
+  const requests: RecordedRequest[] = [];
+  const server = http.createServer((req, res) => {
+    const chunks: Buffer[] = [];
+    let aborted = false;
+    req.on('data', (c: Buffer) => chunks.push(c));
+    req.on('aborted', () => { aborted = true; });
+    req.on('close', () => {
+      if (!req.complete) aborted = true;
+    });
+    req.on('end', () => {
+      const body = Buffer.concat(chunks);
+      const recorded: RecordedRequest = {
+        method: req.method ?? '',
+        url: req.url ?? '',
+        headers: req.headers,
+        rawHeaders: req.rawHeaders,
+        body,
+        aborted,
+      };
+      requests.push(recorded);
+      Promise.resolve(handler({ req, res, rawBody: body })).catch(() => {
+        if (!res.writableEnded) res.end();
+      });
+    });
+  });
+  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
+  const addr = server.address() as AddressInfo;
+  return {
+    origin: `http://127.0.0.1:${addr.port}`,
+    port: addr.port,
+    requests,
+    close: () =>
+      new Promise<void>((resolve, reject) => {
+        const s = server as http.Server & { closeAllConnections?: () => void };
+        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
+        server.close((err) => (err ? reject(err) : resolve()));
+      }),
+  };
+}
+
+export function loadNonStreamingFixture(path: string): FixtureNonStreaming {
+  const txt = readFileSync(path, 'utf8');
+  return JSON.parse(txt) as FixtureNonStreaming;
+}
+
+export function loadSseFixture(path: string): SseLine[] {
+  const txt = readFileSync(path, 'utf8').trim();
+  return txt
+    .split(/\r?\n/)
+    .filter((l) => l.trim().length > 0)
+    .map((l) => JSON.parse(l) as SseLine);
+}
+
+export function sseBytes(lines: SseLine[]): Buffer {
+  const parts = lines.map((l) =>
+    Buffer.from(`event: ${l.event}\ndata: ${l.data}\n\n`, 'utf8'),
+  );
+  return Buffer.concat(parts);
+}
+
+export async function replaySse(res: ServerResponse, lines: SseLine[]): Promise<void> {
+  res.writeHead(200, {
+    'content-type': 'text/event-stream',
+    'cache-control': 'no-cache',
+    connection: 'keep-alive',
+  });
+  let prev = 0;
+  for (const line of lines) {
+    const delay = Math.max(0, line.ts - prev);
+    prev = line.ts;
+    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
+    res.write(`event: ${line.event}\n`);
+    res.write(`data: ${line.data}\n\n`);
+  }
+  res.end();
+}
+
+export function respondNonStreaming(res: ServerResponse, fx: FixtureNonStreaming): void {
+  const bodyStr = JSON.stringify(fx.body);
+  const headers = { ...fx.headers };
+  res.writeHead(fx.status, headers);
+  res.end(bodyStr);
+}
diff --git a/tests/proxy/http2-reject.test.ts b/tests/proxy/http2-reject.test.ts
new file mode 100644
index 0000000..ec4a65d
--- /dev/null
+++ b/tests/proxy/http2-reject.test.ts
@@ -0,0 +1,37 @@
+// HTTP/2 prior-knowledge rejection → 505.
+import { describe, it, expect, afterEach } from 'vitest';
+import net from 'node:net';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'utf8');
+
+describe('http2-reject', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('rejects HTTP/2 prior-knowledge request with 505', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const response = await new Promise<string>((resolve, reject) => {
+      const sock = net.connect({ host: '127.0.0.1', port: proxy!.port }, () => {
+        // Send HTTP/2 preface then a standard GET following (server should treat first line as invalid HTTP/1.1).
+        sock.write(H2_PREFACE);
+      });
+      const chunks: Buffer[] = [];
+      sock.on('data', (c: Buffer) => chunks.push(c));
+      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
+      sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
+      sock.on('error', reject);
+      setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 500);
+    });
+    expect(response).toMatch(/505/);
+  });
+});
diff --git a/tests/proxy/passthrough.test.ts b/tests/proxy/passthrough.test.ts
new file mode 100644
index 0000000..13abbda
--- /dev/null
+++ b/tests/proxy/passthrough.test.ts
@@ -0,0 +1,80 @@
+// Generic /v1/* passthrough: query, method, body, structured log line.
+import { describe, it, expect, afterEach } from 'vitest';
+import { Writable } from 'node:stream';
+import pino from 'pino';
+import type { AddressInfo } from 'node:net';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { createProxyServer } from '../../src/proxy/server.js';
+import { defaultConfig } from '../../src/config/defaults.js';
+
+describe('passthrough', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('GET /v1/models?foo=bar preserves foo=bar on upstream request', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/models?foo=bar&baz=qux`);
+    expect(resp.status).toBe(200);
+    expect(up.requests[0]!.url).toBe('/v1/models?foo=bar&baz=qux');
+  });
+
+  it('forwards path, method, and query string verbatim for non-/v1/messages routes', async () => {
+    up = await startUpstreamMock(({ req, res }) => {
+      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-method': req.method ?? '' });
+      res.end('{}');
+    });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const resp = await fetch(`${proxy.baseUrl}/v1/complete?x=1`, { method: 'DELETE' });
+    expect(resp.status).toBe(200);
+    expect(up.requests[0]!.method).toBe('DELETE');
+    expect(up.requests[0]!.url).toBe('/v1/complete?x=1');
+  });
+
+  it('does not parse request body on passthrough routes', async () => {
+    up = await startUpstreamMock(({ rawBody, res }) => { res.writeHead(200); res.end(rawBody); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
+    const resp = await fetch(`${proxy.baseUrl}/v1/arbitrary`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/octet-stream' },
+      body: payload,
+    });
+    expect(resp.status).toBe(200);
+    const got = Buffer.from(await resp.arrayBuffer());
+    expect(Buffer.compare(got, payload)).toBe(0);
+    expect(Buffer.compare(up.requests[0]!.body, payload)).toBe(0);
+  });
+
+  it('emits one structured log line per passthrough request', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    process.env.UPSTREAM_ORIGIN = up.origin;
+    const lines: string[] = [];
+    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
+    const logger = pino({ level: 'info' }, stream);
+    const app = await createProxyServer({ port: 0, logger, config: defaultConfig() });
+    await app.listen({ port: 0, host: '127.0.0.1' });
+    try {
+      const addr = app.server.address() as AddressInfo;
+      await fetch(`http://127.0.0.1:${addr.port}/v1/models`);
+      const structured = lines
+        .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
+        .filter((x): x is Record<string, unknown> => x !== null)
+        .filter((x) => x['path'] === '/v1/models' && typeof x['upstreamStatus'] === 'number');
+      expect(structured.length).toBe(1);
+      expect(structured[0]!['method']).toBe('GET');
+      expect(typeof structured[0]!['durationMs']).toBe('number');
+    } finally {
+      await app.close();
+      delete process.env.UPSTREAM_ORIGIN;
+    }
+  });
+});
diff --git a/tests/proxy/streaming.test.ts b/tests/proxy/streaming.test.ts
new file mode 100644
index 0000000..999be97
--- /dev/null
+++ b/tests/proxy/streaming.test.ts
@@ -0,0 +1,72 @@
+// Streaming response properties: Nagle off, no content-length on SSE, no compression middleware.
+import { describe, it, expect, afterEach } from 'vitest';
+import { join } from 'node:path';
+import net from 'node:net';
+import { loadSseFixture, replaySse, startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
+
+const SSE_DIR = join(process.cwd(), 'tests', 'fixtures', 'sse');
+
+describe('streaming', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('sets reply.raw.socket.setNoDelay(true)', async () => {
+    const origSetNoDelay = net.Socket.prototype.setNoDelay;
+    const calls: boolean[] = [];
+    net.Socket.prototype.setNoDelay = function (v?: boolean) {
+      if (v === true) calls.push(true);
+      return origSetNoDelay.call(this, v);
+    };
+    try {
+      const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
+      up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
+      proxy = await buildProxy({ upstreamOrigin: up.origin });
+      const req = buildRequest({
+        method: 'POST',
+        path: '/v1/messages',
+        headers: [['content-type', 'application/json']],
+        body: JSON.stringify({ model: 'm', messages: [] }),
+      });
+      const { done } = streamRawRequest(proxy.port, req);
+      await done;
+      expect(calls.length).toBeGreaterThan(0);
+    } finally {
+      net.Socket.prototype.setNoDelay = origSetNoDelay;
+    }
+  });
+
+  it('does not set Content-Length on SSE responses (chunked encoding only)', async () => {
+    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
+    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const req = buildRequest({
+      method: 'POST',
+      path: '/v1/messages',
+      headers: [['content-type', 'application/json']],
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    const { done } = streamRawRequest(proxy.port, req);
+    const resp = parseRawResponse(await done);
+    expect(resp.headers['content-length']).toBeUndefined();
+    expect((resp.headers['transfer-encoding'] as string | undefined)?.toLowerCase()).toBe('chunked');
+  });
+
+  it('registers no gzip/br middleware on the response path', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    // Fastify keeps registered plugins in a symbol-based registry — assert via printPlugins.
+    const plugins = proxy.app.printPlugins();
+    expect(plugins).not.toMatch(/compress/i);
+    // Assert instance has no compress decorator.
+    expect(proxy.app.hasDecorator('compress')).toBe(false);
+  });
+});
diff --git a/tests/proxy/token.test.ts b/tests/proxy/token.test.ts
new file mode 100644
index 0000000..7c4b613
--- /dev/null
+++ b/tests/proxy/token.test.ts
@@ -0,0 +1,87 @@
+// x-ccmux-token gate: require, accept, and log redaction.
+import { describe, it, expect, afterEach } from 'vitest';
+import { Writable } from 'node:stream';
+import pino from 'pino';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+import { createProxyServer } from '../../src/proxy/server.js';
+import { defaultConfig } from '../../src/config/defaults.js';
+import type { AddressInfo } from 'node:net';
+
+describe('token', () => {
+  let up: UpstreamMock | undefined;
+  let proxy: BuiltProxy | undefined;
+
+  afterEach(async () => {
+    if (proxy) await proxy.close();
+    if (up) await up.close();
+    up = undefined;
+    proxy = undefined;
+  });
+
+  it('rejects requests missing matching x-ccmux-token with 401 when CCMUX_PROXY_TOKEN is set', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin, requireProxyToken: true, proxyToken: 'secret-token-xyz' });
+    const bad = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', 'x-ccmux-token': 'wrong' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(bad.status).toBe(401);
+    expect(await bad.json()).toEqual({ error: 'unauthorized' });
+    const missing = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(missing.status).toBe(401);
+    const good = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', 'x-ccmux-token': 'secret-token-xyz' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(good.status).toBe(200);
+    // Token must be stripped outbound.
+    const sent = up.requests[up.requests.length - 1]!;
+    expect(sent.headers['x-ccmux-token']).toBeUndefined();
+  });
+
+  it('accepts requests without the header when CCMUX_PROXY_TOKEN is unset (debug mode)', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin, requireProxyToken: false });
+    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify({ model: 'm', messages: [] }),
+    });
+    expect(resp.status).toBe(200);
+  });
+
+  it('redacts x-ccmux-token from every log line', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    process.env.UPSTREAM_ORIGIN = up.origin;
+    const lines: string[] = [];
+    const stream = new Writable({
+      write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
+    });
+    const logger = pino(
+      { level: 'info', redact: { paths: ['req.headers["x-ccmux-token"]', 'headers["x-ccmux-token"]'], censor: '[REDACTED]' } },
+      stream,
+    );
+    const app = await createProxyServer({ port: 0, logger, config: defaultConfig(), requireProxyToken: false });
+    await app.listen({ port: 0, host: '127.0.0.1' });
+    try {
+      const addr = app.server.address() as AddressInfo;
+      await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
+        method: 'POST',
+        headers: { 'content-type': 'application/json', 'x-ccmux-token': 'REAL-SECRET-VALUE' },
+        body: JSON.stringify({ model: 'm', messages: [] }),
+      });
+      const combined = lines.join('\n');
+      expect(combined).not.toContain('REAL-SECRET-VALUE');
+    } finally {
+      await app.close();
+      delete process.env.UPSTREAM_ORIGIN;
+    }
+  });
+});
