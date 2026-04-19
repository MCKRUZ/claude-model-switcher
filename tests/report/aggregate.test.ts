// Aggregation pipeline: filter → group → reduce over decision JSONL.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate } from '../../src/report/aggregate.js';
import type { DecisionRecord } from '../../src/decisions/types.js';
import type { PricingEntry } from '../../src/config/schema.js';

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
    upstream_latency_ms: 0,
    usage: null,
    cost_estimate_usd: null,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

function tmpLogDir(records: readonly DecisionRecord[], dateStamp = '2026-04-18'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-agg-'));
  const file = join(dir, `decisions-${dateStamp}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return dir;
}

const PRICING: Readonly<Record<string, PricingEntry>> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
  'claude-sonnet-4-6': { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
};

describe('aggregate', () => {
  it('filters log entries by since window', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recent = mkRecord({ timestamp: '2026-04-17T12:00:00.000Z', session_id: 'recent' });
    const old = mkRecord({ timestamp: '2026-04-10T12:00:00.000Z', session_id: 'old' });
    const ancient = mkRecord({ timestamp: '2026-03-18T12:00:00.000Z', session_id: 'ancient' });
    const dir = tmpLogDir([recent, old, ancient]);

    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: dir,
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.totalCount).toBe(1);
  });

  it('groups cost by inferred project path', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recs = [
      mkRecord({
        timestamp: '2026-04-18T01:00:00.000Z',
        extracted_signals: { projectPath: '/a' },
        cost_estimate_usd: 0.10,
      }),
      mkRecord({
        timestamp: '2026-04-18T02:00:00.000Z',
        extracted_signals: { projectPath: '/a' },
        cost_estimate_usd: 0.05,
      }),
      mkRecord({
        timestamp: '2026-04-18T03:00:00.000Z',
        extracted_signals: { projectPath: '/b' },
        cost_estimate_usd: 0.02,
      }),
    ];
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'project',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const map = new Map(r.value.costBreakdown.map((c) => [c.key, c]));
    expect(map.get('/a')?.withoutOverhead).toBeCloseTo(0.15, 10);
    expect(map.get('/b')?.withoutOverhead).toBeCloseTo(0.02, 10);
  });

  it('routing distribution percentages sum to exactly 100.0', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const mk = (model: string, n: number): DecisionRecord[] =>
      Array.from({ length: n }, (_, i) =>
        mkRecord({
          timestamp: '2026-04-18T01:00:00.000Z',
          session_id: `${model}-${i}`,
          forwarded_model: model,
        }),
      );
    const recs = [...mk('m1', 3), ...mk('m2', 3), ...mk('m3', 1)]; // 3/7, 3/7, 1/7 → 42.86%, 42.86%, 14.28%
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sum = r.value.routingDistribution.reduce((s, row) => s + row.pct, 0);
    expect(sum).toBeCloseTo(100, 10);
  });

  it('with-overhead minus without-overhead equals sum of classifier_cost_usd', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recs = [
      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: 0.10, classifier_cost_usd: 0.01 }),
      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: 0.20, classifier_cost_usd: 0.03 }),
      mkRecord({ timestamp: '2026-04-18T03:00:00.000Z', cost_estimate_usd: 0.05, classifier_cost_usd: null }),
    ];
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const diff = (r.value.totalWithOverhead ?? 0) - (r.value.totalWithoutOverhead ?? 0);
    expect(diff).toBeCloseTo(0.04, 10);
  });

  it('returns fail when the log directory does not exist', async () => {
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: join(tmpdir(), 'ccmux-does-not-exist-' + Date.now()),
      pricing: PRICING,
    });
    expect(r.ok).toBe(false);
  });

  it('handles entries with null cost components without crashing', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recs = [
      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: null }),
      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: null }),
    ];
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalWithoutOverhead).toBeNull();
    expect(r.value.totalCount).toBe(2);
  });

  it('cache-hit rate = cache_read / (cache_read + input)', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const usage = (cacheRead: number, input: number) => ({
      input_tokens: input,
      output_tokens: 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    });
    const recs = [
      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', usage: usage(80, 20) }),
      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', usage: usage(20, 80) }),
    ];
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // total cache_read = 100, total input = 100, rate = 0.5
    expect(r.value.cacheHitRate).toBeCloseTo(0.5, 10);
  });

  it('latency percentiles via linear interpolation on sorted values', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const recs = values.map((v, i) =>
      mkRecord({
        timestamp: '2026-04-18T01:00:00.000Z',
        session_id: `v-${i}`,
        upstream_latency_ms: v,
      }),
    );
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // idx = p*(n-1). n=10. p50 idx=4.5 → 50+0.5*10=55. p95 idx=8.55 → 90+0.55*10=95.5. p99 idx=8.91 → 90+0.91*10=99.1
    expect(r.value.latency.p50).toBeCloseTo(55, 5);
    expect(r.value.latency.p95).toBeCloseTo(95.5, 5);
    expect(r.value.latency.p99).toBeCloseTo(99.1, 5);
  });

  it('returns null p95/p99 when sample size is below 3', async () => {
    const now = Date.parse('2026-04-18T12:00:00.000Z');
    const recs = [
      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', upstream_latency_ms: 10 }),
      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', upstream_latency_ms: 20 }),
    ];
    const r = await aggregate({
      since: 7 * 86_400_000,
      groupBy: 'model',
      logDir: tmpLogDir(recs),
      pricing: PRICING,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.latency.p95).toBeNull();
    expect(r.value.latency.p99).toBeNull();
    expect(r.value.latency.p50).toBeCloseTo(15, 5);
  });
});
