// POST /v1/messages hot path: raw-body, hijack, undici stream pipe to client socket.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { Writable } from 'node:stream';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
import { parseForSignals } from './body-splice.js';
import { streamRequest, type UpstreamResponseInfo } from './upstream.js';
import { wireAbort } from './abort.js';
import { emitSseError } from './errors.js';
import { passThrough } from './pass-through.js';

export interface HotPathDeps {
  readonly logger: Logger;
}

export function makeHotPathHandler(deps: HotPathDeps) {
  return async function hotPath(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toString().toLowerCase().includes('application/json')) {
      await passThrough(deps)(req, reply);
      return;
    }
    const raw = req.body as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw)) {
      await reply.code(400).send({ error: 'missing-body' });
      return;
    }
    const spliced = parseForSignals(raw);
    if (!spliced.ok) {
      await reply.code(400).send({ error: 'invalid-json', message: spliced.error.message });
      return;
    }
    const { buffer: outBody } = spliced.value;
    const outHeaders = filterRequestHeaders(req.raw.rawHeaders).rawHeaders;
    const path = buildUpstreamPath(req.url);
    void reply.hijack();
    const abortHandle = wireAbort(req, new AbortController());
    try {
      await streamRequest(
        {
          method: 'POST',
          path,
          headers: outHeaders,
          body: outBody,
          signal: abortHandle.controller.signal,
        },
        (info) => writeResponseHead(reply, info, deps.logger),
      );
      abortHandle.markComplete();
    } catch (err: unknown) {
      handleStreamError(reply, err, deps.logger);
    } finally {
      abortHandle.dispose();
    }
  };
}

function buildUpstreamPath(url: string): string {
  // Reject absolute-form URIs or anything not starting with '/'. Node's HTTP
  // parser normalizes request lines to origin-form, but this is defense-in-depth
  // against future parser changes or odd clients.
  if (!url.startsWith('/')) return '/';
  return url;
}

function writeResponseHead(reply: FastifyReply, info: UpstreamResponseInfo, logger: Logger): Writable {
  const filtered = filterResponseHeaders(info.rawHeaders).rawHeaders;
  const raw = reply.raw;
  if (!raw.headersSent) {
    raw.writeHead(info.statusCode, filtered);
  }
  raw.flushHeaders();
  if (raw.socket && typeof raw.socket.setNoDelay === 'function') {
    raw.socket.setNoDelay(true);
  }
  // Proxy writable: forwards writes to raw, ends raw on normal completion.
  // On error (upstream RST mid-stream), emit a synthetic SSE error event if
  // headers were already sent, then destroy raw to free the client socket.
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      raw.write(chunk, (err) => cb(err ?? null));
    },
    final(cb) {
      raw.end();
      cb();
    },
    destroy(err, cb) {
      if (err && raw.headersSent && !raw.writableEnded) {
        emitSseError(raw, err, logger);
      }
      raw.destroy(err ?? undefined);
      cb(err);
    },
  });
}

function handleStreamError(reply: FastifyReply, err: unknown, logger: Logger): void {
  const raw = reply.raw;
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  if (raw.headersSent) {
    emitSseError(raw, err, logger);
    return;
  }
  try {
    raw.writeHead(502, { 'content-type': 'application/json' });
    raw.end(JSON.stringify({ error: 'upstream-unavailable', detail: msg }));
  } catch (_err: unknown) {
    // Response socket already destroyed.
  }
  logger.error({ causeKind: err instanceof Error ? err.name : typeof err, detail: msg }, 'upstream request failed');
}
