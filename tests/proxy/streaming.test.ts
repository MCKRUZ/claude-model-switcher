// Streaming response properties: Nagle off, no content-length on SSE, no compression middleware.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import net from 'node:net';
import { loadSseFixture, replaySse, startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';

const SSE_DIR = join(process.cwd(), 'tests', 'fixtures', 'sse');

describe('streaming', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('sets reply.raw.socket.setNoDelay(true)', async () => {
    const origSetNoDelay = net.Socket.prototype.setNoDelay;
    const calls: boolean[] = [];
    net.Socket.prototype.setNoDelay = function (v?: boolean) {
      if (v === true) calls.push(true);
      return origSetNoDelay.call(this, v);
    };
    try {
      const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
      up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
      proxy = await buildProxy({ upstreamOrigin: up.origin });
      const req = buildRequest({
        method: 'POST',
        path: '/v1/messages',
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      const { done } = streamRawRequest(proxy.port, req);
      await done;
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      net.Socket.prototype.setNoDelay = origSetNoDelay;
    }
  });

  it('does not set Content-Length on SSE responses (chunked encoding only)', async () => {
    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const { done } = streamRawRequest(proxy.port, req);
    const resp = parseRawResponse(await done);
    expect(resp.headers['content-length']).toBeUndefined();
    expect((resp.headers['transfer-encoding'] as string | undefined)?.toLowerCase()).toBe('chunked');
  });

  it('registers no gzip/br middleware on the response path', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    // Fastify keeps registered plugins in a symbol-based registry — assert via printPlugins.
    const plugins = proxy.app.printPlugins();
    expect(plugins).not.toMatch(/compress/i);
    // Assert instance has no compress decorator.
    expect(proxy.app.hasDecorator('compress')).toBe(false);
  });
});
