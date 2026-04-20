// Content-block flatten helpers. Tolerant of both string and ContentBlock[] shapes.

import type { AnthropicContent, ContentBlock } from '../types/anthropic.js';

export function flattenText(content: AnthropicContent | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

export function lastUserMessage(messages: readonly unknown[] | undefined): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const obj = msg as { role?: unknown; content?: unknown };
    if (obj.role !== 'user') continue;
    return flattenText(obj.content as AnthropicContent | undefined);
  }
  return null;
}

export function firstUserMessage(messages: readonly unknown[] | undefined): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const obj = msg as { role?: unknown; content?: unknown };
    if (obj.role !== 'user') continue;
    return flattenText(obj.content as AnthropicContent | undefined);
  }
  return null;
}

export function allUserMessages(messages: readonly unknown[] | undefined): readonly string[] {
  if (!messages || !Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const obj = msg as { role?: unknown; content?: unknown };
    if (obj.role !== 'user') continue;
    out.push(flattenText(obj.content as AnthropicContent | undefined));
  }
  return out;
}

export function contentBlocks(content: unknown): readonly ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ContentBlock => b != null && typeof b === 'object',
  );
}
