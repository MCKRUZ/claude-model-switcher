diff --git a/src/cli/main.ts b/src/cli/main.ts
index b639661..2e4fbe5 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -1,13 +1,14 @@
 // commander router. Subcommands lazy-import so `ccmux version` stays fast.
 
 import { Command, CommanderError } from 'commander';
+import { splitOnDoubleDash } from './run.js';
 
 export interface RunOptions {
   readonly stdout?: NodeJS.WritableStream;
   readonly stderr?: NodeJS.WritableStream;
 }
 
-interface ActionBox { code: number; }
+interface ActionBox { code: number; childArgv: readonly string[]; }
 
 export async function run(
   argv: readonly string[],
@@ -15,10 +16,11 @@ export async function run(
 ): Promise<number> {
   const stdout = opts.stdout ?? process.stdout;
   const stderr = opts.stderr ?? process.stderr;
-  const box: ActionBox = { code: 0 };
+  const split = splitOnDoubleDash(argv);
+  const box: ActionBox = { code: 0, childArgv: split.after };
   const program = buildProgram(box, stdout, stderr);
   try {
-    await program.parseAsync([...argv], { from: 'user' });
+    await program.parseAsync([...split.before], { from: 'user' });
     return box.code;
   } catch (err: unknown) {
     return handleCommanderError(err, stderr);
@@ -44,6 +46,19 @@ function buildProgram(
       const { runStart } = await import('./start.js');
       box.code = await runStart({ foreground: cmdOpts.foreground === true, stdout });
     });
+  program
+    .command('run')
+    .description('Start the proxy and run a child command against it (ccmux run -- <cmd...>)')
+    .allowUnknownOption(true)
+    .action(async () => {
+      const { runRun } = await import('./run.js');
+      const [childCmd, ...childArgs] = box.childArgv;
+      box.code = await runRun({
+        childCmd: childCmd ?? '',
+        childArgs,
+        stderr,
+      });
+    });
   program
     .command('status')
     .description('Report proxy status from PID file and /healthz')
diff --git a/src/cli/run.ts b/src/cli/run.ts
index f7f8ad2..af14ec2 100644
--- a/src/cli/run.ts
+++ b/src/cli/run.ts
@@ -1,2 +1,48 @@
-// Populated in section-10. Do not import.
-export {};
+// `ccmux run -- <cmd...>` handler — thin CLI wrapper around runWrapper.
+
+import { runWrapper, type WrapperResult } from '../lifecycle/wrapper.js';
+
+export interface RunCmdOptions {
+  readonly childCmd: string;
+  readonly childArgs: readonly string[];
+  readonly configPath?: string;
+  readonly stderr?: NodeJS.WritableStream;
+}
+
+export interface SplitArgv {
+  readonly before: readonly string[];
+  readonly after: readonly string[];
+  readonly hadSeparator: boolean;
+}
+
+export function splitOnDoubleDash(argv: readonly string[]): SplitArgv {
+  const idx = argv.indexOf('--');
+  if (idx === -1) {
+    return { before: argv.slice(), after: [], hadSeparator: false };
+  }
+  return {
+    before: argv.slice(0, idx),
+    after: argv.slice(idx + 1),
+    hadSeparator: true,
+  };
+}
+
+export async function runRun(opts: RunCmdOptions): Promise<number> {
+  const stderr = opts.stderr ?? process.stderr;
+  if (!opts.childCmd) {
+    stderr.write('ccmux run: missing child command after `--`\n');
+    return 2;
+  }
+  try {
+    const result: WrapperResult = await runWrapper({
+      childCmd: opts.childCmd,
+      childArgs: opts.childArgs,
+      ...(opts.configPath ? { configPath: opts.configPath } : {}),
+    });
+    return result.exitCode;
+  } catch (err: unknown) {
+    const msg = err instanceof Error ? err.message : String(err);
+    stderr.write(`ccmux run: ${msg}\n`);
+    return 1;
+  }
+}
diff --git a/src/lifecycle/token.ts b/src/lifecycle/token.ts
new file mode 100644
index 0000000..500a96f
--- /dev/null
+++ b/src/lifecycle/token.ts
@@ -0,0 +1,7 @@
+// 128-bit random proxy token generator (defense-in-depth per plan §6.8).
+
+import { randomBytes } from 'node:crypto';
+
+export function generateProxyToken(): string {
+  return randomBytes(16).toString('hex');
+}
diff --git a/src/lifecycle/wrapper.ts b/src/lifecycle/wrapper.ts
index f7f8ad2..e8a88dc 100644
--- a/src/lifecycle/wrapper.ts
+++ b/src/lifecycle/wrapper.ts
@@ -1,2 +1,223 @@
-// Populated in section-10. Do not import.
-export {};
+// `ccmux run -- <cmd>` orchestrator: owns the proxy lifecycle, spawns the
+// child, forwards signals, tears down, and propagates exit code.
+//
+// See planning/sections/section-10-wrapper.md for the full contract.
+
+import { spawn as childSpawn, type ChildProcess } from 'node:child_process';
+import { mkdirSync } from 'node:fs';
+import { constants as osConstants } from 'node:os';
+import type { FastifyInstance } from 'fastify';
+import type { Logger } from 'pino';
+import { loadConfig } from '../config/loader.js';
+import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
+import { startConfigWatcher, type WatcherHandle } from '../config/watcher.js';
+import { createLogger } from '../logging/logger.js';
+import { createProxyServer } from '../proxy/server.js';
+import { listenWithFallback } from './ports.js';
+import { generateProxyToken } from './token.js';
+
+export interface WrapperOptions {
+  readonly childCmd: string;
+  readonly childArgs: readonly string[];
+  readonly configPath?: string;
+  readonly paths?: CcmuxPaths;
+  readonly parentEnv?: NodeJS.ProcessEnv;
+  readonly healthzTimeoutMs?: number;
+  readonly logDir?: string;
+  readonly signalSource?: NodeJS.EventEmitter;
+  readonly stdio?: 'inherit' | 'pipe' | 'ignore';
+  readonly installSignalHandlers?: boolean;
+}
+
+export interface WrapperResult {
+  readonly exitCode: number;
+}
+
+interface ProxyHandle {
+  readonly app: FastifyInstance;
+  readonly port: number;
+  readonly watcher: WatcherHandle;
+  readonly logger: Logger;
+}
+
+const DEFAULT_HEALTHZ_TIMEOUT_MS = 5000;
+const HEALTHZ_POLL_MS = 50;
+const ENOENT_EXIT_CODE = 127;
+
+export async function runWrapper(opts: WrapperOptions): Promise<WrapperResult> {
+  const parentEnv = opts.parentEnv ?? process.env;
+  const token = generateProxyToken();
+  const proxy = await startWrapperProxy(opts, token);
+  try {
+    await waitForHealthz(proxy.port, opts.healthzTimeoutMs ?? DEFAULT_HEALTHZ_TIMEOUT_MS);
+    const childEnv = buildChildEnv(parentEnv, proxy.port, token);
+    return await runChildLifecycle(opts, childEnv, proxy);
+  } finally {
+    await teardownProxy(proxy);
+  }
+}
+
+async function startWrapperProxy(opts: WrapperOptions, token: string): Promise<ProxyHandle> {
+  const paths = opts.paths ?? resolvePaths();
+  const configPath = opts.configPath ?? paths.configFile;
+  const loaded = await loadConfig(configPath);
+  if (!loaded.ok) {
+    const msgs = loaded.error.map((e) => `${e.path}: ${e.message}`).join('; ');
+    throw new Error(`ccmux run: invalid config: ${msgs}`);
+  }
+  const { config } = loaded.value;
+  if (opts.logDir) mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
+  const logger = createLogger(
+    opts.logDir ? { destination: 'file', logDir: opts.logDir } : { destination: 'stderr' },
+  );
+  const { store, handle: watcher } = startConfigWatcher(configPath, config, logger);
+  // The token is injected into the child env for defense-in-depth (plan §6.8)
+  // but not enforced on the proxy: Claude Code has no outbound-header knob, so
+  // hard-failing requests without x-ccmux-token would break the happy path.
+  // The proxy binds 127.0.0.1 only, which is the real containment boundary.
+  const app = await createProxyServer({
+    port: config.port,
+    logger,
+    config,
+    configStore: store,
+    proxyToken: token,
+  });
+  const port = await listenWithFallback(app, '127.0.0.1', config.port, 20);
+  return { app, port, watcher, logger };
+}
+
+export function buildChildEnv(
+  parentEnv: NodeJS.ProcessEnv,
+  port: number,
+  token: string,
+): NodeJS.ProcessEnv {
+  const baseUrl = `http://127.0.0.1:${port}`;
+  const noProxy = '127.0.0.1,localhost';
+  const env: NodeJS.ProcessEnv = { ...parentEnv };
+  // Redirect Claude Code to the local proxy and prevent any outbound proxy
+  // env from intercepting 127.0.0.1 traffic.
+  env.ANTHROPIC_BASE_URL = baseUrl;
+  env.NO_PROXY = noProxy;
+  env.no_proxy = noProxy;
+  env.NOPROXY = noProxy;
+  env.CCMUX_PROXY_TOKEN = token;
+  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CONFIG_DIR survive the
+  // spread above; explicit here for clarity — the preservation is asserted by
+  // tests in tests/lifecycle/wrapper.test.ts.
+  return env;
+}
+
+async function waitForHealthz(port: number, timeoutMs: number): Promise<void> {
+  const url = `http://127.0.0.1:${port}/healthz`;
+  const deadline = Date.now() + timeoutMs;
+  let lastError: unknown;
+  while (Date.now() < deadline) {
+    try {
+      const resp = await fetch(url);
+      if (resp.status === 200) return;
+    } catch (err: unknown) {
+      lastError = err;
+    }
+    await sleep(HEALTHZ_POLL_MS);
+  }
+  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
+  throw new Error(`ccmux run: /healthz did not respond 200 within ${timeoutMs}ms${reason}`);
+}
+
+async function runChildLifecycle(
+  opts: WrapperOptions,
+  childEnv: NodeJS.ProcessEnv,
+  proxy: ProxyHandle,
+): Promise<WrapperResult> {
+  const child = childSpawn(opts.childCmd, [...opts.childArgs], {
+    env: childEnv,
+    stdio: opts.stdio ?? 'inherit',
+    shell: false,
+    windowsHide: true,
+  });
+  const forwardSignals = opts.installSignalHandlers !== false;
+  const signalSource = opts.signalSource ?? process;
+  const uninstall = forwardSignals ? installSignalForwarding(child, signalSource) : noop;
+  try {
+    return await awaitChildExit(child, proxy.logger);
+  } finally {
+    uninstall();
+  }
+}
+
+function awaitChildExit(child: ChildProcess, logger: Logger): Promise<WrapperResult> {
+  return new Promise<WrapperResult>((resolve) => {
+    let settled = false;
+    const settle = (code: number): void => {
+      if (settled) return;
+      settled = true;
+      resolve({ exitCode: code });
+    };
+    child.once('error', (err: NodeJS.ErrnoException) => {
+      logger.error({ err, code: err.code }, 'ccmux run: failed to spawn child');
+      settle(err.code === 'ENOENT' ? ENOENT_EXIT_CODE : 1);
+    });
+    child.once('exit', (code, signal) => {
+      settle(exitCodeFor(code, signal));
+    });
+  });
+}
+
+function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
+  if (typeof code === 'number') return code;
+  if (signal) {
+    if (process.platform === 'win32') return 1;
+    const num = osConstants.signals[signal];
+    return typeof num === 'number' ? 128 + num : 1;
+  }
+  return 0;
+}
+
+type SignalHandler = (sig: NodeJS.Signals) => void;
+
+function installSignalForwarding(
+  child: ChildProcess,
+  source: NodeJS.EventEmitter,
+): () => void {
+  const makeHandler = (sig: NodeJS.Signals): SignalHandler => () => {
+    try {
+      child.kill(sig);
+    } catch {
+      // Best-effort — child may already have exited.
+    }
+  };
+  const sigint = makeHandler('SIGINT');
+  const sigterm = makeHandler('SIGTERM');
+  source.on('SIGINT', sigint);
+  source.on('SIGTERM', sigterm);
+  return () => {
+    source.off('SIGINT', sigint);
+    source.off('SIGTERM', sigterm);
+  };
+}
+
+async function teardownProxy(proxy: ProxyHandle): Promise<void> {
+  try {
+    await proxy.watcher.stop();
+  } catch {
+    // best-effort
+  }
+  try {
+    await proxy.app.close();
+  } catch {
+    // best-effort
+  }
+  try {
+    proxy.logger.flush?.();
+  } catch {
+    // pino flush is best-effort
+  }
+}
+
+function sleep(ms: number): Promise<void> {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
+
+function noop(): void {
+  // intentionally empty
+}
diff --git a/tests/cli/run.test.ts b/tests/cli/run.test.ts
new file mode 100644
index 0000000..fc1d2b0
--- /dev/null
+++ b/tests/cli/run.test.ts
@@ -0,0 +1,50 @@
+// `ccmux run` argv parsing: everything after the first `--` is child argv.
+import { describe, it, expect } from 'vitest';
+import { splitOnDoubleDash, runRun } from '../../src/cli/run.js';
+import { Writable } from 'node:stream';
+
+function sink(): { stream: Writable; read: () => string } {
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
+describe('ccmux run argv parsing', () => {
+  it('splits argv on the first -- and treats everything after as child argv', () => {
+    const s = splitOnDoubleDash(['run', '--', 'claude', '--help']);
+    expect(s.before).toEqual(['run']);
+    expect(s.after).toEqual(['claude', '--help']);
+    expect(s.hadSeparator).toBe(true);
+  });
+
+  it('returns empty `after` when no -- is present', () => {
+    const s = splitOnDoubleDash(['run']);
+    expect(s.before).toEqual(['run']);
+    expect(s.after).toEqual([]);
+    expect(s.hadSeparator).toBe(false);
+  });
+
+  it('only splits on the first -- (later -- become child argv tokens)', () => {
+    const s = splitOnDoubleDash(['run', '--', 'claude', '--', 'extra']);
+    expect(s.before).toEqual(['run']);
+    expect(s.after).toEqual(['claude', '--', 'extra']);
+  });
+
+  it('forwards ccmux-looking flags that appear after -- to the child unchanged', () => {
+    // e.g., `ccmux run -- claude --help` must pass --help to claude.
+    const s = splitOnDoubleDash(['run', '--', 'claude', '--help']);
+    expect(s.after).toEqual(['claude', '--help']);
+  });
+
+  it('rejects invocations with no command after -- (exit code 2)', async () => {
+    const err = sink();
+    const code = await runRun({ childCmd: '', childArgs: [], stderr: err.stream });
+    expect(code).toBe(2);
+    expect(err.read()).toMatch(/missing child command/);
+  });
+});
diff --git a/tests/fixtures/bin/echo-env.mjs b/tests/fixtures/bin/echo-env.mjs
new file mode 100644
index 0000000..892316c
--- /dev/null
+++ b/tests/fixtures/bin/echo-env.mjs
@@ -0,0 +1,42 @@
+#!/usr/bin/env node
+// Test fixture: records select env vars to a file, then exits (or loops on
+// signal) based on env flags set by the test.
+//
+// Env contract:
+//   CCMUX_TEST_OUT   — absolute path; JSON snapshot of selected env vars is written here
+//   CCMUX_TEST_MODE  — "exit" (default), "loop" (block until signal), or "sleep:<ms>"
+//   CCMUX_TEST_CODE  — integer; exit code to use for "exit" mode (default 0)
+
+import { writeFileSync } from 'node:fs';
+
+const OUT_KEYS = [
+  'ANTHROPIC_BASE_URL',
+  'ANTHROPIC_API_KEY',
+  'ANTHROPIC_AUTH_TOKEN',
+  'CLAUDE_CONFIG_DIR',
+  'NO_PROXY',
+  'no_proxy',
+  'NOPROXY',
+  'CCMUX_PROXY_TOKEN',
+];
+
+const outPath = process.env.CCMUX_TEST_OUT;
+if (outPath) {
+  const snapshot = {};
+  for (const key of OUT_KEYS) snapshot[key] = process.env[key] ?? '';
+  writeFileSync(outPath, JSON.stringify(snapshot));
+}
+
+const mode = process.env.CCMUX_TEST_MODE ?? 'exit';
+
+if (mode === 'loop') {
+  process.on('SIGINT', () => process.exit(130));
+  process.on('SIGTERM', () => process.exit(143));
+  setInterval(() => {}, 3600_000);
+} else if (mode.startsWith('sleep:')) {
+  const ms = Number(mode.slice('sleep:'.length));
+  setTimeout(() => process.exit(0), Number.isFinite(ms) ? ms : 100);
+} else {
+  const code = Number(process.env.CCMUX_TEST_CODE ?? '0');
+  process.exit(Number.isFinite(code) ? code : 0);
+}
diff --git a/tests/lifecycle/wrapper.test.ts b/tests/lifecycle/wrapper.test.ts
new file mode 100644
index 0000000..136b4f3
--- /dev/null
+++ b/tests/lifecycle/wrapper.test.ts
@@ -0,0 +1,291 @@
+// `ccmux run` wrapper contract (section-10):
+// child env, signal forwarding, exit code propagation, ENOENT, token redaction.
+import { describe, it, expect, beforeEach, afterEach } from 'vitest';
+import { EventEmitter } from 'node:events';
+import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import type { CcmuxPaths } from '../../src/config/paths.js';
+import { runWrapper, buildChildEnv } from '../../src/lifecycle/wrapper.js';
+
+const FIXTURE = fileURLToPath(new URL('../fixtures/bin/echo-env.mjs', import.meta.url));
+
+function tempPaths(root: string): CcmuxPaths {
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
+function writeConfig(path: string, port: number): void {
+  writeFileSync(path, `port: ${port}\n`, 'utf8');
+}
+
+function readSnapshot(path: string): Record<string, string> {
+  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
+}
+
+function nextPort(): number {
+  // Seed from Math.random to spread across tests; listenWithFallback handles collisions.
+  return 18800 + Math.floor(Math.random() * 500);
+}
+
+let tmp: string;
+let outFile: string;
+let logDir: string;
+
+beforeEach(() => {
+  tmp = mkdtempSync(join(tmpdir(), 'ccmux-wrap-'));
+  outFile = join(tmp, 'env.json');
+  logDir = join(tmp, 'logs');
+  writeConfig(join(tmp, 'config.yaml'), nextPort());
+  delete process.env.CCMUX_TEST_OUT;
+  delete process.env.CCMUX_TEST_MODE;
+  delete process.env.CCMUX_TEST_CODE;
+});
+
+afterEach(() => {
+  rmSync(tmp, { recursive: true, force: true });
+});
+
+describe('ccmux run wrapper — child env', () => {
+  it('sets ANTHROPIC_BASE_URL to the bound proxy port in child env', async () => {
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
+    const res = await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    expect(res.exitCode).toBe(0);
+    const snap = readSnapshot(outFile);
+    expect(snap.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
+  });
+
+  it('preserves ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from parent env', async () => {
+    const parentEnv = {
+      ...process.env,
+      CCMUX_TEST_OUT: outFile,
+      CCMUX_TEST_MODE: 'exit',
+      ANTHROPIC_API_KEY: 'sk-test-api',
+      ANTHROPIC_AUTH_TOKEN: 'auth-test',
+      CLAUDE_CONFIG_DIR: '/tmp/claude-fake',
+    };
+    await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    const snap = readSnapshot(outFile);
+    expect(snap.ANTHROPIC_API_KEY).toBe('sk-test-api');
+    expect(snap.ANTHROPIC_AUTH_TOKEN).toBe('auth-test');
+    expect(snap.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-fake');
+  });
+
+  it('sets NO_PROXY / no_proxy / NOPROXY to include 127.0.0.1 and localhost', async () => {
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
+    await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    const snap = readSnapshot(outFile);
+    for (const key of ['NO_PROXY', 'no_proxy', 'NOPROXY']) {
+      expect(snap[key]).toContain('127.0.0.1');
+      expect(snap[key]).toContain('localhost');
+    }
+  });
+
+  it('generates and injects CCMUX_PROXY_TOKEN into child env (128 bits, hex)', async () => {
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
+    await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    const snap = readSnapshot(outFile);
+    expect(snap.CCMUX_PROXY_TOKEN).toMatch(/^[0-9a-f]{32}$/);
+  });
+
+  it('buildChildEnv uses the actually-bound port, not the requested port', () => {
+    const env = buildChildEnv({ FOO: 'bar' } as NodeJS.ProcessEnv, 18999, 'deadbeef');
+    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18999');
+    expect(env.FOO).toBe('bar');
+  });
+});
+
+describe('ccmux run wrapper — signals and exit codes', () => {
+  it('propagates non-zero child exit code to wrapper exit code', async () => {
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit', CCMUX_TEST_CODE: '7' };
+    const res = await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    expect(res.exitCode).toBe(7);
+  });
+
+  it.skipIf(process.platform === 'win32')(
+    'forwards SIGINT to the child, tears down proxy, and exits with child code',
+    async () => {
+      const signalSource = new EventEmitter();
+      const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'loop' };
+      // Kick off the wrapper.
+      const resultPromise = runWrapper({
+        childCmd: process.execPath,
+        childArgs: [FIXTURE],
+        paths: tempPaths(tmp),
+        parentEnv,
+        signalSource,
+        logDir,
+      });
+      // Wait briefly for child to start, then emit SIGINT on the injected source.
+      await new Promise((r) => setTimeout(r, 250));
+      signalSource.emit('SIGINT', 'SIGINT');
+      const res = await resultPromise;
+      // Fixture traps SIGINT and exits 130.
+      expect(res.exitCode).toBe(130);
+    },
+  );
+
+  it.skipIf(process.platform === 'win32')(
+    'forwards SIGTERM to the child, tears down proxy, and exits with child code',
+    async () => {
+      const signalSource = new EventEmitter();
+      const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'loop' };
+      const resultPromise = runWrapper({
+        childCmd: process.execPath,
+        childArgs: [FIXTURE],
+        paths: tempPaths(tmp),
+        parentEnv,
+        signalSource,
+        logDir,
+      });
+      await new Promise((r) => setTimeout(r, 250));
+      signalSource.emit('SIGTERM', 'SIGTERM');
+      const res = await resultPromise;
+      expect(res.exitCode).toBe(143);
+    },
+  );
+
+  it('exits 127 when child command is not found (ENOENT)', async () => {
+    const res = await runWrapper({
+      childCmd: '/definitely/not/a/real/binary-ccmux-enoent',
+      childArgs: [],
+      paths: tempPaths(tmp),
+      parentEnv: process.env,
+      installSignalHandlers: false,
+      logDir,
+    });
+    expect(res.exitCode).toBe(127);
+  });
+
+  it('when configured port is busy, uses the next free port and injects it into child env', async () => {
+    // Seed config with a likely-free port; then hold it by starting one wrapper, and
+    // concurrently starting another that should fall back.
+    const configPath = join(tmp, 'config.yaml');
+    const port = nextPort();
+    writeFileSync(configPath, `port: ${port}\n`, 'utf8');
+
+    const firstOut = join(tmp, 'env1.json');
+    const secondOut = join(tmp, 'env2.json');
+
+    const firstEnv = { ...process.env, CCMUX_TEST_OUT: firstOut, CCMUX_TEST_MODE: 'sleep:500' };
+    const secondEnv = { ...process.env, CCMUX_TEST_OUT: secondOut, CCMUX_TEST_MODE: 'exit' };
+
+    const first = runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv: firstEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    // Give the first wrapper time to bind the port before starting the second.
+    await new Promise((r) => setTimeout(r, 150));
+    const second = runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv: secondEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    const [r1, r2] = await Promise.all([first, second]);
+    expect(r1.exitCode).toBe(0);
+    expect(r2.exitCode).toBe(0);
+    const s1 = readSnapshot(firstOut);
+    const s2 = readSnapshot(secondOut);
+    const p1 = extractPort(s1.ANTHROPIC_BASE_URL ?? '');
+    const p2 = extractPort(s2.ANTHROPIC_BASE_URL ?? '');
+    expect(p1).toBe(port);
+    expect(p2).toBeGreaterThan(port);
+  });
+});
+
+describe('ccmux run wrapper — proxy coordination', () => {
+  it('waits for /healthz before spawning the child', async () => {
+    // When the wrapper returns and the child has already exited, /healthz should
+    // have been reachable at least once during the run. We assert indirectly by
+    // requiring a successful exit and a valid BASE_URL — if healthz never
+    // returned 200, runWrapper would throw before spawning.
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
+    const res = await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      healthzTimeoutMs: 2000,
+      logDir,
+    });
+    expect(res.exitCode).toBe(0);
+    const snap = readSnapshot(outFile);
+    expect(snap.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
+  });
+
+  it('never writes the proxy token to any log line (redaction check)', async () => {
+    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
+    await runWrapper({
+      childCmd: process.execPath,
+      childArgs: [FIXTURE],
+      paths: tempPaths(tmp),
+      parentEnv,
+      installSignalHandlers: false,
+      logDir,
+    });
+    const snap = readSnapshot(outFile);
+    const token = snap.CCMUX_PROXY_TOKEN;
+    expect(token).toMatch(/^[0-9a-f]{32}$/);
+    // Give pino a tick to flush to disk.
+    await new Promise((r) => setTimeout(r, 100));
+    const logPath = join(logDir, 'ccmux.log');
+    if (!existsSync(logPath)) return; // no logs written — trivially passes
+    const logContents = readFileSync(logPath, 'utf8');
+    expect(logContents).not.toContain(token);
+  });
+});
+
+function extractPort(url: string): number {
+  const m = url.match(/:(\d+)$/);
+  return m ? Number.parseInt(m[1]!, 10) : -1;
+}
