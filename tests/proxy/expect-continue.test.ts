// Expect: 100-continue end-to-end.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { parseRawResponse } from './helpers/http-client.js';

describe('expect-continue', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('handles Expect: 100-continue end-to-end without hang', async () => {
    up = await startUpstreamMock(({ rawBody, res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: rawBody.length }));
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }), 'utf8');
    const headers = [
      'POST /v1/messages HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Expect: 100-continue',
      `Content-Length: ${body.length}`,
      '',
      '',
    ].join('\r\n');

    const result = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const sock = net.connect({ host: '127.0.0.1', port: proxy!.port }, () => {
        sock.write(headers);
      });
      let continued = false;
      sock.on('data', (c: Buffer) => {
        chunks.push(c);
        if (!continued && Buffer.concat(chunks).toString('utf8').includes('100 Continue')) {
          continued = true;
          sock.write(body);
        }
      });
      sock.on('end', () => resolve(Buffer.concat(chunks)));
      sock.on('close', () => resolve(Buffer.concat(chunks)));
      sock.on('error', reject);
      setTimeout(() => {
        // Fallback: if server does NOT send a 100-continue, fastify may still accept the body — send anyway.
        if (!continued) { continued = true; sock.write(body); }
      }, 200);
      setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 1500);
    });

    // Find the final response (after optional 100 Continue chunk).
    const text = result.toString('utf8');
    const lastStart = text.lastIndexOf('HTTP/1.1 ');
    const finalChunk = Buffer.from(text.slice(lastStart), 'utf8');
    const resp = parseRawResponse(finalChunk);
    expect(resp.status).toBe(200);
    const parsed = JSON.parse(resp.body.toString('utf8'));
    expect(parsed.echoed).toBe(body.length);
  }, 10000);
});
