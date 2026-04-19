// ASCII + JSON renderers for report data.
import { describe, expect, it } from 'vitest';
import { renderAscii, renderJson } from '../../src/report/tables.js';
import type { ReportData } from '../../src/report/aggregate.js';

function mkData(over: Partial<ReportData> = {}): ReportData {
  return {
    totalCount: 0,
    windowStartIso: '2026-04-11T00:00:00.000Z',
    groupBy: 'model',
    routingDistribution: [],
    costBreakdown: [],
    totalWithoutOverhead: null,
    totalWithOverhead: null,
    cacheHitRate: null,
    latency: { p50: null, p95: null, p99: null },
    ...over,
  };
}

describe('renderAscii', () => {
  it('parsed percentages from the rendered table sum to exactly 100.0', () => {
    const data = mkData({
      totalCount: 7,
      routingDistribution: [
        { key: 'm1', count: 3, pct: 42.9 },
        { key: 'm2', count: 3, pct: 42.9 },
        { key: 'm3', count: 1, pct: 14.2 },
      ],
    });
    const out = renderAscii(data);
    const pcts = [...out.matchAll(/(\d+\.\d+)%/g)].map((m) => Number(m[1]));
    // Percentages that are cache-hit rate percentages aren't in routing. Filter by routing region.
    // Simpler: pick the first N (== routing count) that appear.
    const first3 = pcts.slice(0, 3);
    const sum = first3.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(100, 5);
  });

  it('renders "—" for null cost components', () => {
    const data = mkData({
      costBreakdown: [{ key: 'm1', withoutOverhead: null, withOverhead: null }],
      totalWithoutOverhead: null,
      totalWithOverhead: null,
    });
    const out = renderAscii(data);
    expect(out).toContain('—');
  });

  it('labels the cost-breakdown key column based on groupBy', () => {
    const byProject = renderAscii(mkData({ groupBy: 'project' }));
    const byModel = renderAscii(mkData({ groupBy: 'model' }));
    expect(byProject).toContain('Project');
    expect(byModel).toContain('Model');
  });
});

describe('renderJson', () => {
  it('emits valid JSON parseable by JSON.parse with matching group totals', () => {
    const data = mkData({
      totalCount: 2,
      totalWithoutOverhead: 0.15,
      totalWithOverhead: 0.19,
      costBreakdown: [
        { key: 'm1', withoutOverhead: 0.15, withOverhead: 0.19 },
      ],
    });
    const out = renderJson(data);
    const parsed = JSON.parse(out);
    expect(parsed.totalWithoutOverhead).toBe(0.15);
    expect(parsed.totalWithOverhead).toBe(0.19);
    expect(parsed.costBreakdown[0].key).toBe('m1');
  });
});
