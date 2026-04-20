// Shared undici Agent + stream helper pointed at api.anthropic.com (or UPSTREAM_ORIGIN override).
import { Agent, Dispatcher } from 'undici';
import type { Writable } from 'node:stream';

let cachedAgent: Agent | undefined;
let lastOutboundHeaders: string[] | undefined;

function buildAgent(): Agent {
  return new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
}

export function getUpstreamAgent(): Agent {
  if (!cachedAgent) cachedAgent = buildAgent();
  return cachedAgent;
}

export async function resetUpstreamAgent(): Promise<void> {
  if (cachedAgent) {
    const a = cachedAgent;
    cachedAgent = undefined;
    await a.close().catch(() => undefined);
  }
}

export function __getLastOutboundHeaders(): readonly string[] | undefined {
  return lastOutboundHeaders;
}

export function resolveUpstreamOrigin(): string {
  return process.env.UPSTREAM_ORIGIN ?? 'https://api.anthropic.com';
}

export interface StreamRequestOpts {
  readonly method: string;
  readonly path: string;
  readonly headers: string[];
  readonly body?: Buffer | NodeJS.ReadableStream | undefined;
  readonly signal: AbortSignal;
}

export interface UpstreamResponseInfo {
  readonly statusCode: number;
  readonly rawHeaders: readonly string[];
}

export type StreamFactory = (info: UpstreamResponseInfo) => Writable;

export async function streamRequest(
  opts: StreamRequestOpts,
  factory: StreamFactory,
): Promise<void> {
  const origin = resolveUpstreamOrigin();
  const agent = getUpstreamAgent();
  lastOutboundHeaders = opts.headers;
  const reqOpts: Dispatcher.RequestOptions = {
    origin,
    method: opts.method as Dispatcher.HttpMethod,
    path: opts.path,
    headers: opts.headers,
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    (reqOpts as { body?: Buffer | NodeJS.ReadableStream }).body = opts.body;
  }
  await agent.stream(reqOpts, (data: Dispatcher.StreamFactoryData) => {
    const rawHeaders = (data as unknown as { rawHeaders?: Buffer[] }).rawHeaders;
    const raw = toRawHeaders(data.headers, rawHeaders);
    return factory({ statusCode: data.statusCode, rawHeaders: raw });
  });
}

function toRawHeaders(
  headers: Record<string, string | string[] | undefined>,
  rawHeaders: Buffer[] | undefined,
): string[] {
  if (rawHeaders && rawHeaders.length > 0) {
    return rawHeaders.map((b) => b.toString('utf8'));
  }
  const out: string[] = [];
  for (const k of Object.keys(headers)) {
    const v = headers[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.push(k, item);
    else out.push(k, v);
  }
  return out;
}
