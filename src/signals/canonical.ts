// Canonical request hash. Deterministic JSON → sha256 → 128-bit hex prefix.
// Explicitly excludes `model`, request IDs, timestamps, metadata.user_id.

import { createHash } from 'node:crypto';
import type { AnthropicRequestBody } from '../types/anthropic.js';
import { allUserMessages, flattenText } from './messages.js';

const PREFIX_CAP = 2048;
const USER_TAIL = 3;

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

interface CanonicalFields {
  readonly systemPrefix: string;
  readonly userMessagesPrefix: readonly string[];
  readonly toolNames: readonly string[];
  readonly betaFlags: readonly string[];
}

export function buildCanonicalInput(
  body: AnthropicRequestBody | undefined,
  toolNames: readonly string[],
  betaFlags: readonly string[],
): CanonicalFields {
  const sys = flattenText(body?.system).slice(0, PREFIX_CAP);
  const users = allUserMessages(body?.messages).slice(-USER_TAIL).map((t) => t.slice(0, PREFIX_CAP));
  return {
    systemPrefix: sys,
    userMessagesPrefix: users,
    toolNames: [...toolNames].sort(),
    betaFlags: [...betaFlags].sort(),
  };
}

export function requestHash(canonical: CanonicalFields): string {
  const serialized = stableStringify(canonical);
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

export { stableStringify };
