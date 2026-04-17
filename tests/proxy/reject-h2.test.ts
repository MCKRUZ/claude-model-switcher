// reject-h2 module: positive (H2 preface → 505) + negative (HTTP/1.1 GET /healthz not rejected).
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'utf8');

function rawRequest(port: number, payload: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(payload));
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
    setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 500);
  });
}

describe('reject-h2', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('rejects HTTP/2 prior-knowledge preface with 505 and JSON body naming HTTP/1.1', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const response = await rawRequest(proxy.port, H2_PREFACE);
    expect(response).toMatch(/505/);
    expect(response).toMatch(/http2-not-supported/);
    expect(response).toMatch(/HTTP\/1\.1/);
  });

  it('does NOT reject an HTTP/1.1 GET /healthz (negative control)', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const addr = proxy.app.server.address() as AddressInfo;
    const resp = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});
