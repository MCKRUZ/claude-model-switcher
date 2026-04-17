// Generic /v1/* passthrough: any method, streams req.raw as upstream body, no body parse.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { Writable } from 'node:stream';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
import { streamRequest, type UpstreamResponseInfo } from './upstream.js';
import { wireAbort } from './abort.js';
import { emitSseError } from './errors.js';

export interface PassThroughDeps {
  readonly logger: Logger;
}

export function passThrough(deps: PassThroughDeps) {
  return async function passthroughHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const started = Date.now();
    const method = req.raw.method ?? 'GET';
    const path = buildUpstreamPath(req.url);
    const outHeaders = filterRequestHeaders(req.raw.rawHeaders).rawHeaders;
    const body = hasRequestBody(req) ? req.raw : undefined;
    void reply.hijack();
    const abortHandle = wireAbort(req, new AbortController());
    let upstreamStatus = 0;
    try {
      await streamRequest(
        { method, path, headers: outHeaders, body, signal: abortHandle.controller.signal },
        (info) => {
          upstreamStatus = info.statusCode;
          return writePassthroughHead(reply, info);
        },
      );
      abortHandle.markComplete();
    } catch (err: unknown) {
      handlePassthroughError(reply, err, deps.logger);
    } finally {
      abortHandle.dispose();
      deps.logger.info(
        { method, path: req.url, upstreamStatus, durationMs: Date.now() - started },
        'proxy passthrough',
      );
    }
  };
}

function buildUpstreamPath(url: string): string {
  if (!url.startsWith('/')) return '/';
  return url;
}

function hasRequestBody(req: FastifyRequest): boolean {
  const method = (req.raw.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const len = req.headers['content-length'];
  const te = req.headers['transfer-encoding'];
  return (typeof len === 'string' && Number(len) > 0) || typeof te === 'string';
}

function writePassthroughHead(reply: FastifyReply, info: UpstreamResponseInfo): Writable {
  const filtered = filterResponseHeaders(info.rawHeaders).rawHeaders;
  const raw = reply.raw;
  if (!raw.headersSent) {
    raw.writeHead(info.statusCode, filtered);
  }
  raw.flushHeaders();
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      raw.write(chunk, (err) => cb(err ?? null));
    },
    final(cb) {
      raw.end();
      cb();
    },
    destroy(err, cb) {
      cb(err);
    },
  });
}

function handlePassthroughError(reply: FastifyReply, err: unknown, logger: Logger): void {
  const raw = reply.raw;
  if (raw.headersSent) {
    emitSseError(raw, err, logger);
    return;
  }
  try {
    raw.writeHead(502, { 'content-type': 'application/json' });
    raw.end(JSON.stringify({ error: 'upstream-unavailable' }));
  } catch (_err: unknown) {
    // Already ended.
  }
}
