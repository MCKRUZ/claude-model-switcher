// `ccmux run` wrapper contract (section-10):
// child env, signal forwarding, exit code propagation, ENOENT, token redaction.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CcmuxPaths } from '../../src/config/paths.js';
import { runWrapper, buildChildEnv, exitCodeFor } from '../../src/lifecycle/wrapper.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/bin/echo-env.mjs', import.meta.url));

function tempPaths(root: string): CcmuxPaths {
  return {
    configDir: root,
    configFile: join(root, 'config.yaml'),
    logDir: join(root, 'logs'),
    decisionLogDir: join(root, 'logs', 'decisions'),
    stateDir: join(root, 'state'),
    pidFile: join(root, 'state', 'ccmux.pid'),
  };
}

function writeConfig(path: string, port: number): void {
  writeFileSync(path, `port: ${port}\n`, 'utf8');
}

function readSnapshot(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

// Deterministic, per-test port selection so parallel Vitest workers do not
// grab the same port and produce order-dependent assertions.
let __portCounter = 0;
function nextPort(): number {
  __portCounter += 1;
  const workerId = Number(process.env.VITEST_POOL_ID ?? '1');
  return 19000 + workerId * 100 + __portCounter;
}

let tmp: string;
let outFile: string;
let logDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccmux-wrap-'));
  outFile = join(tmp, 'env.json');
  logDir = join(tmp, 'logs');
  writeConfig(join(tmp, 'config.yaml'), nextPort());
  delete process.env.CCMUX_TEST_OUT;
  delete process.env.CCMUX_TEST_MODE;
  delete process.env.CCMUX_TEST_CODE;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ccmux run wrapper — child env', () => {
  it('sets ANTHROPIC_BASE_URL to the bound proxy port in child env', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
    const res = await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    expect(res.exitCode).toBe(0);
    const snap = readSnapshot(outFile);
    expect(snap.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('preserves ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from parent env', async () => {
    const parentEnv = {
      ...process.env,
      CCMUX_TEST_OUT: outFile,
      CCMUX_TEST_MODE: 'exit',
      ANTHROPIC_API_KEY: 'sk-test-api',
      ANTHROPIC_AUTH_TOKEN: 'auth-test',
      CLAUDE_CONFIG_DIR: '/tmp/claude-fake',
    };
    await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    const snap = readSnapshot(outFile);
    expect(snap.ANTHROPIC_API_KEY).toBe('sk-test-api');
    expect(snap.ANTHROPIC_AUTH_TOKEN).toBe('auth-test');
    expect(snap.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-fake');
  });

  it('sets NO_PROXY / no_proxy / NOPROXY to include 127.0.0.1 and localhost', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
    await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    const snap = readSnapshot(outFile);
    for (const key of ['NO_PROXY', 'no_proxy', 'NOPROXY']) {
      expect(snap[key]).toContain('127.0.0.1');
      expect(snap[key]).toContain('localhost');
    }
  });

  it('generates and injects CCMUX_PROXY_TOKEN into child env (128 bits, hex)', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
    await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    const snap = readSnapshot(outFile);
    expect(snap.CCMUX_PROXY_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it('buildChildEnv uses the actually-bound port, not the requested port', () => {
    const env = buildChildEnv({ FOO: 'bar' } as NodeJS.ProcessEnv, 18999, 'deadbeef');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18999');
    expect(env.FOO).toBe('bar');
  });
});

describe('ccmux run wrapper — signals and exit codes', () => {
  it('propagates non-zero child exit code to wrapper exit code', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit', CCMUX_TEST_CODE: '7' };
    const res = await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    expect(res.exitCode).toBe(7);
  });

  it.skipIf(process.platform === 'win32')(
    'forwards SIGINT to the child, tears down proxy, and exits with child code',
    async () => {
      const signalSource = new EventEmitter();
      const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'loop' };
      // Kick off the wrapper.
      const resultPromise = runWrapper({
        childCmd: process.execPath,
        childArgs: [FIXTURE],
        paths: tempPaths(tmp),
        parentEnv,
        signalSource,
        logDir,
      });
      // Wait briefly for child to start, then emit SIGINT on the injected source.
      await new Promise((r) => setTimeout(r, 250));
      signalSource.emit('SIGINT', 'SIGINT');
      const res = await resultPromise;
      // Fixture traps SIGINT and exits 130.
      expect(res.exitCode).toBe(130);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'forwards SIGTERM to the child, tears down proxy, and exits with child code',
    async () => {
      const signalSource = new EventEmitter();
      const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'loop' };
      const resultPromise = runWrapper({
        childCmd: process.execPath,
        childArgs: [FIXTURE],
        paths: tempPaths(tmp),
        parentEnv,
        signalSource,
        logDir,
      });
      await new Promise((r) => setTimeout(r, 250));
      signalSource.emit('SIGTERM', 'SIGTERM');
      const res = await resultPromise;
      expect(res.exitCode).toBe(143);
    },
  );

  it('exits 127 when child command is not found (ENOENT)', async () => {
    const res = await runWrapper({
      childCmd: '/definitely/not/a/real/binary-ccmux-enoent',
      childArgs: [],
      paths: tempPaths(tmp),
      parentEnv: process.env,
      installSignalHandlers: false,
      logDir,
    });
    expect(res.exitCode).toBe(127);
  });

  it('when configured port is busy, uses the next free port and injects it into child env', async () => {
    // Seed config with a likely-free port; then hold it by starting one wrapper, and
    // concurrently starting another that should fall back.
    const configPath = join(tmp, 'config.yaml');
    const port = nextPort();
    writeFileSync(configPath, `port: ${port}\n`, 'utf8');

    const firstOut = join(tmp, 'env1.json');
    const secondOut = join(tmp, 'env2.json');

    const firstEnv = { ...process.env, CCMUX_TEST_OUT: firstOut, CCMUX_TEST_MODE: 'sleep:500' };
    const secondEnv = { ...process.env, CCMUX_TEST_OUT: secondOut, CCMUX_TEST_MODE: 'exit' };

    const first = runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv: firstEnv,
      installSignalHandlers: false,
      logDir,
    });
    // Give the first wrapper time to bind the port before starting the second.
    await new Promise((r) => setTimeout(r, 150));
    const second = runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv: secondEnv,
      installSignalHandlers: false,
      logDir,
    });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    const s1 = readSnapshot(firstOut);
    const s2 = readSnapshot(secondOut);
    const p1 = extractPort(s1.ANTHROPIC_BASE_URL ?? '');
    const p2 = extractPort(s2.ANTHROPIC_BASE_URL ?? '');
    expect(p1).toBe(port);
    expect(p2).toBeGreaterThan(port);
  });
});

