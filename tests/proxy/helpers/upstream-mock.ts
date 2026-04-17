// Local HTTP upstream mock used by proxy tests. Replays SSE fixtures with inter-chunk delays.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';

export interface FixtureNonStreaming {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface SseLine {
  ts: number;
  event: string;
  data: string;
}

export interface UpstreamHandlerCtx {
  req: IncomingMessage;
  res: ServerResponse;
  rawBody: Buffer;
}

export type UpstreamHandler = (ctx: UpstreamHandlerCtx) => Promise<void> | void;

export interface UpstreamMock {
  origin: string;
  port: number;
  close: () => Promise<void>;
  requests: RecordedRequest[];
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: Buffer;
  aborted: boolean;
}

export async function startUpstreamMock(handler: UpstreamHandler): Promise<UpstreamMock> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('aborted', () => { aborted = true; });
    req.on('close', () => {
      if (!req.complete) aborted = true;
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body,
        aborted,
      };
      requests.push(recorded);
      Promise.resolve(handler({ req, res, rawBody: body })).catch(() => {
        if (!res.writableEnded) res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        const s = server as http.Server & { closeAllConnections?: () => void };
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function loadNonStreamingFixture(path: string): FixtureNonStreaming {
  const txt = readFileSync(path, 'utf8');
  return JSON.parse(txt) as FixtureNonStreaming;
}

export function loadSseFixture(path: string): SseLine[] {
  const txt = readFileSync(path, 'utf8').trim();
  return txt
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SseLine);
}

export function sseBytes(lines: SseLine[]): Buffer {
  const parts = lines.map((l) =>
    Buffer.from(`event: ${l.event}\ndata: ${l.data}\n\n`, 'utf8'),
  );
  return Buffer.concat(parts);
}

export async function replaySse(res: ServerResponse, lines: SseLine[]): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let prev = 0;
  for (const line of lines) {
    const delay = Math.max(0, line.ts - prev);
    prev = line.ts;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    res.write(`event: ${line.event}\n`);
    res.write(`data: ${line.data}\n\n`);
  }
  res.end();
}

export function respondNonStreaming(res: ServerResponse, fx: FixtureNonStreaming): void {
  const bodyStr = JSON.stringify(fx.body);
  const headers = { ...fx.headers };
  res.writeHead(fx.status, headers);
  res.end(bodyStr);
}
