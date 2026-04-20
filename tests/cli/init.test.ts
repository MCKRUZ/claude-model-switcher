import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { run } from '../../src/cli/main.js';

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

describe('ccmux init', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-init-'));
    originalEnv = process.env['CCMUX_HOME'];
    process.env['CCMUX_HOME'] = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['CCMUX_HOME'];
    } else {
      process.env['CCMUX_HOME'] = originalEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write balanced recipe by default to the resolved config path', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const configPath = join(tmpDir, 'config.yaml');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toMatch(/Recipe: balanced/);
    expect(out.read()).toContain(configPath);
  });

  it('should write the named recipe when --recipe is passed', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init', '--recipe', 'frugal'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
    expect(content).toMatch(/Recipe: frugal/);
  });

  it('should exit non-zero with a helpful message on an unknown recipe name', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init', '--recipe', 'nonexistent'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(2);
    const stderr = err.read();
    expect(stderr).toMatch(/frugal/);
    expect(stderr).toMatch(/balanced/);
    expect(stderr).toMatch(/opus-forward/);
  });

  it('should refuse to overwrite an existing config without --force', async () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'existing: true\n');
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(1);
    const stderr = err.read();
    expect(stderr).toMatch(/--force/);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
    expect(content).toBe('existing: true\n');
  });

  it('should overwrite when --force is passed', async () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'existing: true\n');
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init', '--force'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
    expect(content).toMatch(/Recipe: balanced/);
  });

  it('should create the target directory if missing', async () => {
    const nested = join(tmpDir, 'sub', 'dir');
    process.env['CCMUX_HOME'] = nested;
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    expect(existsSync(join(nested, 'config.yaml'))).toBe(true);
  });

  it('should produce output that the config loader parses without errors', async () => {
    const out = bufferStream();
    const err = bufferStream();
    await run(['init'], { stdout: out.stream, stderr: err.stream });
    const { loadConfig } = await import('../../src/config/loader.js');
    const result = await loadConfig(join(tmpDir, 'config.yaml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toHaveLength(0);
    }
  });

  it('should write opus-forward recipe when requested', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['init', '--recipe', 'opus-forward'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(0);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf8');
    expect(content).toMatch(/Recipe: opus-forward/);
  });
});
