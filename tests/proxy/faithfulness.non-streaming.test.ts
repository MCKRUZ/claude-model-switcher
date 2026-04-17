// Non-streaming faithfulness: status, body, and rate-limit headers round-trip byte-equal.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { startUpstreamMock, loadNonStreamingFixture, respondNonStreaming, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'non-streaming');

describe('faithfulness.non-streaming', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('forwards POST /v1/messages with model: claude-sonnet-4-6 to upstream with the same model when no rule fires', async () => {
    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(200);
    expect(up.requests).toHaveLength(1);
    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
    expect(sent.model).toBe('claude-sonnet-4-6');
  });

  it('returns upstream 200 non-streaming JSON response byte-for-byte identical to fixture', async () => {
    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    const got = await resp.text();
    expect(got).toBe(JSON.stringify(fx.body));
    expect(resp.headers.get('x-request-id')).toBe('req_simple_01');
  });

  it('calls reply.hijack() before any body byte is written', async () => {
    const fx = loadNonStreamingFixture(join(FIXTURES, '200-simple.json'));
    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
    // buildProxy already listens, so addHook would throw. Build manually, add hook, then listen.
    const { createProxyServer } = await import('../../src/proxy/server.js');
    const { createLogger } = await import('../../src/logging/logger.js');
    const { defaultConfig } = await import('../../src/config/defaults.js');
    const { resetUpstreamAgent } = await import('../../src/proxy/upstream.js');
    process.env.UPSTREAM_ORIGIN = up.origin;
    const app = await createProxyServer({
      port: 0,
      logger: createLogger({ destination: 'stderr', level: 'silent' }),
      config: defaultConfig(),
      requireProxyToken: false,
    });
    let hijackCalledBeforeWrite = false;
    app.addHook('onRequest', (_req, reply, done) => {
      const origHijack = reply.hijack.bind(reply);
      reply.hijack = () => {
        hijackCalledBeforeWrite = true;
        return origHijack();
      };
      done();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    try {
      await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(hijackCalledBeforeWrite).toBe(true);
    } finally {
      await resetUpstreamAgent();
      await app.close();
      delete process.env.UPSTREAM_ORIGIN;
    }
  });

  it('returns upstream 4xx error body verbatim including request-id', async () => {
    const fx = loadNonStreamingFixture(join(FIXTURES, '400-validation.json'));
    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(400);
    expect(resp.headers.get('x-request-id')).toBe('req_bad_01');
    expect(await resp.text()).toBe(JSON.stringify(fx.body));
  });

  it('returns upstream 5xx error body verbatim', async () => {
    const body = { type: 'error', error: { type: 'api_error', message: 'boom' } };
    up = await startUpstreamMock(({ res }) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(502);
    expect(await resp.text()).toBe(JSON.stringify(body));
  });

  it('returns upstream 429 body and rate-limit headers verbatim', async () => {
    const fx = loadNonStreamingFixture(join(FIXTURES, '429-rate-limit.json'));
    up = await startUpstreamMock(({ res }) => respondNonStreaming(res, fx));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get('retry-after')).toBe('15');
    expect(resp.headers.get('anthropic-ratelimit-requests-remaining')).toBe('0');
    expect(resp.headers.get('anthropic-ratelimit-requests-limit')).toBe('100');
    expect(await resp.text()).toBe(JSON.stringify(fx.body));
  });
});
