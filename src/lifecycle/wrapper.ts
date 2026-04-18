// `ccmux run -- <cmd>` orchestrator: owns the proxy lifecycle, spawns the
// child, forwards signals, tears down, and propagates exit code.
//
// See planning/sections/section-10-wrapper.md for the full contract.

import { spawn as childSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { loadConfig } from '../config/loader.js';
import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
import { startConfigWatcher, type WatcherHandle } from '../config/watcher.js';
import { createLogger } from '../logging/logger.js';
import { createProxyServer } from '../proxy/server.js';
import { listenWithFallback } from './ports.js';
import { generateProxyToken } from './token.js';

export interface WrapperOptions {
  readonly childCmd: string;
  readonly childArgs: readonly string[];
  readonly configPath?: string;
  readonly paths?: CcmuxPaths;
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly healthzTimeoutMs?: number;
  readonly logDir?: string;
  readonly signalSource?: NodeJS.EventEmitter;
  readonly stdio?: 'inherit' | 'pipe' | 'ignore';
  readonly installSignalHandlers?: boolean;
}

export interface WrapperResult {
  readonly exitCode: number;
}

interface ProxyHandle {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly watcher: WatcherHandle;
  readonly logger: Logger;
}

const DEFAULT_HEALTHZ_TIMEOUT_MS = 5000;
const HEALTHZ_POLL_MS = 50;
const ENOENT_EXIT_CODE = 127;

export async function runWrapper(opts: WrapperOptions): Promise<WrapperResult> {
  const parentEnv = opts.parentEnv ?? process.env;
  const token = generateProxyToken();
  const proxy = await startWrapperProxy(opts, token);
  try {
    await waitForHealthz(proxy.port, opts.healthzTimeoutMs ?? DEFAULT_HEALTHZ_TIMEOUT_MS);
    const childEnv = buildChildEnv(parentEnv, proxy.port, token);
    return await runChildLifecycle(opts, childEnv, proxy);
  } finally {
    await teardownProxy(proxy);
  }
}

async function startWrapperProxy(opts: WrapperOptions, token: string): Promise<ProxyHandle> {
  const paths = opts.paths ?? resolvePaths();
  const configPath = opts.configPath ?? paths.configFile;
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    const msgs = loaded.error.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`ccmux run: invalid config: ${msgs}`);
  }
  const { config } = loaded.value;
  if (opts.logDir) mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
  const logger = createLogger(
    opts.logDir ? { destination: 'file', logDir: opts.logDir } : { destination: 'stderr' },
  );
  const { store, handle: watcher } = startConfigWatcher(configPath, config, logger);
  // The proxy is not token-gated: Claude Code has no outbound-header knob, so
  // enforcement would break the happy path. The token is injected into the
  // child env only (defense-in-depth per plan §6.8); the proxy's 127.0.0.1-only
  // bind is the real containment boundary.
  const app = await createProxyServer({
    port: config.port,
    logger,
    config,
    configStore: store,
  });
  const port = await listenWithFallback(app, '127.0.0.1', config.port, 20);
  return { app, port, watcher, logger };
}

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  port: number,
  token: string,
): NodeJS.ProcessEnv {
  const baseUrl = `http://127.0.0.1:${port}`;
  const noProxy = '127.0.0.1,localhost';
  // Redirect Claude Code to the local proxy and prevent any outbound proxy
  // env from intercepting 127.0.0.1 traffic. ANTHROPIC_API_KEY /
  // ANTHROPIC_AUTH_TOKEN / CLAUDE_CONFIG_DIR flow through unchanged via the
  // spread (tests in tests/lifecycle/wrapper.test.ts assert on them).
  return {
    ...parentEnv,
    ANTHROPIC_BASE_URL: baseUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NOPROXY: noProxy,
    CCMUX_PROXY_TOKEN: token,
  };
}

// Fastify's `listen()` only resolves after the socket is accepting, so in
// practice /healthz is already live by the time we get here. We still poll to
// cover async route-init edge cases and to surface a clear error if the
// proxy gets into a degraded state before spawn.
async function waitForHealthz(port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.status === 200) return;
    } catch (err: unknown) {
      lastError = err;
    }
    await sleep(HEALTHZ_POLL_MS);
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`ccmux run: /healthz did not respond 200 within ${timeoutMs}ms${reason}`);
}

async function runChildLifecycle(
  opts: WrapperOptions,
  childEnv: NodeJS.ProcessEnv,
  proxy: ProxyHandle,
): Promise<WrapperResult> {
  const child = childSpawn(opts.childCmd, [...opts.childArgs], {
    env: childEnv,
    stdio: opts.stdio ?? 'inherit',
    shell: false,
    windowsHide: true,
  });
  const forwardSignals = opts.installSignalHandlers !== false;
  const signalSource = opts.signalSource ?? process;
  const uninstall = forwardSignals ? installSignalForwarding(child, signalSource) : noop;
  try {
    return await awaitChildExit(child, proxy.logger);
  } finally {
    uninstall();
  }
}

// Never rejects — any spawn error is mapped to an exit code. The outer
// `finally` in runWrapper relies on this to guarantee proxy teardown.
function awaitChildExit(child: ChildProcess, logger: Logger): Promise<WrapperResult> {
  return new Promise<WrapperResult>((resolve) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code });
    };
    child.once('error', (err: NodeJS.ErrnoException) => {
      logger.error({ err, code: err.code }, 'ccmux run: failed to spawn child');
      settle(err.code === 'ENOENT' ? ENOENT_EXIT_CODE : 1);
    });
    child.once('exit', (code, signal) => {
      settle(exitCodeFor(code, signal));
    });
  });
}

export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal) {
    if (process.platform === 'win32') return 1;
    const num = osConstants.signals[signal];
    return typeof num === 'number' ? 128 + num : 1;
  }
  return 0;
}

type SignalHandler = (sig: NodeJS.Signals) => void;

function installSignalForwarding(
  child: ChildProcess,
  source: NodeJS.EventEmitter,
): () => void {
  const makeHandler = (sig: NodeJS.Signals): SignalHandler => () => {
    try {
      child.kill(sig);
    } catch {
      // Best-effort — child may already have exited.
    }
  };
  const sigint = makeHandler('SIGINT');
  const sigterm = makeHandler('SIGTERM');
  source.on('SIGINT', sigint);
  source.on('SIGTERM', sigterm);
  return () => {
    source.off('SIGINT', sigint);
    source.off('SIGTERM', sigterm);
  };
}

async function teardownProxy(proxy: ProxyHandle): Promise<void> {
  try {
    await proxy.watcher.stop();
  } catch {
    // best-effort
  }
  try {
    await proxy.app.close();
  } catch {
    // best-effort
  }
  try {
    proxy.logger.flush?.();
  } catch {
    // pino flush is best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noop(): void {
  // intentionally empty
}
