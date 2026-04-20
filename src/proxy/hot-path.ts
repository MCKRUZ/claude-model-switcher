// POST /v1/messages hot path: raw-body, hijack, undici stream pipe to client socket.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { Writable } from 'node:stream';
import type { ConfigStore } from '../config/watcher.js';
import type { DecisionLogWriter } from '../decisions/log.js';
import type { CostContext } from '../decisions/cost.js';
import { computeCostUsd } from '../decisions/cost.js';
import type { UsageInfo } from './usage-tap.js';
import { createUsageTap, extractContentType, type UsageTapResult } from './usage-tap.js';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
import { parseForSignals, spliceModel } from './body-splice.js';
import { streamRequest, type UpstreamResponseInfo } from './upstream.js';
import { wireAbort } from './abort.js';
import { emitSseError } from './errors.js';
import { passThrough } from './pass-through.js';
import { routeRequest, buildDecisionRecord, createSessionContext, type RouteResult } from './route.js';

export interface HotPathDeps {
  readonly logger: Logger;
  readonly configStore?: ConfigStore;
  readonly decisionWriter?: DecisionLogWriter;
  readonly costContext?: CostContext;
}

export function makeHotPathHandler(deps: HotPathDeps) {
  const session = createSessionContext();
  const through = passThrough(deps);

  return async function hotPath(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toString().toLowerCase().includes('application/json')) {
      await through(req, reply);
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
    const routed = applyRouting(spliced.value.parsed, spliced.value.buffer, req, deps, session);
    const outHeaders = routed.rawHeaders;
    const path = buildUpstreamPath(req.url);
    void reply.hijack();
    const startMs = Date.now();
    const abortHandle = wireAbort(req, new AbortController());
    let usageTap: UsageTapResult | null = null;
    try {
      await streamRequest(
        { method: 'POST', path, headers: outHeaders, body: routed.body, signal: abortHandle.controller.signal },
        (info) => {
          const downstream = writeResponseHead(reply, info, deps.logger);
          const ct = extractContentType(info.rawHeaders);
          const tap = createUsageTap(downstream, ct);
          usageTap = tap;
          return tap.writable;
        },
      );
      abortHandle.markComplete();
    } catch (err: unknown) {
      handleStreamError(reply, err, deps.logger);
    } finally {
      abortHandle.dispose();
      const usageInfo = await resolveUsage(usageTap);
      logDecision(req, routed.route, deps, usageInfo, Date.now() - startMs);
    }
  };
}

interface RoutedBody {
  readonly body: Buffer;
  readonly rawHeaders: string[];
  readonly route: RouteResult | null;
}

function applyRouting(
  parsed: unknown,
  originalBuffer: Buffer,
  req: FastifyRequest,
  deps: HotPathDeps,
  session: ReturnType<typeof createSessionContext>,
): RoutedBody {
  const rawHeaders = filterRequestHeaders(req.raw.rawHeaders).rawHeaders;
  if (!deps.configStore) return { body: originalBuffer, rawHeaders, route: null };
  const config = deps.configStore.getCurrent();
  const headers = req.headers as Readonly<Record<string, string | string[] | undefined>>;
  const route = routeRequest(parsed, headers, config, session, deps.logger);
  if (route.forwardedModel === route.originalModel) {
    return { body: originalBuffer, rawHeaders, route };
  }
  const body = spliceModel(parsed, route.forwardedModel);
  return { body, rawHeaders: replaceContentLength(rawHeaders, body.length), route };
}

function replaceContentLength(rawHeaders: string[], newLength: number): string[] {
  const result = [...rawHeaders];
  for (let i = 0; i < result.length - 1; i += 2) {
    if (result[i]!.toLowerCase() === 'content-length') {
      result[i + 1] = String(newLength);
      return result;
    }
  }
  return result;
}

const USAGE_TIMEOUT_MS = 5000;

async function resolveUsage(tap: UsageTapResult | null): Promise<UsageInfo | null> {
  if (!tap) return null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), USAGE_TIMEOUT_MS));
  return Promise.race([tap.usage, timeout]);
}

function logDecision(
  req: FastifyRequest,
  route: RouteResult | null,
  deps: HotPathDeps,
  usageInfo: UsageInfo | null,
  latencyMs: number,
): void {
  if (!route || !deps.decisionWriter) return;
  const sessionId = (req.headers['x-claude-code-session-id'] as string) ?? 'unknown';
  const usage = usageInfo?.usage ?? null;
  const model = usageInfo?.upstreamModel ?? route.forwardedModel;
  const cost = deps.costContext ? computeCostUsd(model, usage, deps.costContext) : null;
  deps.decisionWriter.append(buildDecisionRecord(route, sessionId, latencyMs, usage, cost));
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
