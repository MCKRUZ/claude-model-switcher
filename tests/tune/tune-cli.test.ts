import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runTune } from '../../src/cli/tune.js';
import { mkDecision, mkLogDir } from './helpers.js';

const FIXTURE = join(__dirname, 'fixtures', 'config.yaml');

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

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runTune', () => {
  it('emits unified diff to stdout without modifying config.yaml', async () => {
    const decisions = [];
    for (let i = 0; i < 100; i += 1) {
      decisions.push(mkDecision({
        request_hash: `h${i}`,
        session_id: `s${i}`,
        policy_result: { rule_id: 'trivial-to-haiku' },
        forwarded_model: 'claude-haiku-4-5-20251001',
      }));
    }
    const outcomes = decisions.slice(0, 80).map((d) => ({ requestHash: d.request_hash, tag: 'frustration_next_turn' as const }));
    const dir = mkLogDir(decisions, outcomes);
    cleanup.push(dir);

    const configCopy = join(dir, 'config.yaml');
    copyFileSync(FIXTURE, configCopy);
    const before = readFileSync(configCopy);
    const beforeMtime = statSync(configCopy).mtimeMs;

    const out = bufferStream();
    const err = bufferStream();
    const code = await runTune(['--log-dir', dir, '--config', configCopy], {
      stdout: out.stream,
      stderr: err.stream,
    });

    expect(code).toBe(0);
    expect(out.read()).toMatch(/^@@ /m);
    const after = readFileSync(configCopy);
    expect(after.equals(before)).toBe(true);
    expect(statSync(configCopy).mtimeMs).toBe(beforeMtime);
  });

  it('exits 0 with no stdout and stderr message when no suggestions', async () => {
    const dir = mkLogDir([
      mkDecision({
        request_hash: 'h1',
        policy_result: { rule_id: 'trivial-to-haiku' },
        forwarded_model: 'claude-haiku-4-5-20251001',
      }),
    ]);
    cleanup.push(dir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await runTune(['--log-dir', dir, '--config', FIXTURE], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    expect(out.read()).toBe('');
    expect(err.read()).toMatch(/no suggestions/);
  });

  it('exits 1 when log directory is missing', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await runTune(['--log-dir', '/tmp/ccmux-nonexistent-xyz', '--config', FIXTURE], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.read()).toMatch(/log/i);
  });

  it('exits 2 on invalid --since', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await runTune(['--since', 'bogus'], { stdout: out.stream, stderr: err.stream });
    expect(code).toBe(2);
    expect(err.read()).toMatch(/since/i);
  });

  it('exits 1 when config.yaml is unreadable', async () => {
    const dir = mkLogDir([
      mkDecision({
        request_hash: 'h1',
        policy_result: { rule_id: 'trivial-to-haiku' },
        forwarded_model: 'claude-haiku-4-5-20251001',
      }),
    ]);
    cleanup.push(dir);
    const out = bufferStream();
    const err = bufferStream();
    const code = await runTune(['--log-dir', dir, '--config', '/tmp/ccmux-missing-config.yaml'], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
  });
});
