// Body splice tests: parse-then-stringify semantic equivalence, unknown fields, cache_control preserved, bodyLimit.
import { describe, it, expect, afterEach } from 'vitest';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

describe('body', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  async function post(body: unknown, init: RequestInit = {}): Promise<Response> {
    return fetch(`${proxy!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
  }

  it('produces a forwarded body with JSON parsed-then-stringified semantic equivalence (original model field unchanged in Phase 0)', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const original = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
    await post(original);
    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
    expect(sent.model).toBe(original.model);
    expect(sent).toEqual(original);
  });

  it('preserves unknown top-level fields in the request body through round-trip', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const original = { model: 'm', messages: [], future_field: { nested: [1, 2, 3] }, other: 'x' };
    await post(original);
    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
    expect(sent).toEqual(original);
  });

  it('never strips or reorders cache_control markers on message blocks', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const original = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'more' },
          ],
        },
      ],
    };
    await post(original);
    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.messages[0].content).toEqual(original.messages[0]!.content);
  });

  it('rejects body > bodyLimit with 413 and a clear error (no silent truncation)', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end(''); });
    proxy = await buildProxy({ upstreamOrigin: up.origin, bodyLimit: 1024 });
    const huge = 'x'.repeat(2048);
    const resp = await post({ model: 'm', messages: [], big: huge });
    expect(resp.status).toBe(413);
    const json = await resp.json();
    expect(json).toEqual({ error: 'payload-too-large' });
  });

  it('non-application/json content-type falls through to passthrough path without crashing', async () => {
    up = await startUpstreamMock(({ req, res, rawBody }) => {
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/plain' });
      res.end(rawBody);
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain text body',
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('plain text body');
  });
});
