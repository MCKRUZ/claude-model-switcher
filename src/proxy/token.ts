// Optional x-ccmux-token gate, constant-time comparison.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface TokenCheckResult {
  readonly ok: boolean;
}

export function checkProxyToken(req: FastifyRequest, expectedToken: string): TokenCheckResult {
  const got = req.headers['x-ccmux-token'];
  const gotStr = Array.isArray(got) ? got[0] : got;
  if (typeof gotStr !== 'string' || gotStr.length === 0) return { ok: false };
  const a = Buffer.from(gotStr);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return { ok: false };
  return { ok: timingSafeEqual(a, b) };
}
