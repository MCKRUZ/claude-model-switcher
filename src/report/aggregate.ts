// Streaming aggregation over the section-13 decision log. Pure pipeline:
// filter-by-window → group → reduce → summary. The renderer lives in
// tables.ts; this file only emits plain data.
//
// Null-cost semantics: `cost_estimate_usd` and `classifier_cost_usd` are
// independently nullable. `totalWithoutOverhead` is null iff no record in the
// window had a base cost; `totalWithOverhead` is null iff no record had any
// cost component at all. The documented invariant
// `withOverhead − withoutOverhead === sum(classifier_cost_usd ?? 0)`
// holds whenever both totals are numeric. In the edge case where every
// record has a null base cost but some have classifier cost, the base
// column renders as "—" and no meaningful diff can be computed — the
// renderer shows this via the "—" placeholder.

import { stat } from 'node:fs/promises';
import type { PricingEntry } from '../config/schema.js';
import type { DecisionRecord } from '../decisions/types.js';
import { readDecisions } from '../decisions/reader.js';
import { fail, ok, type Result } from '../types/result.js';

export type GroupBy = 'model' | 'project';

export interface ReportOptions {
  readonly since: number;
  readonly groupBy: GroupBy;
  readonly logDir: string;
  // Kept on the options for forward-compatibility with recomputation paths
  // (section-16 tune). Aggregation sums the already-derived cost_estimate_usd
  // stored by section-13 and ignores pricing for now.
  readonly pricing?: Readonly<Record<string, PricingEntry>>;
  readonly now?: number;
}

export interface RoutingRow {
  readonly key: string;
  readonly count: number;
  readonly pct: number;
}

export interface CostRow {
  readonly key: string;
  readonly withoutOverhead: number | null;
  readonly withOverhead: number | null;
}

