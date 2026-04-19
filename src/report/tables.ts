// ASCII + JSON renderers for report data. No I/O — callers write strings to
// their own stream. Keeps rendering pure for testability.

import type { CostRow, LatencyPercentiles, ReportData, RoutingRow } from './aggregate.js';

export function renderAscii(data: ReportData): string {
  const sections: readonly string[] = [
    renderRouting(data.routingDistribution),
    renderCost(data.groupBy, data.costBreakdown, data.totalWithoutOverhead, data.totalWithOverhead),
    renderCacheHit(data.cacheHitRate),
    renderLatency(data.latency),
  ];
  return sections.join('\n\n') + '\n';
}

export function renderJson(data: ReportData): string {
  return JSON.stringify(data);
}

function renderRouting(rows: readonly RoutingRow[]): string {
  const body = rows.map((r) => [r.key, String(r.count), `${r.pct.toFixed(1)}%`]);
  return table('Routing distribution', ['Model', 'Count', '%'], body);
}

function renderCost(
  groupBy: 'model' | 'project',
  rows: readonly CostRow[],
  totalWithout: number | null,
  totalWith: number | null,
): string {
  const keyHeader = groupBy === 'project' ? 'Project' : 'Model';
  const body: string[][] = rows.map((r) => [
    r.key,
    fmtUsd(r.withoutOverhead),
    fmtUsd(r.withOverhead),
  ]);
  body.push(['TOTAL', fmtUsd(totalWithout), fmtUsd(totalWith)]);
  return table('Cost breakdown (USD)', [keyHeader, 'Without overhead', 'With overhead'], body);
}

function renderCacheHit(rate: number | null): string {
  const value = rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
  return table(
    'Cache-hit rate',
    ['Metric', 'Value'],
    [['cache_read / (cache_read + input)', value]],
  );
}

function renderLatency(p: LatencyPercentiles): string {
  const fmt = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`);
  return table('Upstream latency', ['p50', 'p95', 'p99'], [[fmt(p.p50), fmt(p.p95), fmt(p.p99)]]);
}

function fmtUsd(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(4)}`;
}

function table(title: string, headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const pad = (cells: readonly string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ') + ' |';
  const sep = '+-' + widths.map((w) => '-'.repeat(w)).join('-+-') + '-+';
  const lines: string[] = [title, sep, pad(headers), sep];
  for (const r of rows) lines.push(pad(r));
  lines.push(sep);
  return lines.join('\n');
}
