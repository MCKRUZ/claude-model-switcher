// version subcommand prints `ccmux <semver>` matching package.json.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { NAME, VERSION, runVersion } from '../../src/cli/version.js';

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

function readManifestVersion(): string {
  const raw = readFileSync(join(repoRoot(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function bufferStream(): { stream: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, chunks };
}

describe('cli version', () => {
  it('module constants match package.json', () => {
    expect(NAME).toBe('ccmux');
    expect(VERSION).toBe(readManifestVersion());
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runVersion prints "ccmux <version>\\n" and returns 0', () => {
    const { stream, chunks } = bufferStream();
    const code = runVersion(stream);
    const out = Buffer.concat(chunks).toString('utf8');
    expect(code).toBe(0);
    expect(out).toBe(`${NAME} ${VERSION}\n`);
  });
});
