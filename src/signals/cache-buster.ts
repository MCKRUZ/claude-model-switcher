// Cache-buster detector. A Claude prompt-cache hit needs the cached prefix
// (tools, then system prompt) to be byte-identical between requests. A value
// that changes inside that prefix — a date, a time, a UUID, a hex id — makes
// every request a cache write.
//
// Each request's prefix is fingerprinted twice: raw, and with those values
// masked. A request whose masked fingerprint matches an earlier request's but
// whose raw fingerprint differs changed only by those values, so it is flagged
// with the kinds that changed.
//
// Read-only: the request body is never modified. No prompt text leaves this
// module — only HMAC-SHA256 fingerprints (salted per process, never persisted,
// so they cannot be compared across restarts or reversed) and kind labels.
// State is a bounded in-memory map; detection is per process by design.

import { createHmac, randomBytes } from 'node:crypto';
import type { AnthropicRequestBody } from '../types/anthropic.js';
import { stableStringify } from './canonical.js';
import { flattenText } from './messages.js';
import {
  CACHE_BUSTER_KINDS,
  type CacheBusterFinding,
  type CacheBusterKind,
} from './types.js';

export const CACHE_BUSTER_MAX_ENTRIES = 512;

const FINGERPRINT_LEN = 32;
const HEX_ID_MIN_LEN = 16;
const SYSTEM_SEPARATOR = '\n\u0002system\u0002\n';

interface MaskRule {
  readonly kind: CacheBusterKind;
  readonly pattern: RegExp;
  readonly accepts?: (value: string) => boolean;
}

// Order matters: UUIDs before anything built from digits; dates before times
// so the date part of an ISO-8601 date-time is consumed first; hex ids last.
const MASK_RULES: readonly MaskRule[] = [
  {
    kind: 'uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  { kind: 'date', pattern: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g },
  {
    kind: 'time',
    pattern: /(?<![\d:.])\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d:])/g,
  },
  {
    kind: 'hex_id',
    pattern: new RegExp(`\\b[0-9a-f]{${HEX_ID_MIN_LEN},}\\b`, 'gi'),
    // A run of letters a-f only is a word, not an id.
    accepts: (value) => /\d/.test(value),
  },
];

type KindValues = Record<CacheBusterKind, string[]>;
type KindFingerprints = Readonly<Record<CacheBusterKind, string>>;

interface Seen {
  readonly raw: string;
  readonly kinds: KindFingerprints;
}

let localSalt: Buffer | null = null;
let seen = new Map<string, Seen>();

function getSalt(): Buffer {
  if (localSalt === null) localSalt = randomBytes(32);
  return localSalt;
}

/** Test-only: drop the module salt and all remembered prefixes. */
export function __resetCacheBusterForTests(): void {
  localSalt = null;
  seen = new Map();
}

function hmacHex(input: string): string {
  return createHmac('sha256', getSalt()).update(input).digest('hex');
}

function cachedPrefix(body: AnthropicRequestBody | undefined): string | null {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const system = flattenText(body?.system);
  if (tools.length === 0 && system.length === 0) return null;
  return tools.map((t) => stableStringify(t)).join('\n') + SYSTEM_SEPARATOR + system;
}

function maskVolatileValues(text: string): { masked: string; values: KindValues } {
  const values: KindValues = { date: [], time: [], uuid: [], hex_id: [] };
  let masked = text;
  for (const rule of MASK_RULES) {
    masked = masked.replace(rule.pattern, (value: string) => {
      if (rule.accepts !== undefined && !rule.accepts(value)) return value;
      values[rule.kind].push(value);
      return `\u0000${rule.kind}\u0000`;
    });
  }
  return { masked, values };
}

function fingerprintKinds(values: KindValues): KindFingerprints {
  const out = {} as Record<CacheBusterKind, string>;
  for (const kind of CACHE_BUSTER_KINDS) {
    out[kind] = hmacHex(`${kind}\u0001${JSON.stringify(values[kind])}`);
  }
  return out;
}

function remember(key: string, entry: Seen): void {
  seen.delete(key);
  seen.set(key, entry);
  if (seen.size <= CACHE_BUSTER_MAX_ENTRIES) return;
  const oldest = seen.keys().next();
  if (!oldest.done) seen.delete(oldest.value);
}

/**
 * Returns a finding when this request's cached prefix differs from an earlier
 * request's only by masked values, else null. Records the request either way.
 */
export function detectCacheBuster(
  body: AnthropicRequestBody | undefined,
): CacheBusterFinding | null {
  const prefix = cachedPrefix(body);
  if (prefix === null) return null;

  const { masked, values } = maskVolatileValues(prefix);
  const maskedFingerprint = hmacHex(masked);
  const current: Seen = { raw: hmacHex(prefix), kinds: fingerprintKinds(values) };
  const prior = seen.get(maskedFingerprint);
  remember(maskedFingerprint, current);

  if (prior === undefined || prior.raw === current.raw) return null;
  const changed = CACHE_BUSTER_KINDS.filter((k) => prior.kinds[k] !== current.kinds[k]);
  if (changed.length === 0) return null;
  return Object.freeze({
    kinds: Object.freeze(changed),
    prefix_fingerprint: maskedFingerprint.slice(0, FINGERPRINT_LEN),
  });
}
