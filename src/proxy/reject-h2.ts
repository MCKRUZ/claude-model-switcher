// HTTP/2 prior-knowledge rejection: replies 505 on clientError when the raw
// packet looks like the HTTP/2 connection preface ("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").
//
// Fastify (Node's http) runs HTTP/1.1; Node's parser rejects "PRI * HTTP/2.0"
// before any Fastify hook runs, so we prepend a clientError listener that
// matches the preface and responds 505. Anything else falls through to
// Fastify's default clientError handler.

import type { FastifyInstance } from 'fastify';

const H2_PREFACE_PREFIX = Buffer.from('PRI * HTTP/2', 'utf8');
const STATUS_LINE = 'HTTP/1.1 505 HTTP Version Not Supported';
const BODY = '{"error":"http2-not-supported","expected":"HTTP/1.1"}';

export function registerRejectHttp2(app: FastifyInstance): void {
  app.server.prependListener('clientError', (err, socket) => {
    const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
    if (!looksLikeH2Preface(rawPacket) || socket.destroyed) return;
    socket.end(
      `${STATUS_LINE}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(BODY)}\r\n` +
      `Connection: close\r\n\r\n` +
      BODY,
    );
  });

  // Belt-and-suspenders (spec §6.6 line 72): if Node's parser ever admits a
  // PRI request to the Fastify layer, reject at the first onRequest hook.
  app.addHook('onRequest', async (req, reply) => {
    if (req.raw.method === 'PRI') {
      await reply
        .code(505)
        .header('content-type', 'application/json')
        .send({ error: 'http2-not-supported', expected: 'HTTP/1.1' });
    }
  });
}

function looksLikeH2Preface(rawPacket: Buffer | undefined): boolean {
  if (rawPacket === undefined) return false;
  if (rawPacket.length < H2_PREFACE_PREFIX.length) return false;
  return rawPacket.subarray(0, H2_PREFACE_PREFIX.length).equals(H2_PREFACE_PREFIX);
}
