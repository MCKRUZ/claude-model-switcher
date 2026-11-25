// "Cache busters" section of `ccmux report`: aggregate, ASCII, JSON, CLI, and
// compatibility with log lines written before the field existed.
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReport } from '../../src/cli/report.js';
import { aggregate, type ReportData } from '../../src/report/aggregate.js';
import { renderAscii, renderJson } from '../../src/report/tables.js';
import type { DecisionRecord } from '../../src/decisions/types.js';
import type { CacheBusterKind } from '../../src/signals/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const WEEK = 7 * 86_400_000;

function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    timestamp: '2026-11-25T01:00:00.000Z',
    session_id: 's',
    request_hash: 'h',
    extracted_signals: {},
    policy_result: {},
    classifier_result: null,
    sticky_hit: false,
    chosen_model: 'claude-sonnet-4-6',
    chosen_by: 'policy',
    forwarded_model: 'claude-sonnet-4-6',
    upstream_model: null,
    upstream_latency_ms: 10,
    usage: null,
    cost_estimate_usd: null,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

function flagged(
  kinds: readonly CacheBusterKind[],
  usage: DecisionRecord['usage'],
): DecisionRecord {
  return mkRecord({ cache_buster: { kinds, prefix_fingerprint: 'f'.repeat(32) }, usage });
}

function usage(creation: number | null, read: number | null): DecisionRecord['usage'] {
  return {
    input_tokens: 5,
    output_tokens: 5,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: creation,
  };
}

function seedLogDir(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-busters-'));
  writeFileSync(join(dir, 'decisions-2026-11-25.jsonl'), lines.join('\n') + '\n', 'utf8');
  return dir;
}

async function report(records: readonly DecisionRecord[]): Promise<ReportData> {
  const dir = seedLogDir(records.map((r) => JSON.stringify(r)));
  const result = await aggregate({ since: WEEK, groupBy: 'model', logDir: dir, now: NOW });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

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

describe('report aggregate: cache busters', () => {
  it('counts flagged requests, kinds, and billed cache tokens', async () => {
    const data = await report([
      flagged(['date'], usage(20_000, 0)),
      flagged(['date', 'uuid'], usage(18_000, 12)),
      flagged(['hex_id'], usage(null, null)),
      mkRecord({ usage: usage(100, 9_000) }),
      mkRecord(),
    ]);
    expect(data.totalCount).toBe(5);
    expect(data.cacheBusters.flaggedCount).toBe(3);
    expect(data.cacheBusters.byKind).toEqual([
      { kind: 'date', count: 2 },
      { kind: 'uuid', count: 1 },
      { kind: 'hex_id', count: 1 },
    ]);
    expect(data.cacheBusters.cacheCreationTokens).toBe(38_000);
    expect(data.cacheBusters.cacheReadTokens).toBe(12);
  });

  it('reports zero when no line carries the field', async () => {
    const data = await report([mkRecord(), mkRecord({ usage: usage(1, 2) })]);
    expect(data.cacheBusters).toEqual({
      flaggedCount: 0,
      byKind: [],
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it('ignores a malformed cache_buster value instead of failing the report', async () => {
    const bad = JSON.stringify({ ...mkRecord(), cache_buster: { kinds: 'date' } });
    const worse = JSON.stringify({ ...mkRecord(), cache_buster: null });
    const dir = seedLogDir([bad, worse]);
    const result = await aggregate({ since: WEEK, groupBy: 'model', logDir: dir, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cacheBusters.flaggedCount).toBe(0);
  });

  it('still loads the old-format dashboard sample log with zero flagged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccmux-old-fixture-'));
    copyFileSync(
      join(HERE, '..', 'dashboard', 'fixtures', 'decisions.sample.jsonl'),
      join(dir, 'decisions-2026-04-18.jsonl'),
    );
    const result = await aggregate({
      since: 20 * 365 * 86_400_000,
      groupBy: 'model',
      logDir: dir,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBeGreaterThan(0);
    expect(result.value.cacheBusters.flaggedCount).toBe(0);
  });
});

describe('report renderers: cache busters', () => {
  it('ASCII output has a Cache busters table after the cache-hit-rate table', async () => {
    const data = await report([flagged(['date'], usage(20_000, 0))]);
    const out = renderAscii(data);
    expect(out).toContain('Cache busters');
    expect(out.indexOf('Cache busters')).toBeGreaterThan(out.indexOf('Cache-hit rate'));
    expect(out.indexOf('Cache busters')).toBeLessThan(out.indexOf('Upstream latency'));
    expect(out).toMatch(/flagged requests\s*\|\s*1\s*\|/);
    expect(out).toMatch(/kind: date\s*\|\s*1\s*\|/);
    expect(out).toMatch(/cache_creation tokens \(flagged\)\s*\|\s*20000\s*\|/);
    expect(out).toMatch(/cache_read tokens \(flagged\)\s*\|\s*0\s*\|/);
  });

  it('ASCII output shows a zero count rather than dropping the section', async () => {
    const out = renderAscii(await report([mkRecord()]));
    expect(out).toContain('Cache busters');
    expect(out).toMatch(/flagged requests\s*\|\s*0\s*\|/);
  });

  it('JSON output includes the same data', async () => {
    const data = await report([flagged(['uuid'], usage(7, 1))]);
    const parsed = JSON.parse(renderJson(data));
    expect(parsed.cacheBusters).toEqual({
      flaggedCount: 1,
      byKind: [{ kind: 'uuid', count: 1 }],
      cacheCreationTokens: 7,
      cacheReadTokens: 1,
    });
  });
});

describe('ccmux report CLI: cache busters', () => {
  it('prints the Cache busters section for a log with flagged requests', async () => {
    const dir = seedLogDir([JSON.stringify(flagged(['date'], usage(25_000, 3)))]);
    mkdirSync(dir, { recursive: true });
    const out = bufferStream();
    const code = await runReport([], {
      stdout: out.stream,
      stderr: bufferStream().stream,
      logDir: dir,
      now: NOW,
    });
    expect(code).toBe(0);
    const text = out.read();
    expect(text).toContain('Cache busters');
    expect(text).toMatch(/flagged requests\s*\|\s*1\s*\|/);
    expect(text).toMatch(/cache_creation tokens \(flagged\)\s*\|\s*25000\s*\|/);
  });
});
