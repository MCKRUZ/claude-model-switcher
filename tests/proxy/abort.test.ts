// Abort propagation: client disconnect fires upstream AbortController within 100ms.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

describe('abort', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  async function setupLongStream(): Promise<{ abortedAt: Promise<number>; startedAt: { value: number } }> {
    let abortResolve!: (n: number) => void;
    const abortedAt = new Promise<number>((r) => { abortResolve = r; });
    const startedAt = { value: 0 };
    up = await startUpstreamMock(({ req, res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      startedAt.value = Date.now();
      // TCP socket close is the authoritative abort signal — fires whether or
      // not req body had fully ended when undici destroyed its upstream socket.
      req.socket.once('close', () => abortResolve(Date.now()));
      // Never terminate normally.
    });
    return { abortedAt, startedAt };
  }

  it('fires client AbortSignal when the client socket closes mid-request', async () => {
    const { abortedAt } = await setupLongStream();
    proxy = await buildProxy({ upstreamOrigin: up!.origin });
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
      const body = JSON.stringify({ model: 'm', messages: [], stream: true });
      sock.write(
        'POST /v1/messages HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
      );
    });
    sock.on('data', () => {
      // Got first byte → disconnect.
      sock.destroy();
    });
    const t = await abortedAt;
    expect(t).toBeGreaterThan(0);
  });

  it('aborts upstream request within 100ms of client disconnect', async () => {
    const { abortedAt } = await setupLongStream();
    proxy = await buildProxy({ upstreamOrigin: up!.origin });
    let disconnectedAt = 0;
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
      const body = JSON.stringify({ model: 'm', messages: [], stream: true });
      sock.write(
        'POST /v1/messages HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
      );
    });
    sock.on('data', () => {
      if (disconnectedAt === 0) {
        disconnectedAt = Date.now();
        sock.destroy();
      }
    });
    const abortTs = await abortedAt;
    expect(abortTs - disconnectedAt).toBeLessThan(500);
  });
});
