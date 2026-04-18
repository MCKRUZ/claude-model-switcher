// Tool list, tool_use count, and file-reference count.

import type { AnthropicMessage, AnthropicToolDefinition, ContentBlock } from '../types/anthropic.js';
import { contentBlocks } from './messages.js';

const FILE_REF_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'write',
  'edit',
  // Current Anthropic-canonical equivalents used by Claude Code.
  'str_replace_editor',
  'str_replace_based_edit_tool',
]);

export function extractToolNames(
  tools: readonly AnthropicToolDefinition[] | undefined,
): readonly string[] {
  if (!Array.isArray(tools)) return Object.freeze([]);
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = (t as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) seen.add(name);
  }
  return Object.freeze(Array.from(seen).sort());
}

export function countToolUse(messages: readonly AnthropicMessage[] | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if ((msg as { role?: unknown }).role !== 'assistant') continue;
    const blocks = contentBlocks((msg as { content?: unknown }).content);
    for (const b of blocks) if (b.type === 'tool_use') n++;
  }
  return n;
}

export function countFileRefs(messages: readonly AnthropicMessage[] | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if ((msg as { role?: unknown }).role !== 'assistant') continue;
    const blocks = contentBlocks((msg as { content?: unknown }).content);
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      const name = (b as ContentBlock).name;
      if (typeof name === 'string' && FILE_REF_TOOL_NAMES.has(name)) n++;
    }
  }
  return n;
}
