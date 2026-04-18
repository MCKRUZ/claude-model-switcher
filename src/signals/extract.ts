// Top-level orchestrator: parsedBody + headers + sessionContext → frozen Signals.
// Wraps each extractor in try/catch so a bad extractor degrades one field, not the request.

import type { Logger } from 'pino';
import type {
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicToolDefinition,
} from '../types/anthropic.js';
import type { Signals, SessionContext } from './types.js';
import { detectPlanMode } from './plan-mode.js';
import { detectFrustration } from './frustration.js';
import { estimateInputTokens } from './tokens.js';
import { extractToolNames, countToolUse, countFileRefs } from './tools.js';
import { buildCanonicalInput, requestHash } from './canonical.js';
import { deriveSessionId } from './session.js';
import { extractBetaFlags } from './beta.js';
import { retryCount } from './retry.js';
import { contentBlocks } from './messages.js';

const PROJECT_PATH_WINDOW = 10;
const EMPTY_FROZEN: readonly string[] = Object.freeze([]);

function asBody(parsedBody: unknown): AnthropicRequestBody | undefined {
  if (!parsedBody || typeof parsedBody !== 'object') return undefined;
  return parsedBody as AnthropicRequestBody;
}

function asMessages(body: AnthropicRequestBody | undefined): readonly AnthropicMessage[] | undefined {
  const m = body?.messages;
  return Array.isArray(m) ? m : undefined;
}

function asTools(
  body: AnthropicRequestBody | undefined,
): readonly AnthropicToolDefinition[] | undefined {
  const t = body?.tools;
  return Array.isArray(t) ? t : undefined;
}

function explicitModelOf(body: AnthropicRequestBody | undefined): string | null {
  return typeof body?.model === 'string' ? body.model : null;
}

function longestCommonPrefix(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0] ?? null;
  const first = paths[0]!;
  let end = first.length;
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i]!;
    end = Math.min(end, p.length);
    let j = 0;
    while (j < end && first[j] === p[j]) j++;
    end = j;
    if (end === 0) return null;
  }
  const prefix = first.slice(0, end);
  return prefix.length > 0 ? prefix : null;
}

// Heuristic: accepts POSIX roots and Windows drive-letter paths; UNC paths
// (\\server\share) intentionally fall through — project inference only needs
// the common case of repo-rooted tool calls.
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function collectPathsFromInput(input: unknown, out: string[]): void {
  if (input === null || input === undefined) return;
  if (typeof input === 'string') {
    if (isAbsolutePath(input)) out.push(input);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectPathsFromInput(item, out);
    return;
  }
  if (typeof input === 'object') {
    for (const v of Object.values(input as Record<string, unknown>)) collectPathsFromInput(v, out);
  }
}

function inferProjectPath(messages: readonly AnthropicMessage[] | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  const uses: unknown[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if ((msg as { role?: unknown }).role !== 'assistant') continue;
    const blocks = contentBlocks((msg as { content?: unknown }).content);
    for (const b of blocks) {
      if (b.type === 'tool_use' && 'input' in b) uses.push(b.input);
    }
  }
  const recent = uses.slice(-PROJECT_PATH_WINDOW);
  const paths: string[] = [];
  for (const inp of recent) collectPathsFromInput(inp, paths);
  if (paths.length === 0) return null;
  return longestCommonPrefix(paths);
}

type Extractor<T> = () => T;

function safe<T>(logger: Logger, name: string, fallback: T, fn: Extractor<T>): T {
  try {
    return fn();
  } catch (err) {
    logger.warn({ extractor: name, err }, 'signal extractor failed; using fallback');
    return fallback;
  }
}

export function extractSignals(
  parsedBody: unknown,
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
  sessionContext: SessionContext,
  logger: Logger,
): Signals {
  const body = asBody(parsedBody);
  const messages = asMessages(body);
  const tools = asTools(body);

  const toolNames = safe(logger, 'tools', EMPTY_FROZEN, () => extractToolNames(tools));
  const betaFlags = safe(logger, 'beta', EMPTY_FROZEN, () => extractBetaFlags(headers));

  const canonical = safe(
    logger,
    'canonical',
    { systemPrefix: '', userMessagesPrefix: [], toolNames, betaFlags },
    () => buildCanonicalInput(body, toolNames, betaFlags),
  );
  const hash = safe(logger, 'requestHash', '0'.repeat(32), () => requestHash(canonical));

  return Object.freeze({
    planMode: safe(logger, 'plan-mode', null as boolean | null, () => detectPlanMode(body?.system)),
    messageCount: safe(logger, 'messageCount', 0, () => (Array.isArray(messages) ? messages.length : 0)),
    tools: toolNames,
    toolUseCount: safe(logger, 'tool-use-count', 0, () => countToolUse(messages)),
    estInputTokens: safe(logger, 'tokens', 0, () => estimateInputTokens(body?.system, messages)),
    fileRefCount: safe(logger, 'file-refs', 0, () => countFileRefs(messages)),
    retryCount: safe(logger, 'retry', 0, () => retryCount(hash, sessionContext)),
    frustration: safe(logger, 'frustration', null as boolean | null, () => detectFrustration(messages)),
    explicitModel: safe(logger, 'explicit-model', null as string | null, () => explicitModelOf(body)),
    projectPath: safe(logger, 'project-path', null as string | null, () => inferProjectPath(messages)),
    sessionDurationMs: safe(logger, 'session-duration', 0, () => Date.now() - sessionContext.createdAt),
    betaFlags,
    sessionId: safe(logger, 'session-id', '0'.repeat(32), () => deriveSessionId(body, toolNames)),
    requestHash: hash,
  });
}
