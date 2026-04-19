import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const FIXTURES = join(
  import.meta.dirname ?? '',
  '..',
  'fixtures',
  'explain',
);

function configWithRule(tmpDir: string): string {
  const configPath = join(tmpDir, 'config.yaml');
  writeFileSync(configPath, [
    'port: 7879',
    'mode: live',
    'rules:',
    '  - id: tools-to-opus',
    '    when:',
    '      toolUseCount: { gte: 2 }',
    '    then: { choice: opus }',
    '  - id: tiny-to-haiku',
    '    when:',
    '      all:',
    '        - { messageCount: { lt: 3 } }',
    '        - { toolUseCount: { eq: 0 } }',
    '        - { estInputTokens: { lt: 500 } }',
    '    then: { choice: haiku }',
  ].join('\n'));
  return configPath;
}

function emptyRulesConfig(tmpDir: string): string {
  const configPath = join(tmpDir, 'no-rules.yaml');
  writeFileSync(configPath, 'port: 7879\nmode: live\nrules: []\n');
  return configPath;
}

describe('ccmux explain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-explain-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should print the winning rule id for a matching fixture', async () => {
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(
      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(code).toBe(0);
    const output = out.read();
    expect(output).toContain('tools-to-opus');
    expect(output).toContain('opus');
  });

  it('should print abstain when no rule matches', async () => {
    const configPath = emptyRulesConfig(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(
      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(code).toBe(0);
    const output = out.read();
    expect(output).toContain('abstain');
  });

  it('should render extracted signals in a stable table', async () => {
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    await run(
      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    const output = out.read();
    expect(output).toContain('plan_mode');
    expect(output).toContain('message_count');
    expect(output).toContain('tool_count');
    expect(output).toContain('token_estimate');
    expect(output).toContain('Signals');
    expect(output).toContain('Policy');

    const out2 = bufferStream();
    const err2 = bufferStream();
    await run(
      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
      { stdout: out2.stream, stderr: err2.stream },
    );
    const normalize = (s: string) => s.replace(/session_duration_ms\s+\d+/, 'session_duration_ms 0');
    expect(normalize(out2.read())).toBe(normalize(output));
  });

  it('should exit non-zero when the request JSON is malformed', async () => {
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(
      ['explain', join(FIXTURES, 'malformed.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(code).toBe(1);
    expect(err.read()).toContain('Invalid JSON');
  });

  it('should exit non-zero when the request file does not exist', async () => {
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(
      ['explain', join(tmpDir, 'nonexistent.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(code).toBe(1);
    expect(err.read()).toContain('Cannot read');
  });

  it('should never perform network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    await run(
      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('should honor --classifier by showing heuristic result on abstain', async () => {
    const configPath = emptyRulesConfig(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(
      ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath, '--classifier'],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(code).toBe(0);
    const output = out.read();
    expect(output).toContain('heuristic');
    expect(output).toContain('via classifier');
  });

  it('should not write to the decision log', async () => {
    const logDir = join(tmpDir, 'logs', 'decisions');
    mkdirSync(logDir, { recursive: true });
    const savedHome = process.env['CCMUX_HOME'];
    process.env['CCMUX_HOME'] = tmpDir;
    try {
      const configPath = configWithRule(tmpDir);
      const out = bufferStream();
      const err = bufferStream();
      await run(
        ['explain', join(FIXTURES, 'valid-with-tools.json'), '--config', configPath],
        { stdout: out.stream, stderr: err.stream },
      );
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(logDir)).toHaveLength(0);
    } finally {
      if (savedHome === undefined) delete process.env['CCMUX_HOME'];
      else process.env['CCMUX_HOME'] = savedHome;
    }
  });

  it('should show "(not requested)" for classifier when flag is omitted', async () => {
    const configPath = configWithRule(tmpDir);
    const out = bufferStream();
    const err = bufferStream();
    await run(
      ['explain', join(FIXTURES, 'valid-minimal.json'), '--config', configPath],
      { stdout: out.stream, stderr: err.stream },
    );
    expect(out.read()).toContain('(not requested)');
  });
});
