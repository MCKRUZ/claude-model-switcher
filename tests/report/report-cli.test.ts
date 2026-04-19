// `ccmux report` end-to-end: flag parsing, missing log dir, default since, JSON format.
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReport } from '../../src/cli/report.js';
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
    classifier_cost_usd: 0.01,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

function seedLogDir(records: readonly DecisionRecord[], dateStamp = '2026-04-18'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-report-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `decisions-${dateStamp}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  return dir;
}

describe('runReport', () => {
  it('exits non-zero and writes a human-readable stderr when log dir is missing', async () => {
    const out = bufferStream();
    const err = bufferStream();
    const code = await runReport([], {
      stdout: out.stream,
      stderr: err.stream,
      logDir: join(tmpdir(), 'ccmux-missing-' + Date.now()),
      now: Date.parse('2026-04-18T12:00:00.000Z'),
    });
    expect(code).not.toBe(0);
    const stderr = err.read();
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/at .*\.ts:\d+/); // no stack-trace leak
  });

  it('applies default --since 7d when omitted', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recent = mkRecord({ timestamp: '2026-04-17T00:00:00.000Z', session_id: 'recent' });
    const older = mkRecord({ timestamp: '2026-04-09T00:00:00.000Z', session_id: 'older' });
    const dir = seedLogDir([recent, older]);

    const out = bufferStream();
    const err = bufferStream();
    const code = await runReport(['--format', 'json'], {
      stdout: out.stream,
      stderr: err.stream,
      logDir: dir,
      now,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.read().trim());
    expect(parsed.totalCount).toBe(1);
  });

  it('--format json emits valid JSON with the same totals as the ASCII view', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recs = [
      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: 0.10, classifier_cost_usd: 0.01 }),
      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: 0.20, classifier_cost_usd: 0.03 }),
    ];
    const dir = seedLogDir(recs);

    const outJson = bufferStream();
    const codeJson = await runReport(['--format', 'json'], {
      stdout: outJson.stream,
      stderr: bufferStream().stream,
      logDir: dir,
      now,
    });
    expect(codeJson).toBe(0);
    const parsed = JSON.parse(outJson.read().trim());
    expect(parsed.totalWithoutOverhead).toBeCloseTo(0.30, 10);
    expect(parsed.totalWithOverhead).toBeCloseTo(0.34, 10);
  });

  it('rejects an invalid --since with a non-zero exit code', async () => {
    const err = bufferStream();
    const code = await runReport(['--since', 'not-a-duration'], {
      stdout: bufferStream().stream,
      stderr: err.stream,
      logDir: seedLogDir([mkRecord()]),
      now: Date.parse('2026-04-18T12:00:00.000Z'),
    });
    expect(code).not.toBe(0);
    expect(err.read()).toMatch(/duration/i);
  });

  it('rejects an invalid --group-by', async () => {
    const err = bufferStream();
    const code = await runReport(['--group-by', 'invalid'], {
      stdout: bufferStream().stream,
      stderr: err.stream,
      logDir: seedLogDir([mkRecord()]),
      now: Date.parse('2026-04-18T12:00:00.000Z'),
    });
    expect(code).not.toBe(0);
    expect(err.read()).toMatch(/group-by/i);
  });
});
