// commander router: version, help, unknown command.
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { run } from '../../src/cli/main.js';
import { VERSION, NAME } from '../../src/cli/version.js';

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

describe('cli main', () => {
  it('ccmux version prints the version and returns 0', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['version'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    expect(out.read()).toBe(`${NAME} ${VERSION}\n`);
  });

  it('--help lists all three subcommands', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['--help'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const combined = out.read() + err.read();
    expect(combined).toMatch(/\bstart\b/);
    expect(combined).toMatch(/\bstatus\b/);
    expect(combined).toMatch(/\bversion\b/);
  });

  it('unknown subcommand returns non-zero and writes to stderr', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['unknown-command-xyz'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(1);
    expect(err.read().length).toBeGreaterThan(0);
  });
});