describe('ccmux run wrapper — proxy coordination', () => {
  it('waits for /healthz before spawning the child', async () => {
    // When the wrapper returns and the child has already exited, /healthz should
    // have been reachable at least once during the run. We assert indirectly by
    // requiring a successful exit and a valid BASE_URL — if healthz never
    // returned 200, runWrapper would throw before spawning.
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
    const res = await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      healthzTimeoutMs: 2000,
      logDir,
    });
    expect(res.exitCode).toBe(0);
    const snap = readSnapshot(outFile);
    expect(snap.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('never writes the proxy token to any log line (redaction check)', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'exit' };
    await runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      installSignalHandlers: false,
      logDir,
    });
    const snap = readSnapshot(outFile);
    const token = snap.CCMUX_PROXY_TOKEN;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Give pino a tick to flush to disk.
    await new Promise((r) => setTimeout(r, 100));
    const logPath = join(logDir, 'ccmux.log');
    expect(existsSync(logPath)).toBe(true);
    const logContents = readFileSync(logPath, 'utf8');
    expect(logContents).not.toContain(token);
  });
});

describe('ccmux run wrapper — exitCodeFor', () => {
  it('returns the exit code when provided', () => {
    expect(exitCodeFor(42, null)).toBe(42);
    expect(exitCodeFor(0, null)).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'maps POSIX signal names to 128 + signum',
    () => {
      // SIGINT = 2, SIGTERM = 15 on POSIX.
      expect(exitCodeFor(null, 'SIGINT')).toBe(130);
      expect(exitCodeFor(null, 'SIGTERM')).toBe(143);
    },
  );

  it('returns 0 when neither code nor signal is present', () => {
    expect(exitCodeFor(null, null)).toBe(0);
  });
});

describe('ccmux run wrapper — default signal source', () => {
  it('installs SIGINT/SIGTERM listeners on process when no signalSource is provided', async () => {
    const parentEnv = { ...process.env, CCMUX_TEST_OUT: outFile, CCMUX_TEST_MODE: 'sleep:400' };
    const intBefore = process.listenerCount('SIGINT');
    const termBefore = process.listenerCount('SIGTERM');
    const p = runWrapper({
      childCmd: process.execPath,
      childArgs: [FIXTURE],
      paths: tempPaths(tmp),
      parentEnv,
      logDir,
      // installSignalHandlers defaults to true; no signalSource injected -> process
    });
    // Let the wrapper install handlers and spawn.
    await new Promise((r) => setTimeout(r, 120));
    expect(process.listenerCount('SIGINT')).toBe(intBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1);
    const res = await p;
    expect(res.exitCode).toBe(0);
    // Handlers must be cleaned up.
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
  });
});

function extractPort(url: string): number {
  const m = url.match(/:(\d+)$/);
  return m ? Number.parseInt(m[1]!, 10) : -1;
}
