// Health endpoint and bindWithFallback behavior.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { bindWithFallback } from '../../src/lifecycle/ports.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { createLogger } from '../../src/logging/logger.js';
import { defaultConfig } from '../../src/config/defaults.js';

describe('health', () => {
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    proxy = undefined;
  });

  it('GET /healthz returns 200 with ok status', async () => {
    proxy = await buildProxy({ upstreamOrigin: 'http://127.0.0.1:1' });
    const resp = await fetch(`${proxy.baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { status: string; mode: string; port: number; uptimeMs: number };
    expect(json.status).toBe('ok');
    expect(json.mode).toBe('passthrough');
    expect(typeof json.port).toBe('number');
    expect(typeof json.uptimeMs).toBe('number');
  });

  it('binds to 127.0.0.1 only', async () => {
    proxy = await buildProxy({ upstreamOrigin: 'http://127.0.0.1:1' });
    const addr = proxy.app.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('refuses to bind 0.0.0.0', async () => {
    const logger = createLogger({ destination: 'stderr', level: 'silent' });
    const app = await createProxyServer({ port: 0, logger, config: defaultConfig() });
    await expect(app.listen({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/i);
    await app.close();
  });

  it('bindWithFallback picks the next free port when startPort is in use', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as AddressInfo).port;
    const fastify = Fastify({ logger: false });
    try {
      const { port } = await bindWithFallback(fastify, busyPort, 10);
      expect(port).toBeGreaterThan(busyPort);
    } finally {
      await fastify.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
