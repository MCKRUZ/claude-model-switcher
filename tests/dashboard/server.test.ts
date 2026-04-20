import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { buildServer } from '../../src/dashboard/server.js';
import type { ConfigStore } from '../../src/config/watcher.js';
import type { CcmuxConfig } from '../../src/config/schema.js';

function testConfig(): CcmuxConfig {
  return {
    port: 8080,
    mode: 'live',
    security: { requireProxyToken: false },
    rules: [],
    classifier: { enabled: false, model: '', timeoutMs: 5000, confidenceThresholds: { haiku: 0.8, heuristic: 0.7 } },
    stickyModel: { enabled: false, sessionTtlMs: 300_000 },
    modelTiers: {},
    logging: { content: 'none', fsync: false, rotation: { strategy: 'none', keep: 7, maxMb: 100 } },
    dashboard: { port: 8788 },
    pricing: {
      'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
      'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
      'claude-haiku-4': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
    },
  };
}

function testStore(config?: CcmuxConfig): ConfigStore {
  const c = config ?? testConfig();
  return { getCurrent: () => c };
}

const silentLogger = pino({ level: 'silent' });

describe('dashboard server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccmux-dash-srv-'));
    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects requests with a non-loopback Host header with 421', async () => {
    const server = buildServer({
      configStore: testStore(),
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { host: 'evil.example.com:8788' },
      });
      expect(res.statusCode).toBe(421);
    } finally {
      await server.close();
    }
  });

  it('accepts requests with localhost Host header', async () => {
    const server = buildServer({
      configStore: testStore(),
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { host: 'localhost:8788' },
      });
      expect(res.statusCode).not.toBe(421);
    } finally {
      await server.close();
    }
  });

  it('accepts requests with 127.0.0.1 Host header', async () => {
    const server = buildServer({
      configStore: testStore(),
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { host: '127.0.0.1:8788' },
      });
      expect(res.statusCode).not.toBe(421);
    } finally {
      await server.close();
    }
  });

  it('GET / returns 404 with spa-not-built error', async () => {
    const server = buildServer({
      configStore: testStore(),
      decisionLogDir: join(tmpDir, 'decisions'),
      logger: silentLogger,
    });
    await server.ready();
    try {
      const res = await server.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('spa-not-built');
    } finally {
      await server.close();
    }
  });
});
