// Phase 0 body splice: identity parse + re-serialize. Phase 1 hooks model rewrite here.
import { ok, fail, type Result } from '../types/result.js';

export interface SpliceError {
  readonly code: 'parse-failed' | 'invalid-body';
  readonly message: string;
}

export interface SpliceOutput {
  readonly parsed: unknown;
  readonly buffer: Buffer;
}

export function parseForSignals(raw: Buffer): Result<SpliceOutput, SpliceError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail({ code: 'parse-failed', message: msg });
  }
  const buffer = Buffer.from(JSON.stringify(parsed));
  return ok({ parsed, buffer });
}

export function spliceModel(parsed: unknown, modelId: string): Buffer {
  const body = { ...(parsed as Record<string, unknown>), model: modelId };
  return Buffer.from(JSON.stringify(body));
}
