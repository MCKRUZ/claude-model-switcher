// Hot-reload watcher: chokidar + 500ms debounce; atomic-swap of the in-memory
// config reference. On parse/validate failure the previous config is retained
// and a warn-level log entry is emitted.

import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import { loadConfig } from './loader.js';
import type { CcmuxConfig } from './schema.js';

export interface ConfigStore {
  getCurrent(): CcmuxConfig;
}

export interface WatcherHandle {
  stop(): Promise<void>;
  readonly whenReady: Promise<void>;
}

export interface WatcherOpts {
  readonly debounceMs?: number;
  readonly onReload?: (next: CcmuxConfig) => void;
}

const DEFAULT_DEBOUNCE_MS = 500;

export function startConfigWatcher(
  configPath: string,
  initial: CcmuxConfig,
  logger: Logger,
  opts: WatcherOpts = {},
): { store: ConfigStore; handle: WatcherHandle } {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let current: CcmuxConfig = initial;
  const store: ConfigStore = { getCurrent: () => current };

  let debounceTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let reloadInFlight = false;
  let reloadPending = false;

  const watcher: FSWatcher = chokidar.watch(configPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    usePolling: true,
    interval: 50,
  });

  const scheduleReload = (): void => {
    if (stopped) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runReload();
    }, debounceMs);
  };

  const runReload = async (): Promise<void> => {
    if (stopped) return;
    if (reloadInFlight) {
      // Single-flight: coalesce into a follow-up run so completion-order never inverts.
      reloadPending = true;
      return;
    }
    reloadInFlight = true;
    try {
      const result = await loadConfig(configPath);
      if (stopped) return;
      if (!result.ok) {
        const msg = result.error.map((e) => `${e.path}: ${e.message}`).join('; ');
        logger.warn({ errors: result.error }, `config reload rejected: ${msg}`);
        return;
      }
      current = result.value.config;
      logger.info({ warnings: result.value.warnings.length }, 'config reloaded');
      opts.onReload?.(current);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, `config reload failed: ${msg}`);
    } finally {
      reloadInFlight = false;
      if (reloadPending && !stopped) {
        reloadPending = false;
        void runReload();
      }
    }
  };

  watcher.on('add', scheduleReload);
  watcher.on('change', scheduleReload);
  watcher.on('error', (err) => {
    logger.warn({ err }, 'config watcher error');
  });

  let resolveReady: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
    watcher.once('ready', () => resolve());
  });

  const handle: WatcherHandle = {
    whenReady,
    stop: async () => {
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      resolveReady(); // unblock any awaiters that never saw `ready`
      await watcher.close();
    },
  };

  return { store, handle };
}
