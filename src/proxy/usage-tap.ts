// Taps into the response stream to extract usage fields without buffering.
// SSE: scans for message_start (input tokens, model) and message_delta (output tokens).
// JSON: accumulates the body and parses usage from the top-level object.

import { Writable } from 'node:stream';
import { parseUsage, modelFromMessageStart } from '../decisions/cost.js';
import type { UsageFields } from '../decisions/types.js';

export interface UsageInfo {
  readonly usage: UsageFields;
  readonly upstreamModel: string | null;
}

export interface UsageTapResult {
  readonly writable: Writable;
  readonly usage: Promise<UsageInfo | null>;
}

export function createUsageTap(downstream: Writable, contentType: string): UsageTapResult {
  if (contentType.toLowerCase().includes('text/event-stream')) {
    return createSseTap(downstream);
  }
  return createJsonTap(downstream);
}

export function extractContentType(rawHeaders: readonly string[]): string {
  for (let i = 0; i < rawHeaders.length - 1; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === 'content-type') return rawHeaders[i + 1]!;
  }
  return '';
}

interface SseAccumulator {
  residual: string;
  currentEvent: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  upstreamModel: string | null;
}

function newSseAccumulator(): SseAccumulator {
  return { residual: '', currentEvent: '', inputTokens: null, outputTokens: null, cacheRead: null, cacheCreate: null, upstreamModel: null };
}

function processSseLine(acc: SseAccumulator, line: string): void {
  if (line.startsWith('event:')) { acc.currentEvent = line.slice(6).trim(); return; }
  if (!line.startsWith('data:')) return;
  if (acc.currentEvent !== 'message_start' && acc.currentEvent !== 'message_delta') return;
  const json = line.slice(5).trim();
  if (!json) return;
  try {
    const parsed = JSON.parse(json);
    if (acc.currentEvent === 'message_start') {
      acc.upstreamModel = modelFromMessageStart(parsed);
      const fields = parseUsage(parsed?.message?.usage);
      if (fields) {
        acc.inputTokens = fields.input_tokens;
        acc.cacheRead = fields.cache_read_input_tokens;
        acc.cacheCreate = fields.cache_creation_input_tokens;
      }
    } else {
      const fields = parseUsage(parsed?.usage);
      if (fields?.output_tokens !== null && fields?.output_tokens !== undefined) {
        acc.outputTokens = fields.output_tokens;
      }
    }
  } catch { /* malformed JSON */ }
}

function processChunk(acc: SseAccumulator, chunk: Buffer): void {
  const text = acc.residual + chunk.toString('utf8');
  const lines = text.split('\n');
  acc.residual = lines.pop()!;
  for (const line of lines) processSseLine(acc, line);
}

function buildSseResult(acc: SseAccumulator): UsageInfo | null {
  if (acc.inputTokens === null && acc.outputTokens === null && acc.cacheRead === null && acc.cacheCreate === null) {
    return null;
  }
  return {
    usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens, cache_read_input_tokens: acc.cacheRead, cache_creation_input_tokens: acc.cacheCreate },
    upstreamModel: acc.upstreamModel,
  };
}

function createSseTap(downstream: Writable): UsageTapResult {
  const acc = newSseAccumulator();
  let resolved = false;
  let resolveUsage!: (info: UsageInfo | null) => void;
  const usagePromise = new Promise<UsageInfo | null>((r) => { resolveUsage = r; });

  function settle(): void {
    if (resolved) return;
    resolved = true;
    resolveUsage(buildSseResult(acc));
  }

  const writable = new Writable({
    write(chunk: Buffer, enc, cb) {
      processChunk(acc, chunk);
      downstream.write(chunk, enc, (err) => cb(err ?? null));
    },
    final(cb) {
      if (acc.residual) processSseLine(acc, acc.residual);
      settle();
      downstream.end(() => cb());
    },
    destroy(err, cb) { settle(); downstream.destroy(err ?? undefined); cb(err); },
  });
  return { writable, usage: usagePromise };
}

function createJsonTap(downstream: Writable): UsageTapResult {
  const chunks: Buffer[] = [];
  const MAX_BUFFER = 1024 * 1024;
  let totalBytes = 0;
  let overflowed = false;
  let resolved = false;
  let resolveUsage!: (info: UsageInfo | null) => void;
  const usagePromise = new Promise<UsageInfo | null>((r) => { resolveUsage = r; });

  function settle(): void {
    if (resolved) return;
    resolved = true;
    if (overflowed || chunks.length === 0) { resolveUsage(null); return; }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const usage = parseUsage(body?.usage);
      if (!usage) { resolveUsage(null); return; }
      const model = typeof body?.model === 'string' ? body.model : null;
      resolveUsage({ usage, upstreamModel: model });
    } catch { resolveUsage(null); }
  }

  const writable = new Writable({
    write(chunk: Buffer, enc, cb) {
      if (!overflowed) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BUFFER) { overflowed = true; chunks.length = 0; }
        else chunks.push(chunk);
      }
      downstream.write(chunk, enc, (err) => cb(err ?? null));
    },
    final(cb) { settle(); downstream.end(() => cb()); },
    destroy(err, cb) { settle(); downstream.destroy(err ?? undefined); cb(err); },
  });
  return { writable, usage: usagePromise };
}
