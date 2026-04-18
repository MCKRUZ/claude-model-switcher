diff --git a/src/cli/start.ts b/src/cli/start.ts
index 5021c35..e9eb86f 100644
--- a/src/cli/start.ts
+++ b/src/cli/start.ts
@@ -9,6 +9,7 @@ import { dirname } from 'node:path';
 import type { FastifyInstance } from 'fastify';
 import { loadConfig } from '../config/loader.js';
 import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
+import { startConfigWatcher, type WatcherHandle } from '../config/watcher.js';
 import { createLogger } from '../logging/logger.js';
 import { createProxyServer } from '../proxy/server.js';
 import { listenWithFallback } from '../lifecycle/ports.js';
@@ -30,25 +31,36 @@ export interface StartedServer {
 export async function startProxy(opts: StartOpts): Promise<StartedServer> {
   const paths = opts.paths ?? resolvePaths();
   const out = opts.stdout ?? process.stdout;
-  const loaded = await loadConfig(opts.configPath);
+  const configPath = opts.configPath ?? paths.configFile;
+  const loaded = await loadConfig(configPath);
   if (!loaded.ok) {
     const msgs = loaded.error.map((e) => `${e.path}: ${e.message}`).join('; ');
     throw new Error(`ccmux: invalid config: ${msgs}`);
   }
   const { config } = loaded.value;
   const logger = createLogger({ destination: 'stderr' });
-  const app = await createProxyServer({ port: config.port, logger, config });
+  const { store, handle: watcher } = startConfigWatcher(configPath, config, logger);
+  const app = await createProxyServer({ port: config.port, logger, config, configStore: store });
   const port = await listenWithFallback(app, '127.0.0.1', config.port, 20);
   out.write(`ccmux listening on http://127.0.0.1:${port}\n`);
 
   const pidFile = opts.foreground ? null : writePidFile(paths.pidFile, process.pid, port);
   const baseClose = async (): Promise<void> => {
+    await closeWatcher(watcher);
     await app.close();
     if (pidFile !== null) safeUnlink(pidFile);
   };
   return { app, port, pidFile, close: baseClose };
 }
 
+async function closeWatcher(watcher: WatcherHandle): Promise<void> {
+  try {
+    await watcher.stop();
+  } catch {
+    // Shutdown path — best-effort.
+  }
+}
+
 export async function runStart(opts: StartOpts): Promise<number> {
   const server = await startProxy(opts);
   return new Promise<number>((resolve) => installShutdownHandlers(server, resolve));
diff --git a/src/config/watch.ts b/src/config/watch.ts
deleted file mode 100644
index c76ed4a..0000000
--- a/src/config/watch.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// Populated in section-06. Do not import.
-export {};
diff --git a/src/config/watcher.ts b/src/config/watcher.ts
new file mode 100644
index 0000000..7b87ef5
--- /dev/null
+++ b/src/config/watcher.ts
@@ -0,0 +1,96 @@
+// Hot-reload watcher: chokidar + 500ms debounce; atomic-swap of the in-memory
+// config reference. On parse/validate failure the previous config is retained
+// and a warn-level log entry is emitted.
+
+import chokidar, { type FSWatcher } from 'chokidar';
+import type { Logger } from 'pino';
+import { loadConfig } from './loader.js';
+import type { CcmuxConfig } from './schema.js';
+
+export interface ConfigStore {
+  getCurrent(): CcmuxConfig;
+}
+
+export interface WatcherHandle {
+  stop(): Promise<void>;
+  readonly whenReady: Promise<void>;
+}
+
+export interface WatcherOpts {
+  readonly debounceMs?: number;
+  readonly onReload?: (next: CcmuxConfig) => void;
+}
+
+const DEFAULT_DEBOUNCE_MS = 500;
+
+export function startConfigWatcher(
+  configPath: string,
+  initial: CcmuxConfig,
+  logger: Logger,
+  opts: WatcherOpts = {},
+): { store: ConfigStore; handle: WatcherHandle } {
+  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
+  let current: CcmuxConfig = initial;
+  const store: ConfigStore = { getCurrent: () => current };
+
+  let debounceTimer: NodeJS.Timeout | null = null;
+  let stopped = false;
+
+  const watcher: FSWatcher = chokidar.watch(configPath, {
+    ignoreInitial: true,
+    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
+    usePolling: true,
+    interval: 50,
+  });
+
+  const scheduleReload = (): void => {
+    if (stopped) return;
+    if (debounceTimer !== null) clearTimeout(debounceTimer);
+    debounceTimer = setTimeout(() => {
+      debounceTimer = null;
+      void runReload();
+    }, debounceMs);
+  };
+
+  const runReload = async (): Promise<void> => {
+    if (stopped) return;
+    try {
+      const result = await loadConfig(configPath);
+      if (!result.ok) {
+        const msg = result.error.map((e) => `${e.path}: ${e.message}`).join('; ');
+        logger.warn({ errors: result.error }, `config reload rejected: ${msg}`);
+        return;
+      }
+      current = result.value.config;
+      logger.info({ warnings: result.value.warnings.length }, 'config reloaded');
+      opts.onReload?.(current);
+    } catch (err) {
+      const msg = err instanceof Error ? err.message : String(err);
+      logger.warn({ err }, `config reload failed: ${msg}`);
+    }
+  };
+
+  watcher.on('add', scheduleReload);
+  watcher.on('change', scheduleReload);
+  watcher.on('error', (err) => {
+    logger.warn({ err }, 'config watcher error');
+  });
+
+  const whenReady = new Promise<void>((resolve) => {
+    watcher.once('ready', () => resolve());
+  });
+
+  const handle: WatcherHandle = {
+    whenReady,
+    stop: async () => {
+      stopped = true;
+      if (debounceTimer !== null) {
+        clearTimeout(debounceTimer);
+        debounceTimer = null;
+      }
+      await watcher.close();
+    },
+  };
+
+  return { store, handle };
+}
diff --git a/src/proxy/server.ts b/src/proxy/server.ts
index c2c6863..8011ef5 100644
--- a/src/proxy/server.ts
+++ b/src/proxy/server.ts
@@ -2,6 +2,7 @@
 import Fastify, { type FastifyInstance } from 'fastify';
 import type { Logger } from 'pino';
 import type { CcmuxConfig } from '../config/schema.js';
+import type { ConfigStore } from '../config/watcher.js';
 import { makeHotPathHandler } from './hot-path.js';
 import { passThrough } from './pass-through.js';
 import { makeHealthHandler } from './health.js';
@@ -12,6 +13,7 @@ export interface ProxyServerOptions {
   readonly port: number;
   readonly logger: Logger;
   readonly config: CcmuxConfig;
+  readonly configStore?: ConfigStore;
   readonly requireProxyToken?: boolean;
   readonly proxyToken?: string;
   readonly bodyLimit?: number;
diff --git a/tests/config/watcher.test.ts b/tests/config/watcher.test.ts
new file mode 100644
index 0000000..b8776be
--- /dev/null
+++ b/tests/config/watcher.test.ts
@@ -0,0 +1,147 @@
+// Config hot-reload watcher: debounce, atomic swap, invalid-YAML retention,
+// teardown. Uses real timers + small debounce because chokidar uses setTimeout
+// internally for awaitWriteFinish, which conflicts with vitest fake timers.
+import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
+import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import pino from 'pino';
+import { defaultConfig } from '../../src/config/defaults.js';
+import { startConfigWatcher, type WatcherHandle } from '../../src/config/watcher.js';
+
+const DEBOUNCE_MS = 100;
+const SETTLE_MS = 3000; // chokidar polling on Windows + debounce + stabilization; padded for parallel test load
+
+function waitMs(ms: number): Promise<void> {
+  return new Promise((r) => setTimeout(r, ms));
+}
+
+function silentLogger(): pino.Logger {
+  return pino({ level: 'silent' });
+}
+
+function collectingLogger(): { log: pino.Logger; entries: Array<{ level: number; msg: string; obj?: unknown }> } {
+  const entries: Array<{ level: number; msg: string; obj?: unknown }> = [];
+  const log = pino({ level: 'warn' }, {
+    write(chunk: string): void {
+      const parsed: unknown = JSON.parse(chunk);
+      if (typeof parsed === 'object' && parsed !== null) {
+        const rec = parsed as { level?: number; msg?: string };
+        entries.push({ level: rec.level ?? 0, msg: rec.msg ?? '', obj: parsed });
+      }
+    },
+  });
+  return { log, entries };
+}
+
+describe('startConfigWatcher', { timeout: 15000 }, () => {
+  let tmp: string | undefined;
+  let handle: WatcherHandle | undefined;
+
+  beforeEach(() => {
+    tmp = mkdtempSync(join(tmpdir(), 'ccmux-watcher-'));
+  });
+
+  afterEach(async () => {
+    if (handle) await handle.stop();
+    handle = undefined;
+    if (tmp) rmSync(tmp, { recursive: true, force: true });
+    tmp = undefined;
+  });
+
+  it('swaps config after a valid edit (debounced)', async () => {
+    const cfg = join(tmp!, 'config.yaml');
+    writeFileSync(cfg, 'port: 9000\n', 'utf8');
+    const initial = { ...defaultConfig(), port: 9000 };
+    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
+    handle = h;
+    await h.whenReady;
+    expect(store.getCurrent().port).toBe(9000);
+
+    writeFileSync(cfg, 'port: 9100\n', 'utf8');
+    await waitMs(SETTLE_MS);
+    expect(store.getCurrent().port).toBe(9100);
+  });
+
+  it('keeps previous config and logs warn on invalid YAML', async () => {
+    const cfg = join(tmp!, 'config.yaml');
+    writeFileSync(cfg, 'port: 9000\n', 'utf8');
+    const { log, entries } = collectingLogger();
+    const initial = { ...defaultConfig(), port: 9000 };
+    const { store, handle: h } = startConfigWatcher(cfg, initial, log, { debounceMs: DEBOUNCE_MS });
+    handle = h;
+    await h.whenReady;
+
+    writeFileSync(cfg, 'port: [not-a-scalar\n', 'utf8');
+    await waitMs(SETTLE_MS);
+    expect(store.getCurrent().port).toBe(9000); // unchanged
+    const warns = entries.filter((e) => e.level >= 40);
+    expect(warns.length).toBeGreaterThanOrEqual(1);
+  });
+
+  it('coalesces rapid writes into a single reload', async () => {
+    const cfg = join(tmp!, 'config.yaml');
+    writeFileSync(cfg, 'port: 9000\n', 'utf8');
+    const initial = { ...defaultConfig(), port: 9000 };
+    const reloadSpy = vi.fn();
+    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), {
+      debounceMs: DEBOUNCE_MS,
+      onReload: reloadSpy,
+    });
+    handle = h;
+    await h.whenReady;
+
+    writeFileSync(cfg, 'port: 9100\n', 'utf8');
+    writeFileSync(cfg, 'port: 9200\n', 'utf8');
+    writeFileSync(cfg, 'port: 9300\n', 'utf8');
+    await waitMs(SETTLE_MS);
+    expect(store.getCurrent().port).toBe(9300);
+    expect(reloadSpy).toHaveBeenCalledTimes(1);
+  });
+
+  it('atomic swap: a reference captured before reload still reads the old config', async () => {
+    const cfg = join(tmp!, 'config.yaml');
+    writeFileSync(cfg, 'port: 9000\n', 'utf8');
+    const initial = { ...defaultConfig(), port: 9000 };
+    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
+    handle = h;
+    await h.whenReady;
+
+    const snapshotBefore = store.getCurrent(); // handler-style capture
+    writeFileSync(cfg, 'port: 9100\n', 'utf8');
+    await waitMs(SETTLE_MS);
+    expect(store.getCurrent().port).toBe(9100);
+    expect(snapshotBefore.port).toBe(9000); // captured reference unchanged
+  });
+
+  it('teardown: after stop(), further edits do not reload', async () => {
+    const cfg = join(tmp!, 'config.yaml');
+    writeFileSync(cfg, 'port: 9000\n', 'utf8');
+    const initial = { ...defaultConfig(), port: 9000 };
+    const reloadSpy = vi.fn();
+    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), {
+      debounceMs: DEBOUNCE_MS,
+      onReload: reloadSpy,
+    });
+    await h.stop();
+
+    writeFileSync(cfg, 'port: 9100\n', 'utf8');
+    await waitMs(SETTLE_MS);
+    expect(store.getCurrent().port).toBe(9000);
+    expect(reloadSpy).not.toHaveBeenCalled();
+  });
+
+  it('missing file at start does not throw and remains idle until it appears', async () => {
+    const cfg = join(tmp!, 'does-not-exist.yaml');
+    const initial = { ...defaultConfig(), port: 9000 };
+    const { store, handle: h } = startConfigWatcher(cfg, initial, silentLogger(), { debounceMs: DEBOUNCE_MS });
+    handle = h;
+    await h.whenReady;
+    expect(store.getCurrent().port).toBe(9000);
+    // Give polling a cycle to settle on the missing path before creating it.
+    await waitMs(150);
+    writeFileSync(cfg, 'port: 9400\n', 'utf8');
+    await waitMs(SETTLE_MS * 2);
+    expect(store.getCurrent().port).toBe(9400);
+  });
+});
