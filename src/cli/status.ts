// `ccmux status` handler. Reads the PID file, probes /healthz, prints a table.

import { readFileSync, rmSync } from 'node:fs';
import { request } from 'undici';
import { resolvePaths, type CcmuxPaths } from '../config/paths.js';

export interface StatusOpts {
  readonly paths?: CcmuxPaths;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly healthTimeoutMs?: number;
}

interface PidFileContents {
  readonly pid: number;
  readonly port: number;
}

interface HealthResponse {
  readonly version: string;
  readonly mode: string;
  readonly uptimeMs: number;
}

type PidReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'ok'; value: PidFileContents };

export async function runStatus(opts: StatusOpts = {}): Promise<number> {
  const paths = opts.paths ?? resolvePaths();
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const pidFile = paths.pidFile;
  const result = readPidFile(pidFile);
  if (result.kind === 'missing') { err.write('not running\n'); return 1; }
  if (result.kind === 'corrupt') {
    err.write(`PID file corrupt at ${pidFile}: ${result.reason}\n`);
    return 1;
  }
  const parsed = result.value;
  if (!isProcessAlive(parsed.pid)) {
    safeUnlink(pidFile);
    out.write(`stale PID file, removing (pid=${parsed.pid})\n`);
    return 1;
  }
  const health = await probeHealth(parsed.port, opts.healthTimeoutMs ?? 1000);
  if (health === null) {
    out.write(`pid=${parsed.pid} port=${parsed.port} status=pid-alive-health-unresponsive\n`);
    return 0;
  }
  out.write(formatStatus(parsed, health));
  return 0;
}

function readPidFile(pidFile: string): PidReadResult {
  let contents: string;
  try { contents = readFileSync(pidFile, 'utf8'); }
  catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', reason: (err as Error).message };
  }
  const [pidLine, portLine] = contents.split('\n');
  const pid = Number.parseInt((pidLine ?? '').trim(), 10);
  const port = Number.parseInt((portLine ?? '').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'corrupt', reason: 'pid line not a positive integer' };
  if (!Number.isInteger(port) || port <= 0) return { kind: 'corrupt', reason: 'port line not a positive integer' };
  return { kind: 'ok', value: { pid, port } };
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

async function probeHealth(port: number, timeoutMs: number): Promise<HealthResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(`http://127.0.0.1:${port}/healthz`, {
      method: 'GET',
      signal: ctrl.signal,
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.json() as HealthResponse;
    return body;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function formatStatus(pidInfo: PidFileContents, health: HealthResponse): string {
  return (
    `pid       ${pidInfo.pid}\n` +
    `port      ${pidInfo.port}\n` +
    `version   ${health.version}\n` +
    `mode      ${health.mode}\n` +
    `uptimeMs  ${health.uptimeMs}\n`
  );
}

function safeUnlink(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* best-effort */ }
}
