import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/dashboard/server.js';

const FIXTURE_SRC = join(__dirname, 'fixtures', 'decisions.sample.jsonl');
const silentLogger = pino({ level: 'silent' });

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

describe('pagination', () => {
  let tmpDir: string;
  let server: FastifyInstance;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-page-'));
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

  it('offset+limit traverses the log without duplicates or gaps', async () => {
    const page1 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=0' });
    const page2 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=10' });
    const page3 = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=20' });

    const body1 = JSON.parse(page1.body);
    const body2 = JSON.parse(page2.body);
    const body3 = JSON.parse(page3.body);

    expect(body1.items.length).toBe(10);
    expect(body2.items.length).toBe(10);
    expect(body3.items.length).toBe(10);

    const allHashes = [
      ...body1.items.map((r: { request_hash: string }) => r.request_hash),
      ...body2.items.map((r: { request_hash: string }) => r.request_hash),
      ...body3.items.map((r: { request_hash: string }) => r.request_hash),
    ];
    const unique = new Set(allHashes);
    expect(unique.size).toBe(30);
  });

  it('stable ordering by ts descending', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=30' });
    const body = JSON.parse(res.body);
    const timestamps = body.items.map((r: { timestamp: string }) => new Date(r.timestamp).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
    }
  });

  it('offset beyond total returns empty items', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/decisions?limit=10&offset=100' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.length).toBe(0);
  });
});
