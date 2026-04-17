// `ccmux status` behavior: no-PID, stale PID, live proxy.
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy, type StartedServer } from '../../src/cli/start.js';
import { runStatus } from '../../src/cli/status.js';
import type { CcmuxPaths } from '../../src/config/paths.js';

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

describe('cli status', () => {
  let tmp: string | undefined;
  let started: StartedServer | undefined;

  afterEach(async () => {
    if (started) await started.close();
    started = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('returns 1 with "not running" when no PID file exists', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
    const paths = makeTempPaths(tmp);
    const out = bufferStream();
    const err = bufferStream();
    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
    expect(code).toBe(1);
    expect(err.read()).toMatch(/not running/);
  });

  it('removes stale PID file when the referenced process is dead', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
    const paths = makeTempPaths(tmp);
    mkdirSync(paths.stateDir, { recursive: true });
    const deadPid = 999999; // improbable live PID
    writeFileSync(paths.pidFile, `${deadPid}\n12345\n`, 'utf8');
    const out = bufferStream();
    const err = bufferStream();
    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
    expect(code).toBe(1);
    expect(out.read()).toMatch(/stale PID file/);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('reports corrupt PID file without unlinking it', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
    const paths = makeTempPaths(tmp);
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.pidFile, 'not-a-number\nalso-not\n', 'utf8');
    const out = bufferStream();
    const err = bufferStream();
    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
    expect(code).toBe(1);
    expect(err.read()).toMatch(/PID file corrupt/);
    expect(existsSync(paths.pidFile)).toBe(true); // evidence preserved
  });

  it('prints pid/port/version/mode/uptime when proxy is live', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccmux-status-'));
    const paths = makeTempPaths(tmp);
    const startOut = bufferStream();
    started = await startProxy({ foreground: false, paths, stdout: startOut.stream });
    const out = bufferStream();
    const err = bufferStream();
    const code = await runStatus({ paths, stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const text = out.read();
    expect(text).toMatch(new RegExp(`pid\\s+${process.pid}`));
    expect(text).toMatch(new RegExp(`port\\s+${started.port}`));
    expect(text).toMatch(/version/);
    expect(text).toMatch(/mode\s+passthrough/);
    expect(text).toMatch(/uptimeMs\s+\d+/);
  });
});
