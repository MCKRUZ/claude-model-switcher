// Integration test: `ccmux report` flags reach runReport via the commander
// router (not just a direct call to runReport). Guards against regressions
// where `.option()` declarations on the subcommand consume flags before the
// inner argv parser sees them.

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli/main.js';
import type { DecisionRecord } from '../../src/decisions/types.js';

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

function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    timestamp: '2026-04-18T00:00:00.000Z',
    session_id: 's',
    request_hash: 'h',
    extracted_signals: {},
    policy_result: {},
    classifier_result: null,
    sticky_hit: false,
    chosen_model: 'claude-haiku-4-5-20251001',
    chosen_by: 'policy',
    forwarded_model: 'claude-haiku-4-5-20251001',
    upstream_latency_ms: 10,
    usage: null,
    cost_estimate_usd: 0.05,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

describe('cli report (integration via main.run)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ccmux-cli-report-'));
    mkdirSync(join(tmpHome, 'logs', 'decisions'), { recursive: true });
    // Seed today's file so the default 7d window has something to read.
    const dateStamp = new Date().toISOString().slice(0, 10);
    const today = new Date().toISOString();
    writeFileSync(
      join(tmpHome, 'logs', 'decisions', `decisions-${dateStamp}.jsonl`),
      JSON.stringify(mkRecord({ timestamp: today, forwarded_model: 'claude-opus-4-7' })) + '\n',
      'utf8',
    );
    process.env.CCMUX_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.CCMUX_HOME;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('forwards --format json flag through commander to runReport', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['report', '--format', 'json'], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    // If commander were eating the flag, the default ASCII renderer would run
    // and this parse would fail.
    const parsed = JSON.parse(out.read().trim());
    expect(parsed.totalCount).toBe(1);
    expect(parsed.routingDistribution[0].key).toBe('claude-opus-4-7');
  });

  it('forwards --since and --group-by through commander', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['report', '--since', '30d', '--group-by', 'project', '--format', 'json'], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.read().trim());
    expect(parsed.groupBy).toBe('project');
  });

  it('invalid --since exits non-zero via commander dispatch', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await run(['report', '--since', 'bogus'], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).not.toBe(0);
    expect(err.read()).toMatch(/duration/i);
  });
});
