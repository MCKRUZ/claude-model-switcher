// `ccmux start` foreground behavior: bind 127.0.0.1, /healthz 200, no-token bypass, PID file.
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startProxy, installShutdownHandlers, type StartedServer } from '../../src/cli/start.js';
import type { CcmuxPaths } from '../../src/config/paths.js';

const IS_POSIX = process.platform !== 'win32';

function bufferStream(): { stream: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

function makeTempPaths(root: string): CcmuxPaths {
  return {
    configDir: root,
    configFile: join(root, 'config.yaml'),
    logDir: join(root, 'logs'),
    decisionLogDir: join(root, 'logs', 'decisions'),
    stateDir: join(root, 'state'),
    pidFile: join(root, 'state', 'ccmux.pid'),
  };
}

describe('cli start (foreground)', () => {
  let started: StartedServer | undefined;
  let tmp: string | undefined;

  afterEach(async () => {
    if (started) await started.close();
    started = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    delete process.env.CCMUX_PROXY_TOKEN;
  });

  it('binds to 127.0.0.1 and responds 200 on /healthz', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    const out = bufferStream();
    started = await startProxy({ foreground: true, paths: makeTempPaths(tmp), stdout: out.stream });
    const addr = started.app.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    const resp = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(resp.status).toBe(200);
    expect(out.read()).toMatch(/^ccmux listening on http:\/\/127\.0\.0\.1:\d+\n$/);
  });

  it('does not write PID file in foreground mode', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    const paths = makeTempPaths(tmp);
    const out = bufferStream();
    started = await startProxy({ foreground: true, paths, stdout: out.stream });
    expect(started.pidFile).toBeNull();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('writes PID file (pid, port) when not foreground and removes it on close', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    const paths = makeTempPaths(tmp);
    const out = bufferStream();
    started = await startProxy({ foreground: false, paths, stdout: out.stream });
    expect(started.pidFile).toBe(paths.pidFile);
    const contents = readFileSync(paths.pidFile, 'utf8');
    const lines = contents.split('\n');
    expect(Number.parseInt(lines[0]!, 10)).toBe(process.pid);
    expect(Number.parseInt(lines[1]!, 10)).toBe(started.port);
    await started.close();
    started = undefined;
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it.skipIf(!IS_POSIX)('writes PID file with mode 0o600 and parent dir 0o700', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    const paths = makeTempPaths(tmp);
    const out = bufferStream();
    started = await startProxy({ foreground: false, paths, stdout: out.stream });
    const fileMode = statSync(paths.pidFile).mode & 0o777;
    const dirMode = statSync(dirname(paths.pidFile)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('installShutdownHandlers removes SIGINT/SIGTERM listeners on graceful close', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    const out = bufferStream();
    started = await startProxy({ foreground: true, paths: makeTempPaths(tmp), stdout: out.stream });
    const intBefore = process.listenerCount('SIGINT');
    const termBefore = process.listenerCount('SIGTERM');
    const exitPromise = new Promise<number>((resolve) => installShutdownHandlers(started!, resolve));
    expect(process.listenerCount('SIGINT')).toBe(intBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1);
    // Drive shutdown by emitting SIGINT in-process. Handler was installed via
    // process.once, so it fires, closes the server, and removes both listeners.
    process.emit('SIGINT');
    const code = await exitPromise;
    expect(code).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    // /healthz should stop answering because app.close() ran.
    await expect(fetch(`http://127.0.0.1:${started.port}/healthz`)).rejects.toThrow();
    started = undefined; // already closed
  });

  it('requests without x-ccmux-token succeed when CCMUX_PROXY_TOKEN is unset (bypass-on-unset)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-start-'));
    delete process.env.CCMUX_PROXY_TOKEN;
    const out = bufferStream();
    started = await startProxy({ foreground: true, paths: makeTempPaths(tmp), stdout: out.stream });
    const resp = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(resp.status).toBe(200);
  });
});
