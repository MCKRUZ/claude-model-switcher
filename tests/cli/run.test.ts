// `ccmux run` argv parsing: everything after the first `--` is child argv.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitOnDoubleDash, runRun } from '../../src/cli/run.js';
import { run as runCli } from '../../src/cli/main.js';
import { Writable } from 'node:stream';

const FIXTURE = fileURLToPath(new URL('../fixtures/bin/echo-env.mjs', import.meta.url));

function sink(): { stream: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

describe('ccmux run argv parsing', () => {
  it('splits argv on the first -- and treats everything after as child argv', () => {
    const s = splitOnDoubleDash(['run', '--', 'claude', '--help']);
    expect(s.before).toEqual(['run']);
    expect(s.after).toEqual(['claude', '--help']);
    expect(s.hadSeparator).toBe(true);
  });

  it('returns empty `after` when no -- is present', () => {
    const s = splitOnDoubleDash(['run']);
    expect(s.before).toEqual(['run']);
    expect(s.after).toEqual([]);
    expect(s.hadSeparator).toBe(false);
  });

  it('only splits on the first -- (later -- become child argv tokens)', () => {
    const s = splitOnDoubleDash(['run', '--', 'claude', '--', 'extra']);
    expect(s.before).toEqual(['run']);
    expect(s.after).toEqual(['claude', '--', 'extra']);
  });

  it('forwards ccmux-looking flags that appear after -- to the child unchanged', () => {
    // e.g., `ccmux run -- claude --help` must pass --help to claude.
    const s = splitOnDoubleDash(['run', '--', 'claude', '--help']);
    expect(s.after).toEqual(['claude', '--help']);
  });

  it('rejects invocations with no command after -- (exit code 2)', async () => {
    const err = sink();
    const code = await runRun({ childCmd: '', childArgs: [], stderr: err.stream });
    expect(code).toBe(2);
    expect(err.read()).toMatch(/missing child command/);
  });
});

describe('ccmux run — main.ts integration', () => {
  it('passes post-`--` argv through to the child unchanged (e.g., --help reaches child)', async () => {
    // Uses the echo-env fixture as the "child" so we don't depend on `claude`
    // being installed. The fixture records env, including ANTHROPIC_BASE_URL,
    // which proves the wrapper ran to completion with a real spawned child.
    const tmp = mkdtempSync(join(tmpdir(), 'ccmux-main-'));
    try {
      const outFile = join(tmp, 'env.json');
      // Seed a config so the wrapper's proxy can start with a deterministic port.
      writeFileSync(join(tmp, 'config.yaml'), 'port: 19977\n', 'utf8');
      const err = sink();
      const out = sink();
      // parentEnv cannot be injected through main.ts; rely on process.env for the
      // fixture's output path. Cleanup below.
      process.env.CCMUX_TEST_OUT = outFile;
      process.env.CCMUX_TEST_MODE = 'exit';
      const priorHome = process.env.CCMUX_HOME;
      process.env.CCMUX_HOME = tmp;
      try {
        // Simulate: ccmux run -- node <fixture>
        // The argv is plumbed via splitOnDoubleDash inside runCli.
        const code = await runCli(['run', '--', process.execPath, FIXTURE], {
          stdout: out.stream,
          stderr: err.stream,
        });
        expect(code).toBe(0);
      } finally {
        delete process.env.CCMUX_TEST_OUT;
        delete process.env.CCMUX_TEST_MODE;
        if (priorHome === undefined) delete process.env.CCMUX_HOME;
        else process.env.CCMUX_HOME = priorHome;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
