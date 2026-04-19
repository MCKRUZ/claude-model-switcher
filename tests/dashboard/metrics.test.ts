import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { DecisionRecord } from '../../src/decisions/types.js';
import { buildServer } from '../../src/dashboard/server.js';
import { invalidateMetricsCache } from '../../src/dashboard/metrics.js';

const silentLogger = pino({ level: 'silent' });

function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: 's',
    request_hash: 'h',
    extracted_signals: {},
    policy_result: {},
    classifier_result: null,
    sticky_hit: false,
    chosen_model: 'claude-sonnet-4',
    chosen_by: 'policy',
    forwarded_model: 'claude-sonnet-4',
    upstream_latency_ms: 200,
    usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    cost_estimate_usd: 0.01,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

function testConfig() {
  return {
    port: 8080,
    mode: 'live' as const,
    security: { requireProxyToken: false },
    rules: [],
    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
    modelTiers: {},
    logging: { content: 'none' as const, fsync: false, rotation: { strategy: 'none' as const, keep: 7, maxMb: 100 } },
    dashboard: { port: 8788 },
    pricing: {},
  };
}

describe('/metrics', () => {
  let tmpDir: string;
  let server: FastifyInstance;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-metrics-'));
    const logDir = join(tmpDir, 'decisions');
    mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10);
    const recent = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
    const lines = [
      mkRecord({ timestamp: recent(5), forwarded_model: 'claude-opus-4', upstream_latency_ms: 500, cost_estimate_usd: 0.05, classifier_result: { score: 0.9, suggested: 'opus', confidence: 0.95, source: 'haiku', latencyMs: 120 }, classifier_cost_usd: 0.001 }),
      mkRecord({ timestamp: recent(10), forwarded_model: 'claude-opus-4', upstream_latency_ms: 800, cost_estimate_usd: 0.08 }),
      mkRecord({ timestamp: recent(15), forwarded_model: 'claude-sonnet-4', upstream_latency_ms: 200, cost_estimate_usd: 0.02, classifier_result: { score: 0.6, suggested: 'sonnet', confidence: 0.75, source: 'haiku', latencyMs: 100 }, classifier_cost_usd: 0.0005 }),
      mkRecord({ timestamp: recent(20), forwarded_model: 'claude-sonnet-4', upstream_latency_ms: 300, cost_estimate_usd: 0.03 }),
      mkRecord({ timestamp: recent(25), forwarded_model: 'claude-haiku-4', upstream_latency_ms: 50, cost_estimate_usd: 0.001, classifier_result: { score: 0.3, suggested: 'haiku', confidence: 0.92, source: 'heuristic', latencyMs: 5 }, classifier_cost_usd: 0.0003 }),
      mkRecord({ timestamp: recent(30), forwarded_model: 'claude-haiku-4', upstream_latency_ms: 80, cost_estimate_usd: 0.002 }),
    ];
    writeFileSync(
      join(logDir, `decisions-${dateStamp}.jsonl`),
      lines.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    server = buildServer({
      configStore: { getCurrent: () => testConfig() },
      decisionLogDir: logDir,
      logger: silentLogger,
    });
    return server.ready();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    invalidateMetricsCache();
  });

  it('returns Prometheus text format with the expected content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
  });

  it('includes ccmux_decisions_total counters per forwarded_model', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    const body = res.body;
    expect(body).toContain('ccmux_decisions_total');
    expect(body).toContain('forwarded_model="claude-opus-4"');
    expect(body).toContain('forwarded_model="claude-sonnet-4"');
    expect(body).toContain('forwarded_model="claude-haiku-4"');
  });

  it('includes cache-hit ratio gauge', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('ccmux_cache_hit_ratio');
  });

  it('includes p50/p95/p99 latency gauges', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    const body = res.body;
    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.5"}');
    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.95"}');
    expect(body).toContain('ccmux_upstream_latency_ms{quantile="0.99"}');
  });

  it('includes classifier latency gauges', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    const body = res.body;
    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.5"}');
    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.95"}');
    expect(body).toContain('ccmux_classifier_latency_ms{quantile="0.99"}');
  });

  it('includes cost counters', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    const body = res.body;
    expect(body).toContain('ccmux_cost_usd_total{kind="forwarded"}');
    expect(body).toContain('ccmux_cost_usd_total{kind="classifier"}');
  });

  it('caches for 10s to prevent repeated full-log scans', async () => {
    const res1 = await server.inject({ method: 'GET', url: '/metrics' });
    const res2 = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res1.body).toBe(res2.body);
    expect(res1.statusCode).toBe(200);
  });
});
