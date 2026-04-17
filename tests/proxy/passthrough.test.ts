// Generic /v1/* passthrough: query, method, body, structured log line.
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { AddressInfo } from 'node:net';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { createProxyServer } from '../../src/proxy/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

describe('passthrough', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('GET /v1/models?foo=bar preserves foo=bar on upstream request', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/models?foo=bar&baz=qux`);
    expect(resp.status).toBe(200);
    expect(up.requests[0]!.url).toBe('/v1/models?foo=bar&baz=qux');
  });

  it('forwards path, method, and query string verbatim for non-/v1/messages routes', async () => {
    up = await startUpstreamMock(({ req, res }) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-method': req.method ?? '' });
      res.end('{}');
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/complete?x=1`, { method: 'DELETE' });
    expect(resp.status).toBe(200);
    expect(up.requests[0]!.method).toBe('DELETE');
    expect(up.requests[0]!.url).toBe('/v1/complete?x=1');
  });

  it('does not parse request body on passthrough routes', async () => {
    up = await startUpstreamMock(({ rawBody, res }) => { res.writeHead(200); res.end(rawBody); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const resp = await fetch(`${proxy.baseUrl}/v1/arbitrary`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    expect(resp.status).toBe(200);
    const got = Buffer.from(await resp.arrayBuffer());
    expect(Buffer.compare(got, payload)).toBe(0);
    expect(Buffer.compare(up.requests[0]!.body, payload)).toBe(0);
  });

  it('emits one structured log line per passthrough request', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    process.env.UPSTREAM_ORIGIN = up.origin;
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const logger = pino({ level: 'info' }, stream);
    const app = await createProxyServer({ port: 0, logger, config: defaultConfig() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = app.server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${addr.port}/v1/models`);
      const structured = lines
        .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((x): x is Record<string, unknown> => x !== null)
        .filter((x) => x['path'] === '/v1/models' && typeof x['upstreamStatus'] === 'number');
      expect(structured.length).toBe(1);
      expect(structured[0]!['method']).toBe('GET');
      expect(typeof structured[0]!['durationMs']).toBe('number');
    } finally {
      await app.close();
      delete process.env.UPSTREAM_ORIGIN;
    }
  });
});
