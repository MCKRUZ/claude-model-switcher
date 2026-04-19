import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/dashboard/server.js';
import type { ConfigStore } from '../../src/config/watcher.js';
import type { CcmuxConfig } from '../../src/config/schema.js';

const FIXTURE_SRC = join(__dirname, 'fixtures', 'decisions.sample.jsonl');

function testConfig(overrides: Partial<CcmuxConfig> = {}): CcmuxConfig {
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
    pricing: {
      'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
      'claude-haiku-4': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
    },
    ...overrides,
  };
}

const silentLogger = pino({ level: 'silent' });

describe('/api/decisions', () => {
  let tmpDir: string;
  let server: FastifyInstance;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-api-'));
    const logDir = join(tmpDir, 'decisions');
    mkdirSync(logDir, { recursive: true });
    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');

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

  it('defaults limit to 100 when unspecified', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/decisions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(100);
  });

  it('clamps limit=2000 to 1000 silently (no 400)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=2000' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(1000);
  });

  it('honors since= to filter older records', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/decisions?since=2026-04-19T08:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const item of body.items) {
      expect(new Date(item.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date('2026-04-19T08:00:00.000Z').getTime(),
      );
    }
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThan(30);
  });

  it('returns { items, limit, offset, total_scanned }', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/decisions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
    expect(body).toHaveProperty('total_scanned');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(30);
  });
});

describe('/api/summary', () => {
  let tmpDir: string;
  let server: FastifyInstance;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-summary-'));
    const logDir = join(tmpDir, 'decisions');
    mkdirSync(logDir, { recursive: true });
    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');

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

  it('computes routing distribution per forwarded model', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.routingDistribution).toBeDefined();
    expect(body.routingDistribution['claude-opus-4']).toBe(10);
    expect(body.routingDistribution['claude-sonnet-4']).toBe(12);
    expect(body.routingDistribution['claude-haiku-4']).toBe(8);
  });

  it('computes cache-hit rate from usage.cache_read_input_tokens', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/summary' });
    const body = JSON.parse(res.body);
    expect(body.cacheHitRate).toBeGreaterThan(0);
    expect(body.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it('computes p50/p95/p99 of upstream_latency_ms', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/summary' });
    const body = JSON.parse(res.body);
    expect(body.latency).toBeDefined();
    expect(body.latency.p50).toBeGreaterThan(0);
    expect(body.latency.p95).toBeGreaterThan(body.latency.p50);
    expect(body.latency.p99).toBeGreaterThanOrEqual(body.latency.p95);
  });

  it('reports cost with and without classifier overhead', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/summary' });
    const body = JSON.parse(res.body);
    expect(body.totalCost).toBeGreaterThan(0);
    expect(body.classifierCost).toBeGreaterThan(0);
    expect(body.totalCost).toBeGreaterThan(body.classifierCost);
  });
});

describe('/api/costs', () => {
  let tmpDir: string;
  let server: FastifyInstance;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-costs-'));
    const logDir = join(tmpDir, 'decisions');
    mkdirSync(logDir, { recursive: true });
    const fixture = readFileSync(FIXTURE_SRC, 'utf8');
    writeFileSync(join(logDir, 'decisions-2026-04-19.jsonl'), fixture, 'utf8');

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

  it('returns time-bucketed cost series for hour granularity', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/costs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.buckets.length).toBeGreaterThan(0);
    const bucket = body.buckets[0];
    expect(bucket).toHaveProperty('ts_bucket');
    expect(bucket).toHaveProperty('cost_usd');
    expect(bucket).toHaveProperty('classifier_cost_usd');
    expect(bucket).toHaveProperty('requests');
  });

  it('accepts bucket=day query parameter', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/costs?bucket=day' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.buckets.length).toBeGreaterThan(0);
  });
});

describe('/api/pricing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-pricing-'));
    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the live config pricing table', async () => {
    const config = testConfig();
    const server = buildServer({
      configStore: { getCurrent: () => config },
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res = await server.inject({ method: 'GET', url: '/api/pricing' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body['claude-opus-4']).toEqual({
        input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75,
      });
    } finally {
      await server.close();
    }
  });

  it('reflects hot-swapped pricing after a config reload', async () => {
    let current = testConfig();
    const store: ConfigStore = { getCurrent: () => current };
    const server = buildServer({
      configStore: store,
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res1 = await server.inject({ method: 'GET', url: '/api/pricing' });
      const before = JSON.parse(res1.body);
      expect(before['claude-opus-4'].input).toBe(15);

      current = testConfig({
        pricing: {
          'claude-opus-4': { input: 20, output: 100, cacheRead: 2, cacheCreate: 25 },
        },
      });
      const res2 = await server.inject({ method: 'GET', url: '/api/pricing' });
      const after = JSON.parse(res2.body);
      expect(after['claude-opus-4'].input).toBe(20);
    } finally {
      await server.close();
    }
  });
});
