diff --git a/src/cli/main.ts b/src/cli/main.ts
index 2e4fbe5..d20174c 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -73,9 +73,30 @@ function buildProgram(
       const { runVersion } = await import('./version.js');
       box.code = runVersion(stdout);
     });
+  registerReport(program, box, stdout, stderr);
   return program;
 }
 
+function registerReport(
+  program: Command,
+  box: ActionBox,
+  stdout: NodeJS.WritableStream,
+  stderr: NodeJS.WritableStream,
+): void {
+  program
+    .command('report')
+    .description('Summarize the decision log (routing, cost, cache, latency)')
+    .allowUnknownOption(true)
+    .helpOption(false)
+    .option('--since <duration>', 'Window: 7d, 24h, 30m (default: 7d)')
+    .option('--group-by <key>', 'Group cost by model or project (default: model)')
+    .option('--format <fmt>', 'Output format: ascii or json (default: ascii)')
+    .action(async (_cmdOpts: unknown, cmd: Command) => {
+      const { runReport } = await import('./report.js');
+      box.code = await runReport(cmd.args as readonly string[], { stdout, stderr });
+    });
+}
+
 function handleCommanderError(err: unknown, stderr: NodeJS.WritableStream): number {
   if (err instanceof CommanderError) {
     if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') return 0;
diff --git a/src/cli/report.ts b/src/cli/report.ts
index 197d301..5db0f6a 100644
--- a/src/cli/report.ts
+++ b/src/cli/report.ts
@@ -1,2 +1,98 @@
-// Populated in section-15. Do not import.
-export {};
+// `ccmux report`: aggregate the decision log and render a summary.
+// Flags: --since <duration>, --group-by <model|project>, --format <ascii|json>.
+// Exit codes: 0 on success; 1 on missing/unreadable log dir; 2 on flag errors.
+
+import { resolvePaths } from '../config/paths.js';
+import { parseDuration } from '../report/duration.js';
+import { aggregate, type GroupBy, type ReportOptions } from '../report/aggregate.js';
+import { renderAscii, renderJson } from '../report/tables.js';
+import { fail, ok, type Result } from '../types/result.js';
+
+export interface RunReportOpts {
+  readonly stdout?: NodeJS.WritableStream;
+  readonly stderr?: NodeJS.WritableStream;
+  readonly logDir?: string;
+  readonly now?: number;
+}
+
+interface Flags {
+  since: string;
+  groupBy: string;
+  format: string;
+}
+
+export async function runReport(
+  argv: readonly string[],
+  opts: RunReportOpts = {},
+): Promise<number> {
+  const stdout = opts.stdout ?? process.stdout;
+  const stderr = opts.stderr ?? process.stderr;
+
+  const parsed = parseFlags(argv);
+  if (!parsed.ok) {
+    stderr.write(`ccmux report: ${parsed.error}\n`);
+    return 2;
+  }
+  const flags = parsed.value;
+
+  const durationResult = parseDuration(flags.since);
+  if (!durationResult.ok) {
+    stderr.write(`ccmux report: invalid --since duration: ${flags.since}\n`);
+    return 2;
+  }
+
+  if (flags.groupBy !== 'model' && flags.groupBy !== 'project') {
+    stderr.write(`ccmux report: invalid --group-by (must be 'model' or 'project')\n`);
+    return 2;
+  }
+  if (flags.format !== 'ascii' && flags.format !== 'json') {
+    stderr.write(`ccmux report: invalid --format (must be 'ascii' or 'json')\n`);
+    return 2;
+  }
+
+  const logDir = opts.logDir ?? resolvePaths().decisionLogDir;
+  const reportOpts: ReportOptions = {
+    since: durationResult.value,
+    groupBy: flags.groupBy as GroupBy,
+    logDir,
+    ...(opts.now !== undefined ? { now: opts.now } : {}),
+  };
+
+  const result = await aggregate(reportOpts);
+  if (!result.ok) {
+    stderr.write(`ccmux report: ${result.error}\n`);
+    return 1;
+  }
+
+  if (flags.format === 'json') {
+    stdout.write(renderJson(result.value) + '\n');
+  } else {
+    stdout.write(renderAscii(result.value));
+  }
+  return 0;
+}
+
+function parseFlags(argv: readonly string[]): Result<Flags, string> {
+  const out: Flags = { since: '7d', groupBy: 'model', format: 'ascii' };
+  const assign = (key: keyof Flags, value: string | undefined): Result<null, string> => {
+    if (value === undefined || value.length === 0) {
+      return fail(`missing value for --${key}`);
+    }
+    out[key] = value;
+    return ok(null);
+  };
+  for (let i = 0; i < argv.length; i += 1) {
+    const a = argv[i];
+    if (a === undefined) break;
+    let r: Result<null, string> | null = null;
+    if (a === '--since') r = assign('since', argv[++i]);
+    else if (a.startsWith('--since=')) r = assign('since', a.slice('--since='.length));
+    else if (a === '--group-by') r = assign('groupBy', argv[++i]);
+    else if (a.startsWith('--group-by=')) r = assign('groupBy', a.slice('--group-by='.length));
+    else if (a === '--format') r = assign('format', argv[++i]);
+    else if (a.startsWith('--format=')) r = assign('format', a.slice('--format='.length));
+    else return fail(`unknown argument: ${a}`);
+    if (r !== null && !r.ok) return fail(r.error);
+  }
+  return ok(out);
+}
diff --git a/src/report/aggregate.ts b/src/report/aggregate.ts
new file mode 100644
index 0000000..bf27146
--- /dev/null
+++ b/src/report/aggregate.ts
@@ -0,0 +1,228 @@
+// Streaming aggregation over the section-13 decision log. Pure pipeline:
+// filter-by-window → group → reduce → summary. The renderer lives in
+// tables.ts; this file only emits plain data.
+
+import { stat } from 'node:fs/promises';
+import type { PricingEntry } from '../config/schema.js';
+import type { DecisionRecord } from '../decisions/types.js';
+import { readDecisions } from '../decisions/reader.js';
+import { fail, ok, type Result } from '../types/result.js';
+
+export type GroupBy = 'model' | 'project';
+
+export interface ReportOptions {
+  readonly since: number;
+  readonly groupBy: GroupBy;
+  readonly logDir: string;
+  // Kept on the options for forward-compatibility with recomputation paths
+  // (section-16 tune). Aggregation sums the already-derived cost_estimate_usd
+  // stored by section-13 and ignores pricing for now.
+  readonly pricing?: Readonly<Record<string, PricingEntry>>;
+  readonly now?: number;
+}
+
+export interface RoutingRow {
+  readonly key: string;
+  readonly count: number;
+  readonly pct: number;
+}
+
+export interface CostRow {
+  readonly key: string;
+  readonly withoutOverhead: number | null;
+  readonly withOverhead: number | null;
+}
+
+export interface LatencyPercentiles {
+  readonly p50: number | null;
+  readonly p95: number | null;
+  readonly p99: number | null;
+}
+
+export interface ReportData {
+  readonly totalCount: number;
+  readonly windowStartIso: string;
+  readonly groupBy: GroupBy;
+  readonly routingDistribution: readonly RoutingRow[];
+  readonly costBreakdown: readonly CostRow[];
+  readonly totalWithoutOverhead: number | null;
+  readonly totalWithOverhead: number | null;
+  readonly cacheHitRate: number | null;
+  readonly latency: LatencyPercentiles;
+}
+
+interface Bucket {
+  count: number;
+  withoutOverhead: number;
+  withOverhead: number;
+  anyWithout: boolean;
+  anyWith: boolean;
+}
+
+interface Accum {
+  readonly buckets: Map<string, Bucket>;
+  readonly modelCounts: Map<string, number>;
+  totalCount: number;
+  withoutTotal: number;
+  withTotal: number;
+  anyWithout: boolean;
+  anyWith: boolean;
+  sumCacheRead: number;
+  sumInput: number;
+  readonly latencies: number[];
+}
+
+function freshAccum(): Accum {
+  return {
+    buckets: new Map(),
+    modelCounts: new Map(),
+    totalCount: 0,
+    withoutTotal: 0,
+    withTotal: 0,
+    anyWithout: false,
+    anyWith: false,
+    sumCacheRead: 0,
+    sumInput: 0,
+    latencies: [],
+  };
+}
+
+export async function aggregate(
+  opts: ReportOptions,
+): Promise<Result<ReportData, string>> {
+  try {
+    const s = await stat(opts.logDir);
+    if (!s.isDirectory()) return fail(`decision log directory not found: ${opts.logDir}`);
+  } catch {
+    return fail(`decision log directory not found: ${opts.logDir}`);
+  }
+
+  const now = opts.now ?? Date.now();
+  const sinceIso = new Date(now - opts.since).toISOString();
+  const acc = freshAccum();
+  for await (const rec of readDecisions(opts.logDir, { since: sinceIso })) {
+    absorb(acc, rec, opts.groupBy);
+  }
+  return ok(finalize(acc, sinceIso, opts.groupBy));
+}
+
+function absorb(acc: Accum, rec: DecisionRecord, groupBy: GroupBy): void {
+  acc.totalCount += 1;
+  const model = rec.forwarded_model;
+  acc.modelCounts.set(model, (acc.modelCounts.get(model) ?? 0) + 1);
+  const bucket = getOrInit(acc.buckets, groupBy === 'project' ? projectKey(rec) : model);
+  bucket.count += 1;
+  if (rec.cost_estimate_usd !== null) {
+    bucket.withoutOverhead += rec.cost_estimate_usd;
+    bucket.withOverhead += rec.cost_estimate_usd;
+    bucket.anyWithout = true;
+    bucket.anyWith = true;
+    acc.withoutTotal += rec.cost_estimate_usd;
+    acc.withTotal += rec.cost_estimate_usd;
+    acc.anyWithout = true;
+    acc.anyWith = true;
+  }
+  if (rec.classifier_cost_usd !== null) {
+    bucket.withOverhead += rec.classifier_cost_usd;
+    bucket.anyWith = true;
+    acc.withTotal += rec.classifier_cost_usd;
+    acc.anyWith = true;
+  }
+  if (rec.usage !== null) {
+    if (rec.usage.cache_read_input_tokens !== null) acc.sumCacheRead += rec.usage.cache_read_input_tokens;
+    if (rec.usage.input_tokens !== null) acc.sumInput += rec.usage.input_tokens;
+  }
+  if (Number.isFinite(rec.upstream_latency_ms) && rec.upstream_latency_ms >= 0) {
+    acc.latencies.push(rec.upstream_latency_ms);
+  }
+}
+
+function finalize(acc: Accum, sinceIso: string, groupBy: GroupBy): ReportData {
+  const costBreakdown: CostRow[] = [...acc.buckets.entries()]
+    .map(([key, b]) => ({
+      key,
+      withoutOverhead: b.anyWithout ? b.withoutOverhead : null,
+      withOverhead: b.anyWith ? b.withOverhead : null,
+    }))
+    .sort((a, b) => a.key.localeCompare(b.key));
+  const denom = acc.sumCacheRead + acc.sumInput;
+  return {
+    totalCount: acc.totalCount,
+    windowStartIso: sinceIso,
+    groupBy,
+    routingDistribution: largestRemainder(acc.modelCounts, acc.totalCount),
+    costBreakdown,
+    totalWithoutOverhead: acc.anyWithout ? acc.withoutTotal : null,
+    totalWithOverhead: acc.anyWith ? acc.withTotal : null,
+    cacheHitRate: denom > 0 ? acc.sumCacheRead / denom : null,
+    latency: computePercentiles(acc.latencies),
+  };
+}
+
+function getOrInit(map: Map<string, Bucket>, key: string): Bucket {
+  const existing = map.get(key);
+  if (existing !== undefined) return existing;
+  const fresh: Bucket = {
+    count: 0,
+    withoutOverhead: 0,
+    withOverhead: 0,
+    anyWithout: false,
+    anyWith: false,
+  };
+  map.set(key, fresh);
+  return fresh;
+}
+
+function projectKey(rec: DecisionRecord): string {
+  const v = rec.extracted_signals.projectPath;
+  return typeof v === 'string' && v.length > 0 ? v : '(unknown)';
+}
+
+function largestRemainder(
+  counts: ReadonlyMap<string, number>,
+  total: number,
+): readonly RoutingRow[] {
+  if (total === 0) return [];
+  // One decimal place → work in tenths-of-a-percent (target sum = 1000).
+  interface E { key: string; count: number; floor: number; remainder: number }
+  const entries: E[] = [...counts.entries()].map(([key, count]) => {
+    const exact = (count / total) * 1000;
+    const floor = Math.floor(exact);
+    return { key, count, floor, remainder: exact - floor };
+  });
+  const currentSum = entries.reduce((s, e) => s + e.floor, 0);
+  const diff = 1000 - currentSum;
+  const sorted = [...entries].sort((a, b) => {
+    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
+    return a.key.localeCompare(b.key);
+  });
+  for (let i = 0; i < diff; i += 1) {
+    const target = sorted[i % sorted.length];
+    if (target !== undefined) target.floor += 1;
+  }
+  return entries
+    .map((e) => ({ key: e.key, count: e.count, pct: e.floor / 10 }))
+    .sort((a, b) => {
+      if (b.count !== a.count) return b.count - a.count;
+      return a.key.localeCompare(b.key);
+    });
+}
+
+function computePercentiles(values: readonly number[]): LatencyPercentiles {
+  if (values.length === 0) return { p50: null, p95: null, p99: null };
+  const sorted = [...values].sort((a, b) => a - b);
+  const pick = (p: number): number => {
+    const idx = p * (sorted.length - 1);
+    const lo = Math.floor(idx);
+    const hi = Math.ceil(idx);
+    const loVal = sorted[lo] ?? 0;
+    const hiVal = sorted[hi] ?? loVal;
+    const frac = idx - lo;
+    return loVal + frac * (hiVal - loVal);
+  };
+  const p50 = pick(0.5);
+  // Small samples can't support a meaningful p95/p99; the renderer prints '—'.
+  const p95 = sorted.length >= 3 ? pick(0.95) : null;
+  const p99 = sorted.length >= 3 ? pick(0.99) : null;
+  return { p50, p95, p99 };
+}
diff --git a/src/report/duration.ts b/src/report/duration.ts
new file mode 100644
index 0000000..fa9529f
--- /dev/null
+++ b/src/report/duration.ts
@@ -0,0 +1,25 @@
+// Parse duration strings like `7d`, `24h`, `30m`, `60s`, `500ms` into
+// milliseconds. Used by `ccmux report --since` and downstream tooling.
+
+import { fail, ok, type Result } from '../types/result.js';
+
+const UNIT_MS: Readonly<Record<string, number>> = {
+  ms: 1,
+  s: 1_000,
+  m: 60_000,
+  h: 3_600_000,
+  d: 86_400_000,
+};
+
+const RE = /^(\d+)(ms|s|m|h|d)$/;
+
+export function parseDuration(input: string): Result<number, string> {
+  const trimmed = input.trim();
+  const m = RE.exec(trimmed);
+  if (m === null) return fail(`invalid duration: ${input}`);
+  const [, digits, unit] = m;
+  if (digits === undefined || unit === undefined) return fail(`invalid duration: ${input}`);
+  const factor = UNIT_MS[unit];
+  if (factor === undefined) return fail(`invalid duration unit: ${unit}`);
+  return ok(Number(digits) * factor);
+}
diff --git a/src/report/tables.ts b/src/report/tables.ts
index 197d301..8e823c9 100644
--- a/src/report/tables.ts
+++ b/src/report/tables.ts
@@ -1,2 +1,70 @@
-// Populated in section-15. Do not import.
-export {};
+// ASCII + JSON renderers for report data. No I/O — callers write strings to
+// their own stream. Keeps rendering pure for testability.
+
+import type { CostRow, LatencyPercentiles, ReportData, RoutingRow } from './aggregate.js';
+
+export function renderAscii(data: ReportData): string {
+  const sections: readonly string[] = [
+    renderRouting(data.routingDistribution),
+    renderCost(data.groupBy, data.costBreakdown, data.totalWithoutOverhead, data.totalWithOverhead),
+    renderCacheHit(data.cacheHitRate),
+    renderLatency(data.latency),
+  ];
+  return sections.join('\n\n') + '\n';
+}
+
+export function renderJson(data: ReportData): string {
+  return JSON.stringify(data);
+}
+
+function renderRouting(rows: readonly RoutingRow[]): string {
+  const body = rows.map((r) => [r.key, String(r.count), `${r.pct.toFixed(1)}%`]);
+  return table('Routing distribution', ['Model', 'Count', '%'], body);
+}
+
+function renderCost(
+  groupBy: 'model' | 'project',
+  rows: readonly CostRow[],
+  totalWithout: number | null,
+  totalWith: number | null,
+): string {
+  const keyHeader = groupBy === 'project' ? 'Project' : 'Model';
+  const body: string[][] = rows.map((r) => [
+    r.key,
+    fmtUsd(r.withoutOverhead),
+    fmtUsd(r.withOverhead),
+  ]);
+  body.push(['TOTAL', fmtUsd(totalWithout), fmtUsd(totalWith)]);
+  return table('Cost breakdown (USD)', [keyHeader, 'Without overhead', 'With overhead'], body);
+}
+
+function renderCacheHit(rate: number | null): string {
+  const value = rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
+  return table(
+    'Cache-hit rate',
+    ['Metric', 'Value'],
+    [['cache_read / (cache_read + input)', value]],
+  );
+}
+
+function renderLatency(p: LatencyPercentiles): string {
+  const fmt = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`);
+  return table('Upstream latency', ['p50', 'p95', 'p99'], [[fmt(p.p50), fmt(p.p95), fmt(p.p99)]]);
+}
+
+function fmtUsd(v: number | null): string {
+  return v === null ? '—' : `$${v.toFixed(4)}`;
+}
+
+function table(title: string, headers: readonly string[], rows: readonly (readonly string[])[]): string {
+  const widths = headers.map((header, col) =>
+    Math.max(header.length, ...rows.map((r) => (r[col] ?? '').length)),
+  );
+  const pad = (cells: readonly string[]) =>
+    '| ' + cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ') + ' |';
+  const sep = '+-' + widths.map((w) => '-'.repeat(w)).join('-+-') + '-+';
+  const lines: string[] = [title, sep, pad(headers), sep];
+  for (const r of rows) lines.push(pad(r));
+  lines.push(sep);
+  return lines.join('\n');
+}
diff --git a/tests/report/aggregate.test.ts b/tests/report/aggregate.test.ts
new file mode 100644
index 0000000..eaf19b2
--- /dev/null
+++ b/tests/report/aggregate.test.ts
@@ -0,0 +1,238 @@
+// Aggregation pipeline: filter → group → reduce over decision JSONL.
+import { describe, expect, it } from 'vitest';
+import { mkdtempSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { aggregate } from '../../src/report/aggregate.js';
+import type { DecisionRecord } from '../../src/decisions/types.js';
+import type { PricingEntry } from '../../src/config/schema.js';
+
+function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
+  return {
+    timestamp: '2026-04-18T00:00:00.000Z',
+    session_id: 's',
+    request_hash: 'h',
+    extracted_signals: {},
+    policy_result: {},
+    classifier_result: null,
+    sticky_hit: false,
+    chosen_model: 'claude-haiku-4-5-20251001',
+    chosen_by: 'policy',
+    forwarded_model: 'claude-haiku-4-5-20251001',
+    upstream_latency_ms: 0,
+    usage: null,
+    cost_estimate_usd: null,
+    classifier_cost_usd: null,
+    mode: 'live',
+    shadow_choice: null,
+    ...over,
+  };
+}
+
+function tmpLogDir(records: readonly DecisionRecord[], dateStamp = '2026-04-18'): string {
+  const dir = mkdtempSync(join(tmpdir(), 'ccmux-agg-'));
+  const file = join(dir, `decisions-${dateStamp}.jsonl`);
+  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
+  return dir;
+}
+
+const PRICING: Readonly<Record<string, PricingEntry>> = {
+  'claude-haiku-4-5-20251001': { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
+  'claude-sonnet-4-6': { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
+};
+
+describe('aggregate', () => {
+  it('filters log entries by since window', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recent = mkRecord({ timestamp: '2026-04-17T12:00:00.000Z', session_id: 'recent' });
+    const old = mkRecord({ timestamp: '2026-04-10T12:00:00.000Z', session_id: 'old' });
+    const ancient = mkRecord({ timestamp: '2026-03-18T12:00:00.000Z', session_id: 'ancient' });
+    const dir = tmpLogDir([recent, old, ancient]);
+
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: dir,
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (r.ok) expect(r.value.totalCount).toBe(1);
+  });
+
+  it('groups cost by inferred project path', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recs = [
+      mkRecord({
+        timestamp: '2026-04-18T01:00:00.000Z',
+        extracted_signals: { projectPath: '/a' },
+        cost_estimate_usd: 0.10,
+      }),
+      mkRecord({
+        timestamp: '2026-04-18T02:00:00.000Z',
+        extracted_signals: { projectPath: '/a' },
+        cost_estimate_usd: 0.05,
+      }),
+      mkRecord({
+        timestamp: '2026-04-18T03:00:00.000Z',
+        extracted_signals: { projectPath: '/b' },
+        cost_estimate_usd: 0.02,
+      }),
+    ];
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'project',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const map = new Map(r.value.costBreakdown.map((c) => [c.key, c]));
+    expect(map.get('/a')?.withoutOverhead).toBeCloseTo(0.15, 10);
+    expect(map.get('/b')?.withoutOverhead).toBeCloseTo(0.02, 10);
+  });
+
+  it('routing distribution percentages sum to exactly 100.0', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const mk = (model: string, n: number): DecisionRecord[] =>
+      Array.from({ length: n }, (_, i) =>
+        mkRecord({
+          timestamp: '2026-04-18T01:00:00.000Z',
+          session_id: `${model}-${i}`,
+          forwarded_model: model,
+        }),
+      );
+    const recs = [...mk('m1', 3), ...mk('m2', 3), ...mk('m3', 1)]; // 3/7, 3/7, 1/7 → 42.86%, 42.86%, 14.28%
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const sum = r.value.routingDistribution.reduce((s, row) => s + row.pct, 0);
+    expect(sum).toBeCloseTo(100, 10);
+  });
+
+  it('with-overhead minus without-overhead equals sum of classifier_cost_usd', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recs = [
+      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: 0.10, classifier_cost_usd: 0.01 }),
+      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: 0.20, classifier_cost_usd: 0.03 }),
+      mkRecord({ timestamp: '2026-04-18T03:00:00.000Z', cost_estimate_usd: 0.05, classifier_cost_usd: null }),
+    ];
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const diff = (r.value.totalWithOverhead ?? 0) - (r.value.totalWithoutOverhead ?? 0);
+    expect(diff).toBeCloseTo(0.04, 10);
+  });
+
+  it('returns fail when the log directory does not exist', async () => {
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: join(tmpdir(), 'ccmux-does-not-exist-' + Date.now()),
+      pricing: PRICING,
+    });
+    expect(r.ok).toBe(false);
+  });
+
+  it('handles entries with null cost components without crashing', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recs = [
+      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: null }),
+      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: null }),
+    ];
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    expect(r.value.totalWithoutOverhead).toBeNull();
+    expect(r.value.totalCount).toBe(2);
+  });
+
+  it('cache-hit rate = cache_read / (cache_read + input)', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const usage = (cacheRead: number, input: number) => ({
+      input_tokens: input,
+      output_tokens: 0,
+      cache_read_input_tokens: cacheRead,
+      cache_creation_input_tokens: 0,
+    });
+    const recs = [
+      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', usage: usage(80, 20) }),
+      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', usage: usage(20, 80) }),
+    ];
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    // total cache_read = 100, total input = 100, rate = 0.5
+    expect(r.value.cacheHitRate).toBeCloseTo(0.5, 10);
+  });
+
+  it('latency percentiles via linear interpolation on sorted values', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
+    const recs = values.map((v, i) =>
+      mkRecord({
+        timestamp: '2026-04-18T01:00:00.000Z',
+        session_id: `v-${i}`,
+        upstream_latency_ms: v,
+      }),
+    );
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    // idx = p*(n-1). n=10. p50 idx=4.5 → 50+0.5*10=55. p95 idx=8.55 → 90+0.55*10=95.5. p99 idx=8.91 → 90+0.91*10=99.1
+    expect(r.value.latency.p50).toBeCloseTo(55, 5);
+    expect(r.value.latency.p95).toBeCloseTo(95.5, 5);
+    expect(r.value.latency.p99).toBeCloseTo(99.1, 5);
+  });
+
+  it('returns null p95/p99 when sample size is below 3', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recs = [
+      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', upstream_latency_ms: 10 }),
+      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', upstream_latency_ms: 20 }),
+    ];
+    const r = await aggregate({
+      since: 7 * 86_400_000,
+      groupBy: 'model',
+      logDir: tmpLogDir(recs),
+      pricing: PRICING,
+      now,
+    });
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    expect(r.value.latency.p95).toBeNull();
+    expect(r.value.latency.p99).toBeNull();
+    expect(r.value.latency.p50).toBeCloseTo(15, 5);
+  });
+});
diff --git a/tests/report/duration.test.ts b/tests/report/duration.test.ts
new file mode 100644
index 0000000..f2a0f65
--- /dev/null
+++ b/tests/report/duration.test.ts
@@ -0,0 +1,34 @@
+// Duration parser: `7d`, `24h`, `30m`, `60s`, `500ms`.
+import { describe, expect, it } from 'vitest';
+import { parseDuration } from '../../src/report/duration.js';
+
+describe('parseDuration', () => {
+  it('parses 7d as 7 * 86_400_000 ms', () => {
+    const r = parseDuration('7d');
+    expect(r.ok).toBe(true);
+    if (r.ok) expect(r.value).toBe(7 * 86_400_000);
+  });
+
+  it('parses 24h, 30m, 60s, 500ms', () => {
+    const h = parseDuration('24h');
+    const m = parseDuration('30m');
+    const s = parseDuration('60s');
+    const ms = parseDuration('500ms');
+    expect(h.ok && h.value).toBe(24 * 3_600_000);
+    expect(m.ok && m.value).toBe(30 * 60_000);
+    expect(s.ok && s.value).toBe(60 * 1_000);
+    expect(ms.ok && ms.value).toBe(500);
+  });
+
+  it('tolerates whitespace', () => {
+    const r = parseDuration('  7d  ');
+    expect(r.ok && r.value).toBe(7 * 86_400_000);
+  });
+
+  it('returns fail for invalid input', () => {
+    for (const bad of ['', 'abc', '7', '7x', '-1d', '1.5d', 'd7', '7 d']) {
+      const r = parseDuration(bad);
+      expect(r.ok).toBe(false);
+    }
+  });
+});
diff --git a/tests/report/report-cli.test.ts b/tests/report/report-cli.test.ts
new file mode 100644
index 0000000..0225177
--- /dev/null
+++ b/tests/report/report-cli.test.ts
@@ -0,0 +1,133 @@
+// `ccmux report` end-to-end: flag parsing, missing log dir, default since, JSON format.
+import { describe, expect, it } from 'vitest';
+import { Writable } from 'node:stream';
+import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { runReport } from '../../src/cli/report.js';
+import type { DecisionRecord } from '../../src/decisions/types.js';
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
+  return {
+    timestamp: '2026-04-18T00:00:00.000Z',
+    session_id: 's',
+    request_hash: 'h',
+    extracted_signals: {},
+    policy_result: {},
+    classifier_result: null,
+    sticky_hit: false,
+    chosen_model: 'claude-haiku-4-5-20251001',
+    chosen_by: 'policy',
+    forwarded_model: 'claude-haiku-4-5-20251001',
+    upstream_latency_ms: 10,
+    usage: null,
+    cost_estimate_usd: 0.05,
+    classifier_cost_usd: 0.01,
+    mode: 'live',
+    shadow_choice: null,
+    ...over,
+  };
+}
+
+function seedLogDir(records: readonly DecisionRecord[], dateStamp = '2026-04-18'): string {
+  const dir = mkdtempSync(join(tmpdir(), 'ccmux-report-'));
+  mkdirSync(dir, { recursive: true });
+  writeFileSync(
+    join(dir, `decisions-${dateStamp}.jsonl`),
+    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
+    'utf8',
+  );
+  return dir;
+}
+
+describe('runReport', () => {
+  it('exits non-zero and writes a human-readable stderr when log dir is missing', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runReport([], {
+      stdout: out.stream,
+      stderr: err.stream,
+      logDir: join(tmpdir(), 'ccmux-missing-' + Date.now()),
+      now: Date.parse('2026-04-18T12:00:00.000Z'),
+    });
+    expect(code).not.toBe(0);
+    const stderr = err.read();
+    expect(stderr.length).toBeGreaterThan(0);
+    expect(stderr).not.toMatch(/at .*\.ts:\d+/); // no stack-trace leak
+  });
+
+  it('applies default --since 7d when omitted', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recent = mkRecord({ timestamp: '2026-04-17T00:00:00.000Z', session_id: 'recent' });
+    const older = mkRecord({ timestamp: '2026-04-09T00:00:00.000Z', session_id: 'older' });
+    const dir = seedLogDir([recent, older]);
+
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runReport(['--format', 'json'], {
+      stdout: out.stream,
+      stderr: err.stream,
+      logDir: dir,
+      now,
+    });
+    expect(code).toBe(0);
+    const parsed = JSON.parse(out.read().trim());
+    expect(parsed.totalCount).toBe(1);
+  });
+
+  it('--format json emits valid JSON with the same totals as the ASCII view', async () => {
+    const now = Date.parse('2026-04-18T12:00:00.000Z');
+    const recs = [
+      mkRecord({ timestamp: '2026-04-18T01:00:00.000Z', cost_estimate_usd: 0.10, classifier_cost_usd: 0.01 }),
+      mkRecord({ timestamp: '2026-04-18T02:00:00.000Z', cost_estimate_usd: 0.20, classifier_cost_usd: 0.03 }),
+    ];
+    const dir = seedLogDir(recs);
+
+    const outJson = bufferStream();
+    const codeJson = await runReport(['--format', 'json'], {
+      stdout: outJson.stream,
+      stderr: bufferStream().stream,
+      logDir: dir,
+      now,
+    });
+    expect(codeJson).toBe(0);
+    const parsed = JSON.parse(outJson.read().trim());
+    expect(parsed.totalWithoutOverhead).toBeCloseTo(0.30, 10);
+    expect(parsed.totalWithOverhead).toBeCloseTo(0.34, 10);
+  });
+
+  it('rejects an invalid --since with a non-zero exit code', async () => {
+    const err = bufferStream();
+    const code = await runReport(['--since', 'not-a-duration'], {
+      stdout: bufferStream().stream,
+      stderr: err.stream,
+      logDir: seedLogDir([mkRecord()]),
+      now: Date.parse('2026-04-18T12:00:00.000Z'),
+    });
+    expect(code).not.toBe(0);
+    expect(err.read()).toMatch(/duration/i);
+  });
+
+  it('rejects an invalid --group-by', async () => {
+    const err = bufferStream();
+    const code = await runReport(['--group-by', 'invalid'], {
+      stdout: bufferStream().stream,
+      stderr: err.stream,
+      logDir: seedLogDir([mkRecord()]),
+      now: Date.parse('2026-04-18T12:00:00.000Z'),
+    });
+    expect(code).not.toBe(0);
+    expect(err.read()).toMatch(/group-by/i);
+  });
+});
diff --git a/tests/report/tables.test.ts b/tests/report/tables.test.ts
new file mode 100644
index 0000000..986f2ce
--- /dev/null
+++ b/tests/report/tables.test.ts
@@ -0,0 +1,74 @@
+// ASCII + JSON renderers for report data.
+import { describe, expect, it } from 'vitest';
+import { renderAscii, renderJson } from '../../src/report/tables.js';
+import type { ReportData } from '../../src/report/aggregate.js';
+
+function mkData(over: Partial<ReportData> = {}): ReportData {
+  return {
+    totalCount: 0,
+    windowStartIso: '2026-04-11T00:00:00.000Z',
+    groupBy: 'model',
+    routingDistribution: [],
+    costBreakdown: [],
+    totalWithoutOverhead: null,
+    totalWithOverhead: null,
+    cacheHitRate: null,
+    latency: { p50: null, p95: null, p99: null },
+    ...over,
+  };
+}
+
+describe('renderAscii', () => {
+  it('parsed percentages from the rendered table sum to exactly 100.0', () => {
+    const data = mkData({
+      totalCount: 7,
+      routingDistribution: [
+        { key: 'm1', count: 3, pct: 42.9 },
+        { key: 'm2', count: 3, pct: 42.9 },
+        { key: 'm3', count: 1, pct: 14.2 },
+      ],
+    });
+    const out = renderAscii(data);
+    const pcts = [...out.matchAll(/(\d+\.\d+)%/g)].map((m) => Number(m[1]));
+    // Percentages that are cache-hit rate percentages aren't in routing. Filter by routing region.
+    // Simpler: pick the first N (== routing count) that appear.
+    const first3 = pcts.slice(0, 3);
+    const sum = first3.reduce((s, v) => s + v, 0);
+    expect(sum).toBeCloseTo(100, 5);
+  });
+
+  it('renders "—" for null cost components', () => {
+    const data = mkData({
+      costBreakdown: [{ key: 'm1', withoutOverhead: null, withOverhead: null }],
+      totalWithoutOverhead: null,
+      totalWithOverhead: null,
+    });
+    const out = renderAscii(data);
+    expect(out).toContain('—');
+  });
+
+  it('labels the cost-breakdown key column based on groupBy', () => {
+    const byProject = renderAscii(mkData({ groupBy: 'project' }));
+    const byModel = renderAscii(mkData({ groupBy: 'model' }));
+    expect(byProject).toContain('Project');
+    expect(byModel).toContain('Model');
+  });
+});
+
+describe('renderJson', () => {
+  it('emits valid JSON parseable by JSON.parse with matching group totals', () => {
+    const data = mkData({
+      totalCount: 2,
+      totalWithoutOverhead: 0.15,
+      totalWithOverhead: 0.19,
+      costBreakdown: [
+        { key: 'm1', withoutOverhead: 0.15, withOverhead: 0.19 },
+      ],
+    });
+    const out = renderJson(data);
+    const parsed = JSON.parse(out);
+    expect(parsed.totalWithoutOverhead).toBe(0.15);
+    expect(parsed.totalWithOverhead).toBe(0.19);
+    expect(parsed.costBreakdown[0].key).toBe('m1');
+  });
+});
