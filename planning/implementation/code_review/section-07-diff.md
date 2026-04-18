# Section 07 — Staged Diff

```diff
diff --git a/package.json b/package.json
index ed20f58..b15c60b 100644
--- a/package.json
+++ b/package.json
@@ -29,6 +29,7 @@
     "chokidar": "^3.6.0",
     "commander": "^12.1.0",
     "fastify": "^4.28.1",
+    "js-tiktoken": "^1.0.21",
     "js-yaml": "^4.1.0",
     "pino": "^9.3.2",
     "pino-pretty": "^11.2.1",
diff --git a/src/signals/beta.ts b/src/signals/beta.ts
new file mode 100644
index 0000000..1713207
--- /dev/null
+++ b/src/signals/beta.ts
@@ -0,0 +1,26 @@
+// anthropic-beta header → sorted, trimmed, deduped string list.
+
+type HeaderValue = string | readonly string[] | undefined;
+
+function toLines(raw: HeaderValue): readonly string[] {
+  if (raw === undefined) return [];
+  if (typeof raw === 'string') return [raw];
+  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
+  return [];
+}
+
+export function extractBetaFlags(
+  headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
+): readonly string[] {
+  if (!headers) return Object.freeze([]);
+  const raw: HeaderValue = headers['anthropic-beta'] ?? headers['Anthropic-Beta'];
+  const lines = toLines(raw);
+  const out = new Set<string>();
+  for (const line of lines) {
+    for (const part of line.split(',')) {
+      const trimmed = part.trim();
+      if (trimmed.length > 0) out.add(trimmed);
+    }
+  }
+  return Object.freeze(Array.from(out).sort());
+}
diff --git a/src/signals/canonical.ts b/src/signals/canonical.ts
index 2e9c188..63c8f0b 100644
--- a/src/signals/canonical.ts
+++ b/src/signals/canonical.ts
@@ -1,2 +1,47 @@
-// Populated in section-07. Do not import.
-export {};
+// Canonical request hash. Deterministic JSON → sha256 → 128-bit hex prefix.
+// Explicitly excludes `model`, request IDs, timestamps, metadata.user_id.
+
+import { createHash } from 'node:crypto';
+import type { AnthropicRequestBody } from '../types/anthropic.js';
+import { allUserMessages, flattenText } from './messages.js';
+
+const PREFIX_CAP = 2048;
+const USER_TAIL = 3;
+
+function stableStringify(value: unknown): string {
+  if (value === null || typeof value !== 'object') return JSON.stringify(value);
+  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
+  const obj = value as Record<string, unknown>;
+  const keys = Object.keys(obj).sort();
+  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
+  return '{' + parts.join(',') + '}';
+}
+
+interface CanonicalFields {
+  readonly systemPrefix: string;
+  readonly userMessagesPrefix: readonly string[];
+  readonly toolNames: readonly string[];
+  readonly betaFlags: readonly string[];
+}
+
+export function buildCanonicalInput(
+  body: AnthropicRequestBody | undefined,
+  toolNames: readonly string[],
+  betaFlags: readonly string[],
+): CanonicalFields {
+  const sys = flattenText(body?.system).slice(0, PREFIX_CAP);
+  const users = allUserMessages(body?.messages).slice(-USER_TAIL).map((t) => t.slice(0, PREFIX_CAP));
+  return {
+    systemPrefix: sys,
+    userMessagesPrefix: users,
+    toolNames: [...toolNames].sort(),
+    betaFlags: [...betaFlags].sort(),
+  };
+}
+
+export function requestHash(canonical: CanonicalFields): string {
+  const serialized = stableStringify(canonical);
+  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
+}
+
+export { stableStringify };
diff --git a/src/signals/extract.ts b/src/signals/extract.ts
index 2e9c188..5d5b3bf 100644
--- a/src/signals/extract.ts
+++ b/src/signals/extract.ts
@@ -1,2 +1,144 @@
-// Populated in section-07. Do not import.
-export {};
+// Top-level orchestrator: parsedBody + headers + sessionContext → frozen Signals.
+// Wraps each extractor in try/catch so a bad extractor degrades one field, not the request.
+
+import type { Logger } from 'pino';
+import type {
+  AnthropicMessage,
+  AnthropicRequestBody,
+  AnthropicToolDefinition,
+} from '../types/anthropic.js';
+import type { Signals, SessionContext } from './types.js';
+import { detectPlanMode } from './plan-mode.js';
+import { detectFrustration } from './frustration.js';
+import { estimateInputTokens } from './tokens.js';
+import { extractToolNames, countToolUse, countFileRefs } from './tools.js';
+import { buildCanonicalInput, requestHash } from './canonical.js';
+import { deriveSessionId } from './session.js';
+import { extractBetaFlags } from './beta.js';
+import { retryCount } from './retry.js';
+import { contentBlocks } from './messages.js';
+
+const PROJECT_PATH_WINDOW = 10;
+
+function asBody(parsedBody: unknown): AnthropicRequestBody | undefined {
+  if (!parsedBody || typeof parsedBody !== 'object') return undefined;
+  return parsedBody as AnthropicRequestBody;
+}
+
+function asMessages(body: AnthropicRequestBody | undefined): readonly AnthropicMessage[] | undefined {
+  const m = body?.messages;
+  return Array.isArray(m) ? m : undefined;
+}
+
+function asTools(
+  body: AnthropicRequestBody | undefined,
+): readonly AnthropicToolDefinition[] | undefined {
+  const t = body?.tools;
+  return Array.isArray(t) ? t : undefined;
+}
+
+function explicitModelOf(body: AnthropicRequestBody | undefined): string | null {
+  return typeof body?.model === 'string' ? body.model : null;
+}
+
+function longestCommonPrefix(paths: readonly string[]): string | null {
+  if (paths.length === 0) return null;
+  if (paths.length === 1) return paths[0] ?? null;
+  const first = paths[0]!;
+  let end = first.length;
+  for (let i = 1; i < paths.length; i++) {
+    const p = paths[i]!;
+    end = Math.min(end, p.length);
+    let j = 0;
+    while (j < end && first[j] === p[j]) j++;
+    end = j;
+    if (end === 0) return null;
+  }
+  const prefix = first.slice(0, end);
+  return prefix.length > 0 ? prefix : null;
+}
+
+function isAbsolutePath(p: string): boolean {
+  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
+}
+
+function collectPathsFromInput(input: unknown, out: string[]): void {
+  if (input === null || input === undefined) return;
+  if (typeof input === 'string') {
+    if (isAbsolutePath(input)) out.push(input);
+    return;
+  }
+  if (Array.isArray(input)) {
+    for (const item of input) collectPathsFromInput(item, out);
+    return;
+  }
+  if (typeof input === 'object') {
+    for (const v of Object.values(input as Record<string, unknown>)) collectPathsFromInput(v, out);
+  }
+}
+
+function inferProjectPath(messages: readonly AnthropicMessage[] | undefined): string | null {
+  if (!Array.isArray(messages)) return null;
+  const uses: unknown[] = [];
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    if ((msg as { role?: unknown }).role !== 'assistant') continue;
+    const blocks = contentBlocks((msg as { content?: unknown }).content as never);
+    for (const b of blocks) if (b.type === 'tool_use' && 'input' in b) uses.push(b.input);
+  }
+  const recent = uses.slice(-PROJECT_PATH_WINDOW);
+  const paths: string[] = [];
+  for (const inp of recent) collectPathsFromInput(inp, paths);
+  if (paths.length === 0) return null;
+  return longestCommonPrefix(paths);
+}
+
+type Extractor<T> = () => T;
+
+function safe<T>(logger: Logger, name: string, fallback: T, fn: Extractor<T>): T {
+  try {
+    return fn();
+  } catch (err) {
+    logger.warn({ extractor: name, err }, 'signal extractor failed; using fallback');
+    return fallback;
+  }
+}
+
+export function extractSignals(
+  parsedBody: unknown,
+  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
+  sessionContext: SessionContext,
+  logger: Logger,
+): Signals {
+  const body = asBody(parsedBody);
+  const messages = asMessages(body);
+  const tools = asTools(body);
+
+  const toolNames = safe(logger, 'tools', Object.freeze<string[]>([]), () => extractToolNames(tools));
+  const betaFlags = safe(logger, 'beta', Object.freeze<string[]>([]), () => extractBetaFlags(headers));
+
+  const canonical = safe(
+    logger,
+    'canonical',
+    { systemPrefix: '', userMessagesPrefix: [], toolNames, betaFlags },
+    () => buildCanonicalInput(body, toolNames, betaFlags),
+  );
+  const hash = safe(logger, 'requestHash', '0'.repeat(32), () => requestHash(canonical));
+
+  return Object.freeze({
+    planMode: safe(logger, 'plan-mode', null as boolean | null, () => detectPlanMode(body?.system)),
+    messageCount: safe(logger, 'messageCount', 0, () => (Array.isArray(messages) ? messages.length : 0)),
+    tools: toolNames,
+    toolUseCount: safe(logger, 'tool-use-count', 0, () => countToolUse(messages)),
+    estInputTokens: safe(logger, 'tokens', 0, () => estimateInputTokens(body?.system, messages)),
+    fileRefCount: safe(logger, 'file-refs', 0, () => countFileRefs(messages)),
+    retryCount: safe(logger, 'retry', 0, () => retryCount(hash, sessionContext)),
+    frustration: safe(logger, 'frustration', null as boolean | null, () => detectFrustration(messages)),
+    explicitModel: safe(logger, 'explicit-model', null as string | null, () => explicitModelOf(body)),
+    projectPath: safe(logger, 'project-path', null as string | null, () => inferProjectPath(messages)),
+    sessionDurationMs: safe(logger, 'session-duration', 0, () => Date.now() - sessionContext.createdAt),
+    betaFlags,
+    sessionId: safe(logger, 'session-id', '0'.repeat(32), () => deriveSessionId(body, toolNames)),
+    requestHash: hash,
+  });
+}
diff --git a/src/signals/frustration.ts b/src/signals/frustration.ts
index 2e9c188..34363c2 100644
--- a/src/signals/frustration.ts
+++ b/src/signals/frustration.ts
@@ -1,2 +1,18 @@
-// Populated in section-07. Do not import.
-export {};
+// Frustration-phrase detection on the most recent user message.
+// Case-insensitive, word-boundary match. Trigger phrases from plan §7.1.
+
+import { lastUserMessage } from './messages.js';
+
+const PATTERNS: readonly RegExp[] = [
+  /\bno\b/i,
+  /\bstop\b/i,
+  /\bwhy did you\b/i,
+  /\bthat'?s wrong\b/i,
+];
+
+export function detectFrustration(messages: readonly unknown[] | undefined): boolean | null {
+  const text = lastUserMessage(messages);
+  if (text === null) return null;
+  if (text.length === 0) return false;
+  return PATTERNS.some((re) => re.test(text));
+}
diff --git a/src/signals/messages.ts b/src/signals/messages.ts
new file mode 100644
index 0000000..7ff3c82
--- /dev/null
+++ b/src/signals/messages.ts
@@ -0,0 +1,62 @@
+// Content-block flatten helpers. Tolerant of both string and ContentBlock[] shapes.
+
+import type { AnthropicContent, ContentBlock } from '../types/anthropic.js';
+
+function isContentBlockArray(value: unknown): value is readonly ContentBlock[] {
+  return Array.isArray(value);
+}
+
+export function flattenText(content: AnthropicContent | undefined): string {
+  if (content === undefined) return '';
+  if (typeof content === 'string') return content;
+  if (!isContentBlockArray(content)) return '';
+  const parts: string[] = [];
+  for (const block of content) {
+    if (!block || typeof block !== 'object') continue;
+    if (block.type === 'text' && typeof block.text === 'string') {
+      parts.push(block.text);
+    }
+  }
+  return parts.join('\n');
+}
+
+export function lastUserMessage(messages: readonly unknown[] | undefined): string | null {
+  if (!messages || !Array.isArray(messages)) return null;
+  for (let i = messages.length - 1; i >= 0; i--) {
+    const msg = messages[i];
+    if (!msg || typeof msg !== 'object') continue;
+    const obj = msg as { role?: unknown; content?: unknown };
+    if (obj.role !== 'user') continue;
+    return flattenText(obj.content as AnthropicContent | undefined);
+  }
+  return null;
+}
+
+export function firstUserMessage(messages: readonly unknown[] | undefined): string | null {
+  if (!messages || !Array.isArray(messages)) return null;
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    const obj = msg as { role?: unknown; content?: unknown };
+    if (obj.role !== 'user') continue;
+    return flattenText(obj.content as AnthropicContent | undefined);
+  }
+  return null;
+}
+
+export function allUserMessages(messages: readonly unknown[] | undefined): readonly string[] {
+  if (!messages || !Array.isArray(messages)) return [];
+  const out: string[] = [];
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    const obj = msg as { role?: unknown; content?: unknown };
+    if (obj.role !== 'user') continue;
+    out.push(flattenText(obj.content as AnthropicContent | undefined));
+  }
+  return out;
+}
+
+export function contentBlocks(content: AnthropicContent | undefined): readonly ContentBlock[] {
+  if (!content || typeof content === 'string') return [];
+  if (!Array.isArray(content)) return [];
+  return content.filter((b): b is ContentBlock => b != null && typeof b === 'object');
+}
diff --git a/src/signals/plan-mode.ts b/src/signals/plan-mode.ts
index 2e9c188..4b45ecf 100644
--- a/src/signals/plan-mode.ts
+++ b/src/signals/plan-mode.ts
@@ -1,2 +1,17 @@
-// Populated in section-07. Do not import.
-export {};
+// Plan-mode marker detection. Scans `system` (string or ContentBlock[]).
+// Returns null only when the system field is present but unparseable.
+
+import type { AnthropicContent } from '../types/anthropic.js';
+import { flattenText } from './messages.js';
+
+// Claude Code injects "Plan mode is active" inside a system-reminder block when
+// the user toggles plan mode. Match case-insensitive to tolerate minor variants.
+const MARKER = /plan mode is active/i;
+
+export function detectPlanMode(system: AnthropicContent | undefined): boolean | null {
+  if (system === undefined || system === null) return false;
+  if (typeof system === 'string') return MARKER.test(system);
+  if (!Array.isArray(system)) return null;
+  const joined = flattenText(system);
+  return MARKER.test(joined);
+}
diff --git a/src/signals/retry.ts b/src/signals/retry.ts
new file mode 100644
index 0000000..1cd434d
--- /dev/null
+++ b/src/signals/retry.ts
@@ -0,0 +1,9 @@
+// Retry count: repetition of requestHash within the current session.
+// Delegates counting to the sessionContext callback (store lives in section-09).
+
+import type { SessionContext } from './types.js';
+
+export function retryCount(hash: string, ctx: SessionContext): number {
+  const n = ctx.retrySeen(hash);
+  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
+}
diff --git a/src/signals/session.ts b/src/signals/session.ts
index 2e9c188..2696f60 100644
--- a/src/signals/session.ts
+++ b/src/signals/session.ts
@@ -1,2 +1,50 @@
-// Populated in section-07. Do not import.
-export {};
+// Session ID resolver. Prefers metadata.user_id when valid, else HMAC of canonical input.
+// Uses a process-local salt generated at module load; never persisted.
+
+import { createHmac, randomBytes } from 'node:crypto';
+import type { AnthropicRequestBody } from '../types/anthropic.js';
+import { firstUserMessage, flattenText } from './messages.js';
+import { stableStringify } from './canonical.js';
+
+const MAX_USER_ID_LEN = 256;
+// Printable ASCII (space to tilde). Anchored so newlines/control chars reject.
+const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
+const SYSTEM_PREFIX_CAP = 4096;
+const FIRST_USER_CAP = 4096;
+
+// Module-local secret. Discarded on process exit; not re-derivable from any public input.
+let localSalt: Buffer | null = null;
+
+function getSalt(): Buffer {
+  if (localSalt === null) localSalt = randomBytes(32);
+  return localSalt;
+}
+
+/** Test-only: reset the module salt. NOT exported publicly outside tests. */
+export function __resetLocalSaltForTests(): void {
+  localSalt = null;
+}
+
+function isValidUserId(raw: unknown): raw is string {
+  if (typeof raw !== 'string') return false;
+  if (raw.length === 0 || raw.length > MAX_USER_ID_LEN) return false;
+  return PRINTABLE_ASCII.test(raw);
+}
+
+export function deriveSessionId(
+  body: AnthropicRequestBody | undefined,
+  toolNames: readonly string[],
+): string {
+  const userId = body?.metadata?.user_id;
+  if (isValidUserId(userId)) return userId;
+
+  const systemPrefix = flattenText(body?.system).slice(0, SYSTEM_PREFIX_CAP);
+  const firstUserPrefix = (firstUserMessage(body?.messages) ?? '').slice(0, FIRST_USER_CAP);
+  const canonicalInput = {
+    systemPrefix,
+    firstUserPrefix,
+    toolNames: [...toolNames].sort(),
+  };
+  const hmac = createHmac('sha256', getSalt()).update(stableStringify(canonicalInput));
+  return hmac.digest('hex').slice(0, 32);
+}
diff --git a/src/signals/tokens.ts b/src/signals/tokens.ts
index 2e9c188..a0632c9 100644
--- a/src/signals/tokens.ts
+++ b/src/signals/tokens.ts
@@ -1,2 +1,31 @@
-// Populated in section-07. Do not import.
-export {};
+// js-tiktoken cl100k token estimate. Routing heuristic, not exact.
+// Counts joined text of system + all message content.
+
+import { getEncoding, type Tiktoken } from 'js-tiktoken';
+import type { AnthropicContent, AnthropicMessage } from '../types/anthropic.js';
+import { flattenText } from './messages.js';
+
+let encoder: Tiktoken | null = null;
+
+function getEncoder(): Tiktoken {
+  if (encoder === null) encoder = getEncoding('cl100k_base');
+  return encoder;
+}
+
+export function estimateInputTokens(
+  system: AnthropicContent | undefined,
+  messages: readonly AnthropicMessage[] | undefined,
+): number {
+  const parts: string[] = [];
+  const sysText = flattenText(system);
+  if (sysText.length > 0) parts.push(sysText);
+  if (Array.isArray(messages)) {
+    for (const msg of messages) {
+      if (!msg || typeof msg !== 'object') continue;
+      const t = flattenText((msg as { content?: AnthropicContent }).content);
+      if (t.length > 0) parts.push(t);
+    }
+  }
+  if (parts.length === 0) return 0;
+  return getEncoder().encode(parts.join('\n')).length;
+}
diff --git a/src/signals/tools.ts b/src/signals/tools.ts
new file mode 100644
index 0000000..5eb11cc
--- /dev/null
+++ b/src/signals/tools.ts
@@ -0,0 +1,54 @@
+// Tool list, tool_use count, and file-reference count.
+
+import type { AnthropicMessage, AnthropicToolDefinition, ContentBlock } from '../types/anthropic.js';
+import { contentBlocks } from './messages.js';
+
+const FILE_REF_TOOL_NAMES: ReadonlySet<string> = new Set([
+  'read_file',
+  'write',
+  'edit',
+  // Current Anthropic-canonical equivalents used by Claude Code.
+  'str_replace_editor',
+  'str_replace_based_edit_tool',
+]);
+
+export function extractToolNames(
+  tools: readonly AnthropicToolDefinition[] | undefined,
+): readonly string[] {
+  if (!Array.isArray(tools)) return Object.freeze([]);
+  const seen = new Set<string>();
+  for (const t of tools) {
+    if (!t || typeof t !== 'object') continue;
+    const name = (t as { name?: unknown }).name;
+    if (typeof name === 'string' && name.length > 0) seen.add(name);
+  }
+  return Object.freeze(Array.from(seen).sort());
+}
+
+export function countToolUse(messages: readonly AnthropicMessage[] | undefined): number {
+  if (!Array.isArray(messages)) return 0;
+  let n = 0;
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    if ((msg as { role?: unknown }).role !== 'assistant') continue;
+    const blocks = contentBlocks((msg as { content?: unknown }).content as never);
+    for (const b of blocks) if (b.type === 'tool_use') n++;
+  }
+  return n;
+}
+
+export function countFileRefs(messages: readonly AnthropicMessage[] | undefined): number {
+  if (!Array.isArray(messages)) return 0;
+  let n = 0;
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    if ((msg as { role?: unknown }).role !== 'assistant') continue;
+    const blocks = contentBlocks((msg as { content?: unknown }).content as never);
+    for (const b of blocks) {
+      if (b.type !== 'tool_use') continue;
+      const name = (b as ContentBlock).name;
+      if (typeof name === 'string' && FILE_REF_TOOL_NAMES.has(name)) n++;
+    }
+  }
+  return n;
+}
diff --git a/src/signals/types.ts b/src/signals/types.ts
index 2e9c188..572291e 100644
--- a/src/signals/types.ts
+++ b/src/signals/types.ts
@@ -1,2 +1,24 @@
-// Populated in section-07. Do not import.
-export {};
+// Signals — frozen input shape shared by policy engine, classifier, and feedback.
+// Contract is consumed verbatim by sections 08, 11/12, and beyond.
+
+export interface Signals {
+  readonly planMode: boolean | null;
+  readonly messageCount: number;
+  readonly tools: readonly string[];
+  readonly toolUseCount: number;
+  readonly estInputTokens: number;
+  readonly fileRefCount: number;
+  readonly retryCount: number;
+  readonly frustration: boolean | null;
+  readonly explicitModel: string | null;
+  readonly projectPath: string | null;
+  readonly sessionDurationMs: number;
+  readonly betaFlags: readonly string[];
+  readonly sessionId: string;
+  readonly requestHash: string;
+}
+
+export interface SessionContext {
+  readonly createdAt: number;
+  retrySeen(hash: string): number;
+}
diff --git a/src/types/anthropic.ts b/src/types/anthropic.ts
index 55cb492..2f0828e 100644
--- a/src/types/anthropic.ts
+++ b/src/types/anthropic.ts
@@ -1,2 +1,32 @@
-// Populated in section-04. Do not import.
-export {};
+// Anthropic request shapes used for signal extraction. Permissive by design:
+// only fields relevant to routing are typed; unknown fields round-trip.
+
+export interface ContentBlock {
+  readonly type: string;
+  readonly text?: string;
+  readonly input?: unknown;
+  readonly name?: string;
+  readonly [k: string]: unknown;
+}
+
+export type AnthropicContent = string | readonly ContentBlock[];
+
+export interface AnthropicMessage {
+  readonly role: string;
+  readonly content: AnthropicContent;
+  readonly [k: string]: unknown;
+}
+
+export interface AnthropicToolDefinition {
+  readonly name: string;
+  readonly [k: string]: unknown;
+}
+
+export interface AnthropicRequestBody {
+  readonly model?: unknown;
+  readonly system?: AnthropicContent;
+  readonly messages?: readonly AnthropicMessage[];
+  readonly tools?: readonly AnthropicToolDefinition[];
+  readonly metadata?: { readonly user_id?: unknown; readonly [k: string]: unknown };
+  readonly [k: string]: unknown;
+}
diff --git a/tests/signals/extract.test.ts b/tests/signals/extract.test.ts
new file mode 100644
index 0000000..78503a0
--- /dev/null
+++ b/tests/signals/extract.test.ts
@@ -0,0 +1,369 @@
+import { describe, it, expect, beforeEach } from 'vitest';
+import pino from 'pino';
+import { PassThrough } from 'node:stream';
+import { extractSignals } from '../../src/signals/extract.js';
+import { detectPlanMode } from '../../src/signals/plan-mode.js';
+import { detectFrustration } from '../../src/signals/frustration.js';
+import { estimateInputTokens } from '../../src/signals/tokens.js';
+import { extractToolNames, countFileRefs, countToolUse } from '../../src/signals/tools.js';
+import { buildCanonicalInput, requestHash } from '../../src/signals/canonical.js';
+import { deriveSessionId, __resetLocalSaltForTests } from '../../src/signals/session.js';
+import { extractBetaFlags } from '../../src/signals/beta.js';
+import { flattenText, lastUserMessage } from '../../src/signals/messages.js';
+import type { SessionContext } from '../../src/signals/types.js';
+
+function silentLogger(): pino.Logger {
+  return pino({ level: 'silent' }, new PassThrough());
+}
+
+function captureLogger(sink: { warnings: Array<Record<string, unknown>> }): pino.Logger {
+  const base = silentLogger();
+  return new Proxy(base, {
+    get(target, prop, receiver) {
+      if (prop === 'warn') {
+        return (payload: unknown, _msg?: string) => {
+          if (payload && typeof payload === 'object') {
+            sink.warnings.push(payload as Record<string, unknown>);
+          }
+        };
+      }
+      return Reflect.get(target, prop, receiver);
+    },
+  }) as pino.Logger;
+}
+
+function fakeCtx(retryMap: Record<string, number> = {}): SessionContext {
+  return {
+    createdAt: Date.now() - 1234,
+    retrySeen: (hash: string) => retryMap[hash] ?? 0,
+  };
+}
+
+describe('flattenText', () => {
+  it('returns string content unchanged', () => {
+    expect(flattenText('hello')).toBe('hello');
+  });
+  it('joins text blocks with newlines and skips non-text', () => {
+    const text = flattenText([
+      { type: 'text', text: 'one' },
+      { type: 'image', source: 'x' },
+      { type: 'text', text: 'two' },
+    ]);
+    expect(text).toBe('one\ntwo');
+  });
+  it('returns empty string on undefined', () => {
+    expect(flattenText(undefined)).toBe('');
+  });
+});
+
+describe('lastUserMessage', () => {
+  it('picks the most recent user message and flattens it', () => {
+    const msgs = [
+      { role: 'user', content: 'first' },
+      { role: 'assistant', content: 'reply' },
+      { role: 'user', content: [{ type: 'text', text: 'latest' }] },
+    ];
+    expect(lastUserMessage(msgs)).toBe('latest');
+  });
+  it('returns null when no user messages', () => {
+    expect(lastUserMessage([{ role: 'assistant', content: 'x' }])).toBe(null);
+  });
+});
+
+describe('plan-mode detection', () => {
+  it('detects marker when system is a string', () => {
+    expect(detectPlanMode('Plan mode is active. Do not modify files.')).toBe(true);
+  });
+  it('detects marker when system is a ContentBlock[]', () => {
+    expect(
+      detectPlanMode([
+        { type: 'text', text: 'normal system' },
+        { type: 'text', text: '<system-reminder>\nPlan mode is active.' },
+      ]),
+    ).toBe(true);
+  });
+  it('returns false when system is absent or marker missing', () => {
+    expect(detectPlanMode(undefined)).toBe(false);
+    expect(detectPlanMode('no marker')).toBe(false);
+  });
+});
+
+describe('token estimate', () => {
+  it('returns zero on empty input', () => {
+    expect(estimateInputTokens(undefined, undefined)).toBe(0);
+  });
+  it('grows roughly with input length', () => {
+    const short = estimateInputTokens('hi', undefined);
+    const long = estimateInputTokens('hi '.repeat(500), undefined);
+    expect(short).toBeGreaterThan(0);
+    expect(long).toBeGreaterThan(short * 10);
+  });
+  it('counts system + message text', () => {
+    const n = estimateInputTokens('system bits', [
+      { role: 'user', content: 'user bits' },
+      { role: 'assistant', content: [{ type: 'text', text: 'assistant bits' }] },
+    ]);
+    expect(n).toBeGreaterThan(3);
+  });
+});
+
+describe('tools extractor', () => {
+  it('extracts tool names sorted and deduped', () => {
+    const names = extractToolNames([
+      { name: 'write' },
+      { name: 'read_file' },
+      { name: 'write' },
+      { name: 'edit' },
+    ]);
+    expect(names).toEqual(['edit', 'read_file', 'write']);
+    expect(Object.isFrozen(names)).toBe(true);
+  });
+  it('counts tool_use blocks in assistant messages', () => {
+    const n = countToolUse([
+      { role: 'user', content: 'x' },
+      { role: 'assistant', content: [
+        { type: 'text', text: 'ok' },
+        { type: 'tool_use', name: 'read_file', input: { path: '/a/b.ts' } },
+        { type: 'tool_use', name: 'edit', input: {} },
+      ] },
+    ]);
+    expect(n).toBe(2);
+  });
+  it('counts file-ref tool_use blocks (read_file, write, edit)', () => {
+    const n = countFileRefs([
+      { role: 'assistant', content: [
+        { type: 'tool_use', name: 'read_file', input: {} },
+        { type: 'tool_use', name: 'bash', input: {} },
+        { type: 'tool_use', name: 'write', input: {} },
+        { type: 'tool_use', name: 'edit', input: {} },
+      ] },
+    ]);
+    expect(n).toBe(3);
+  });
+});
+
+describe('frustration detection', () => {
+  it('detects trigger phrases case-insensitively', () => {
+    expect(detectFrustration([{ role: 'user', content: 'No, that did not work' }])).toBe(true);
+    expect(detectFrustration([{ role: 'user', content: 'Why did you delete that?' }])).toBe(true);
+    expect(detectFrustration([{ role: 'user', content: "That's wrong." }])).toBe(true);
+    expect(detectFrustration([{ role: 'user', content: 'STOP please' }])).toBe(true);
+  });
+  it('does not match substrings of other words', () => {
+    expect(detectFrustration([{ role: 'user', content: 'stopper note nope' }])).toBe(false);
+  });
+  it('returns null when no user message is present', () => {
+    expect(detectFrustration([{ role: 'assistant', content: 'hi' }])).toBe(null);
+  });
+});
+
+describe('beta flags', () => {
+  it('splits, trims, dedupes, and sorts', () => {
+    const out = extractBetaFlags({ 'anthropic-beta': 'b,a, c ,a' });
+    expect(out).toEqual(['a', 'b', 'c']);
+    expect(Object.isFrozen(out)).toBe(true);
+  });
+  it('returns empty array when header is absent', () => {
+    expect(extractBetaFlags({})).toEqual([]);
+  });
+  it('handles array-valued headers', () => {
+    expect(extractBetaFlags({ 'anthropic-beta': ['x,y', 'z'] })).toEqual(['x', 'y', 'z']);
+  });
+});
+
+describe('canonical hash', () => {
+  const ctx = fakeCtx();
+  const logger = silentLogger();
+  const baseBody = {
+    model: 'claude-opus-4-7',
+    system: 'sys',
+    messages: [
+      { role: 'user', content: 'first' },
+      { role: 'assistant', content: 'reply' },
+      { role: 'user', content: 'second' },
+    ],
+    tools: [{ name: 'edit' }, { name: 'read_file' }],
+  };
+  it('is stable across key-order permutations', () => {
+    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
+    const b = extractSignals(
+      {
+        messages: baseBody.messages,
+        tools: baseBody.tools,
+        system: baseBody.system,
+        model: baseBody.model,
+      },
+      {},
+      ctx,
+      logger,
+    ).requestHash;
+    expect(a).toBe(b);
+    expect(a).toMatch(/^[0-9a-f]{32}$/);
+  });
+  it('excludes model (changing only model yields identical hash)', () => {
+    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
+    const b = extractSignals({ ...baseBody, model: 'claude-haiku-4-5' }, {}, ctx, logger).requestHash;
+    expect(a).toBe(b);
+  });
+  it('excludes request IDs, timestamps, and metadata.user_id', () => {
+    const a = extractSignals(baseBody, {}, ctx, logger).requestHash;
+    const b = extractSignals(
+      { ...baseBody, request_id: 'req_123', created_at: 1, metadata: { user_id: 'u_abc' } },
+      {},
+      ctx,
+      logger,
+    ).requestHash;
+    expect(a).toBe(b);
+  });
+  it('buildCanonicalInput + requestHash produces deterministic hex', () => {
+    const c = buildCanonicalInput(baseBody as never, ['edit', 'read_file'], []);
+    expect(requestHash(c)).toMatch(/^[0-9a-f]{32}$/);
+  });
+});
+
+describe('sessionId', () => {
+  beforeEach(() => __resetLocalSaltForTests());
+  it('uses metadata.user_id when valid printable-ASCII string', () => {
+    const id = deriveSessionId({ metadata: { user_id: 'user-abc.123' } }, []);
+    expect(id).toBe('user-abc.123');
+  });
+  it('rejects user_id with non-printable or oversized input', () => {
+    expect(deriveSessionId({ metadata: { user_id: 'bad\nnewline' } }, [])).not.toBe('bad\nnewline');
+    expect(deriveSessionId({ metadata: { user_id: 'a'.repeat(257) } }, [])).toMatch(/^[0-9a-f]{32}$/);
+  });
+  it('falls back to HMAC when user_id absent', () => {
+    const id = deriveSessionId({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, ['t']);
+    expect(id).toMatch(/^[0-9a-f]{32}$/);
+  });
+  it('localSalt stays constant within a process but is not derivable from public input', () => {
+    const body = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
+    const a = deriveSessionId(body, []);
+    const b = deriveSessionId(body, []);
+    expect(a).toBe(b);
+    __resetLocalSaltForTests();
+    const c = deriveSessionId(body, []);
+    expect(c).not.toBe(a);
+  });
+});
+
+describe('extractSignals orchestrator', () => {
+  it('returns frozen Signals with expected shape', () => {
+    const s = extractSignals(
+      {
+        model: 'claude-opus-4-7',
+        system: 'You are helpful.',
+        messages: [{ role: 'user', content: 'hello' }],
+        tools: [{ name: 'edit' }],
+      },
+      { 'anthropic-beta': 'beta-a,beta-b' },
+      fakeCtx(),
+      silentLogger(),
+    );
+    expect(Object.isFrozen(s)).toBe(true);
+    expect(Object.isFrozen(s.tools)).toBe(true);
+    expect(Object.isFrozen(s.betaFlags)).toBe(true);
+    expect(s.messageCount).toBe(1);
+    expect(s.explicitModel).toBe('claude-opus-4-7');
+    expect(s.tools).toEqual(['edit']);
+    expect(s.betaFlags).toEqual(['beta-a', 'beta-b']);
+    expect(s.requestHash).toMatch(/^[0-9a-f]{32}$/);
+    expect(s.sessionId).toMatch(/[0-9a-f]{32}|.+/);
+    expect(s.sessionDurationMs).toBeGreaterThanOrEqual(0);
+  });
+
+  it('retryCount reflects sessionContext.retrySeen result', () => {
+    const logger = silentLogger();
+    const body = { system: 's', messages: [{ role: 'user', content: 'q' }] };
+    const first = extractSignals(body, {}, fakeCtx(), logger);
+    const again = extractSignals(body, {}, fakeCtx({ [first.requestHash]: 2 }), logger);
+    expect(first.retryCount).toBe(0);
+    expect(again.retryCount).toBe(2);
+  });
+
+  it('sessionDurationMs reflects Date.now - createdAt', () => {
+    const ctx: SessionContext = { createdAt: Date.now() - 5000, retrySeen: () => 0 };
+    const s = extractSignals({ messages: [{ role: 'user', content: 'x' }] }, {}, ctx, silentLogger());
+    expect(s.sessionDurationMs).toBeGreaterThanOrEqual(5000);
+    expect(s.sessionDurationMs).toBeLessThan(10000);
+  });
+
+  it('projectPath = longest common prefix of absolute paths in recent tool_use', () => {
+    const s = extractSignals(
+      {
+        messages: [
+          {
+            role: 'assistant',
+            content: [
+              { type: 'tool_use', name: 'read_file', input: { path: '/repo/src/a.ts' } },
+              { type: 'tool_use', name: 'edit', input: { path: '/repo/src/b.ts' } },
+            ],
+          },
+        ],
+      },
+      {},
+      fakeCtx(),
+      silentLogger(),
+    );
+    expect(s.projectPath).toBe('/repo/src/');
+  });
+
+  it('projectPath is null when no absolute paths are present', () => {
+    const s = extractSignals(
+      { messages: [{ role: 'user', content: 'x' }] },
+      {},
+      fakeCtx(),
+      silentLogger(),
+    );
+    expect(s.projectPath).toBe(null);
+  });
+
+  it('explicitModel captured from request body', () => {
+    const s = extractSignals(
+      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] },
+      {},
+      fakeCtx(),
+      silentLogger(),
+    );
+    expect(s.explicitModel).toBe('claude-sonnet-4-6');
+  });
+
+  it('a throwing extractor degrades its field and logs a warning without failing', () => {
+    const sink = { warnings: [] as Array<Record<string, unknown>> };
+    const logger = captureLogger(sink);
+    const throwingCtx: SessionContext = {
+      createdAt: Date.now(),
+      retrySeen: () => {
+        throw new Error('boom from retrySeen');
+      },
+    };
+    const s = extractSignals(
+      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
+      {},
+      throwingCtx,
+      logger,
+    );
+    expect(s.retryCount).toBe(0);
+    expect(Object.isFrozen(s)).toBe(true);
+    expect(sink.warnings.some((w) => w.extractor === 'retry')).toBe(true);
+  });
+
+  it('orchestrator never throws even on fully-malformed input', () => {
+    expect(() =>
+      extractSignals(
+        null,
+        undefined as never,
+        { createdAt: Date.now(), retrySeen: () => 0 },
+        silentLogger(),
+      ),
+    ).not.toThrow();
+    const s = extractSignals(
+      'not an object',
+      {},
+      { createdAt: Date.now(), retrySeen: () => 0 },
+      silentLogger(),
+    );
+    expect(Object.isFrozen(s)).toBe(true);
+    expect(s.messageCount).toBe(0);
+    expect(s.tools).toEqual([]);
+  });
+});
```
