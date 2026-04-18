// Frustration-phrase detection on the most recent user message.
// Case-insensitive, word-boundary match. Trigger phrases from plan §7.1.

import { lastUserMessage } from './messages.js';

const PATTERNS: readonly RegExp[] = [
  /\bno\b/i,
  /\bstop\b/i,
  /\bwhy did you\b/i,
  /\bthat'?s wrong\b/i,
];

export function detectFrustration(messages: readonly unknown[] | undefined): boolean | null {
  const text = lastUserMessage(messages);
  if (text === null) return null;
  if (text.length === 0) return false;
  return PATTERNS.some((re) => re.test(text));
}
