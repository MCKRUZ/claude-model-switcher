// Raw HTTP client helpers for tests: wants raw bytes, duplicate headers, SSE chunks.
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';

export interface RawResponse {
  statusLine: string;
  status: number;
  rawHeaders: string[]; // name, value, name, value, ...
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export async function rawRequest(
  port: number,
  request: Buffer,
  opts: { host?: string; waitMs?: number } = {},
): Promise<RawResponse> {
  const host = opts.host ?? '127.0.0.1';
  return new Promise<RawResponse>((resolve, reject) => {
    const sock = netConnect({ host, port }, () => sock.write(request));
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => {
      try {
        resolve(parseRawResponse(Buffer.concat(chunks)));
      } catch (err) {
        reject(err as Error);
      }
    });
    sock.on('error', reject);
  });
}

export function parseRawResponse(buf: Buffer): RawResponse {
  const sep = buf.indexOf(Buffer.from('\r\n\r\n'));
  const headPart = sep >= 0 ? buf.subarray(0, sep).toString('utf8') : buf.toString('utf8');
  const body = sep >= 0 ? buf.subarray(sep + 4) : Buffer.alloc(0);
  const lines = headPart.split('\r\n');
  const statusLine = lines[0] ?? '';
  const status = Number(statusLine.split(' ')[1] ?? 0);
  const rawHeaders: string[] = [];
  const headers: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    rawHeaders.push(name, value);
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  }
  // Handle chunked transfer encoding naively for test bodies.
  const te = (headers['transfer-encoding'] as string | undefined)?.toLowerCase();
  const finalBody = te === 'chunked' ? decodeChunked(body) : body;
  return { statusLine, status, rawHeaders, headers, body: finalBody };
}

export function decodeChunked(input: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    const crlf = input.indexOf(Buffer.from('\r\n'), offset);
    if (crlf < 0) break;
    const sizeHex = input.subarray(offset, crlf).toString('ascii').trim();
    const size = parseInt(sizeHex, 16);
    if (Number.isNaN(size)) break;
    offset = crlf + 2;
    if (size === 0) break;
    out.push(input.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(out);
}

export function buildRequest(opts: {
  method: string;
  path: string;
  host?: string;
  headers?: Array<[string, string]>;
  body?: Buffer | string;
}): Buffer {
  const host = opts.host ?? '127.0.0.1';
  const headerLines = [`${opts.method} ${opts.path} HTTP/1.1`, `Host: ${host}`];
  const provided = opts.headers ?? [];
  const hasContentLength = provided.some(([k]) => k.toLowerCase() === 'content-length');
  const hasConnection = provided.some(([k]) => k.toLowerCase() === 'connection');
  for (const [k, v] of provided) headerLines.push(`${k}: ${v}`);
  const bodyBuf = opts.body === undefined ? Buffer.alloc(0)
    : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  if (!hasContentLength && bodyBuf.length > 0) {
    headerLines.push(`Content-Length: ${bodyBuf.length}`);
  }
  // Force short-lived TCP connections in tests so raw-socket clients see end-of-stream.
  if (!hasConnection) headerLines.push('Connection: close');
  const head = headerLines.join('\r\n') + '\r\n\r\n';
  return Buffer.concat([Buffer.from(head, 'utf8'), bodyBuf]);
}

export function streamRawRequest(
  port: number,
  request: Buffer,
): { socket: Socket; done: Promise<Buffer> } {
  const sock = netConnect({ host: '127.0.0.1', port }, () => sock.write(request));
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('close', () => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
  });
  return { socket: sock, done };
}
