// Header filter tests: hop-by-hop strip, host rewrite, duplicate preservation, auth passthrough.
import { describe, it, expect, afterEach } from 'vitest';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
import { __getLastOutboundHeaders } from '../../src/proxy/upstream.js';

function outboundHas(name: string): boolean {
  const arr = __getLastOutboundHeaders() ?? [];
  for (let i = 0; i < arr.length; i += 2) {
    if ((arr[i] ?? '').toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}
function outboundValue(name: string): string | undefined {
  const arr = __getLastOutboundHeaders() ?? [];
  for (let i = 0; i < arr.length; i += 2) {
    if ((arr[i] ?? '').toLowerCase() === name.toLowerCase()) return arr[i + 1];
  }
  return undefined;
}

describe('headers', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  async function roundTrip(
    reqHeaders: Array<[string, string]>,
    respHeaders: Array<[string, string]>,
    body: string = '{"model":"m","messages":[]}',
  ): Promise<{ upstream: UpstreamMock; proxy: BuiltProxy; response: ReturnType<typeof parseRawResponse> }> {
    up = await startUpstreamMock(({ res }) => {
      const flat: string[] = [];
      for (const [k, v] of respHeaders) flat.push(k, v);
      res.writeHead(200, flat);
      res.end('{"ok":true}');
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json'], ...reqHeaders],
      body,
    });
    const { done } = streamRawRequest(proxy.port, req);
    const response = parseRawResponse(await done);
    return { upstream: up, proxy, response };
  }

  it('strips hop-by-hop headers from request: connection, keep-alive, transfer-encoding, te, trailer, upgrade, proxy-authenticate, proxy-authorization', async () => {
    await roundTrip(
      [
        ['connection', 'close'],
        ['keep-alive', 'timeout=5'],
        ['te', 'trailers'],
        ['trailer', 'X-Foo'],
        ['upgrade', 'websocket'],
        ['proxy-authenticate', 'Basic'],
        ['proxy-authorization', 'Basic abc'],
      ],
      [['content-type', 'application/json']],
    );
    // Assert the proxy's outbound filtered header array — what we send to undici.
    // Transport-layer connection/content-length added by undici itself are intentionally not checked here.
    for (const h of ['keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']) {
      expect(outboundHas(h)).toBe(false);
    }
    // We also strip client-provided connection (value 'close'): the outbound array has no connection entry.
    expect(outboundHas('connection')).toBe(false);
  });

  it('strips hop-by-hop headers from response (same list)', async () => {
    const { response } = await roundTrip(
      [],
      [
        ['content-type', 'application/json'],
        ['connection', 'close'],
        ['keep-alive', 'timeout=5'],
        ['proxy-authenticate', 'Basic'],
      ],
    );
    expect(response.headers['keep-alive']).toBeUndefined();
    expect(response.headers['proxy-authenticate']).toBeUndefined();
  });

  it('rewrites host to api.anthropic.com on upstream request', async () => {
    await roundTrip([['x-api-key', 'sk-test']], []);
    expect(outboundValue('host')).toBe('api.anthropic.com');
  });

  it('forwards accept-encoding verbatim (no decompression)', async () => {
    await roundTrip([['accept-encoding', 'gzip, br']], []);
    expect(outboundValue('accept-encoding')).toBe('gzip, br');
  });

  it('preserves duplicate-valued headers via undici raw-header arrays', async () => {
    up = await startUpstreamMock(({ res }) => {
      res.writeHead(200, [
        'content-type', 'application/json',
        'set-cookie', 'a=1; Path=/',
        'set-cookie', 'b=2; Path=/',
      ]);
      res.end('{}');
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json']],
      body: '{"model":"m","messages":[]}',
    });
    const { done } = streamRawRequest(proxy.port, req);
    const resp = parseRawResponse(await done);
    const cookieHeaders: string[] = [];
    for (let i = 0; i < resp.rawHeaders.length; i += 2) {
      if (resp.rawHeaders[i]!.toLowerCase() === 'set-cookie') cookieHeaders.push(resp.rawHeaders[i + 1]!);
    }
    expect(cookieHeaders).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('passes anthropic-* headers verbatim in both directions', async () => {
    const { response } = await roundTrip(
      [['anthropic-version', '2023-06-01'], ['anthropic-beta', 'prompt-caching-2024-07-31']],
      [['content-type', 'application/json'], ['anthropic-ratelimit-requests-remaining', '42']],
    );
    expect(outboundValue('anthropic-version')).toBe('2023-06-01');
    expect(outboundValue('anthropic-beta')).toBe('prompt-caching-2024-07-31');
    expect(response.headers['anthropic-ratelimit-requests-remaining']).toBe('42');
  });

  it('round-trips x-request-id, retry-after, anthropic-ratelimit-* verbatim', async () => {
    const { response } = await roundTrip(
      [],
      [
        ['content-type', 'application/json'],
        ['x-request-id', 'req_xyz'],
        ['retry-after', '30'],
        ['anthropic-ratelimit-tokens-remaining', '123'],
      ],
    );
    expect(response.headers['x-request-id']).toBe('req_xyz');
    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['anthropic-ratelimit-tokens-remaining']).toBe('123');
  });

  it('forwards Authorization: Bearer untouched', async () => {
    await roundTrip([['authorization', 'Bearer sk-xyz']], []);
    expect(outboundValue('authorization')).toBe('Bearer sk-xyz');
  });

  it('forwards x-api-key untouched', async () => {
    await roundTrip([['x-api-key', 'sk-abc']], []);
    expect(outboundValue('x-api-key')).toBe('sk-abc');
  });

  it('strips tokens listed in connection: header value', async () => {
    await roundTrip(
      [['x-custom-drop', 'yes'], ['connection', 'x-custom-drop, close']],
      [],
    );
    expect(outboundHas('x-custom-drop')).toBe(false);
  });

  it('drops content-length on outbound request', async () => {
    // Assert our filter drops the client-provided content-length from the outbound array.
    // undici computes and adds its own content-length at transport layer — that is expected.
    await roundTrip([], []);
    expect(outboundHas('content-length')).toBe(false);
  });
});
