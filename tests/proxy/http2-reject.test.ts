// HTTP/2 prior-knowledge rejection → 505.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'utf8');

describe('http2-reject', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('rejects HTTP/2 prior-knowledge request with 505', async () => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: proxy!.port }, () => {
        // Send HTTP/2 preface then a standard GET following (server should treat first line as invalid HTTP/1.1).
        sock.write(H2_PREFACE);
      });
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
      setTimeout(() => { try { sock.end(); } catch { /* ignore */ } }, 500);
    });
    expect(response).toMatch(/505/);
  });
});
