// `ccmux start [--foreground]` handler.
//
// Full daemonization is out of scope (plan §11 calls `ccmux start` a "debug
// sibling"). Both modes bind a single long-lived process and block on
// SIGINT/SIGTERM; non-foreground writes a PID file and removes it on shutdown.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config/loader.js';
import { resolvePaths, type CcmuxPaths } from '../config/paths.js';
import { createLogger } from '../logging/logger.js';
import { createProxyServer } from '../proxy/server.js';
import { listenWithFallback } from '../lifecycle/ports.js';

export interface StartOpts {
  readonly foreground: boolean;
  readonly configPath?: string;
  readonly paths?: CcmuxPaths;
  readonly stdout?: NodeJS.WritableStream;
}

export interface StartedServer {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly pidFile: string | null;
  close(): Promise<void>;
}

export async function startProxy(opts: StartOpts): Promise<StartedServer> {
  const paths = opts.paths ?? resolvePaths();
  const out = opts.stdout ?? process.stdout;
  const loaded = await loadConfig(opts.configPath);
  if (!loaded.ok) {
    const msgs = loaded.error.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`ccmux: invalid config: ${msgs}`);
  }
  const { config } = loaded.value;
  const logger = createLogger({ destination: 'stderr' });
  const app = await createProxyServer({ port: config.port, logger, config });
  const port = await listenWithFallback(app, '127.0.0.1', config.port, 20);
  out.write(`ccmux listening on http://127.0.0.1:${port}\n`);

  const pidFile = opts.foreground ? null : writePidFile(paths.pidFile, process.pid, port);
  const baseClose = async (): Promise<void> => {
    await app.close();
    if (pidFile !== null) safeUnlink(pidFile);
  };
  return { app, port, pidFile, close: baseClose };
}

export async function runStart(opts: StartOpts): Promise<number> {
  const server = await startProxy(opts);
  return new Promise<number>((resolve) => installShutdownHandlers(server, resolve));
}

export function installShutdownHandlers(
  server: StartedServer,
  resolve: (code: number) => void,
): void {
  const GRACE_MS = 5000;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardTimer = setTimeout(() => {
      process.stderr.write('ccmux: graceful shutdown exceeded 5s, forcing exit\n');
      process.exit(1);
    }, GRACE_MS);
    const finish = (code: number): void => {
      clearTimeout(hardTimer);
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolve(code);
    };
    server.close().then(() => finish(0), () => finish(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function writePidFile(pidFile: string, pid: number, port: number): string {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, `${pid}\n${port}\n`, { encoding: 'utf8', mode: 0o600 });
  return pidFile;
}

function safeUnlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Shutdown path — best-effort cleanup.
  }
}
