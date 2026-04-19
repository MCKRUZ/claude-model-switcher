// Privacy redaction for decision-log records.
//
// Three modes (config.logging.content):
//   hashed (default) — replace each content string / tool input with
//                       sha256(JSON.stringify(x)).slice(0, 12). Identical
//                       inputs collide intentionally so they remain
//                       linkable across log entries. Use `none` on shared
//                       machines where collision-linkability is a problem.
//   full              — log raw content. Auth headers are still redacted
//                       unconditionally at the pino layer (section-02).
//   none              — drop messages, tool inputs, and any content fields
//                       from extracted_signals entirely. Only metadata
//                       counts/shapes remain.
//
// Auth headers (authorization, x-api-key, x-ccmux-token) MUST NEVER appear
// in any record regardless of mode — this module never accepts headers and
// the pino layer enforces the same redaction independently.
//
// Privacy mode is config-only. No CLI flag toggles it (see redaction.test.ts).

import { createHash } from 'node:crypto';
import type { Signals } from '../signals/types.js';
import type { ContentMode } from '../config/schema.js';

const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'x-ccmux-token',
]);

export function hash12(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(json ?? '').digest('hex').slice(0, 12);
}

function ensureNoAuth(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) ensureNoAuth(item);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      throw new Error(`refusing to log forbidden header: ${key}`);
    }
    ensureNoAuth(nested);
  }
}

/**
 * Redact a Signals object for logging. Section-04 (proxy) is responsible for
 * any redaction of message bodies / tool-call inputs in the request body —
 * those are not part of Signals and never reach this function. This module
 * only governs what appears in extracted_signals on the decision record.
 */
export function redactSignals(
  signals: Signals,
  mode: ContentMode,
): Readonly<Record<string, unknown>> {
  if (mode === 'full') {
    return { ...signals };
  }
  if (mode === 'none') {
    return {
      planMode: signals.planMode,
      messageCount: signals.messageCount,
      toolCount: signals.tools.length,
      toolUseCount: signals.toolUseCount,
      estInputTokens: signals.estInputTokens,
      fileRefCount: signals.fileRefCount,
      retryCount: signals.retryCount,
      frustration: signals.frustration,
      sessionDurationMs: signals.sessionDurationMs,
      betaFlagCount: signals.betaFlags.length,
      sessionId: signals.sessionId,
      requestHash: signals.requestHash,
    };
  }
  // hashed (default)
  return {
    planMode: signals.planMode,
    messageCount: signals.messageCount,
    tools: signals.tools.map((t) => hash12(t)),
    toolUseCount: signals.toolUseCount,
    estInputTokens: signals.estInputTokens,
    fileRefCount: signals.fileRefCount,
    retryCount: signals.retryCount,
    frustration: signals.frustration,
    explicitModel: signals.explicitModel === null ? null : hash12(signals.explicitModel),
    projectPath: signals.projectPath === null ? null : hash12(signals.projectPath),
    sessionDurationMs: signals.sessionDurationMs,
    betaFlags: signals.betaFlags.map((b) => hash12(b)),
    sessionId: signals.sessionId,
    requestHash: signals.requestHash,
  };
}

export function redactContent(content: unknown, mode: ContentMode): unknown {
  if (mode === 'none') return undefined;
  if (mode === 'full') {
    ensureNoAuth(content);
    return content;
  }
  // hashed
  return hash12(content);
}