export interface LatencyPercentiles {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface ReportData {
  readonly totalCount: number;
  readonly windowStartIso: string;
  readonly groupBy: GroupBy;
  readonly routingDistribution: readonly RoutingRow[];
  readonly costBreakdown: readonly CostRow[];
  readonly totalWithoutOverhead: number | null;
  readonly totalWithOverhead: number | null;
  readonly cacheHitRate: number | null;
  readonly latency: LatencyPercentiles;
}

interface Bucket {
  count: number;
  withoutOverhead: number;
  withOverhead: number;
  anyWithout: boolean;
  anyWith: boolean;
}

interface Accum {
  readonly buckets: Map<string, Bucket>;
  readonly modelCounts: Map<string, number>;
  totalCount: number;
  withoutTotal: number;
  withTotal: number;
  anyWithout: boolean;
  anyWith: boolean;
  sumCacheRead: number;
  sumInput: number;
  readonly latencies: number[];
}

function freshAccum(): Accum {
  return {
    buckets: new Map(),
    modelCounts: new Map(),
    totalCount: 0,
    withoutTotal: 0,
    withTotal: 0,
    anyWithout: false,
    anyWith: false,
    sumCacheRead: 0,
    sumInput: 0,
    latencies: [],
  };
}

export async function aggregate(
  opts: ReportOptions,
): Promise<Result<ReportData, string>> {
  try {
    const s = await stat(opts.logDir);
    if (!s.isDirectory()) return fail(`decision log directory not found: ${opts.logDir}`);
  } catch {
    return fail(`decision log directory not found: ${opts.logDir}`);
  }

  const now = opts.now ?? Date.now();
  const sinceIso = new Date(now - opts.since).toISOString();
  const acc = freshAccum();
  for await (const rec of readDecisions(opts.logDir, { since: sinceIso })) {
    absorb(acc, rec, opts.groupBy);
  }
  return ok(finalize(acc, sinceIso, opts.groupBy));
}

function absorb(acc: Accum, rec: DecisionRecord, groupBy: GroupBy): void {
  acc.totalCount += 1;
  const model = rec.forwarded_model;
  acc.modelCounts.set(model, (acc.modelCounts.get(model) ?? 0) + 1);
  const bucket = getOrInit(acc.buckets, groupBy === 'project' ? projectKey(rec) : model);
  bucket.count += 1;
  if (rec.cost_estimate_usd !== null) {
    bucket.withoutOverhead += rec.cost_estimate_usd;
    bucket.withOverhead += rec.cost_estimate_usd;
    bucket.anyWithout = true;
    bucket.anyWith = true;
    acc.withoutTotal += rec.cost_estimate_usd;
    acc.withTotal += rec.cost_estimate_usd;
    acc.anyWithout = true;
    acc.anyWith = true;
  }
  if (rec.classifier_cost_usd !== null) {
    bucket.withOverhead += rec.classifier_cost_usd;
    bucket.anyWith = true;
    acc.withTotal += rec.classifier_cost_usd;
    acc.anyWith = true;
  }
  if (rec.usage !== null) {
    if (rec.usage.cache_read_input_tokens !== null) acc.sumCacheRead += rec.usage.cache_read_input_tokens;
    if (rec.usage.input_tokens !== null) acc.sumInput += rec.usage.input_tokens;
  }
  if (Number.isFinite(rec.upstream_latency_ms) && rec.upstream_latency_ms >= 0) {
    acc.latencies.push(rec.upstream_latency_ms);
  }
}

function finalize(acc: Accum, sinceIso: string, groupBy: GroupBy): ReportData {
  const costBreakdown: CostRow[] = [...acc.buckets.entries()]
    .map(([key, b]) => ({
      key,
      withoutOverhead: b.anyWithout ? b.withoutOverhead : null,
      withOverhead: b.anyWith ? b.withOverhead : null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const denom = acc.sumCacheRead + acc.sumInput;
  return {
    totalCount: acc.totalCount,
    windowStartIso: sinceIso,
    groupBy,
    routingDistribution: largestRemainder(acc.modelCounts, acc.totalCount),
    costBreakdown,
    totalWithoutOverhead: acc.anyWithout ? acc.withoutTotal : null,
    totalWithOverhead: acc.anyWith ? acc.withTotal : null,
    cacheHitRate: denom > 0 ? acc.sumCacheRead / denom : null,
    latency: computePercentiles(acc.latencies),
  };
}

function getOrInit(map: Map<string, Bucket>, key: string): Bucket {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const fresh: Bucket = {
    count: 0,
    withoutOverhead: 0,
    withOverhead: 0,
    anyWithout: false,
    anyWith: false,
  };
  map.set(key, fresh);
  return fresh;
}

function projectKey(rec: DecisionRecord): string {
  const v = rec.extracted_signals.projectPath;
  return typeof v === 'string' && v.length > 0 ? v : '(unknown)';
}

function largestRemainder(
  counts: ReadonlyMap<string, number>,
  total: number,
): readonly RoutingRow[] {
  if (total === 0) return [];
  // One decimal place → work in tenths-of-a-percent (target sum = 1000).
  interface E { key: string; count: number; floor: number; remainder: number }
  const entries: E[] = [...counts.entries()].map(([key, count]) => {
    const exact = (count / total) * 1000;
    const floor = Math.floor(exact);
    return { key, count, floor, remainder: exact - floor };
  });
  const currentSum = entries.reduce((s, e) => s + e.floor, 0);
  const diff = 1000 - currentSum;
  const sorted = [...entries].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.key.localeCompare(b.key);
  });
  for (let i = 0; i < diff; i += 1) {
    const target = sorted[i % sorted.length];
    if (target !== undefined) target.floor += 1;
  }
  return entries
    .map((e) => ({ key: e.key, count: e.count, pct: e.floor / 10 }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });
}

function computePercentiles(values: readonly number[]): LatencyPercentiles {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const loVal = sorted[lo] ?? 0;
    const hiVal = sorted[hi] ?? loVal;
    const frac = idx - lo;
    return loVal + frac * (hiVal - loVal);
  };
  const p50 = pick(0.5);
  // Small samples can't support a meaningful p95/p99; the renderer prints '—'.
  const p95 = sorted.length >= 3 ? pick(0.95) : null;
  const p99 = sorted.length >= 3 ? pick(0.99) : null;
  return { p50, p95, p99 };
}
