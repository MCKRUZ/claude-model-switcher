// x-ccmux-token gate: require, accept, and log redaction.
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { AddressInfo } from 'node:net';

describe('token', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('rejects requests missing matching x-ccmux-token with 401 when CCMUX_PROXY_TOKEN is set', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin, requireProxyToken: true, proxyToken: 'secret-token-xyz' });
    const bad = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccmux-token': 'wrong' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'unauthorized' });
    const missing = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(missing.status).toBe(401);
    const good = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccmux-token': 'secret-token-xyz' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(good.status).toBe(200);
    // Token must be stripped outbound.
    const sent = up.requests[up.requests.length - 1]!;
    expect(sent.headers['x-ccmux-token']).toBeUndefined();
  });

  it('accepts requests without the header when CCMUX_PROXY_TOKEN is unset (debug mode)', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin, requireProxyToken: false });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(200);
  });

  it('redacts x-ccmux-token from every log line', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    process.env.UPSTREAM_ORIGIN = up.origin;
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
    });
    const logger = pino(
      { level: 'info', redact: { paths: ['req.headers["x-ccmux-token"]', 'headers["x-ccmux-token"]'], censor: '[REDACTED]' } },
      stream,
    );
    const app = await createProxyServer({ port: 0, logger, config: defaultConfig(), requireProxyToken: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = app.server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ccmux-token': 'REAL-SECRET-VALUE' },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      const combined = lines.join('\n');
      expect(combined).not.toContain('REAL-SECRET-VALUE');
    } finally {
      await app.close();
      delete process.env.UPSTREAM_ORIGIN;
    }
  });
});
