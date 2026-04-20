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

interface ReloadState {
  stopped: boolean;
  debounceTimer: NodeJS.Timeout | null;
  reloadInFlight: boolean;
  reloadPending: boolean;
}

function createFsWatcher(configPath: string): FSWatcher {
  return chokidar.watch(configPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    usePolling: true,
    interval: 50,
  });
}

function createReloadRunner(
  configPath: string,
  state: ReloadState,
  getCurrent: () => CcmuxConfig,
  setCurrent: (c: CcmuxConfig) => void,
  logger: Logger,
  opts: WatcherOpts,
): () => Promise<void> {
  const runReload = async (): Promise<void> => {
    if (state.stopped) return;
    if (state.reloadInFlight) {
      state.reloadPending = true;
      return;
    }
    state.reloadInFlight = true;
    try {
      const result = await loadConfig(configPath);
      if (state.stopped) return;
      if (!result.ok) {
        const msg = result.error.map((e) => `${e.path}: ${e.message}`).join('; ');
        logger.warn({ errors: result.error }, `config reload rejected: ${msg}`);
        return;
      }
      setCurrent(result.value.config);
      logger.info({ warnings: result.value.warnings.length }, 'config reloaded');
      opts.onReload?.(getCurrent());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, `config reload failed: ${msg}`);
    } finally {
      state.reloadInFlight = false;
      if (state.reloadPending && !state.stopped) {
        state.reloadPending = false;
        void runReload();
      }
    }
  };
  return runReload;
}

function buildWatcherHandle(
  watcher: FSWatcher,
  state: ReloadState,
): WatcherHandle {
  let resolveReady!: () => void;
  const whenReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
    watcher.once('ready', resolve);
  });

  return {
    whenReady,
    stop: async () => {
      state.stopped = true;
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
      resolveReady();
      await watcher.close();
    },
  };
}

export function startConfigWatcher(
  configPath: string,
  initial: CcmuxConfig,
  logger: Logger,
  opts: WatcherOpts = {},
): { store: ConfigStore; handle: WatcherHandle } {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let current: CcmuxConfig = initial;
  const store: ConfigStore = { getCurrent: () => current };

  const state: ReloadState = {
    stopped: false,
    debounceTimer: null,
    reloadInFlight: false,
    reloadPending: false,
  };

  const watcher = createFsWatcher(configPath);

  const runReload = createReloadRunner(
    configPath,
    state,
    () => current,
    (c) => { current = c; },
    logger,
    opts,
  );

  const scheduleReload = (): void => {
    if (state.stopped) return;
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void runReload();
    }, debounceMs);
  };

  watcher.on('add', scheduleReload);
  watcher.on('change', scheduleReload);
  watcher.on('error', (err) => {
    logger.warn({ err }, 'config watcher error');
  });

  const handle = buildWatcherHandle(watcher, state);

  return { store, handle };
}
