// js-tiktoken cl100k token estimate. Routing heuristic, not exact.
// Counts joined text of system + all message content.

import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { AnthropicContent, AnthropicMessage } from '../types/anthropic.js';
import { flattenText } from './messages.js';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (encoder === null) encoder = getEncoding('cl100k_base');
  return encoder;
}

export function estimateInputTokens(
  system: AnthropicContent | undefined,
  messages: readonly AnthropicMessage[] | undefined,
): number {
  const parts: string[] = [];
  const sysText = flattenText(system);
  if (sysText.length > 0) parts.push(sysText);
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const t = flattenText((msg as { content?: AnthropicContent }).content);
      if (t.length > 0) parts.push(t);
    }
  }
  if (parts.length === 0) return 0;
  return getEncoder().encode(parts.join('\n')).length;
}
