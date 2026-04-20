diff --git a/src/decisions/_fs.ts b/src/decisions/_fs.ts
new file mode 100644
index 0000000..8e01e2a
--- /dev/null
+++ b/src/decisions/_fs.ts
@@ -0,0 +1,23 @@
+// Indirection layer over node:fs so tests can vi.spyOn() the helpers.
+// vi.spyOn cannot redefine ESM module exports directly, but it can mutate
+// our own object's properties.
+
+import {
+  copyFileSync,
+  fsyncSync,
+  openSync,
+  closeSync,
+  renameSync,
+  statSync,
+  truncateSync,
+} from 'node:fs';
+
+export const fsHelpers = {
+  copyFileSync,
+  fsyncSync,
+  openSync,
+  closeSync,
+  renameSync,
+  statSync,
+  truncateSync,
+};
diff --git a/src/decisions/cost.ts b/src/decisions/cost.ts
index 5510409..de37a57 100644
--- a/src/decisions/cost.ts
+++ b/src/decisions/cost.ts
@@ -1,2 +1,101 @@
-// Populated in section-13. Do not import.
-export {};
+// Cost accounting for decision-log records.
+//
+// Parses the four token fields from an Anthropic response.usage object and
+// multiplies by the per-model pricing table from config.yaml. Per the
+// section-13 contract:
+//
+//   - The chargeable model is the actual upstream model (response.model or
+//     message_start.model for streaming) — NOT the client-requested model.
+//   - Unknown model in the pricing table → cost is null. A single warning
+//     is emitted per model per process via the supplied logger.
+//   - If any of the four usage fields is absent, that component is null;
+//     if all are absent, total cost is null. We never silently
+//     under-report by treating missing fields as zero.
+
+import type { Logger } from 'pino';
+import type { PricingEntry } from '../config/schema.js';
+import type { UsageFields } from './types.js';
+
+export function parseUsage(raw: unknown): UsageFields | null {
+  if (raw === null || typeof raw !== 'object') return null;
+  const u = raw as Record<string, unknown>;
+  const input = numOrNull(u.input_tokens);
+  const output = numOrNull(u.output_tokens);
+  const cacheRead = numOrNull(u.cache_read_input_tokens);
+  const cacheCreate = numOrNull(u.cache_creation_input_tokens);
+  if (input === null && output === null && cacheRead === null && cacheCreate === null) {
+    return null;
+  }
+  return {
+    input_tokens: input,
+    output_tokens: output,
+    cache_read_input_tokens: cacheRead,
+    cache_creation_input_tokens: cacheCreate,
+  };
+}
+
+function numOrNull(v: unknown): number | null {
+  return typeof v === 'number' && Number.isFinite(v) ? v : null;
+}
+
+export interface CostContext {
+  readonly pricing: Readonly<Record<string, PricingEntry>>;
+  readonly logger: Pick<Logger, 'warn'>;
+  /** Mutable set so the warning fires only once per model per process. */
+  readonly warnedModels: Set<string>;
+}
+
+export function createCostContext(
+  pricing: Readonly<Record<string, PricingEntry>>,
+  logger: Pick<Logger, 'warn'>,
+): CostContext {
+  return { pricing, logger, warnedModels: new Set() };
+}
+
+export function computeCostUsd(
+  model: string,
+  usage: UsageFields | null,
+  ctx: CostContext,
+): number | null {
+  if (usage === null) return null;
+  const rate = ctx.pricing[model];
+  if (rate === undefined) {
+    if (!ctx.warnedModels.has(model)) {
+      ctx.warnedModels.add(model);
+      ctx.logger.warn({ event: 'cost_unavailable_unknown_model', model }, 'no pricing entry for model');
+    }
+    return null;
+  }
+  let total = 0;
+  let any = false;
+  if (usage.input_tokens !== null) {
+    total += (usage.input_tokens / 1_000_000) * rate.input;
+    any = true;
+  }
+  if (usage.output_tokens !== null) {
+    total += (usage.output_tokens / 1_000_000) * rate.output;
+    any = true;
+  }
+  if (usage.cache_read_input_tokens !== null) {
+    total += (usage.cache_read_input_tokens / 1_000_000) * rate.cacheRead;
+    any = true;
+  }
+  if (usage.cache_creation_input_tokens !== null) {
+    total += (usage.cache_creation_input_tokens / 1_000_000) * rate.cacheCreate;
+    any = true;
+  }
+  return any ? total : null;
+}
+
+/**
+ * Extracts the upstream model from a parsed `message_start` SSE event payload.
+ * Returns null if the shape is not recognized.
+ */
+export function modelFromMessageStart(event: unknown): string | null {
+  if (event === null || typeof event !== 'object') return null;
+  const obj = event as Record<string, unknown>;
+  const msg = obj.message;
+  if (msg === null || typeof msg !== 'object') return null;
+  const m = (msg as Record<string, unknown>).model;
+  return typeof m === 'string' ? m : null;
+}
diff --git a/src/decisions/log.ts b/src/decisions/log.ts
index 5510409..185d6a1 100644
--- a/src/decisions/log.ts
+++ b/src/decisions/log.ts
@@ -1,2 +1,241 @@
-// Populated in section-13. Do not import.
-export {};
+// DecisionLogWriter — best-effort, append-only JSONL writer with daily-or-
+// size rotation, in-process byte counter (no per-append stat), bounded
+// in-memory queue, and pluggable clock (for tests). Durability is
+// best-effort by default; set fsync=true to fsync after each line at a
+// measurable throughput cost.
+//
+// All disk operations are serialized on a single promise chain so that
+// rotation, writes, and shutdown observe a consistent ordering. append() is
+// non-blocking and returns true if the record was enqueued, false on drop.
+
+import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
+import { join } from 'node:path';
+import type { Logger } from 'pino';
+import { fsHelpers } from './_fs.js';
+import type { DecisionRecord, DecisionRotationStrategy } from './types.js';
+import {
+  applyRetention,
+  dailyFilename,
+  dateStamp,
+  nextSizeFilename,
+  rotateRename,
+  statSize,
+} from './rotate.js';
+
+const MAX_QUEUE = 1000;
+const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
+
+export interface DecisionLogWriter {
+  /** Fire-and-forget. Returns true if accepted into the queue, false if dropped. */
+  append(record: DecisionRecord): boolean;
+  /** Resolves once the queue has drained to disk. */
+  flush(): Promise<void>;
+  /** Flush + close stream. Idempotent. */
+  close(): Promise<void>;
+  /** Currently active log file path. Exposed for tests/observability. */
+  currentPath(): string;
+  /** In-process byte count for the active file. */
+  currentBytes(): number;
+}
+
+export interface DecisionLogWriterOptions {
+  readonly dir: string;
+  readonly rotation: DecisionRotationStrategy;
+  /** Threshold for size rotation. Ignored when rotation === 'daily'. */
+  readonly maxBytes: number;
+  readonly retentionDays: number;
+  readonly fsync: boolean;
+  readonly logger: Logger;
+  readonly clock: () => Date;
+  /** Override the periodic reconcile (ms). Used by tests; defaults to 5 min. */
+  readonly reconcileMs?: number;
+}
+
+interface WriteJob {
+  readonly kind: 'write';
+  readonly line: string;
+}
+
+interface RotateJob {
+  readonly kind: 'rotate';
+}
+
+type Job = WriteJob | RotateJob;
+
+export function createDecisionLogWriter(opts: DecisionLogWriterOptions): DecisionLogWriter {
+  mkdirSync(opts.dir, { recursive: true });
+
+  const reconcileMs = opts.reconcileMs ?? RECONCILE_INTERVAL_MS;
+  const queue: Job[] = [];
+  let bytes = 0;
+  let stream: WriteStream | null = null;
+  let path = '';
+  let activeDate = dateStamp(opts.clock());
+  let closed = false;
+  let pending: Promise<void> = Promise.resolve();
+
+  function endStream(s: WriteStream): Promise<void> {
+    return new Promise((resolve) => {
+      s.end(() => resolve());
+    });
+  }
+
+  async function openStream(p: string): Promise<void> {
+    if (stream !== null) {
+      const old = stream;
+      stream = null;
+      await endStream(old);
+    }
+    path = p;
+    const s = createWriteStream(p, { flags: 'a', highWaterMark: 64 * 1024 });
+    await new Promise<void>((resolve, reject) => {
+      const onOpen = (): void => {
+        s.removeListener('error', onErr);
+        resolve();
+      };
+      const onErr = (err: Error): void => {
+        s.removeListener('open', onOpen);
+        reject(err);
+      };
+      s.once('open', onOpen);
+      s.once('error', onErr);
+    });
+    s.on('error', (err) => {
+      opts.logger.error({ err, event: 'decision_log_stream_error', path: p }, 'decision log stream error');
+    });
+    stream = s;
+    // Stat happens after 'open' so an existing file's size is observed correctly.
+    bytes = statSize(p);
+  }
+
+  async function performRotation(now: Date): Promise<void> {
+    const stamp = dateStamp(now);
+    if (opts.rotation === 'daily') {
+      if (stream === null || stamp !== activeDate) {
+        await openStream(join(opts.dir, dailyFilename(now)));
+        activeDate = stamp;
+        applyRetention(opts.dir, opts.retentionDays, now);
+      }
+      return;
+    }
+    // Size strategy.
+    if (stream === null) {
+      await openStream(join(opts.dir, dailyFilename(now)));
+      activeDate = stamp;
+      applyRetention(opts.dir, opts.retentionDays, now);
+      return;
+    }
+    if (stamp !== activeDate) {
+      await openStream(join(opts.dir, dailyFilename(now)));
+      activeDate = stamp;
+      applyRetention(opts.dir, opts.retentionDays, now);
+      return;
+    }
+    if (bytes >= opts.maxBytes) {
+      const target = join(opts.dir, nextSizeFilename(opts.dir, now));
+      const oldPath = path;
+      // Close active stream so Windows can rename the file.
+      if (stream !== null) {
+        const s = stream;
+        stream = null;
+        await endStream(s);
+      }
+      try {
+        rotateRename(oldPath, target);
+      } catch (err) {
+        opts.logger.warn({ err, event: 'decision_log_rotate_failed', src: oldPath, dst: target }, 'rotation rename failed');
+      }
+      await openStream(oldPath);
+      applyRetention(opts.dir, opts.retentionDays, now);
+    }
+  }
+
+  async function performWrite(line: string): Promise<void> {
+    await performRotation(opts.clock());
+    if (stream === null) return;
+    const s = stream;
+    await new Promise<void>((resolve, reject) => {
+      s.write(line, (err) => {
+        if (err !== null && err !== undefined) reject(err);
+        else resolve();
+      });
+    });
+    bytes += line.length;
+    if (opts.fsync) {
+      const fd = (s as unknown as { fd?: number }).fd;
+      if (typeof fd === 'number') {
+        try {
+          fsHelpers.fsyncSync(fd);
+        } catch {
+          // best-effort
+        }
+      }
+    }
+  }
+
+  function enqueue(job: Job): void {
+    queue.push(job);
+    pending = pending
+      .then(async () => {
+        const j = queue.shift();
+        if (j === undefined) return;
+        if (j.kind === 'write') await performWrite(j.line);
+        else if (j.kind === 'rotate') await performRotation(opts.clock());
+      })
+      .catch((err) => {
+        opts.logger.error({ err, event: 'decision_log_internal_error' }, 'decision log internal error');
+      });
+  }
+
+  function append(record: DecisionRecord): boolean {
+    if (closed) {
+      opts.logger.warn({ event: 'decision_log_dropped', reason: 'closed' }, 'decision log dropped (closed)');
+      return false;
+    }
+    if (queue.length >= MAX_QUEUE) {
+      opts.logger.warn({ event: 'decision_log_dropped', reason: 'queue_full' }, 'decision log dropped (queue full)');
+      return false;
+    }
+    const line = JSON.stringify(record) + '\n';
+    enqueue({ kind: 'write', line });
+    return true;
+  }
+
+  function flush(): Promise<void> {
+    return pending;
+  }
+
+  async function close(): Promise<void> {
+    if (closed) return;
+    closed = true;
+    if (reconcileTimer !== null) {
+      clearInterval(reconcileTimer);
+      reconcileTimer = null;
+    }
+    await flush();
+    if (stream !== null) {
+      const s = stream;
+      stream = null;
+      await endStream(s);
+    }
+  }
+
+  // Periodic reconcile to correct counter drift.
+  let reconcileTimer: NodeJS.Timeout | null = setInterval(() => {
+    if (path === '') return;
+    bytes = statSize(path);
+  }, reconcileMs);
+  reconcileTimer.unref?.();
+
+  // Eagerly open the initial stream so currentPath/currentBytes are valid
+  // and the first read-after-flush sees the file on disk.
+  enqueue({ kind: 'rotate' });
+
+  return {
+    append,
+    flush,
+    close,
+    currentPath: () => path,
+    currentBytes: () => bytes,
+  };
+}
diff --git a/src/decisions/reader.ts b/src/decisions/reader.ts
new file mode 100644
index 0000000..68bf23f
--- /dev/null
+++ b/src/decisions/reader.ts
@@ -0,0 +1,66 @@
+// Streaming reader for decision JSONL files. Used by §17 (dashboard-server)
+// and §15 (report-cli) to paginate without loading whole files into memory.
+// Iterates files in chronological order (filename date asc, suffix asc).
+
+import { createReadStream, readdirSync } from 'node:fs';
+import { join } from 'node:path';
+import { createInterface } from 'node:readline';
+import type { DecisionRecord } from './types.js';
+import { parseLogFilename } from './rotate.js';
+
+export interface ReadDecisionsOptions {
+  /** ISO timestamp inclusive lower bound. */
+  readonly since?: string;
+  /** Max records to yield total. */
+  readonly limit?: number;
+}
+
+export async function* readDecisions(
+  dir: string,
+  opts: ReadDecisionsOptions = {},
+): AsyncIterableIterator<DecisionRecord> {
+  let entries: readonly string[];
+  try {
+    entries = readdirSync(dir);
+  } catch {
+    return;
+  }
+  const files = entries
+    .map((name) => ({ name, parsed: parseLogFilename(name) }))
+    .filter((e): e is { name: string; parsed: NonNullable<ReturnType<typeof parseLogFilename>> } => e.parsed !== null)
+    .sort((a, b) => {
+      if (a.parsed.date !== b.parsed.date) return a.parsed.date < b.parsed.date ? -1 : 1;
+      // Within a day: rotated files (suffix 1..N) hold older lines in
+      // order; the active file (suffix 0) is the newest and must come last.
+      const ax = a.parsed.suffix === 0 ? Number.MAX_SAFE_INTEGER : a.parsed.suffix;
+      const bx = b.parsed.suffix === 0 ? Number.MAX_SAFE_INTEGER : b.parsed.suffix;
+      return ax - bx;
+    });
+
+  let yielded = 0;
+  const limit = opts.limit;
+  const since = opts.since;
+
+  for (const entry of files) {
+    if (limit !== undefined && yielded >= limit) return;
+    const stream = createReadStream(join(dir, entry.name), { encoding: 'utf8' });
+    const rl = createInterface({ input: stream, crlfDelay: Infinity });
+    for await (const line of rl) {
+      if (line.length === 0) continue;
+      let record: DecisionRecord;
+      try {
+        record = JSON.parse(line) as DecisionRecord;
+      } catch {
+        continue;
+      }
+      if (since !== undefined && record.timestamp < since) continue;
+      yield record;
+      yielded += 1;
+      if (limit !== undefined && yielded >= limit) {
+        rl.close();
+        stream.destroy();
+        return;
+      }
+    }
+  }
+}
diff --git a/src/decisions/record.ts b/src/decisions/record.ts
new file mode 100644
index 0000000..44127fc
--- /dev/null
+++ b/src/decisions/record.ts
@@ -0,0 +1,81 @@
+// Builds a single DecisionRecord from inputs supplied by the proxy
+// integration point. Applies the configured content-redaction mode to the
+// extracted signals before returning. Other section invariants:
+//
+//   - chosen_model is the actual upstream model — callers (proxy/§04) are
+//     responsible for using message_start.model rather than the inbound
+//     request body's model.
+//   - In shadow mode, forwarded_model equals the client-requested model and
+//     shadow_choice holds the would-have-been override.
+//   - usage and cost_estimate_usd are null when usage was unavailable.
+
+import type { Signals } from '../signals/types.js';
+import type { PolicyResult } from '../policy/dsl.js';
+import type { ClassifierResult } from '../classifier/types.js';
+import { redactSignals } from './redaction.js';
+import type {
+  ContentMode,
+  DecisionClassifierResult,
+  DecisionMode,
+  DecisionPolicyResult,
+  DecisionRecord,
+  DecisionSource,
+  UsageFields,
+} from './types.js';
+
+export interface BuildDecisionRecordInput {
+  readonly now: Date;
+  readonly sessionId: string;
+  readonly requestHash: string;
+  readonly extractedSignals: Signals;
+  readonly policyResult: PolicyResult;
+  readonly classifierResult: ClassifierResult | null;
+  readonly stickyHit: boolean;
+  readonly chosenModel: string;
+  readonly chosenBy: DecisionSource;
+  readonly forwardedModel: string;
+  readonly mode: DecisionMode;
+  readonly shadowChoice: string | null;
+  readonly upstreamLatencyMs: number;
+  readonly usage: UsageFields | null;
+  readonly costEstimateUsd: number | null;
+  readonly classifierCostUsd: number | null;
+  readonly contentMode: ContentMode;
+}
+
+function projectPolicy(p: PolicyResult): DecisionPolicyResult {
+  if (p.kind === 'matched') return { rule_id: p.ruleId };
+  return { abstain: true };
+}
+
+function projectClassifier(c: ClassifierResult | null): DecisionClassifierResult | null {
+  if (c === null) return null;
+  return {
+    score: c.score,
+    suggested: c.suggestedModel,
+    confidence: c.confidence,
+    source: c.source,
+    latencyMs: c.latencyMs,
+  };
+}
+
+export function buildDecisionRecord(input: BuildDecisionRecordInput): DecisionRecord {
+  return {
+    timestamp: input.now.toISOString(),
+    session_id: input.sessionId,
+    request_hash: input.requestHash,
+    extracted_signals: redactSignals(input.extractedSignals, input.contentMode),
+    policy_result: projectPolicy(input.policyResult),
+    classifier_result: projectClassifier(input.classifierResult),
+    sticky_hit: input.stickyHit,
+    chosen_model: input.chosenModel,
+    chosen_by: input.chosenBy,
+    forwarded_model: input.forwardedModel,
+    upstream_latency_ms: input.upstreamLatencyMs,
+    usage: input.usage,
+    cost_estimate_usd: input.costEstimateUsd,
+    classifier_cost_usd: input.classifierCostUsd,
+    mode: input.mode,
+    shadow_choice: input.shadowChoice,
+  };
+}
diff --git a/src/decisions/redaction.ts b/src/decisions/redaction.ts
new file mode 100644
index 0000000..99598f5
--- /dev/null
+++ b/src/decisions/redaction.ts
@@ -0,0 +1,96 @@
+// Privacy redaction for decision-log records.
+//
+// Three modes (config.logging.content):
+//   hashed (default) — replace each content string / tool input with
+//                       sha256(JSON.stringify(x)).slice(0, 12). Identical
+//                       inputs collide intentionally so they remain
+//                       linkable across log entries. Use `none` on shared
+//                       machines where collision-linkability is a problem.
+//   full              — log raw content. Auth headers are still redacted
+//                       unconditionally at the pino layer (section-02).
+//   none              — drop messages, tool inputs, and any content fields
+//                       from extracted_signals entirely. Only metadata
+//                       counts/shapes remain.
+//
+// Auth headers (authorization, x-api-key, x-ccmux-token) MUST NEVER appear
+// in any record regardless of mode — this module never accepts headers and
+// the pino layer enforces the same redaction independently.
+//
+// Privacy mode is config-only. No CLI flag toggles it (see redaction.test.ts).
+
+import { createHash } from 'node:crypto';
+import type { Signals } from '../signals/types.js';
+import type { ContentMode } from '../config/schema.js';
+
+const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
+  'authorization',
+  'x-api-key',
+  'x-ccmux-token',
+]);
+
+export function hash12(value: unknown): string {
+  const json = typeof value === 'string' ? value : JSON.stringify(value);
+  return createHash('sha256').update(json ?? '').digest('hex').slice(0, 12);
+}
+
+function ensureNoAuth(obj: Record<string, unknown>): void {
+  for (const key of Object.keys(obj)) {
+    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
+      throw new Error(`refusing to log forbidden header: ${key}`);
+    }
+  }
+}
+
+export function redactSignals(
+  signals: Signals,
+  mode: ContentMode,
+): Readonly<Record<string, unknown>> {
+  if (mode === 'full') {
+    return { ...signals };
+  }
+  if (mode === 'none') {
+    return {
+      planMode: signals.planMode,
+      messageCount: signals.messageCount,
+      toolCount: signals.tools.length,
+      toolUseCount: signals.toolUseCount,
+      estInputTokens: signals.estInputTokens,
+      fileRefCount: signals.fileRefCount,
+      retryCount: signals.retryCount,
+      frustration: signals.frustration,
+      sessionDurationMs: signals.sessionDurationMs,
+      betaFlagCount: signals.betaFlags.length,
+      sessionId: signals.sessionId,
+      requestHash: signals.requestHash,
+    };
+  }
+  // hashed (default)
+  return {
+    planMode: signals.planMode,
+    messageCount: signals.messageCount,
+    tools: signals.tools.map((t) => hash12(t)),
+    toolUseCount: signals.toolUseCount,
+    estInputTokens: signals.estInputTokens,
+    fileRefCount: signals.fileRefCount,
+    retryCount: signals.retryCount,
+    frustration: signals.frustration,
+    explicitModel: signals.explicitModel === null ? null : hash12(signals.explicitModel),
+    projectPath: signals.projectPath === null ? null : hash12(signals.projectPath),
+    sessionDurationMs: signals.sessionDurationMs,
+    betaFlags: signals.betaFlags.map((b) => hash12(b)),
+    sessionId: signals.sessionId,
+    requestHash: signals.requestHash,
+  };
+}
+
+export function redactContent(content: unknown, mode: ContentMode): unknown {
+  if (mode === 'none') return undefined;
+  if (mode === 'full') {
+    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
+      ensureNoAuth(content as Record<string, unknown>);
+    }
+    return content;
+  }
+  // hashed
+  return hash12(content);
+}
diff --git a/src/decisions/rotate.ts b/src/decisions/rotate.ts
index 5510409..68afb42 100644
--- a/src/decisions/rotate.ts
+++ b/src/decisions/rotate.ts
@@ -1,2 +1,134 @@
-// Populated in section-13. Do not import.
-export {};
+// Rotation policies for the decision-log writer.
+//
+// Daily rotation: the active filename is decisions-YYYY-MM-DD.jsonl. When the
+// local-date component changes, the next append opens a new file (no rename
+// needed, since the date is in the filename).
+//
+// Size rotation: when the in-process byte counter reaches maxBytes, we rotate
+// the active file to decisions-YYYY-MM-DD.<n>.jsonl with n monotonically
+// increasing for the same day; the active filename (suffix 0) keeps writing.
+// On Windows, fs.renameSync may fail with EBUSY/EPERM if the file is held;
+// we fall back to copy+truncate so the active stream can keep going.
+//
+// Retention: dates are parsed from the filename — we never trust mtime.
+
+import { readdirSync, unlinkSync } from 'node:fs';
+import { join } from 'node:path';
+import { fsHelpers } from './_fs.js';
+
+const DAILY_RE = /^decisions-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;
+
+export function dateStamp(date: Date): string {
+  const y = date.getFullYear();
+  const m = String(date.getMonth() + 1).padStart(2, '0');
+  const d = String(date.getDate()).padStart(2, '0');
+  return `${y}-${m}-${d}`;
+}
+
+export function dailyFilename(date: Date): string {
+  return `decisions-${dateStamp(date)}.jsonl`;
+}
+
+export function sizeFilename(date: Date, n: number): string {
+  return `decisions-${dateStamp(date)}.${n}.jsonl`;
+}
+
+export interface ParsedLogName {
+  readonly date: string;
+  readonly suffix: number;
+}
+
+export function parseLogFilename(name: string): ParsedLogName | null {
+  const m = DAILY_RE.exec(name);
+  if (m === null) return null;
+  return {
+    date: `${m[1]}-${m[2]}-${m[3]}`,
+    suffix: m[4] === undefined ? 0 : Number.parseInt(m[4], 10),
+  };
+}
+
+/**
+ * Returns the next size-rotation filename for `date` not already on disk.
+ * Inspects the directory, finds the max suffix for that date, returns +1.
+ */
+export function nextSizeFilename(dir: string, date: Date): string {
+  let max = 0;
+  const stamp = dateStamp(date);
+  let entries: readonly string[];
+  try {
+    entries = readdirSync(dir);
+  } catch {
+    entries = [];
+  }
+  for (const entry of entries) {
+    const parsed = parseLogFilename(entry);
+    if (parsed === null) continue;
+    if (parsed.date !== stamp) continue;
+    if (parsed.suffix > max) max = parsed.suffix;
+  }
+  return sizeFilename(date, max + 1);
+}
+
+/**
+ * Atomic rename with a copy+truncate fallback for Windows EBUSY/EPERM cases
+ * where the source file is still being held by the writer.
+ */
+export function rotateRename(src: string, dst: string): void {
+  try {
+    fsHelpers.renameSync(src, dst);
+    return;
+  } catch (err) {
+    const code = (err as NodeJS.ErrnoException).code;
+    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
+  }
+  fsHelpers.copyFileSync(src, dst);
+  fsHelpers.truncateSync(src, 0);
+}
+
+/**
+ * Deletes log files whose filename-date is older than `retentionDays` from
+ * `now`. Files we cannot parse are left alone. mtime is intentionally
+ * ignored — the filename is the source of truth.
+ */
+export function applyRetention(dir: string, retentionDays: number, now: Date): readonly string[] {
+  if (retentionDays <= 0) return [];
+  let entries: readonly string[];
+  try {
+    entries = readdirSync(dir);
+  } catch {
+    return [];
+  }
+  const cutoff = new Date(now.getTime());
+  cutoff.setDate(cutoff.getDate() - retentionDays);
+  const cutoffStamp = dateStamp(cutoff);
+  const removed: string[] = [];
+  for (const entry of entries) {
+    const parsed = parseLogFilename(entry);
+    if (parsed === null) continue;
+    if (parsed.date < cutoffStamp) {
+      const full = join(dir, entry);
+      try {
+        unlinkSync(full);
+        removed.push(entry);
+      } catch {
+        // best-effort
+      }
+    }
+  }
+  return removed;
+}
+
+/** Best-effort byte counter seed. Returns 0 if the file does not exist. */
+export function statSize(path: string): number {
+  try {
+    return fsHelpers.statSync(path).size;
+  } catch {
+    return 0;
+  }
+}
+
+/** Touches a file so it exists. */
+export function touchFile(path: string): void {
+  const fd = fsHelpers.openSync(path, 'a');
+  fsHelpers.closeSync(fd);
+}
diff --git a/src/decisions/types.ts b/src/decisions/types.ts
index 5510409..12e54d1 100644
--- a/src/decisions/types.ts
+++ b/src/decisions/types.ts
@@ -1,2 +1,64 @@
-// Populated in section-13. Do not import.
-export {};
+// Decision-log record schema. This is the contract consumed by sections
+// 14 (outcome-tagger), 15 (report-cli), 16 (tune), and 17 (dashboard-server).
+// One JSONL line per intercepted /v1/messages request.
+
+import type { ContentMode } from '../config/schema.js';
+import type { Tier } from '../classifier/types.js';
+
+export type { ContentMode };
+
+export type DecisionSource =
+  | 'policy'
+  | 'classifier'
+  | 'fallback'
+  | 'sticky'
+  | 'explicit'
+  | 'shadow';
+
+export type DecisionMode = 'live' | 'shadow';
+
+export type DecisionRotationStrategy = 'daily' | 'size';
+
+export interface UsageFields {
+  readonly input_tokens: number | null;
+  readonly output_tokens: number | null;
+  readonly cache_read_input_tokens: number | null;
+  readonly cache_creation_input_tokens: number | null;
+}
+
+export interface DecisionPolicyResult {
+  readonly rule_id?: string;
+  readonly abstain?: true;
+}
+
+export interface DecisionClassifierResult {
+  readonly score: number;
+  readonly suggested: Tier;
+  readonly confidence: number;
+  readonly source: 'haiku' | 'heuristic';
+  readonly latencyMs: number;
+}
+
+export interface DecisionRecord {
+  readonly timestamp: string;
+  readonly session_id: string;
+  readonly request_hash: string;
+  readonly extracted_signals: Readonly<Record<string, unknown>>;
+  readonly policy_result: DecisionPolicyResult;
+  readonly classifier_result: DecisionClassifierResult | null;
+  readonly sticky_hit: boolean;
+  readonly chosen_model: string;
+  readonly chosen_by: DecisionSource;
+  readonly forwarded_model: string;
+  readonly upstream_latency_ms: number;
+  readonly usage: UsageFields | null;
+  readonly cost_estimate_usd: number | null;
+  readonly classifier_cost_usd: number | null;
+  readonly mode: DecisionMode;
+  readonly shadow_choice: string | null;
+}
+
+export interface DropEvent {
+  readonly event: 'decision_log_dropped';
+  readonly reason: 'queue_full' | 'closed';
+}
diff --git a/tests/decisions/cost.test.ts b/tests/decisions/cost.test.ts
new file mode 100644
index 0000000..f07721a
--- /dev/null
+++ b/tests/decisions/cost.test.ts
@@ -0,0 +1,79 @@
+import { describe, expect, it, vi } from 'vitest';
+import type { Logger } from 'pino';
+import { computeCostUsd, createCostContext, modelFromMessageStart, parseUsage } from '../../src/decisions/cost.js';
+import type { PricingEntry } from '../../src/config/schema.js';
+
+const PRICING: Record<string, PricingEntry> = {
+  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
+  'claude-opus-4-7':           { input: 15,  output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
+};
+
+function mkLogger(): Pick<Logger, 'warn'> & { warn: ReturnType<typeof vi.fn> } {
+  return { warn: vi.fn() };
+}
+
+describe('cost accounting', () => {
+  it('parses the four documented usage fields', () => {
+    const u = parseUsage({
+      input_tokens: 100,
+      output_tokens: 200,
+      cache_read_input_tokens: 50,
+      cache_creation_input_tokens: 25,
+    });
+    expect(u).toEqual({
+      input_tokens: 100,
+      output_tokens: 200,
+      cache_read_input_tokens: 50,
+      cache_creation_input_tokens: 25,
+    });
+  });
+
+  it('returns null when usage is absent or all four fields are missing', () => {
+    expect(parseUsage(null)).toBeNull();
+    expect(parseUsage(undefined)).toBeNull();
+    expect(parseUsage({})).toBeNull();
+    expect(parseUsage({ unrelated: 1 })).toBeNull();
+  });
+
+  it('records a per-component null when a single field is absent', () => {
+    const u = parseUsage({ input_tokens: 100 });
+    expect(u).toEqual({
+      input_tokens: 100,
+      output_tokens: null,
+      cache_read_input_tokens: null,
+      cache_creation_input_tokens: null,
+    });
+  });
+
+  it('uses the pricing table to compute USD cost per million tokens', () => {
+    const u = parseUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
+    const ctx = createCostContext(PRICING, mkLogger());
+    const cost = computeCostUsd('claude-haiku-4-5-20251001', u, ctx);
+    expect(cost).toBeCloseTo(0.8 + 4, 6);
+  });
+
+  it('returns null and warns once per process for an unknown model', () => {
+    const logger = mkLogger();
+    const ctx = createCostContext(PRICING, logger);
+    const u = parseUsage({ input_tokens: 100 });
+    expect(computeCostUsd('claude-mystery', u, ctx)).toBeNull();
+    expect(computeCostUsd('claude-mystery', u, ctx)).toBeNull();
+    expect(logger.warn).toHaveBeenCalledTimes(1);
+  });
+
+  it('returns null cost when usage is null (e.g., stream errored)', () => {
+    const ctx = createCostContext(PRICING, mkLogger());
+    expect(computeCostUsd('claude-opus-4-7', null, ctx)).toBeNull();
+  });
+
+  it('extracts the actual upstream model from a streaming message_start event', () => {
+    const event = { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } };
+    expect(modelFromMessageStart(event)).toBe('claude-haiku-4-5-20251001');
+  });
+
+  it('returns null when message_start does not carry a string model', () => {
+    expect(modelFromMessageStart({})).toBeNull();
+    expect(modelFromMessageStart({ message: {} })).toBeNull();
+    expect(modelFromMessageStart({ message: { model: 42 } })).toBeNull();
+  });
+});
diff --git a/tests/decisions/decision-log.test.ts b/tests/decisions/decision-log.test.ts
new file mode 100644
index 0000000..d1448bb
--- /dev/null
+++ b/tests/decisions/decision-log.test.ts
@@ -0,0 +1,323 @@
+import { afterEach, describe, expect, it, vi } from 'vitest';
+import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { pino, type Logger } from 'pino';
+import { createDecisionLogWriter, type DecisionLogWriter } from '../../src/decisions/log.js';
+import type { DecisionRecord } from '../../src/decisions/types.js';
+import { readDecisions } from '../../src/decisions/reader.js';
+
+function tmpDir(): string {
+  return mkdtempSync(join(tmpdir(), 'ccmux-dl-'));
+}
+
+function silentLogger(): Logger {
+  return pino({ level: 'silent' });
+}
+
+function mkRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
+  return {
+    timestamp: '2026-04-17T00:00:00.000Z',
+    session_id: 'sess-1',
+    request_hash: 'rh-1',
+    extracted_signals: { messageCount: 1 },
+    policy_result: { rule_id: 'r1' },
+    classifier_result: null,
+    sticky_hit: false,
+    chosen_model: 'claude-haiku-4-5-20251001',
+    chosen_by: 'policy',
+    forwarded_model: 'claude-haiku-4-5-20251001',
+    upstream_latency_ms: 0,
+    usage: null,
+    cost_estimate_usd: null,
+    classifier_cost_usd: null,
+    mode: 'live',
+    shadow_choice: null,
+    ...over,
+  };
+}
+
+let writer: DecisionLogWriter | null = null;
+
+afterEach(async () => {
+  if (writer !== null) {
+    await writer.close();
+    writer = null;
+  }
+  vi.restoreAllMocks();
+});
+
+describe('DecisionLogWriter', () => {
+  it('writes one JSONL line per record matching the input shape', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 1024 * 1024,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    writer.append(mkRecord({ session_id: 'a' }));
+    writer.append(mkRecord({ session_id: 'b' }));
+    await writer.flush();
+    const lines = readFileSync(writer.currentPath(), 'utf8').trim().split('\n');
+    expect(lines).toHaveLength(2);
+    expect(JSON.parse(lines[0] as string)).toMatchObject({ session_id: 'a' });
+    expect(JSON.parse(lines[1] as string)).toMatchObject({ session_id: 'b' });
+  });
+
+  it('records the actual forwarded model, not the requested one', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 1024 * 1024,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    writer.append(mkRecord({
+      chosen_model: 'claude-opus-4-7',
+      forwarded_model: 'claude-haiku-4-5-20251001',
+    }));
+    await writer.flush();
+    const line = readFileSync(writer.currentPath(), 'utf8').trim();
+    const parsed = JSON.parse(line) as DecisionRecord;
+    expect(parsed.forwarded_model).toBe('claude-haiku-4-5-20251001');
+    expect(parsed.chosen_model).toBe('claude-opus-4-7');
+  });
+
+  it('does not call statSync on the hot append path (in-process byte counter)', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'size',
+      maxBytes: 1024 * 1024,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    await writer.flush();
+    const { fsHelpers } = await import('../../src/decisions/_fs.js');
+    const spy = vi.spyOn(fsHelpers, 'statSync');
+    for (let i = 0; i < 50; i += 1) {
+      writer.append(mkRecord({ session_id: `s${i}` }));
+    }
+    await writer.flush();
+    expect(spy).not.toHaveBeenCalled();
+  });
+
+  it('triggers size-based rotation when the byte counter crosses maxBytes', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'size',
+      maxBytes: 200, // very small to force rotation after ~1 record
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    for (let i = 0; i < 5; i += 1) {
+      writer.append(mkRecord({ session_id: `s${i}` }));
+      await writer.flush();
+    }
+    const entries = readdirSync(dir).filter((f) => f.startsWith('decisions-')).sort();
+    expect(entries.length).toBeGreaterThanOrEqual(2);
+    expect(entries.some((e) => /^decisions-\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(e))).toBe(true);
+  });
+
+  it('seeds the byte counter from the file size on startup for an existing file', async () => {
+    const dir = tmpDir();
+    const date = new Date(2026, 3, 17, 12);
+    const seedPath = join(dir, `decisions-2026-04-17.jsonl`);
+    writeFileSync(seedPath, 'x'.repeat(500));
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => date,
+    });
+    await writer.flush();
+    expect(writer.currentBytes()).toBe(500);
+  });
+
+  it('rotates when the local date changes (daily strategy)', async () => {
+    const dir = tmpDir();
+    let now = new Date(2026, 3, 17, 23, 59);
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => now,
+    });
+    writer.append(mkRecord({ session_id: 'pre-midnight' }));
+    await writer.flush();
+    const firstPath = writer.currentPath();
+    now = new Date(2026, 3, 18, 0, 1);
+    writer.append(mkRecord({ session_id: 'post-midnight' }));
+    await writer.flush();
+    const secondPath = writer.currentPath();
+    expect(secondPath).not.toBe(firstPath);
+    expect(readFileSync(firstPath, 'utf8')).toMatch(/pre-midnight/);
+    expect(readFileSync(secondPath, 'utf8')).toMatch(/post-midnight/);
+  });
+
+  it('drops records and logs the drop when the bounded queue overflows', async () => {
+    const dir = tmpDir();
+    const warns: unknown[] = [];
+    const logger: Logger = pino({ level: 'silent' });
+    (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
+    // Use a writer but don't drain — instead use a stream that never accepts.
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000_000,
+      retentionDays: 30,
+      fsync: false,
+      logger,
+      clock: () => new Date(2026, 3, 17, 12),
+    });
+    // Saturate by closing first then attempting appends.
+    await writer.close();
+    const accepted = writer.append(mkRecord());
+    expect(accepted).toBe(false);
+    expect(warns.some((a) => JSON.stringify(a).includes('decision_log_dropped'))).toBe(true);
+    writer = null;
+  });
+
+  it('does not fsync on each append by default', async () => {
+    const dir = tmpDir();
+    const { fsHelpers } = await import('../../src/decisions/_fs.js');
+    const spy = vi.spyOn(fsHelpers, 'fsyncSync');
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date(2026, 3, 17, 12),
+    });
+    writer.append(mkRecord());
+    await writer.flush();
+    expect(spy).not.toHaveBeenCalled();
+  });
+
+  it('reader yields records in chronological order across multiple files', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'size',
+      maxBytes: 200,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date(2026, 3, 17, 12),
+    });
+    for (let i = 0; i < 5; i += 1) {
+      writer.append(mkRecord({ session_id: `s${i}` }));
+      await writer.flush();
+    }
+    await writer.close();
+    writer = null;
+    const out: string[] = [];
+    for await (const r of readDecisions(dir)) {
+      out.push(r.session_id);
+    }
+    expect(out).toEqual(['s0', 's1', 's2', 's3', 's4']);
+  });
+
+  it('reader limit caps the number of yielded records', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date(2026, 3, 17, 12),
+    });
+    for (let i = 0; i < 5; i += 1) writer.append(mkRecord({ session_id: `s${i}` }));
+    await writer.flush();
+    await writer.close();
+    writer = null;
+    const out: string[] = [];
+    for await (const r of readDecisions(dir, { limit: 2 })) out.push(r.session_id);
+    expect(out).toHaveLength(2);
+  });
+
+  it('golden record round-trip is byte-for-byte stable for a fixed input', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    const record = mkRecord({
+      timestamp: '2026-04-17T14:00:00.000Z',
+      session_id: 'sess-golden',
+      request_hash: 'rh-golden',
+      chosen_model: 'claude-haiku-4-5-20251001',
+      forwarded_model: 'claude-haiku-4-5-20251001',
+    });
+    writer.append(record);
+    await writer.flush();
+    const onDisk = readFileSync(writer.currentPath(), 'utf8');
+    expect(onDisk).toBe(JSON.stringify(record) + '\n');
+  });
+
+  // Tag for §17 contract: usage = null if upstream stream errors.
+  it('records usage=null and cost=null when upstream usage is absent', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    writer.append(mkRecord({ usage: null, cost_estimate_usd: null }));
+    await writer.flush();
+    const parsed = JSON.parse(readFileSync(writer.currentPath(), 'utf8').trim()) as DecisionRecord;
+    expect(parsed.usage).toBeNull();
+    expect(parsed.cost_estimate_usd).toBeNull();
+  });
+
+  // Defensive: file size on disk must equal what we wrote (no half-written lines).
+  it('writes complete lines (newline-terminated) to disk', async () => {
+    const dir = tmpDir();
+    writer = createDecisionLogWriter({
+      dir,
+      rotation: 'daily',
+      maxBytes: 10_000,
+      retentionDays: 30,
+      fsync: false,
+      logger: silentLogger(),
+      clock: () => new Date('2026-04-17T00:00:00Z'),
+    });
+    writer.append(mkRecord());
+    await writer.flush();
+    const size = statSync(writer.currentPath()).size;
+    const text = readFileSync(writer.currentPath(), 'utf8');
+    expect(size).toBe(Buffer.byteLength(text));
+    expect(text.endsWith('\n')).toBe(true);
+  });
+});
diff --git a/tests/decisions/record.test.ts b/tests/decisions/record.test.ts
new file mode 100644
index 0000000..872580e
--- /dev/null
+++ b/tests/decisions/record.test.ts
@@ -0,0 +1,111 @@
+import { describe, expect, it } from 'vitest';
+import { buildDecisionRecord } from '../../src/decisions/record.js';
+import type { Signals } from '../../src/signals/types.js';
+import type { PolicyResult } from '../../src/policy/dsl.js';
+import type { ClassifierResult } from '../../src/classifier/types.js';
+
+const SIGNALS: Signals = {
+  planMode: false,
+  messageCount: 1,
+  tools: ['bash'],
+  toolUseCount: 0,
+  estInputTokens: 100,
+  fileRefCount: 0,
+  retryCount: 0,
+  frustration: false,
+  explicitModel: null,
+  projectPath: '/p',
+  sessionDurationMs: 0,
+  betaFlags: [],
+  sessionId: 'sess',
+  requestHash: 'rh',
+};
+
+const NOW = new Date('2026-04-17T14:00:00.000Z');
+
+describe('buildDecisionRecord', () => {
+  it('serializes timestamp as ISO and projects PolicyResult.matched into rule_id', () => {
+    const policy: PolicyResult = { kind: 'matched', ruleId: 'short-simple-haiku', result: { choice: 'haiku' } };
+    const r = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: policy, classifierResult: null, stickyHit: false,
+      chosenModel: 'm', chosenBy: 'policy', forwardedModel: 'm',
+      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
+    });
+    expect(r.timestamp).toBe('2026-04-17T14:00:00.000Z');
+    expect(r.policy_result).toEqual({ rule_id: 'short-simple-haiku' });
+  });
+
+  it('projects PolicyResult.abstain into { abstain: true }', () => {
+    const r = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: { kind: 'abstain' },
+      classifierResult: null, stickyHit: false,
+      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
+      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
+    });
+    expect(r.policy_result).toEqual({ abstain: true });
+  });
+
+  it('projects ClassifierResult into the documented decision-log shape', () => {
+    const cr: ClassifierResult = {
+      score: 4.2, suggestedModel: 'sonnet', confidence: 0.81, source: 'haiku', latencyMs: 512,
+    };
+    const r = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: { kind: 'abstain' }, classifierResult: cr, stickyHit: false,
+      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
+      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
+    });
+    expect(r.classifier_result).toEqual({
+      score: 4.2, suggested: 'sonnet', confidence: 0.81, source: 'haiku', latencyMs: 512,
+    });
+  });
+
+  it('shadow mode: forwarded_model is the requested one and shadow_choice holds the would-have-been override', () => {
+    const r = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: { kind: 'matched', ruleId: 'opus-rule', result: { choice: 'opus' } },
+      classifierResult: null, stickyHit: false,
+      chosenModel: 'claude-sonnet-4-5',          // client-requested
+      chosenBy: 'shadow',
+      forwardedModel: 'claude-sonnet-4-5',       // what actually went upstream
+      mode: 'shadow',
+      shadowChoice: 'claude-opus-4-7',           // what we WOULD have done
+      upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
+    });
+    expect(r.mode).toBe('shadow');
+    expect(r.forwarded_model).toBe('claude-sonnet-4-5');
+    expect(r.shadow_choice).toBe('claude-opus-4-7');
+  });
+
+  it('applies the configured content-mode redaction to extracted_signals', () => {
+    const full = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: { kind: 'abstain' }, classifierResult: null, stickyHit: false,
+      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
+      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'full',
+    });
+    expect((full.extracted_signals as Record<string, unknown>).projectPath).toBe('/p');
+
+    const none = buildDecisionRecord({
+      now: NOW,
+      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
+      policyResult: { kind: 'abstain' }, classifierResult: null, stickyHit: false,
+      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
+      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
+      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'none',
+    });
+    expect('projectPath' in (none.extracted_signals as Record<string, unknown>)).toBe(false);
+  });
+});
diff --git a/tests/decisions/redaction.test.ts b/tests/decisions/redaction.test.ts
new file mode 100644
index 0000000..2590284
--- /dev/null
+++ b/tests/decisions/redaction.test.ts
@@ -0,0 +1,87 @@
+import { describe, expect, it } from 'vitest';
+import { readFileSync, readdirSync } from 'node:fs';
+import { join } from 'node:path';
+import type { Signals } from '../../src/signals/types.js';
+import { hash12, redactContent, redactSignals } from '../../src/decisions/redaction.js';
+
+const CLI_DIR = join(process.cwd(), 'src', 'cli');
+
+function mkSignals(over: Partial<Signals> = {}): Signals {
+  return {
+    planMode: false,
+    messageCount: 3,
+    tools: ['bash', 'read'],
+    toolUseCount: 2,
+    estInputTokens: 1234,
+    fileRefCount: 1,
+    retryCount: 0,
+    frustration: false,
+    explicitModel: 'claude-opus-4-7',
+    projectPath: '/home/user/proj',
+    sessionDurationMs: 60_000,
+    betaFlags: ['beta-flag-1'],
+    sessionId: 'sess-1',
+    requestHash: 'rh-1',
+    ...over,
+  };
+}
+
+describe('redaction', () => {
+  it('hashed mode replaces sensitive strings with 12-char hex digests', () => {
+    const r = redactSignals(mkSignals(), 'hashed') as Record<string, unknown>;
+    expect(r.projectPath).toBe(hash12('/home/user/proj'));
+    expect(r.explicitModel).toBe(hash12('claude-opus-4-7'));
+    expect(Array.isArray(r.tools)).toBe(true);
+    expect((r.tools as string[]).every((t) => /^[0-9a-f]{12}$/.test(t))).toBe(true);
+  });
+
+  it('hashed mode keeps identical inputs linkable (collision intentional)', () => {
+    const a = redactSignals(mkSignals({ projectPath: '/p' }), 'hashed') as Record<string, unknown>;
+    const b = redactSignals(mkSignals({ projectPath: '/p' }), 'hashed') as Record<string, unknown>;
+    expect(a.projectPath).toBe(b.projectPath);
+  });
+
+  it('full mode preserves the raw signal values', () => {
+    const r = redactSignals(mkSignals(), 'full') as Record<string, unknown>;
+    expect(r.projectPath).toBe('/home/user/proj');
+    expect(r.tools).toEqual(['bash', 'read']);
+  });
+
+  it('none mode drops content fields entirely (tools/explicitModel/projectPath/betaFlags)', () => {
+    const r = redactSignals(mkSignals(), 'none') as Record<string, unknown>;
+    expect('tools' in r).toBe(false);
+    expect('explicitModel' in r).toBe(false);
+    expect('projectPath' in r).toBe(false);
+    expect('betaFlags' in r).toBe(false);
+    // Counts/metadata still present.
+    expect(r.toolCount).toBe(2);
+    expect(r.betaFlagCount).toBe(1);
+    expect(r.messageCount).toBe(3);
+  });
+
+  it('redactContent in none mode returns undefined', () => {
+    expect(redactContent({ secret: 'abc' }, 'none')).toBeUndefined();
+  });
+
+  it('redactContent in hashed mode returns a 12-char digest', () => {
+    const out = redactContent({ secret: 'abc' }, 'hashed');
+    expect(typeof out).toBe('string');
+    expect((out as string).length).toBe(12);
+  });
+
+  it('redactContent in full mode throws if the object contains a forbidden auth header', () => {
+    expect(() => redactContent({ authorization: 'Bearer x' }, 'full')).toThrow(/forbidden header/i);
+    expect(() => redactContent({ 'x-api-key': 'sk-x' }, 'full')).toThrow();
+    expect(() => redactContent({ 'x-ccmux-token': 't' }, 'full')).toThrow();
+  });
+
+  it('no CLI flag exists to toggle the privacy mode (config-only)', () => {
+    const sources = readdirSync(CLI_DIR)
+      .filter((f) => f.endsWith('.ts'))
+      .map((f) => readFileSync(join(CLI_DIR, f), 'utf8'))
+      .join('\n');
+    expect(sources).not.toMatch(/--content\b/);
+    expect(sources).not.toMatch(/--privacy\b/);
+    expect(sources).not.toMatch(/--redact\b/);
+  });
+});
diff --git a/tests/decisions/rotation.test.ts b/tests/decisions/rotation.test.ts
new file mode 100644
index 0000000..c98a86f
--- /dev/null
+++ b/tests/decisions/rotation.test.ts
@@ -0,0 +1,102 @@
+import { describe, expect, it, vi } from 'vitest';
+import { mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import {
+  applyRetention,
+  dailyFilename,
+  nextSizeFilename,
+  parseLogFilename,
+  rotateRename,
+} from '../../src/decisions/rotate.js';
+
+function tmpDir(): string {
+  return mkdtempSync(join(tmpdir(), 'ccmux-rot-'));
+}
+
+describe('rotation', () => {
+  it('parses daily and size-suffixed filenames; ignores unrelated files', () => {
+    expect(parseLogFilename('decisions-2026-04-17.jsonl')).toEqual({ date: '2026-04-17', suffix: 0 });
+    expect(parseLogFilename('decisions-2026-04-17.3.jsonl')).toEqual({ date: '2026-04-17', suffix: 3 });
+    expect(parseLogFilename('outcomes.jsonl')).toBeNull();
+    expect(parseLogFilename('random.txt')).toBeNull();
+  });
+
+  it('daily strategy uses a date-stamped filename', () => {
+    const d = new Date('2026-04-17T12:34:56Z');
+    // Daily filename uses local-time components; assert against a parse of the result.
+    const parsed = parseLogFilename(dailyFilename(d));
+    expect(parsed?.suffix).toBe(0);
+    expect(parsed?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
+  });
+
+  it('nextSizeFilename increments the suffix beyond the existing max', () => {
+    const dir = tmpDir();
+    const date = new Date(2026, 3, 17, 12, 0, 0); // local
+    writeFileSync(join(dir, dailyFilename(date)), '');
+    writeFileSync(join(dir, 'decisions-2026-04-17.1.jsonl'), '');
+    writeFileSync(join(dir, 'decisions-2026-04-17.5.jsonl'), '');
+    const next = nextSizeFilename(dir, date);
+    expect(next).toBe('decisions-2026-04-17.6.jsonl');
+  });
+
+  it('rotateRename falls back to copy+truncate when rename throws EBUSY', async () => {
+    const dir = tmpDir();
+    const src = join(dir, 'decisions-2026-04-17.jsonl');
+    const dst = join(dir, 'decisions-2026-04-17.1.jsonl');
+    writeFileSync(src, 'hello\n');
+    const err = Object.assign(new Error('busy'), { code: 'EBUSY' }) as NodeJS.ErrnoException;
+    const { fsHelpers } = await import('../../src/decisions/_fs.js');
+    const spy = vi.spyOn(fsHelpers, 'renameSync').mockImplementationOnce(() => { throw err; });
+    try {
+      rotateRename(src, dst);
+    } finally {
+      spy.mockRestore();
+    }
+    const entries = readdirSync(dir).sort();
+    expect(entries).toContain('decisions-2026-04-17.1.jsonl');
+    expect(entries).toContain('decisions-2026-04-17.jsonl');
+  });
+
+  it('rotateRename rethrows non-recoverable errors', async () => {
+    const dir = tmpDir();
+    const src = join(dir, 'a.jsonl');
+    writeFileSync(src, '');
+    const err = Object.assign(new Error('disk gone'), { code: 'EIO' }) as NodeJS.ErrnoException;
+    const { fsHelpers } = await import('../../src/decisions/_fs.js');
+    const spy = vi.spyOn(fsHelpers, 'renameSync').mockImplementationOnce(() => { throw err; });
+    try {
+      expect(() => rotateRename(src, join(dir, 'b.jsonl'))).toThrow(/disk gone/);
+    } finally {
+      spy.mockRestore();
+    }
+  });
+
+  it('retention parses dates from the filename, not mtime', () => {
+    const dir = tmpDir();
+    // Old-by-name files should be deleted.
+    writeFileSync(join(dir, 'decisions-2024-01-01.jsonl'), '');
+    writeFileSync(join(dir, 'decisions-2024-01-02.3.jsonl'), '');
+    // Recent-by-name should survive even if mtime is fresh.
+    writeFileSync(join(dir, 'decisions-2026-04-17.jsonl'), '');
+    // Unrelated files left alone.
+    writeFileSync(join(dir, 'outcomes.jsonl'), '');
+    const removed = applyRetention(dir, 30, new Date('2026-04-17T00:00:00Z'));
+    expect([...removed].sort()).toEqual([
+      'decisions-2024-01-01.jsonl',
+      'decisions-2024-01-02.3.jsonl',
+    ]);
+    const remaining = readdirSync(dir).sort();
+    expect(remaining).toEqual(['decisions-2026-04-17.jsonl', 'outcomes.jsonl']);
+  });
+
+  it('retention with retentionDays <= 0 is a no-op', () => {
+    const dir = tmpDir();
+    writeFileSync(join(dir, 'decisions-2024-01-01.jsonl'), '');
+    expect(applyRetention(dir, 0, new Date()).length).toBe(0);
+    expect(readdirSync(dir).length).toBe(1);
+  });
+
+  // Silences unused import warning when test trims later.
+  void renameSync;
+});
