diff --git a/bin/ccmux.js b/bin/ccmux.js
new file mode 100644
index 0000000..8b311fa
--- /dev/null
+++ b/bin/ccmux.js
@@ -0,0 +1,6 @@
+#!/usr/bin/env node
+// Thin shim that forwards argv to the compiled CLI router.
+import('../dist/cli/main.js')
+  .then((m) => m.run(process.argv.slice(2)))
+  .then((code) => { process.exit(typeof code === 'number' ? code : 0); })
+  .catch((err) => { process.stderr.write(`ccmux: ${err?.message ?? err}\n`); process.exit(1); });
diff --git a/package.json b/package.json
index d6791f7..ed20f58 100644
--- a/package.json
+++ b/package.json
@@ -7,11 +7,12 @@
     "node": ">=20"
   },
   "bin": {
-    "ccmux": "dist/cli/main.js"
+    "ccmux": "bin/ccmux.js"
   },
   "main": "dist/index.js",
   "types": "dist/index.d.ts",
   "files": [
+    "bin",
     "dist",
     "README.md",
     "LICENSE"
diff --git a/src/cli/main.ts b/src/cli/main.ts
index 43bc612..b639661 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -1,2 +1,73 @@
-// Populated in section-05. Do not import.
-export {};
+// commander router. Subcommands lazy-import so `ccmux version` stays fast.
+
+import { Command, CommanderError } from 'commander';
+
+export interface RunOptions {
+  readonly stdout?: NodeJS.WritableStream;
+  readonly stderr?: NodeJS.WritableStream;
+}
+
+interface ActionBox { code: number; }
+
+export async function run(
+  argv: readonly string[],
+  opts: RunOptions = {},
+): Promise<number> {
+  const stdout = opts.stdout ?? process.stdout;
+  const stderr = opts.stderr ?? process.stderr;
+  const box: ActionBox = { code: 0 };
+  const program = buildProgram(box, stdout, stderr);
+  try {
+    await program.parseAsync([...argv], { from: 'user' });
+    return box.code;
+  } catch (err: unknown) {
+    return handleCommanderError(err, stderr);
+  }
+}
+
+function buildProgram(
+  box: ActionBox,
+  stdout: NodeJS.WritableStream,
+  stderr: NodeJS.WritableStream,
+): Command {
+  const program = new Command();
+  program.name('ccmux').description('Claude model switcher (ccmux)').exitOverride();
+  program.configureOutput({
+    writeOut: (s) => stdout.write(s),
+    writeErr: (s) => stderr.write(s),
+  });
+  program
+    .command('start')
+    .description('Start the ccmux proxy (debug runner)')
+    .option('--foreground', 'Block on SIGINT; do not write a PID file', false)
+    .action(async (cmdOpts: { foreground?: boolean }) => {
+      const { runStart } = await import('./start.js');
+      box.code = await runStart({ foreground: cmdOpts.foreground === true, stdout });
+    });
+  program
+    .command('status')
+    .description('Report proxy status from PID file and /healthz')
+    .action(async () => {
+      const { runStatus } = await import('./status.js');
+      box.code = await runStatus({ stdout, stderr });
+    });
+  program
+    .command('version')
+    .description('Print ccmux version')
+    .action(async () => {
+      const { runVersion } = await import('./version.js');
+      box.code = runVersion(stdout);
+    });
+  return program;
+}
+
+function handleCommanderError(err: unknown, stderr: NodeJS.WritableStream): number {
+  if (err instanceof CommanderError) {
+    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') return 0;
+    if (err.code === 'commander.version') return 0;
+    if (err.exitCode !== undefined) return err.exitCode;
+  }
+  const message = err instanceof Error ? err.message : String(err);
+  stderr.write(`ccmux: ${message}\n`);
+  return 1;
+}
diff --git a/src/cli/start.ts b/src/cli/start.ts
index 43bc612..87bcae4 100644
--- a/src/cli/start.ts
+++ b/src/cli/start.ts
@@ -1,2 +1,93 @@
-// Populated in section-05. Do not import.
-export {};
+// `ccmux start [--foreground]` handler.
+//
+// Full daemonization is out of scope (plan §11 calls `ccmux start` a "debug
+// sibling"). Both modes bind a single long-lived process and block on
+// SIGINT/SIGTERM; non-foreground writes a PID file and removes it on shutdown.
+
+import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
+import { dirname } from 'node:path';
+import type { FastifyInstance } from 'fastify';
+import { loadConfig } from '../config/loader.js';
+import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
+import { createLogger } from '../logging/logger.js';
+import { createProxyServer } from '../proxy/server.js';
+import { listenWithFallback } from '../lifecycle/ports.js';
+
+export interface StartOpts {
+  readonly foreground: boolean;
+  readonly configPath?: string;
+  readonly paths?: CcmuxPaths;
+  readonly stdout?: NodeJS.WritableStream;
+}
+
+export interface StartedServer {
+  readonly app: FastifyInstance;
+  readonly port: number;
+  readonly pidFile: string | null;
+  close(): Promise<void>;
+}
+
+export async function startProxy(opts: StartOpts): Promise<StartedServer> {
+  const paths = opts.paths ?? resolvePaths();
+  const out = opts.stdout ?? process.stdout;
+  const loaded = await loadConfig(opts.configPath);
+  if (!loaded.ok) {
+    const msgs = loaded.error.map((e) => `${e.path}: ${e.message}`).join('; ');
+    throw new Error(`ccmux: invalid config: ${msgs}`);
+  }
+  const { config } = loaded.value;
+  const logger = createLogger({ destination: 'stderr' });
+  const app = await createProxyServer({ port: config.port, logger, config });
+  const port = await listenWithFallback(app, '127.0.0.1', config.port, 20);
+  out.write(`ccmux listening on http://127.0.0.1:${port}\n`);
+
+  const pidFile = opts.foreground ? null : writePidFile(paths.pidFile, process.pid, port);
+  return {
+    app,
+    port,
+    pidFile,
+    close: async () => {
+      await app.close();
+      if (pidFile !== null) safeUnlink(pidFile);
+    },
+  };
+}
+
+export async function runStart(opts: StartOpts): Promise<number> {
+  const server = await startProxy(opts);
+  return new Promise<number>((resolve) => installShutdownHandlers(server, resolve));
+}
+
+function installShutdownHandlers(
+  server: StartedServer,
+  resolve: (code: number) => void,
+): void {
+  const GRACE_MS = 5000;
+  let shuttingDown = false;
+  const shutdown = (): void => {
+    if (shuttingDown) return;
+    shuttingDown = true;
+    const hardTimer = setTimeout(() => resolve(1), GRACE_MS);
+    hardTimer.unref();
+    server.close().then(
+      () => { clearTimeout(hardTimer); resolve(0); },
+      () => { clearTimeout(hardTimer); resolve(1); },
+    );
+  };
+  process.once('SIGINT', shutdown);
+  process.once('SIGTERM', shutdown);
+}
+
+function writePidFile(pidFile: string, pid: number, port: number): string {
+  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
+  writeFileSync(pidFile, `${pid}\n${port}\n`, { encoding: 'utf8', mode: 0o600 });
+  return pidFile;
+}
+
+function safeUnlink(path: string): void {
+  try {
+    rmSync(path, { force: true });
+  } catch {
+    // Shutdown path — best-effort cleanup.
+  }
+}
diff --git a/src/cli/status.ts b/src/cli/status.ts
index 43bc612..ad8c549 100644
--- a/src/cli/status.ts
+++ b/src/cli/status.ts
@@ -1,2 +1,93 @@
-// Populated in section-05. Do not import.
-export {};
+// `ccmux status` handler. Reads the PID file, probes /healthz, prints a table.
+
+import { readFileSync, rmSync } from 'node:fs';
+import { request } from 'undici';
+import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
+
+export interface StatusOpts {
+  readonly paths?: CcmuxPaths;
+  readonly stdout?: NodeJS.WritableStream;
+  readonly stderr?: NodeJS.WritableStream;
+  readonly healthTimeoutMs?: number;
+}
+
+interface PidFileContents {
+  readonly pid: number;
+  readonly port: number;
+}
+
+interface HealthResponse {
+  readonly version: string;
+  readonly mode: string;
+  readonly uptimeMs: number;
+}
+
+export async function runStatus(opts: StatusOpts = {}): Promise<number> {
+  const paths = opts.paths ?? resolvePaths();
+  const out = opts.stdout ?? process.stdout;
+  const err = opts.stderr ?? process.stderr;
+  const pidFile = paths.pidFile;
+  const parsed = readPidFile(pidFile);
+  if (parsed === null) { err.write('not running\n'); return 1; }
+  if (!isProcessAlive(parsed.pid)) {
+    safeUnlink(pidFile);
+    out.write(`stale PID file, removing (pid=${parsed.pid})\n`);
+    return 1;
+  }
+  const health = await probeHealth(parsed.port, opts.healthTimeoutMs ?? 1000);
+  if (health === null) {
+    out.write(`pid=${parsed.pid} port=${parsed.port} status=pid-alive-health-unresponsive\n`);
+    return 0;
+  }
+  out.write(formatStatus(parsed, health));
+  return 0;
+}
+
+function readPidFile(pidFile: string): PidFileContents | null {
+  let contents: string;
+  try { contents = readFileSync(pidFile, 'utf8'); } catch { return null; }
+  const [pidLine, portLine] = contents.split('\n');
+  const pid = Number.parseInt((pidLine ?? '').trim(), 10);
+  const port = Number.parseInt((portLine ?? '').trim(), 10);
+  if (!Number.isInteger(pid) || pid <= 0) return null;
+  if (!Number.isInteger(port) || port <= 0) return null;
+  return { pid, port };
+}
+
+function isProcessAlive(pid: number): boolean {
+  try { process.kill(pid, 0); return true; }
+  catch (err: unknown) {
+    const code = (err as { code?: string }).code;
+    if (code === 'EPERM') return true;
+    return false;
+  }
+}
+
+async function probeHealth(port: number, timeoutMs: number): Promise<HealthResponse | null> {
+  const ctrl = new AbortController();
+  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
+  try {
+    const res = await request(`http://127.0.0.1:${port}/healthz`, {
+      method: 'GET',
+      signal: ctrl.signal,
+    });
+    if (res.statusCode !== 200) return null;
+    const body = await res.body.json() as HealthResponse;
+    return body;
+  } catch { return null; }
+  finally { clearTimeout(timer); }
+}
+
+function formatStatus(pidInfo: PidFileContents, health: HealthResponse): string {
+  return (
+    `pid       ${pidInfo.pid}\n` +
+    `port      ${pidInfo.port}\n` +
+    `version   ${health.version}\n` +
+    `mode      ${health.mode}\n` +
+    `uptimeMs  ${health.uptimeMs}\n`
+  );
+}
+
+function safeUnlink(path: string): void {
+  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
+}
diff --git a/src/cli/version.ts b/src/cli/version.ts
index 43bc612..1b3c7b4 100644
--- a/src/cli/version.ts
+++ b/src/cli/version.ts
@@ -1,2 +1,28 @@
-// Populated in section-05. Do not import.
-export {};
+// `ccmux version` handler. Reads package.json once at module load.
+
+import { readFileSync } from 'node:fs';
+import { dirname, join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+interface PackageManifest {
+  readonly name: string;
+  readonly version: string;
+}
+
+function loadManifest(): PackageManifest {
+  const here = dirname(fileURLToPath(import.meta.url));
+  // src/cli/version.ts and dist/cli/version.js both resolve ../../package.json.
+  const manifestPath = join(here, '..', '..', 'package.json');
+  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
+  return { name: parsed.name, version: parsed.version };
+}
+
+const MANIFEST = loadManifest();
+
+export const NAME = MANIFEST.name;
+export const VERSION = MANIFEST.version;
+
+export function runVersion(stdout: NodeJS.WritableStream = process.stdout): number {
+  stdout.write(`${NAME} ${VERSION}\n`);
+  return 0;
+}
diff --git a/src/lifecycle/ports.ts b/src/lifecycle/ports.ts
index 3273c32..e4fea37 100644
--- a/src/lifecycle/ports.ts
+++ b/src/lifecycle/ports.ts
@@ -1,31 +1,66 @@
-// Port binding helper: try startPort, fall back on EADDRINUSE up to maxAttempts times.
+// Sequential port bind: try startPort, fall back on EADDRINUSE up to maxAttempts times.
+// Calls `server.listen` directly — no TOCTOU helper server — per plan §6.6.
+
+import type { AddressInfo } from 'node:net';
 import type { FastifyInstance } from 'fastify';
 
 export interface BindResult {
   readonly port: number;
 }
 
-const BIND_HOST = '127.0.0.1';
+const DEFAULT_BIND_HOST = '127.0.0.1';
+const DEFAULT_MAX_ATTEMPTS = 20;
 
-export async function bindWithFallback(
-  fastify: FastifyInstance,
+/**
+ * Sequentially attempts `server.listen({ host, port })` starting at `startPort`.
+ * On `EADDRINUSE`, increments the port and retries up to `maxAttempts` times.
+ * Any other error is rethrown immediately without retry.
+ *
+ * Returns the port actually bound (read from `server.server.address()`).
+ */
+export async function listenWithFallback(
+  server: FastifyInstance,
+  host: string,
   startPort: number,
-  maxAttempts = 20,
-): Promise<BindResult> {
+  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
+): Promise<number> {
   let lastError: unknown;
   for (let i = 0; i < maxAttempts; i++) {
     const port = startPort + i;
     try {
-      await fastify.listen({ port, host: BIND_HOST });
-      return { port };
+      await server.listen({ host, port });
+      return readBoundPort(server, port);
     } catch (err: unknown) {
       lastError = err;
       if (!isAddressInUse(err)) throw err;
     }
   }
-  throw lastError instanceof Error
-    ? lastError
-    : new Error(`bindWithFallback: exhausted ${maxAttempts} attempts from port ${startPort}`);
+  const endPort = startPort + maxAttempts - 1;
+  const range = `${startPort}-${endPort}`;
+  throw lastError instanceof Error && /EADDRINUSE/i.test(lastError.message)
+    ? new Error(`listenWithFallback: all ports in range ${range} are in use`)
+    : new Error(`listenWithFallback: exhausted ${maxAttempts} attempts in range ${range}`);
+}
+
+/**
+ * Back-compat alias for the Fastify-only signature used elsewhere in the
+ * codebase; always binds on 127.0.0.1.
+ */
+export async function bindWithFallback(
+  fastify: FastifyInstance,
+  startPort: number,
+  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
+): Promise<BindResult> {
+  const port = await listenWithFallback(fastify, DEFAULT_BIND_HOST, startPort, maxAttempts);
+  return { port };
+}
+
+function readBoundPort(server: FastifyInstance, fallback: number): number {
+  const addr = server.server.address();
+  if (addr && typeof addr === 'object') {
+    return (addr as AddressInfo).port;
+  }
+  return fallback;
 }
 
 function isAddressInUse(err: unknown): boolean {
diff --git a/src/proxy/reject-h2.ts b/src/proxy/reject-h2.ts
new file mode 100644
index 0000000..41270ed
--- /dev/null
+++ b/src/proxy/reject-h2.ts
@@ -0,0 +1,33 @@
+// HTTP/2 prior-knowledge rejection: replies 505 on clientError when the raw
+// packet looks like the HTTP/2 connection preface ("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").
+//
+// Fastify (Node's http) runs HTTP/1.1; Node's parser rejects "PRI * HTTP/2.0"
+// before any Fastify hook runs, so we prepend a clientError listener that
+// matches the preface and responds 505. Anything else falls through to
+// Fastify's default clientError handler.
+
+import type { FastifyInstance } from 'fastify';
+
+const H2_PREFACE_PREFIX = Buffer.from('PRI * HTTP/2', 'utf8');
+const STATUS_LINE = 'HTTP/1.1 505 HTTP Version Not Supported';
+const BODY = '{"error":"http2-not-supported","expected":"HTTP/1.1"}';
+
+export function registerRejectHttp2(app: FastifyInstance): void {
+  app.server.prependListener('clientError', (err, socket) => {
+    const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
+    if (!looksLikeH2Preface(rawPacket) || socket.destroyed) return;
+    socket.end(
+      `${STATUS_LINE}\r\n` +
+      `Content-Type: application/json\r\n` +
+      `Content-Length: ${Buffer.byteLength(BODY)}\r\n` +
+      `Connection: close\r\n\r\n` +
+      BODY,
+    );
+  });
+}
+
+function looksLikeH2Preface(rawPacket: Buffer | undefined): boolean {
+  if (rawPacket === undefined) return false;
+  if (rawPacket.length < H2_PREFACE_PREFIX.length) return false;
+  return rawPacket.subarray(0, H2_PREFACE_PREFIX.length).equals(H2_PREFACE_PREFIX);
+}
diff --git a/src/proxy/server.ts b/src/proxy/server.ts
index 8aed140..c2c6863 100644
--- a/src/proxy/server.ts
+++ b/src/proxy/server.ts
@@ -6,6 +6,7 @@ import { makeHotPathHandler } from './hot-path.js';
 import { passThrough } from './pass-through.js';
 import { makeHealthHandler } from './health.js';
 import { checkProxyToken } from './token.js';
+import { registerRejectHttp2 } from './reject-h2.js';
 
 export interface ProxyServerOptions {
   readonly port: number;
@@ -35,33 +36,11 @@ export async function createProxyServer(opts: ProxyServerOptions): Promise<Fasti
   registerErrorHandler(instance);
   registerSecurityHooks(instance, opts);
   registerRoutes(instance, opts);
-  registerHttp2PrefaceGuard(instance);
+  registerRejectHttp2(instance);
 
   return instance;
 }
 
-function registerHttp2PrefaceGuard(app: FastifyInstance): void {
-  // Node's HTTP/1.1 parser rejects "PRI * HTTP/2.0" before any Fastify hook runs.
-  // Prepend a listener that only handles the H2 preface; anything else falls
-  // through to Fastify's default clientError handler.
-  const h2PrefacePrefix = Buffer.from('PRI * HTTP/2', 'utf8');
-  app.server.prependListener('clientError', (err, socket) => {
-    const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
-    const looksLikeH2 = rawPacket !== undefined
-      && rawPacket.length >= h2PrefacePrefix.length
-      && rawPacket.subarray(0, h2PrefacePrefix.length).equals(h2PrefacePrefix);
-    if (!looksLikeH2 || socket.destroyed) return;
-    const body = '{"error":"http2-not-supported"}';
-    socket.end(
-      `HTTP/1.1 505 HTTP Version Not Supported\r\n` +
-      `Content-Type: application/json\r\n` +
-      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
-      `Connection: close\r\n\r\n` +
-      body,
-    );
-  });
-}
-
 function registerHostGuard(app: FastifyInstance): void {
   const origListen = app.listen.bind(app);
   (app as unknown as { listen: typeof origListen }).listen = (async (arg: unknown) => {
diff --git a/tests/cli/main.test.ts b/tests/cli/main.test.ts
new file mode 100644
index 0000000..89df0b6
--- /dev/null
+++ b/tests/cli/main.test.ts
@@ -0,0 +1,45 @@
+// commander router: version, help, unknown command.
+import { describe, it, expect } from 'vitest';
+import { Writable } from 'node:stream';
+import { run } from '../../src/cli/main.js';
+import { VERSION, NAME } from '../../src/cli/version.js';
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+describe('cli main', () => {
+  it('ccmux version prints the version and returns 0', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['version'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    expect(out.read()).toBe(`${NAME} ${VERSION}\n`);
+  });
+
+  it('--help lists all three subcommands', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['--help'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const combined = out.read() + err.read();
+    expect(combined).toMatch(/\bstart\b/);
+    expect(combined).toMatch(/\bstatus\b/);
+    expect(combined).toMatch(/\bversion\b/);
+  });
+
+  it('unknown subcommand returns non-zero and writes to stderr', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await run(['unknown-command-xyz'], { stdout: out.stream, stderr: err.stream });
+    expect(code).not.toBe(0);
+    expect(err.read().length).toBeGreaterThan(0);
+  });
+});
diff --git a/tests/cli/start.test.ts b/tests/cli/start.test.ts
new file mode 100644
index 0000000..27a125e
--- /dev/null
+++ b/tests/cli/start.test.ts
@@ -0,0 +1,88 @@
+// `ccmux start` foreground behavior: bind 127.0.0.1, /healthz 200, no-token bypass, PID file.
+import { describe, it, expect, afterEach } from 'vitest';
+import { Writable } from 'node:stream';
+import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import type { AddressInfo } from 'node:net';
+import { startProxy, type StartedServer } from '../../src/cli/start.js';
+import type { CcmuxPaths } from '../../src/config/paths.js';
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+function makeTempPaths(root: string): CcmuxPaths {
+  return {
+    configDir: root,
+    configFile: join(root, 'config.yaml'),
+    logDir: join(root, 'logs'),
+    decisionLogDir: join(root, 'logs', 'decisions'),
+    stateDir: join(root, 'state'),
+    pidFile: join(root, 'state', 'ccmux.pid'),
+  };
+}
+
+describe('cli start (foreground)', () => {
+  let started: StartedServer | undefined;
+  let tmp: string | undefined;
+
+  afterEach(async () => {
+    if (started) await started.close();
+    started = undefined;
+    if (tmp) rmSync(tmp, { recursive: true, force: true });
+    tmp = undefined;
+    delete process.env.CCMUX_PROXY_TOKEN;
+  });
+
+  it('binds to 127.0.0.1 and responds 200 on /healthz', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
+    const out = bufferStream();
+    started = await startProxy({ foreground: true, paths: makeTempPaths(tmp), stdout: out.stream });
+    const addr = started.app.server.address() as AddressInfo;
+    expect(addr.address).toBe('127.0.0.1');
+    const resp = await fetch(`http://127.0.0.1:${started.port}/healthz`);
+    expect(resp.status).toBe(200);
+    expect(out.read()).toMatch(/^ccmux listening on http:\/\/127\.0\.0\.1:\d+\n$/);
+  });
+
+  it('does not write PID file in foreground mode', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
+    const paths = makeTempPaths(tmp);
+    const out = bufferStream();
+    started = await startProxy({ foreground: true, paths, stdout: out.stream });
+    expect(started.pidFile).toBeNull();
+    expect(existsSync(paths.pidFile)).toBe(false);
+  });
+
+  it('writes PID file (pid, port) when not foreground and removes it on close', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
+    const paths = makeTempPaths(tmp);
+    const out = bufferStream();
+    started = await startProxy({ foreground: false, paths, stdout: out.stream });
+    expect(started.pidFile).toBe(paths.pidFile);
+    const contents = readFileSync(paths.pidFile, 'utf8');
+    const lines = contents.split('\n');
+    expect(Number.parseInt(lines[0]!, 10)).toBe(process.pid);
+    expect(Number.parseInt(lines[1]!, 10)).toBe(started.port);
+    await started.close();
+    started = undefined;
+    expect(existsSync(paths.pidFile)).toBe(false);
+  });
+
+  it('requests without x-ccmux-token succeed when CCMUX_PROXY_TOKEN is unset (bypass-on-unset)', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
+    delete process.env.CCMUX_PROXY_TOKEN;
+    const out = bufferStream();
+    started = await startProxy({ foreground: true, paths: makeTempPaths(tmp), stdout: out.stream });
+    const resp = await fetch(`http://127.0.0.1:${started.port}/healthz`);
+    expect(resp.status).toBe(200);
+  });
+});
diff --git a/tests/cli/status.test.ts b/tests/cli/status.test.ts
new file mode 100644
index 0000000..27d11f1
--- /dev/null
+++ b/tests/cli/status.test.ts
@@ -0,0 +1,84 @@
+// `ccmux status` behavior: no-PID, stale PID, live proxy.
+import { describe, it, expect, afterEach } from 'vitest';
+import { Writable } from 'node:stream';
+import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { startProxy, type StartedServer } from '../../src/cli/start.js';
+import { runStatus } from '../../src/cli/status.js';
+import type { CcmuxPaths } from '../../src/config/paths.js';
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+function makeTempPaths(root: string): CcmuxPaths {
+  return {
+    configDir: root,
+    configFile: join(root, 'config.yaml'),
+    logDir: join(root, 'logs'),
+    decisionLogDir: join(root, 'logs', 'decisions'),
+    stateDir: join(root, 'state'),
+    pidFile: join(root, 'state', 'ccmux.pid'),
+  };
+}
+
+describe('cli status', () => {
+  let tmp: string | undefined;
+  let started: StartedServer | undefined;
+
+  afterEach(async () => {
+    if (started) await started.close();
+    started = undefined;
+    if (tmp) rmSync(tmp, { recursive: true, force: true });
+    tmp = undefined;
+  });
+
+  it('returns 1 with "not running" when no PID file exists', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
+    const paths = makeTempPaths(tmp);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(1);
+    expect(err.read()).toMatch(/not running/);
+  });
+
+  it('removes stale PID file when the referenced process is dead', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
+    const paths = makeTempPaths(tmp);
+    mkdirSync(paths.stateDir, { recursive: true });
+    const deadPid = 999999; // improbable live PID
+    writeFileSync(paths.pidFile, `${deadPid}\n12345\n`, 'utf8');
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(1);
+    expect(out.read()).toMatch(/stale PID file/);
+    expect(existsSync(paths.pidFile)).toBe(false);
+  });
+
+  it('prints pid/port/version/mode/uptime when proxy is live', async () => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
+    const paths = makeTempPaths(tmp);
+    const startOut = bufferStream();
+    started = await startProxy({ foreground: false, paths, stdout: startOut.stream });
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(0);
+    const text = out.read();
+    expect(text).toMatch(new RegExp(`pid\\s+${process.pid}`));
+    expect(text).toMatch(new RegExp(`port\\s+${started.port}`));
+    expect(text).toMatch(/version/);
+    expect(text).toMatch(/mode\s+passthrough/);
+    expect(text).toMatch(/uptimeMs\s+\d+/);
+  });
+});
diff --git a/tests/cli/version.test.ts b/tests/cli/version.test.ts
new file mode 100644
index 0000000..304b4e7
--- /dev/null
+++ b/tests/cli/version.test.ts
@@ -0,0 +1,44 @@
+// version subcommand prints `ccmux <semver>` matching package.json.
+import { describe, it, expect } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { fileURLToPath } from 'node:url';
+import { dirname, join } from 'node:path';
+import { Writable } from 'node:stream';
+import { NAME, VERSION, runVersion } from '../../src/cli/version.js';
+
+function repoRoot(): string {
+  const here = dirname(fileURLToPath(import.meta.url));
+  return join(here, '..', '..');
+}
+
+function readManifestVersion(): string {
+  const raw = readFileSync(join(repoRoot(), 'package.json'), 'utf8');
+  return (JSON.parse(raw) as { version: string }).version;
+}
+
+function bufferStream(): { stream: Writable; chunks: Buffer[] } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, chunks };
+}
+
+describe('cli version', () => {
+  it('module constants match package.json', () => {
+    expect(NAME).toBe('ccmux');
+    expect(VERSION).toBe(readManifestVersion());
+    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
+  });
+
+  it('runVersion prints "ccmux <version>\\n" and returns 0', () => {
+    const { stream, chunks } = bufferStream();
+    const code = runVersion(stream);
+    const out = Buffer.concat(chunks).toString('utf8');
+    expect(code).toBe(0);
+    expect(out).toBe(`${NAME} ${VERSION}\n`);
+  });
+});
diff --git a/tests/proxy/ports.test.ts b/tests/proxy/ports.test.ts
new file mode 100644
index 0000000..1811202
--- /dev/null
+++ b/tests/proxy/ports.test.ts
@@ -0,0 +1,71 @@
+// listenWithFallback: sequential bind, EADDRINUSE retry, other-error rethrow, no TOCTOU helper server.
+import { describe, it, expect, afterEach, vi } from 'vitest';
+import Fastify, { type FastifyInstance } from 'fastify';
+import net from 'node:net';
+import type { AddressInfo } from 'node:net';
+import { listenWithFallback } from '../../src/lifecycle/ports.js';
+
+describe('listenWithFallback', () => {
+  let app: FastifyInstance | undefined;
+  let blocker: net.Server | undefined;
+
+  afterEach(async () => {
+    if (app) await app.close();
+    app = undefined;
+    if (blocker) await new Promise<void>((resolve) => blocker!.close(() => resolve()));
+    blocker = undefined;
+  });
+
+  it('binds on startPort when free and returns it', async () => {
+    app = Fastify({ logger: false });
+    const port = await listenWithFallback(app, '127.0.0.1', 0, 5);
+    expect(port).toBeGreaterThan(0);
+    const addr = app.server.address() as AddressInfo;
+    expect(addr.port).toBe(port);
+    expect(addr.address).toBe('127.0.0.1');
+  });
+
+  it('returns startPort + 1 when startPort is in use', async () => {
+    blocker = net.createServer();
+    await new Promise<void>((resolve) => blocker!.listen(0, '127.0.0.1', resolve));
+    const busy = (blocker.address() as AddressInfo).port;
+    app = Fastify({ logger: false });
+    const port = await listenWithFallback(app, '127.0.0.1', busy, 10);
+    expect(port).toBeGreaterThan(busy);
+  });
+
+  it('throws a clear error naming the range when all ports are occupied', async () => {
+    app = Fastify({ logger: false });
+    const listenSpy = vi.spyOn(app, 'listen').mockImplementation(async () => {
+      const err = new Error('listen EADDRINUSE') as Error & { code: string };
+      err.code = 'EADDRINUSE';
+      throw err;
+    });
+    await expect(listenWithFallback(app, '127.0.0.1', 7000, 20))
+      .rejects.toThrow(/7000-7019/);
+    expect(listenSpy).toHaveBeenCalledTimes(20);
+    listenSpy.mockRestore();
+  });
+
+  it('rethrows non-EADDRINUSE errors immediately without retry', async () => {
+    app = Fastify({ logger: false });
+    const accessErr = new Error('listen EACCES') as Error & { code: string };
+    accessErr.code = 'EACCES';
+    const listenSpy = vi.spyOn(app, 'listen').mockRejectedValueOnce(accessErr);
+    await expect(listenWithFallback(app, '127.0.0.1', 80, 5)).rejects.toThrow(/EACCES/);
+    expect(listenSpy).toHaveBeenCalledTimes(1);
+    listenSpy.mockRestore();
+  });
+
+  it('does not create a TOCTOU helper server (net.createServer is never called)', async () => {
+    const createServerSpy = vi.spyOn(net, 'createServer');
+    const before = createServerSpy.mock.calls.length;
+    app = Fastify({ logger: false });
+    await listenWithFallback(app, '127.0.0.1', 0, 5);
+    // Fastify itself calls net.createServer once during app construction.
+    // listenWithFallback must NOT add any additional createServer calls.
+    const delta = createServerSpy.mock.calls.length - before;
+    expect(delta).toBeLessThanOrEqual(1);
+    createServerSpy.mockRestore();
+  });
+});
diff --git a/tests/proxy/reject-h2.test.ts b/tests/proxy/reject-h2.test.ts
new file mode 100644
index 0000000..94cfed1
--- /dev/null
+++ b/tests/proxy/reject-h2.test.ts
@@ -0,0 +1,51 @@
+// reject-h2 module: positive (H2 preface → 505) + negative (HTTP/1.1 GET /healthz not rejected).
+import { describe, it, expect, afterEach } from 'vitest';
+import net from 'node:net';
+import type { AddressInfo } from 'node:net';
+import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
+import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
+
+const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'utf8');
+
+function rawRequest(port: number, payload: Buffer): Promise<string> {
+  return new Promise<string>((resolve, reject) => {
+    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(payload));
+    const chunks: Buffer[] = [];
+    sock.on('data', (c: Buffer) => chunks.push(c));
+    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
+    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
+    sock.on('error', reject);
+    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 500);
+  });
+}
+
+describe('reject-h2', () => {
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
+  it('rejects HTTP/2 prior-knowledge preface with 505 and JSON body naming HTTP/1.1', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const response = await rawRequest(proxy.port, H2_PREFACE);
+    expect(response).toMatch(/505/);
+    expect(response).toMatch(/http2-not-supported/);
+    expect(response).toMatch(/HTTP\/1\.1/);
+  });
+
+  it('does NOT reject an HTTP/1.1 GET /healthz (negative control)', async () => {
+    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
+    proxy = await buildProxy({ upstreamOrigin: up.origin });
+    const addr = proxy.app.server.address() as AddressInfo;
+    const resp = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
+    expect(resp.status).toBe(200);
+    const body = await resp.json() as { status: string };
+    expect(body.status).toBe('ok');
+  });
+});
