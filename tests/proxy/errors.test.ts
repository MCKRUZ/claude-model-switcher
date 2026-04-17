// Synthetic SSE error emission and redaction on failure paths.
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';
import { emitSseError } from '../../src/proxy/errors.js';
import pino from 'pino';

describe('errors', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  it('emits a single synthetic Anthropic-shaped SSE event: error when upstream disconnects mid-stream, then closes client socket', async () => {
    up = await startUpstreamMock(({ req, res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => req.socket.destroy(), 30);
    });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const { done } = streamRawRequest(proxy.port, req);
    const body = parseRawResponse(await done).body.toString('utf8');
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: error\n');
    expect(body).toContain('"type":"api_error"');
    expect(body).toContain('upstream stream failed');
    const errCount = (body.match(/event: error\n/g) ?? []).length;
    expect(errCount).toBe(1);
  });

  it('synthetic SSE error message never contains auth data or raw upstream reason strings', async () => {
    const sink = new PassThrough();
    const collected: Buffer[] = [];
    sink.on('data', (c: Buffer) => collected.push(c));
    const logger = pino({ level: 'silent' });
    const cause = new Error('connection refused sk-leak-secret Bearer abc123');
    emitSseError(sink as unknown as Writable, cause, logger);
    await new Promise((r) => setImmediate(r));
    const out = Buffer.concat(collected).toString('utf8');
    expect(out).toContain('event: error');
    expect(out).toContain('upstream stream failed');
    expect(out).not.toContain('sk-leak-secret');
    expect(out).not.toContain('Bearer abc123');
    expect(out).not.toContain('connection refused');
  });

  it('logs via pino on each failure mode with request-id when available and no raw auth headers', async () => {
    const collected: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { collected.push(chunk.toString()); cb(); },
    });
    const logger = pino({ level: 'info' }, stream);
    emitSseError(new PassThrough() as unknown as Writable, new Error('boom'), logger);
    await new Promise((r) => setImmediate(r));
    const combined = collected.join('\n');
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).not.toMatch(/authorization/i);
    expect(combined).not.toMatch(/x-api-key/i);
  });
});
