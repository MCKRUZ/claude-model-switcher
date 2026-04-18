// Session ID resolver. Prefers metadata.user_id when valid, else HMAC of canonical input.
// Uses a process-local salt generated at module load; never persisted.

import { createHmac, randomBytes } from 'node:crypto';
import type { AnthropicRequestBody } from '../types/anthropic.js';
import { firstUserMessage, flattenText } from './messages.js';
import { stableStringify } from './canonical.js';

const MAX_USER_ID_LEN = 256;
// Printable ASCII (space to tilde). Anchored so newlines/control chars reject.
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const SYSTEM_PREFIX_CAP = 4096;
const FIRST_USER_CAP = 4096;

// Module-local secret. Discarded on process exit; not re-derivable from any public input.
let localSalt: Buffer | null = null;

function getSalt(): Buffer {
  if (localSalt === null) localSalt = randomBytes(32);
  return localSalt;
}

/** Test-only: reset the module salt. NOT exported publicly outside tests. */
export function __resetLocalSaltForTests(): void {
  localSalt = null;
}

function isValidUserId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw.length === 0 || raw.length > MAX_USER_ID_LEN) return false;
  return PRINTABLE_ASCII.test(raw);
}

export function deriveSessionId(
  body: AnthropicRequestBody | undefined,
  toolNames: readonly string[],
): string {
  const userId = body?.metadata?.user_id;
  if (isValidUserId(userId)) return userId;

  const systemPrefix = flattenText(body?.system).slice(0, SYSTEM_PREFIX_CAP);
  const firstUserPrefix = (firstUserMessage(body?.messages) ?? '').slice(0, FIRST_USER_CAP);
  const canonicalInput = {
    systemPrefix,
    firstUserPrefix,
    toolNames: [...toolNames].sort(),
  };
  const hmac = createHmac('sha256', getSalt()).update(stableStringify(canonicalInput));
  return hmac.digest('hex').slice(0, 32);
}
