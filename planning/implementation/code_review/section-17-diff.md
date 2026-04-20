diff --git a/src/dashboard/aggregate.ts b/src/dashboard/aggregate.ts
new file mode 100644
index 0000000..7f97a59
--- /dev/null
+++ b/src/dashboard/aggregate.ts
@@ -0,0 +1,109 @@
+import type { DecisionRecord } from '../decisions/types.js';
+
+export interface TimeBucket {
+  readonly ts_bucket: string;
+  readonly cost_usd: number;
+  readonly classifier_cost_usd: number;
+  readonly requests: number;
+}
+
+export interface SummaryResult {
+  readonly routingDistribution: Readonly<Record<string, number>>;
+  readonly cacheHitRate: number;
+  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
+  readonly totalCost: number;
+  readonly classifierCost: number;
+}
+
+export function routingDistribution(
+  records: readonly DecisionRecord[],
+): Record<string, number> {
+  const dist: Record<string, number> = {};
+  for (const r of records) {
+    dist[r.forwarded_model] = (dist[r.forwarded_model] ?? 0) + 1;
+  }
+  return dist;
+}
+
+export function cacheHitRate(records: readonly DecisionRecord[]): number {
+  let totalInput = 0;
+  let cacheRead = 0;
+  for (const r of records) {
+    if (!r.usage) continue;
+    totalInput += r.usage.input_tokens ?? 0;
+    cacheRead += r.usage.cache_read_input_tokens ?? 0;
+  }
+  return totalInput > 0 ? cacheRead / totalInput : 0;
+}
+
+function percentile(sorted: number[], p: number): number {
+  const n = sorted.length;
+  if (n === 0) return 0;
+  if (n === 1) return sorted[0];
+  const idx = p * (n - 1);
+  const lower = Math.floor(idx);
+  const upper = Math.ceil(idx);
+  if (lower === upper) return sorted[lower];
+  return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
+}
+
+export function latencyPercentiles(
+  latencies: readonly number[],
+): { p50: number; p95: number; p99: number } {
+  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
+  const sorted = [...latencies].sort((a, b) => a - b);
+  return {
+    p50: percentile(sorted, 0.5),
+    p95: percentile(sorted, 0.95),
+    p99: percentile(sorted, 0.99),
+  };
+}
+
+export function costSummary(
+  records: readonly DecisionRecord[],
+): { totalCost: number; classifierCost: number } {
+  let totalCost = 0;
+  let classifierCost = 0;
+  for (const r of records) {
+    if (r.cost_estimate_usd != null) totalCost += r.cost_estimate_usd;
+    if (r.classifier_cost_usd != null) classifierCost += r.classifier_cost_usd;
+  }
+  return { totalCost, classifierCost };
+}
+
+export function computeSummary(
+  records: readonly DecisionRecord[],
+): SummaryResult {
+  const costs = costSummary(records);
+  return {
+    routingDistribution: routingDistribution(records),
+    cacheHitRate: cacheHitRate(records),
+    latency: latencyPercentiles(records.map(r => r.upstream_latency_ms)),
+    totalCost: costs.totalCost,
+    classifierCost: costs.classifierCost,
+  };
+}
+
+function bucketKey(ts: string, bucket: 'hour' | 'day'): string {
+  const d = new Date(ts);
+  if (bucket === 'day') return d.toISOString().slice(0, 10);
+  return d.toISOString().slice(0, 13) + ':00:00.000Z';
+}
+
+export function timeBuckets(
+  records: readonly DecisionRecord[],
+  bucket: 'hour' | 'day',
+): TimeBucket[] {
+  const map = new Map<string, { cost_usd: number; classifier_cost_usd: number; requests: number }>();
+  for (const r of records) {
+    const key = bucketKey(r.timestamp, bucket);
+    const cur = map.get(key) ?? { cost_usd: 0, classifier_cost_usd: 0, requests: 0 };
+    cur.cost_usd += r.cost_estimate_usd ?? 0;
+    cur.classifier_cost_usd += r.classifier_cost_usd ?? 0;
+    cur.requests += 1;
+    map.set(key, cur);
+  }
+  return [...map.entries()]
+    .sort(([a], [b]) => a.localeCompare(b))
+    .map(([ts_bucket, data]) => ({ ts_bucket, ...data }));
+}
diff --git a/src/dashboard/api.ts b/src/dashboard/api.ts
index 516b4d3..5d81c57 100644
--- a/src/dashboard/api.ts
+++ b/src/dashboard/api.ts
@@ -1,2 +1,96 @@
-// Populated in section-17. Do not import.
-export {};
+import type { FastifyInstance } from 'fastify';
+import type { ConfigStore } from '../config/watcher.js';
+import { readDecisions } from './read-log.js';
+import { computeSummary, timeBuckets } from './aggregate.js';
+import { getOrComputeMetrics } from './metrics.js';
+
+export interface ApiOpts {
+  readonly configStore: ConfigStore;
+  readonly decisionLogDir: string;
+}
+
+export function registerRoutes(
+  server: FastifyInstance,
+  opts: ApiOpts,
+): void {
+  const { configStore, decisionLogDir } = opts;
+
+  server.get('/api/decisions', async (req, reply) => {
+    const query = req.query as Record<string, string>;
+    let limit = parseInt(query.limit ?? '100', 10);
+    if (isNaN(limit) || limit < 1) limit = 100;
+    if (limit > 1000) limit = 1000;
+
+    let offset = parseInt(query.offset ?? '0', 10);
+    if (isNaN(offset) || offset < 0) offset = 0;
+
+    const since = query.since ? new Date(query.since) : undefined;
+    const groupBy = query.group_by as 'model' | 'rule' | 'hour' | undefined;
+
+    const result = await readDecisions(decisionLogDir, { since, limit, offset });
+
+    if (groupBy) {
+      const groups: Record<string, number> = {};
+      for (const item of result.items) {
+        let key: string;
+        if (groupBy === 'model') key = item.forwarded_model;
+        else if (groupBy === 'rule') key = item.policy_result.rule_id ?? 'none';
+        else key = new Date(item.timestamp).toISOString().slice(0, 13);
+        groups[key] = (groups[key] ?? 0) + 1;
+      }
+      return reply.send({ groups, limit, offset, total_scanned: result.totalScanned });
+    }
+
+    return reply.send({
+      items: result.items,
+      limit,
+      offset,
+      total_scanned: result.totalScanned,
+    });
+  });
+
+  server.get('/api/summary', async (req, reply) => {
+    const query = req.query as Record<string, string>;
+    const since = query.since
+      ? new Date(query.since)
+      : new Date(Date.now() - 24 * 60 * 60 * 1000);
+
+    const result = await readDecisions(decisionLogDir, {
+      since,
+      limit: Number.MAX_SAFE_INTEGER,
+    });
+    return reply.send(computeSummary(result.items));
+  });
+
+  server.get('/api/costs', async (req, reply) => {
+    const query = req.query as Record<string, string>;
+    const bucket = (query.bucket === 'day' ? 'day' : 'hour') as 'hour' | 'day';
+    const since = query.since
+      ? new Date(query.since)
+      : new Date(Date.now() - 24 * 60 * 60 * 1000);
+
+    const result = await readDecisions(decisionLogDir, {
+      since,
+      limit: Number.MAX_SAFE_INTEGER,
+    });
+    return reply.send({ buckets: timeBuckets(result.items, bucket) });
+  });
+
+  server.get('/api/pricing', async (_req, reply) => {
+    return reply.send(configStore.getCurrent().pricing);
+  });
+
+  server.get('/metrics', async (_req, reply) => {
+    const body = await getOrComputeMetrics(async () => {
+      const since = new Date(Date.now() - 60 * 60 * 1000);
+      const result = await readDecisions(decisionLogDir, {
+        since,
+        limit: Number.MAX_SAFE_INTEGER,
+      });
+      return result.items;
+    });
+    return reply
+      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
+      .send(body);
+  });
+}
diff --git a/src/dashboard/index.ts b/src/dashboard/index.ts
new file mode 100644
index 0000000..0aea0ec
--- /dev/null
+++ b/src/dashboard/index.ts
@@ -0,0 +1,14 @@
+export { buildServer, type DashboardServerOpts } from './server.js';
+export { registerRoutes, type ApiOpts } from './api.js';
+export { readDecisions, type ReadOpts, type ReadResult } from './read-log.js';
+export {
+  routingDistribution,
+  cacheHitRate,
+  latencyPercentiles,
+  costSummary,
+  computeSummary,
+  timeBuckets,
+  type TimeBucket,
+  type SummaryResult,
+} from './aggregate.js';
+export { renderPrometheusMetrics, invalidateMetricsCache, getOrComputeMetrics } from './metrics.js';
diff --git a/src/dashboard/metrics.ts b/src/dashboard/metrics.ts
index 516b4d3..3477701 100644
--- a/src/dashboard/metrics.ts
+++ b/src/dashboard/metrics.ts
@@ -1,2 +1,69 @@
-// Populated in section-17. Do not import.
-export {};
+import type { DecisionRecord } from '../decisions/types.js';
+import {
+  routingDistribution,
+  cacheHitRate,
+  latencyPercentiles,
+  costSummary,
+} from './aggregate.js';
+
+export function renderPrometheusMetrics(
+  records: readonly DecisionRecord[],
+): string {
+  const lines: string[] = [];
+
+  const dist = routingDistribution(records);
+  lines.push('# HELP ccmux_decisions_total Total routing decisions per forwarded model.');
+  lines.push('# TYPE ccmux_decisions_total counter');
+  for (const [model, count] of Object.entries(dist)) {
+    lines.push(`ccmux_decisions_total{forwarded_model="${model}"} ${count}`);
+  }
+
+  const hitRate = cacheHitRate(records);
+  lines.push('# HELP ccmux_cache_hit_ratio Cache hit ratio by input tokens.');
+  lines.push('# TYPE ccmux_cache_hit_ratio gauge');
+  lines.push(`ccmux_cache_hit_ratio ${hitRate}`);
+
+  const uLatency = latencyPercentiles(records.map(r => r.upstream_latency_ms));
+  lines.push('# HELP ccmux_upstream_latency_ms Upstream latency in milliseconds.');
+  lines.push('# TYPE ccmux_upstream_latency_ms gauge');
+  lines.push(`ccmux_upstream_latency_ms{quantile="0.5"} ${uLatency.p50}`);
+  lines.push(`ccmux_upstream_latency_ms{quantile="0.95"} ${uLatency.p95}`);
+  lines.push(`ccmux_upstream_latency_ms{quantile="0.99"} ${uLatency.p99}`);
+
+  const cLatencies = records
+    .filter(r => r.classifier_result != null)
+    .map(r => r.classifier_result!.latencyMs);
+  const cLatency = latencyPercentiles(cLatencies);
+  lines.push('# HELP ccmux_classifier_latency_ms Classifier latency in milliseconds.');
+  lines.push('# TYPE ccmux_classifier_latency_ms gauge');
+  lines.push(`ccmux_classifier_latency_ms{quantile="0.5"} ${cLatency.p50}`);
+  lines.push(`ccmux_classifier_latency_ms{quantile="0.95"} ${cLatency.p95}`);
+  lines.push(`ccmux_classifier_latency_ms{quantile="0.99"} ${cLatency.p99}`);
+
+  const costs = costSummary(records);
+  lines.push('# HELP ccmux_cost_usd_total Cumulative cost in USD.');
+  lines.push('# TYPE ccmux_cost_usd_total counter');
+  lines.push(`ccmux_cost_usd_total{kind="forwarded"} ${costs.totalCost}`);
+  lines.push(`ccmux_cost_usd_total{kind="classifier"} ${costs.classifierCost}`);
+
+  return lines.join('\n') + '\n';
+}
+
+let metricsCache: { value: string; expiresAt: number } | null = null;
+
+export function invalidateMetricsCache(): void {
+  metricsCache = null;
+}
+
+export async function getOrComputeMetrics(
+  readFn: () => Promise<readonly DecisionRecord[]>,
+): Promise<string> {
+  const now = Date.now();
+  if (metricsCache && metricsCache.expiresAt > now) {
+    return metricsCache.value;
+  }
+  const records = await readFn();
+  const value = renderPrometheusMetrics(records);
+  metricsCache = { value, expiresAt: now + 10_000 };
+  return value;
+}
diff --git a/src/dashboard/read-log.ts b/src/dashboard/read-log.ts
new file mode 100644
index 0000000..0166557
--- /dev/null
+++ b/src/dashboard/read-log.ts
@@ -0,0 +1,73 @@
+import { createReadStream, readdirSync } from 'node:fs';
+import { createInterface } from 'node:readline';
+import { join } from 'node:path';
+import type { DecisionRecord } from '../decisions/types.js';
+
+const LOG_FILE_RE = /^decisions-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;
+
+export interface ReadOpts {
+  readonly since?: Date;
+  readonly limit: number;
+  readonly offset?: number;
+}
+
+export interface ReadResult {
+  readonly items: readonly DecisionRecord[];
+  readonly totalScanned: number;
+}
+
+function findLogFiles(logDir: string): string[] {
+  try {
+    return readdirSync(logDir)
+      .filter(f => LOG_FILE_RE.test(f))
+      .sort()
+      .map(f => join(logDir, f));
+  } catch {
+    return [];
+  }
+}
+
+async function streamRecords(
+  filePath: string,
+  sinceMs: number,
+  out: DecisionRecord[],
+): Promise<void> {
+  const rl = createInterface({
+    input: createReadStream(filePath, 'utf8'),
+    crlfDelay: Infinity,
+  });
+  for await (const line of rl) {
+    const trimmed = line.trim();
+    if (!trimmed) continue;
+    try {
+      const record = JSON.parse(trimmed) as DecisionRecord;
+      if (sinceMs > 0 && new Date(record.timestamp).getTime() < sinceMs) continue;
+      out.push(record);
+    } catch {
+      // skip malformed lines
+    }
+  }
+}
+
+export async function readDecisions(
+  logDir: string,
+  opts: ReadOpts,
+): Promise<ReadResult> {
+  const files = findLogFiles(logDir);
+  const records: DecisionRecord[] = [];
+  const sinceMs = opts.since ? opts.since.getTime() : 0;
+
+  for (const file of files) {
+    await streamRecords(file, sinceMs, records);
+  }
+
+  records.sort(
+    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
+  );
+
+  const totalScanned = records.length;
+  const offset = opts.offset ?? 0;
+  const items = records.slice(offset, offset + opts.limit);
+
+  return { items, totalScanned };
+}
diff --git a/src/dashboard/server.ts b/src/dashboard/server.ts
index 516b4d3..1f2b80e 100644
--- a/src/dashboard/server.ts
+++ b/src/dashboard/server.ts
@@ -1,2 +1,42 @@
-// Populated in section-17. Do not import.
-export {};
+import Fastify, { type FastifyInstance } from 'fastify';
+import type { Logger } from 'pino';
+import type { ConfigStore } from '../config/watcher.js';
+import { registerRoutes } from './api.js';
+
+const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
+
+function isLoopbackHost(host: string | undefined): boolean {
+  if (!host) return true;
+  const hostname = host.replace(/:\d+$/, '');
+  return LOOPBACK_HOSTS.has(hostname);
+}
+
+export interface DashboardServerOpts {
+  readonly configStore: ConfigStore;
+  readonly decisionLogDir: string;
+  readonly logger: Logger;
+}
+
+export function buildServer(opts: DashboardServerOpts): FastifyInstance {
+  const server = Fastify({ logger: opts.logger });
+
+  server.addHook('onRequest', async (request, reply) => {
+    if (!isLoopbackHost(request.headers.host)) {
+      return reply
+        .code(421)
+        .send({ error: 'misdirected-request', message: 'Dashboard is loopback-only' });
+    }
+  });
+
+  // SPA stub — section-18 replaces this with @fastify/static
+  server.get('/', async (_req, reply) => {
+    return reply.code(404).send({ error: 'spa-not-built' });
+  });
+
+  registerRoutes(server, {
+    configStore: opts.configStore,
+    decisionLogDir: opts.decisionLogDir,
+  });
+
+  return server;
+}
diff --git a/tests/dashboard/api.test.ts b/tests/dashboard/api.test.ts
new file mode 100644
index 0000000..0c08b69
--- /dev/null
+++ b/tests/dashboard/api.test.ts
@@ -0,0 +1,264 @@
+import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
+import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import pino from 'pino';
+import type { FastifyInstance } from 'fastify';
+import { buildServer } from '../../src/dashboard/server.js';
+import type { ConfigStore } from '../../src/config/watcher.js';
+import type { CcmuxConfig } from '../../src/config/schema.js';
+
+const FIXTURE_SRC = join(__dirname, 'fixtures', 'decisions.sample.jsonl');
+
+function testConfig(overrides: Partial<CcmuxConfig> = {}): CcmuxConfig {
+  return {
+    port: 8080,
+    mode: 'live' as const,
+    security: { requireProxyToken: false },
+    rules: [],
+    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
+    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
+    modelTiers: {},
+    logging: { content: 'none' as const, fsync: false, rotation: { strategy: 'none' as const, keep: 7, maxMb: 100 } },
+    dashboard: { port: 8788 },
+    pricing: {
+      'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
+      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
+      'claude-haiku-4': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
+    },
+    ...overrides,
+  };
+}
+
+const silentLogger = pino({ level: 'silent' });
+
+describe('/api/decisions', () => {
+  let tmpDir: string;
+  let server: FastifyInstance;
+
+  beforeAll(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-api-'));
+    const logDir = join(tmpDir, 'decisions');
+    mkdirSync(logDir, { recursive: true });
+    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
+    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');
+
+    server = buildServer({
+      configStore: { getCurrent: () => testConfig() },
+      decisionLogDir: logDir,
+      logger: silentLogger,
+    });
+    return server.ready();
+  });
+
+  afterAll(async () => {
+    await server.close();
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('defaults limit to 100 when unspecified', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/decisions' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body.limit).toBe(100);
+  });
+
+  it('clamps limit=2000 to 1000 silently (no 400)', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=2000' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body.limit).toBe(1000);
+  });
+
+  it('honors since= to filter older records', async () => {
+    const res = await server.inject({
+      method: 'GET',
+      url: '/api/decisions?since=2026-04-19T08:00:00.000Z',
+    });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    for (const item of body.items) {
+      expect(new Date(item.timestamp).getTime()).toBeGreaterThanOrEqual(
+        new Date('2026-04-19T08:00:00.000Z').getTime(),
+      );
+    }
+    expect(body.items.length).toBeGreaterThan(0);
+    expect(body.items.length).toBeLessThan(30);
+  });
+
+  it('returns { items, limit, offset, total_scanned }', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/decisions' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body).toHaveProperty('items');
+    expect(body).toHaveProperty('limit');
+    expect(body).toHaveProperty('offset');
+    expect(body).toHaveProperty('total_scanned');
+    expect(Array.isArray(body.items)).toBe(true);
+    expect(body.items.length).toBe(30);
+  });
+});
+
+describe('/api/summary', () => {
+  let tmpDir: string;
+  let server: FastifyInstance;
+
+  beforeAll(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-summary-'));
+    const logDir = join(tmpDir, 'decisions');
+    mkdirSync(logDir, { recursive: true });
+    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
+    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');
+
+    server = buildServer({
+      configStore: { getCurrent: () => testConfig() },
+      decisionLogDir: logDir,
+      logger: silentLogger,
+    });
+    return server.ready();
+  });
+
+  afterAll(async () => {
+    await server.close();
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('computes routing distribution per forwarded model', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/summary' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body.routingDistribution).toBeDefined();
+    expect(body.routingDistribution['claude-opus-4']).toBe(10);
+    expect(body.routingDistribution['claude-sonnet-4']).toBe(12);
+    expect(body.routingDistribution['claude-haiku-4']).toBe(8);
+  });
+
+  it('computes cache-hit rate from usage.cache_read_input_tokens', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/summary' });
+    const body = JSON.parse(res.body);
+    expect(body.cacheHitRate).toBeGreaterThan(0);
+    expect(body.cacheHitRate).toBeLessThanOrEqual(1);
+  });
+
+  it('computes p50/p95/p99 of upstream_latency_ms', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/summary' });
+    const body = JSON.parse(res.body);
+    expect(body.latency).toBeDefined();
+    expect(body.latency.p50).toBeGreaterThan(0);
+    expect(body.latency.p95).toBeGreaterThan(body.latency.p50);
+    expect(body.latency.p99).toBeGreaterThanOrEqual(body.latency.p95);
+  });
+
+  it('reports cost with and without classifier overhead', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/summary' });
+    const body = JSON.parse(res.body);
+    expect(body.totalCost).toBeGreaterThan(0);
+    expect(body.classifierCost).toBeGreaterThan(0);
+    expect(body.totalCost).toBeGreaterThan(body.classifierCost);
+  });
+});
+
+describe('/api/costs', () => {
+  let tmpDir: string;
+  let server: FastifyInstance;
+
+  beforeAll(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-costs-'));
+    const logDir = join(tmpDir, 'decisions');
+    mkdirSync(logDir, { recursive: true });
+    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
+    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');
+
+    server = buildServer({
+      configStore: { getCurrent: () => testConfig() },
+      decisionLogDir: logDir,
+      logger: silentLogger,
+    });
+    return server.ready();
+  });
+
+  afterAll(async () => {
+    await server.close();
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('returns time-bucketed cost series for hour granularity', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/costs' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(Array.isArray(body.buckets)).toBe(true);
+    expect(body.buckets.length).toBeGreaterThan(0);
+    const bucket = body.buckets[0];
+    expect(bucket).toHaveProperty('ts_bucket');
+    expect(bucket).toHaveProperty('cost_usd');
+    expect(bucket).toHaveProperty('classifier_cost_usd');
+    expect(bucket).toHaveProperty('requests');
+  });
+
+  it('accepts bucket=day query parameter', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/costs?bucket=day' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body.buckets.length).toBeGreaterThan(0);
+  });
+});
+
+describe('/api/pricing', () => {
+  let tmpDir: string;
+
+  beforeEach(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-pricing-'));
+    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
+  });
+
+  afterAll(() => {
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('returns the live config pricing table', async () => {
+    const config = testConfig();
+    const server = buildServer({
+      configStore: { getCurrent: () => config },
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res = await server.inject({ method: 'GET', url: '/api/pricing' });
+      expect(res.statusCode).toBe(200);
+      const body = JSON.parse(res.body);
+      expect(body['claude-opus-4']).toEqual({
+        input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75,
+      });
+    } finally {
+      await server.close();
+    }
+  });
+
+  it('reflects hot-swapped pricing after a config reload', async () => {
+    let current = testConfig();
+    const store: ConfigStore = { getCurrent: () => current };
+    const server = buildServer({
+      configStore: store,
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res1 = await server.inject({ method: 'GET', url: '/api/pricing' });
+      const before = JSON.parse(res1.body);
+      expect(before['claude-opus-4'].input).toBe(15);
+
+      current = testConfig({
+        pricing: {
+          'claude-opus-4': { input: 20, output: 100, cacheRead: 2, cacheCreate: 25 },
+        },
+      });
+      const res2 = await server.inject({ method: 'GET', url: '/api/pricing' });
+      const after = JSON.parse(res2.body);
+      expect(after['claude-opus-4'].input).toBe(20);
+    } finally {
+      await server.close();
+    }
+  });
+});
diff --git a/tests/dashboard/fixtures/decisions.sample.jsonl b/tests/dashboard/fixtures/decisions.sample.jsonl
new file mode 100644
index 0000000..d26f1e2
--- /dev/null
+++ b/tests/dashboard/fixtures/decisions.sample.jsonl
@@ -0,0 +1,30 @@
+{"timestamp":"2026-04-19T01:00:00.000Z","session_id":"s-001","request_hash":"h-001","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"policy","forwarded_model":"claude-opus-4","upstream_latency_ms":500,"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":0},"cost_estimate_usd":0.045,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T02:00:00.000Z","session_id":"s-002","request_hash":"h-002","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.9,"suggested":"opus","confidence":0.95,"source":"haiku","latencyMs":120},"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"classifier","forwarded_model":"claude-opus-4","upstream_latency_ms":800,"usage":{"input_tokens":2000,"output_tokens":1000,"cache_read_input_tokens":500,"cache_creation_input_tokens":100},"cost_estimate_usd":0.060,"classifier_cost_usd":0.001,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T02:30:00.000Z","session_id":"s-003","request_hash":"h-003","extracted_signals":{},"policy_result":{"rule_id":"r2"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"policy","forwarded_model":"claude-opus-4","upstream_latency_ms":1200,"usage":{"input_tokens":1500,"output_tokens":800,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.075,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T03:00:00.000Z","session_id":"s-004","request_hash":"h-004","extracted_signals":{},"policy_result":{},"classifier_result":null,"sticky_hit":true,"chosen_model":"claude-opus-4","chosen_by":"sticky","forwarded_model":"claude-opus-4","upstream_latency_ms":1500,"usage":{"input_tokens":3000,"output_tokens":1500,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0},"cost_estimate_usd":0.090,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T03:30:00.000Z","session_id":"s-005","request_hash":"h-005","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.85,"suggested":"opus","confidence":0.88,"source":"heuristic","latencyMs":5},"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"classifier","forwarded_model":"claude-opus-4","upstream_latency_ms":2000,"usage":null,"cost_estimate_usd":0.100,"classifier_cost_usd":0.0015,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T04:00:00.000Z","session_id":"s-006","request_hash":"h-006","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"policy","forwarded_model":"claude-opus-4","upstream_latency_ms":2500,"usage":{"input_tokens":4000,"output_tokens":2000,"cache_read_input_tokens":1500,"cache_creation_input_tokens":200},"cost_estimate_usd":0.120,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T04:30:00.000Z","session_id":"s-007","request_hash":"h-007","extracted_signals":{},"policy_result":{},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"fallback","forwarded_model":"claude-opus-4","upstream_latency_ms":3000,"usage":{"input_tokens":2000,"output_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.080,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:00:00.000Z","session_id":"s-008","request_hash":"h-008","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.92,"suggested":"opus","confidence":0.97,"source":"haiku","latencyMs":150},"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"classifier","forwarded_model":"claude-opus-4","upstream_latency_ms":3500,"usage":{"input_tokens":5000,"output_tokens":2500,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0},"cost_estimate_usd":0.150,"classifier_cost_usd":0.002,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:30:00.000Z","session_id":"s-009","request_hash":"h-009","extracted_signals":{},"policy_result":{"rule_id":"r3"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"policy","forwarded_model":"claude-opus-4","upstream_latency_ms":4000,"usage":null,"cost_estimate_usd":null,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T06:00:00.000Z","session_id":"s-010","request_hash":"h-010","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-opus-4","chosen_by":"policy","forwarded_model":"claude-opus-4","upstream_latency_ms":5000,"usage":{"input_tokens":6000,"output_tokens":3000,"cache_read_input_tokens":3000,"cache_creation_input_tokens":500},"cost_estimate_usd":0.200,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T02:00:00.000Z","session_id":"s-011","request_hash":"h-011","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":200,"usage":{"input_tokens":500,"output_tokens":200,"cache_read_input_tokens":100,"cache_creation_input_tokens":0},"cost_estimate_usd":0.010,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T03:00:00.000Z","session_id":"s-012","request_hash":"h-012","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.6,"suggested":"sonnet","confidence":0.75,"source":"haiku","latencyMs":100},"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"classifier","forwarded_model":"claude-sonnet-4","upstream_latency_ms":250,"usage":{"input_tokens":800,"output_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.012,"classifier_cost_usd":0.0005,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T03:30:00.000Z","session_id":"s-013","request_hash":"h-013","extracted_signals":{},"policy_result":{"rule_id":"r2"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":300,"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":300,"cache_creation_input_tokens":0},"cost_estimate_usd":0.015,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T04:00:00.000Z","session_id":"s-014","request_hash":"h-014","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.55,"suggested":"sonnet","confidence":0.70,"source":"heuristic","latencyMs":3},"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"classifier","forwarded_model":"claude-sonnet-4","upstream_latency_ms":350,"usage":null,"cost_estimate_usd":0.018,"classifier_cost_usd":0.0008,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T04:30:00.000Z","session_id":"s-015","request_hash":"h-015","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":400,"usage":{"input_tokens":1200,"output_tokens":600,"cache_read_input_tokens":400,"cache_creation_input_tokens":0},"cost_estimate_usd":0.020,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:00:00.000Z","session_id":"s-016","request_hash":"h-016","extracted_signals":{},"policy_result":{},"classifier_result":null,"sticky_hit":true,"chosen_model":"claude-sonnet-4","chosen_by":"sticky","forwarded_model":"claude-sonnet-4","upstream_latency_ms":450,"usage":{"input_tokens":900,"output_tokens":450,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.022,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:30:00.000Z","session_id":"s-017","request_hash":"h-017","extracted_signals":{},"policy_result":{"rule_id":"r2"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":100,"usage":{"input_tokens":600,"output_tokens":300,"cache_read_input_tokens":200,"cache_creation_input_tokens":0},"cost_estimate_usd":0.025,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T06:00:00.000Z","session_id":"s-018","request_hash":"h-018","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.65,"suggested":"sonnet","confidence":0.80,"source":"haiku","latencyMs":110},"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"classifier","forwarded_model":"claude-sonnet-4","upstream_latency_ms":550,"usage":{"input_tokens":1500,"output_tokens":750,"cache_read_input_tokens":500,"cache_creation_input_tokens":50},"cost_estimate_usd":0.028,"classifier_cost_usd":0.001,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T06:30:00.000Z","session_id":"s-019","request_hash":"h-019","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":600,"usage":null,"cost_estimate_usd":null,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T07:00:00.000Z","session_id":"s-020","request_hash":"h-020","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":650,"usage":{"input_tokens":2000,"output_tokens":1000,"cache_read_input_tokens":800,"cache_creation_input_tokens":0},"cost_estimate_usd":0.030,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T07:30:00.000Z","session_id":"s-021","request_hash":"h-021","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.7,"suggested":"sonnet","confidence":0.82,"source":"haiku","latencyMs":130},"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"classifier","forwarded_model":"claude-sonnet-4","upstream_latency_ms":700,"usage":{"input_tokens":1800,"output_tokens":900,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.035,"classifier_cost_usd":0.0012,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T08:00:00.000Z","session_id":"s-022","request_hash":"h-022","extracted_signals":{},"policy_result":{"rule_id":"r2"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-sonnet-4","chosen_by":"policy","forwarded_model":"claude-sonnet-4","upstream_latency_ms":750,"usage":{"input_tokens":2200,"output_tokens":1100,"cache_read_input_tokens":700,"cache_creation_input_tokens":0},"cost_estimate_usd":0.038,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T04:00:00.000Z","session_id":"s-023","request_hash":"h-023","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.3,"suggested":"haiku","confidence":0.92,"source":"haiku","latencyMs":80},"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"classifier","forwarded_model":"claude-haiku-4","upstream_latency_ms":50,"usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":0},"cost_estimate_usd":0.001,"classifier_cost_usd":0.0003,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:00:00.000Z","session_id":"s-024","request_hash":"h-024","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.25,"suggested":"haiku","confidence":0.95,"source":"haiku","latencyMs":90},"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"classifier","forwarded_model":"claude-haiku-4","upstream_latency_ms":80,"usage":{"input_tokens":300,"output_tokens":150,"cache_read_input_tokens":100,"cache_creation_input_tokens":0},"cost_estimate_usd":0.002,"classifier_cost_usd":0.0004,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T05:30:00.000Z","session_id":"s-025","request_hash":"h-025","extracted_signals":{},"policy_result":{"rule_id":"r1"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"policy","forwarded_model":"claude-haiku-4","upstream_latency_ms":120,"usage":{"input_tokens":400,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.003,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T06:00:00.000Z","session_id":"s-026","request_hash":"h-026","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.2,"suggested":"haiku","confidence":0.90,"source":"heuristic","latencyMs":2},"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"classifier","forwarded_model":"claude-haiku-4","upstream_latency_ms":150,"usage":null,"cost_estimate_usd":0.001,"classifier_cost_usd":0.0005,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T07:00:00.000Z","session_id":"s-027","request_hash":"h-027","extracted_signals":{},"policy_result":{"rule_id":"r2"},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"policy","forwarded_model":"claude-haiku-4","upstream_latency_ms":180,"usage":{"input_tokens":500,"output_tokens":250,"cache_read_input_tokens":200,"cache_creation_input_tokens":0},"cost_estimate_usd":0.004,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T08:00:00.000Z","session_id":"s-028","request_hash":"h-028","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.28,"suggested":"haiku","confidence":0.88,"source":"haiku","latencyMs":95},"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"classifier","forwarded_model":"claude-haiku-4","upstream_latency_ms":220,"usage":{"input_tokens":350,"output_tokens":175,"cache_read_input_tokens":150,"cache_creation_input_tokens":0},"cost_estimate_usd":0.005,"classifier_cost_usd":0.0006,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T09:00:00.000Z","session_id":"s-029","request_hash":"h-029","extracted_signals":{},"policy_result":{},"classifier_result":null,"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"fallback","forwarded_model":"claude-haiku-4","upstream_latency_ms":280,"usage":{"input_tokens":600,"output_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"cost_estimate_usd":0.002,"classifier_cost_usd":null,"mode":"live","shadow_choice":null}
+{"timestamp":"2026-04-19T10:00:00.000Z","session_id":"s-030","request_hash":"h-030","extracted_signals":{},"policy_result":{},"classifier_result":{"score":0.22,"suggested":"haiku","confidence":0.93,"source":"haiku","latencyMs":85},"sticky_hit":false,"chosen_model":"claude-haiku-4","chosen_by":"classifier","forwarded_model":"claude-haiku-4","upstream_latency_ms":350,"usage":{"input_tokens":450,"output_tokens":225,"cache_read_input_tokens":180,"cache_creation_input_tokens":0},"cost_estimate_usd":0.006,"classifier_cost_usd":0.0007,"mode":"live","shadow_choice":null}
diff --git a/tests/dashboard/metrics.test.ts b/tests/dashboard/metrics.test.ts
new file mode 100644
index 0000000..1c38a84
--- /dev/null
+++ b/tests/dashboard/metrics.test.ts
@@ -0,0 +1,142 @@
+import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
+import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import pino from 'pino';
+import type { FastifyInstance } from 'fastify';
+import type { DecisionRecord } from '../../src/decisions/types.js';
+import { buildServer } from '../../src/dashboard/server.js';
+import { invalidateMetricsCache } from '../../src/dashboard/metrics.js';
+
+const silentLogger = pino({ level: 'silent' });
+
+function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
+  return {
+    timestamp: new Date().toISOString(),
+    session_id: 's',
+    request_hash: 'h',
+    extracted_signals: {},
+    policy_result: {},
+    classifier_result: null,
+    sticky_hit: false,
+    chosen_model: 'claude-sonnet-4',
+    chosen_by: 'policy',
+    forwarded_model: 'claude-sonnet-4',
+    upstream_latency_ms: 200,
+    usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
+    cost_estimate_usd: 0.01,
+    classifier_cost_usd: null,
+    mode: 'live',
+    shadow_choice: null,
+    ...over,
+  };
+}
+
+function testConfig() {
+  return {
+    port: 8080,
+    mode: 'live' as const,
+    security: { requireProxyToken: false },
+    rules: [],
+    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
+    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
+    modelTiers: {},
+    logging: { content: 'none' as const, fsync: false, rotation: { strategy: 'none' as const, keep: 7, maxMb: 100 } },
+    dashboard: { port: 8788 },
+    pricing: {},
+  };
+}
+
+describe('/metrics', () => {
+  let tmpDir: string;
+  let server: FastifyInstance;
+
+  beforeAll(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-metrics-'));
+    const logDir = join(tmpDir, 'decisions');
+    mkdirSync(logDir, { recursive: true });
+    const now = new Date();
+    const dateStamp = now.toISOString().slice(0, 10);
+    const recent = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
+    const lines = [
+      mkRecord({ timestamp: recent(5), forwarded_model: 'claude-opus-4', upstream_latency_ms: 500, cost_estimate_usd: 0.05, classifier_result: { score: 0.9, suggested: 'opus', confidence: 0.95, source: 'haiku', latencyMs: 120 }, classifier_cost_usd: 0.001 }),
+      mkRecord({ timestamp: recent(10), forwarded_model: 'claude-opus-4', upstream_latency_ms: 800, cost_estimate_usd: 0.08 }),
+      mkRecord({ timestamp: recent(15), forwarded_model: 'claude-sonnet-4', upstream_latency_ms: 200, cost_estimate_usd: 0.02, classifier_result: { score: 0.6, suggested: 'sonnet', confidence: 0.75, source: 'haiku', latencyMs: 100 }, classifier_cost_usd: 0.0005 }),
+      mkRecord({ timestamp: recent(20), forwarded_model: 'claude-sonnet-4', upstream_latency_ms: 300, cost_estimate_usd: 0.03 }),
+      mkRecord({ timestamp: recent(25), forwarded_model: 'claude-haiku-4', upstream_latency_ms: 50, cost_estimate_usd: 0.001, classifier_result: { score: 0.3, suggested: 'haiku', confidence: 0.92, source: 'heuristic', latencyMs: 5 }, classifier_cost_usd: 0.0003 }),
+      mkRecord({ timestamp: recent(30), forwarded_model: 'claude-haiku-4', upstream_latency_ms: 80, cost_estimate_usd: 0.002 }),
+    ];
+    writeFileSync(
+      join(logDir, `decisions-${dateStamp}.jsonl`),
+      lines.map(r => JSON.stringify(r)).join('\n') + '\n',
+      'utf8',
+    );
+
+    server = buildServer({
+      configStore: { getCurrent: () => testConfig() },
+      decisionLogDir: logDir,
+      logger: silentLogger,
+    });
+    return server.ready();
+  });
+
+  afterAll(async () => {
+    await server.close();
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  beforeEach(() => {
+    invalidateMetricsCache();
+  });
+
+  it('returns Prometheus text format with the expected content-type', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    expect(res.statusCode).toBe(200);
+    expect(res.headers['content-type']).toContain('text/plain');
+    expect(res.headers['content-type']).toContain('version=0.0.4');
+  });
+
+  it('includes ccmux_decisions_total counters per forwarded_model', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    const body = res.body;
+    expect(body).toContain('ccmux_decisions_total');
+    expect(body).toContain('forwarded_model="claude-opus-4"');
+    expect(body).toContain('forwarded_model="claude-sonnet-4"');
+    expect(body).toContain('forwarded_model="claude-haiku-4"');
+  });
+
+  it('includes cache-hit ratio gauge', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    expect(res.body).toContain('ccmux_cache_hit_ratio');
+  });
+
+  it('includes p50/p95/p99 latency gauges', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    const body = res.body;
+    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.5"}');
+    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.95"}');
+    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.99"}');
+  });
+
+  it('includes classifier latency gauges', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    const body = res.body;
+    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.5"}');
+    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.95"}');
+    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.99"}');
+  });
+
+  it('includes cost counters', async () => {
+    const res = await server.inject({ method: 'GET', url: '/metrics' });
+    const body = res.body;
+    expect(body).toContain('ccmux_cost_usd_total{kind="forwarded"}');
+    expect(body).toContain('ccmux_cost_usd_total{kind="classifier"}');
+  });
+
+  it('caches for 10s to prevent repeated full-log scans', async () => {
+    const res1 = await server.inject({ method: 'GET', url: '/metrics' });
+    const res2 = await server.inject({ method: 'GET', url: '/metrics' });
+    expect(res1.body).toBe(res2.body);
+    expect(res1.statusCode).toBe(200);
+  });
+});
diff --git a/tests/dashboard/pagination.test.ts b/tests/dashboard/pagination.test.ts
new file mode 100644
index 0000000..a35c32a
--- /dev/null
+++ b/tests/dashboard/pagination.test.ts
@@ -0,0 +1,88 @@
+import { describe, it, expect, beforeAll, afterAll } from 'vitest';
+import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import pino from 'pino';
+import type { FastifyInstance } from 'fastify';
+import { buildServer } from '../../src/dashboard/server.js';
+
+const FIXTURE_SRC = join(__dirname, 'fixtures', 'decisions.sample.jsonl');
+const silentLogger = pino({ level: 'silent' });
+
+function testConfig() {
+  return {
+    port: 8080,
+    mode: 'live' as const,
+    security: { requireProxyToken: false },
+    rules: [],
+    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
+    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
+    modelTiers: {},
+    logging: { content: 'none' as const, fsync: false, rotation: { strategy: 'none' as const, keep: 7, maxMb: 100 } },
+    dashboard: { port: 8788 },
+    pricing: {},
+  };
+}
+
+describe('pagination', () => {
+  let tmpDir: string;
+  let server: FastifyInstance;
+
+  beforeAll(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-page-'));
+    const logDir = join(tmpDir, 'decisions');
+    mkdirSync(logDir, { recursive: true });
+    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
+    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');
+
+    server = buildServer({
+      configStore: { getCurrent: () => testConfig() },
+      decisionLogDir: logDir,
+      logger: silentLogger,
+    });
+    return server.ready();
+  });
+
+  afterAll(async () => {
+    await server.close();
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('offset+limit traverses the log without duplicates or gaps', async () => {
+    const page1 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=0' });
+    const page2 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=10' });
+    const page3 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=20' });
+
+    const body1 = JSON.parse(page1.body);
+    const body2 = JSON.parse(page2.body);
+    const body3 = JSON.parse(page3.body);
+
+    expect(body1.items.length).toBe(10);
+    expect(body2.items.length).toBe(10);
+    expect(body3.items.length).toBe(10);
+
+    const allHashes = [
+      ...body1.items.map((r: { request_hash: string }) => r.request_hash),
+      ...body2.items.map((r: { request_hash: string }) => r.request_hash),
+      ...body3.items.map((r: { request_hash: string }) => r.request_hash),
+    ];
+    const unique = new Set(allHashes);
+    expect(unique.size).toBe(30);
+  });
+
+  it('stable ordering by ts descending', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=30' });
+    const body = JSON.parse(res.body);
+    const timestamps = body.items.map((r: { timestamp: string }) => new Date(r.timestamp).getTime());
+    for (let i = 1; i < timestamps.length; i++) {
+      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
+    }
+  });
+
+  it('offset beyond total returns empty items', async () => {
+    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=100' });
+    expect(res.statusCode).toBe(200);
+    const body = JSON.parse(res.body);
+    expect(body.items.length).toBe(0);
+  });
+});
diff --git a/tests/dashboard/server.test.ts b/tests/dashboard/server.test.ts
new file mode 100644
index 0000000..746b344
--- /dev/null
+++ b/tests/dashboard/server.test.ts
@@ -0,0 +1,121 @@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest';
+import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import pino from 'pino';
+import { buildServer } from '../../src/dashboard/server.js';
+import type { ConfigStore } from '../../src/config/watcher.js';
+import type { CcmuxConfig } from '../../src/config/schema.js';
+
+function testConfig(): CcmuxConfig {
+  return {
+    port: 8080,
+    mode: 'live',
+    security: { requireProxyToken: false },
+    rules: [],
+    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
+    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
+    modelTiers: {},
+    logging: { content: 'none', fsync: false, rotation: { strategy: 'none', keep: 7, maxMb: 100 } },
+    dashboard: { port: 8788 },
+    pricing: {
+      'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
+      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
+      'claude-haiku-4': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
+    },
+  };
+}
+
+function testStore(config?: CcmuxConfig): ConfigStore {
+  const c = config ?? testConfig();
+  return { getCurrent: () => c };
+}
+
+const silentLogger = pino({ level: 'silent' });
+
+describe('dashboard server', () => {
+  let tmpDir: string;
+
+  beforeEach(() => {
+    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-srv-'));
+    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
+  });
+
+  afterEach(() => {
+    rmSync(tmpDir, { recursive: true, force: true });
+  });
+
+  it('rejects requests with a non-loopback Host header with 421', async () => {
+    const server = buildServer({
+      configStore: testStore(),
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res = await server.inject({
+        method: 'GET',
+        url: '/api/decisions',
+        headers: { host: 'evil.example.com:8788' },
+      });
+      expect(res.statusCode).toBe(421);
+    } finally {
+      await server.close();
+    }
+  });
+
+  it('accepts requests with localhost Host header', async () => {
+    const server = buildServer({
+      configStore: testStore(),
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res = await server.inject({
+        method: 'GET',
+        url: '/api/decisions',
+        headers: { host: 'localhost:8788' },
+      });
+      expect(res.statusCode).not.toBe(421);
+    } finally {
+      await server.close();
+    }
+  });
+
+  it('accepts requests with 127.0.0.1 Host header', async () => {
+    const server = buildServer({
+      configStore: testStore(),
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res = await server.inject({
+        method: 'GET',
+        url: '/api/decisions',
+        headers: { host: '127.0.0.1:8788' },
+      });
+      expect(res.statusCode).not.toBe(421);
+    } finally {
+      await server.close();
+    }
+  });
+
+  it('GET / returns 404 with spa-not-built error', async () => {
+    const server = buildServer({
+      configStore: testStore(),
+      decisionLogDir: join(tmpDir, 'decisions'),
+      logger: silentLogger,
+    });
+    await server.ready();
+    try {
+      const res = await server.inject({ method: 'GET', url: '/' });
+      expect(res.statusCode).toBe(404);
+      const body = JSON.parse(res.body);
+      expect(body.error).toBe('spa-not-built');
+    } finally {
+      await server.close();
+    }
+  });
+});
