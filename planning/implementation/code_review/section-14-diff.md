diff --git a/src/decisions/outcome.ts b/src/decisions/outcome.ts
index ccf4042..f778c07 100644
--- a/src/decisions/outcome.ts
+++ b/src/decisions/outcome.ts
@@ -1,2 +1,171 @@
-// Populated in section-14. Do not import.
-export {};
+// Outcome tagger — passive, post-hoc annotation of decision records with a
+// session-outcome label written to outcomes.jsonl. Never blocks the proxy
+// path. First tag wins per requestHash, so re-running over the same log on
+// startup is a no-op. Time and I/O are injected so tests use fake timers and
+// in-memory stores.
+//
+// Tag values:
+//   continued              — next turn in the same session is a new prompt
+//   retried                — same requestHash repeats within retryWindowSec
+//   frustration_next_turn  — follow-up turn flips frustration false → true
+//   abandoned              — no follow-up turn within idleTtlSec
+
+import type { Logger } from 'pino';
+import { join } from 'node:path';
+
+export type OutcomeTag = 'continued' | 'retried' | 'frustration_next_turn' | 'abandoned';
+
+export interface OutcomeTaggerConfig {
+  readonly logDir: string;
+  readonly retryWindowSec: number;
+  readonly idleTtlSec: number;
+  readonly tailIntervalMs: number;
+}
+
+export interface OutcomeTaggerInput {
+  readonly ts: string;            // ISO timestamp
+  readonly requestHash: string;
+  readonly sessionId: string;
+  readonly frustration: boolean | null;
+}
+
+export interface OutcomeTaggerDeps {
+  now(): number;
+  appendLine(path: string, line: string): Promise<void>;
+  readLines(path: string): AsyncIterable<string>;
+  logger: Logger;
+}
+
+export interface OutcomeTagger {
+  start(): Promise<void>;
+  ingest(record: OutcomeTaggerInput): void;
+  /** Resolves once all queued sidecar writes have completed. Mostly for tests. */
+  flush(): Promise<void>;
+  stop(): Promise<void>;
+}
+
+interface SessionEntry {
+  readonly requestHash: string;
+  readonly tsMs: number;
+  readonly frustration: boolean | null;
+}
+
+export function createOutcomeTagger(
+  config: OutcomeTaggerConfig,
+  deps: OutcomeTaggerDeps,
+): OutcomeTagger {
+  const sidecarPath = join(config.logDir, 'outcomes.jsonl');
+  const tagged = new Set<string>();
+  const lastSeen = new Map<string, SessionEntry>();
+  const recentHashes = new Map<string, number>();
+  let timer: NodeJS.Timeout | null = null;
+  let pending: Promise<void> = Promise.resolve();
+  let started = false;
+  let stopped = false;
+
+  function emitTag(requestHash: string, sessionId: string, tag: OutcomeTag, ts: string): void {
+    if (tagged.has(requestHash)) return;
+    tagged.add(requestHash);
+    const line = JSON.stringify({ requestHash, sessionId, tag, ts }) + '\n';
+    pending = pending
+      .then(() => deps.appendLine(sidecarPath, line))
+      .catch((err) => {
+        deps.logger.warn({ err, event: 'outcome_tag_write_failed', requestHash, tag }, 'outcome tag write failed');
+      });
+  }
+
+  function pruneRecent(nowMs: number): void {
+    const cutoff = nowMs - config.retryWindowSec * 2 * 1000;
+    for (const [hash, ts] of recentHashes) {
+      if (ts < cutoff) recentHashes.delete(hash);
+    }
+  }
+
+  function ingest(record: OutcomeTaggerInput): void {
+    if (stopped) return;
+    try {
+      const tsMs = Date.parse(record.ts);
+      if (Number.isNaN(tsMs)) {
+        deps.logger.warn({ event: 'outcome_skip_bad_timestamp', ts: record.ts }, 'skipping record with unparseable timestamp');
+        return;
+      }
+      pruneRecent(tsMs);
+
+      const priorHashTs = recentHashes.get(record.requestHash);
+      if (priorHashTs !== undefined && tsMs - priorHashTs <= config.retryWindowSec * 1000) {
+        emitTag(record.requestHash, record.sessionId, 'retried', record.ts);
+      } else {
+        const prior = lastSeen.get(record.sessionId);
+        if (prior !== undefined) {
+          if (prior.frustration !== true && record.frustration === true) {
+            emitTag(prior.requestHash, record.sessionId, 'frustration_next_turn', record.ts);
+          } else {
+            emitTag(prior.requestHash, record.sessionId, 'continued', record.ts);
+          }
+        }
+      }
+
+      lastSeen.set(record.sessionId, {
+        requestHash: record.requestHash,
+        tsMs,
+        frustration: record.frustration,
+      });
+      recentHashes.set(record.requestHash, tsMs);
+    } catch (err) {
+      deps.logger.warn({ err, event: 'outcome_ingest_error' }, 'outcome tagger ingest error');
+    }
+  }
+
+  function sweepIdle(): void {
+    try {
+      const nowMs = deps.now();
+      const cutoff = nowMs - config.idleTtlSec * 1000;
+      for (const [sessionId, prior] of lastSeen) {
+        if (prior.tsMs < cutoff) {
+          if (!tagged.has(prior.requestHash)) {
+            emitTag(prior.requestHash, sessionId, 'abandoned', new Date(nowMs).toISOString());
+          }
+          lastSeen.delete(sessionId);
+        }
+      }
+    } catch (err) {
+      deps.logger.warn({ err, event: 'outcome_sweep_error' }, 'outcome sweep error');
+    }
+  }
+
+  async function start(): Promise<void> {
+    if (started) return;
+    started = true;
+    try {
+      for await (const line of deps.readLines(sidecarPath)) {
+        if (line.length === 0) continue;
+        try {
+          const parsed = JSON.parse(line) as { requestHash?: unknown };
+          if (typeof parsed.requestHash === 'string') tagged.add(parsed.requestHash);
+        } catch {
+          // skip malformed line
+        }
+      }
+    } catch (err) {
+      deps.logger.warn({ err, event: 'outcome_seed_failed', path: sidecarPath }, 'outcome sidecar seed failed');
+    }
+    timer = setInterval(sweepIdle, config.tailIntervalMs);
+    timer.unref?.();
+  }
+
+  async function stop(): Promise<void> {
+    if (stopped) return;
+    stopped = true;
+    if (timer !== null) {
+      clearInterval(timer);
+      timer = null;
+    }
+    await pending;
+  }
+
+  function flush(): Promise<void> {
+    return pending;
+  }
+
+  return { start, ingest, flush, stop };
+}
diff --git a/tests/decisions/outcome.test.ts b/tests/decisions/outcome.test.ts
new file mode 100644
index 0000000..aa983cb
--- /dev/null
+++ b/tests/decisions/outcome.test.ts
@@ -0,0 +1,238 @@
+import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
+import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { pino, type Logger } from 'pino';
+import {
+  createOutcomeTagger,
+  type OutcomeTagger,
+  type OutcomeTaggerInput,
+} from '../../src/decisions/outcome.js';
+
+function tmpLogDir(): string {
+  return mkdtempSync(join(tmpdir(), 'ccmux-outcome-'));
+}
+
+function silentLogger(): Logger {
+  return pino({ level: 'silent' });
+}
+
+function rec(over: Partial<OutcomeTaggerInput> & { ts: string; requestHash: string; sessionId: string }): OutcomeTaggerInput {
+  return { frustration: false, ...over };
+}
+
+interface InMemoryDeps {
+  appended: { path: string; line: string }[];
+  appendLine: (path: string, line: string) => Promise<void>;
+  readLines: (path: string) => AsyncIterable<string>;
+  files: Map<string, string>;
+  logger: Logger;
+  now: () => number;
+}
+
+function makeDeps(initial: Map<string, string> = new Map()): InMemoryDeps {
+  const files = new Map(initial);
+  const appended: { path: string; line: string }[] = [];
+  return {
+    appended,
+    files,
+    logger: silentLogger(),
+    now: () => Date.now(),
+    appendLine: async (path, line) => {
+      appended.push({ path, line });
+      files.set(path, (files.get(path) ?? '') + line);
+    },
+    readLines: (path) => {
+      const content = files.get(path) ?? '';
+      const lines = content.length === 0 ? [] : content.split('\n').filter((l) => l.length > 0);
+      return (async function* () {
+        for (const l of lines) yield l;
+      })();
+    },
+  };
+}
+
+let tagger: OutcomeTagger | null = null;
+
+beforeEach(() => {
+  vi.useFakeTimers();
+});
+
+afterEach(async () => {
+  if (tagger !== null) {
+    await tagger.stop();
+    tagger = null;
+  }
+  vi.useRealTimers();
+  vi.restoreAllMocks();
+});
+
+describe('outcome tagger', () => {
+  it('tags the prior turn "continued" when a new turn arrives in the same session', async () => {
+    const dir = tmpLogDir();
+    const deps = makeDeps();
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'h2', sessionId: 's1' }));
+    await tagger.flush();
+    expect(deps.appended).toHaveLength(1);
+    const parsed = JSON.parse(deps.appended[0]!.line) as { requestHash: string; tag: string };
+    expect(parsed).toMatchObject({ requestHash: 'h1', tag: 'continued' });
+  });
+
+  it('tags "retried" when the same requestHash repeats within retryWindowSec', async () => {
+    const dir = tmpLogDir();
+    const deps = makeDeps();
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'hX', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'hX', sessionId: 's1' }));
+    await tagger.flush();
+    expect(deps.appended.some((a) => a.line.includes('"tag":"retried"'))).toBe(true);
+    expect(deps.appended.filter((a) => JSON.parse(a.line).requestHash === 'hX')).toHaveLength(1);
+  });
+
+  it('does NOT tag "retried" when the same requestHash repeats AFTER retryWindowSec', async () => {
+    const dir = tmpLogDir();
+    const deps = makeDeps();
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'hY', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:05:00Z', requestHash: 'hY', sessionId: 's1' }));
+    await tagger.flush();
+    expect(deps.appended.every((a) => !a.line.includes('"tag":"retried"'))).toBe(true);
+    expect(deps.appended.some((a) => a.line.includes('"tag":"continued"'))).toBe(true);
+  });
+
+  it('tags "frustration_next_turn" when the follow-up turn has frustration=true', async () => {
+    const dir = tmpLogDir();
+    const deps = makeDeps();
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1', frustration: false }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:30Z', requestHash: 'h2', sessionId: 's1', frustration: true }));
+    await tagger.flush();
+    expect(deps.appended).toHaveLength(1);
+    expect(JSON.parse(deps.appended[0]!.line)).toMatchObject({ requestHash: 'h1', tag: 'frustration_next_turn' });
+  });
+
+  it('tags "abandoned" when no follow-up occurs within idleTtlSec', async () => {
+    const dir = tmpLogDir();
+    let nowMs = Date.parse('2026-04-17T10:00:00Z');
+    const deps = makeDeps();
+    deps.now = () => nowMs;
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'lone', sessionId: 's1' }));
+    nowMs += 901_000;
+    await vi.advanceTimersByTimeAsync(2_000);
+    await tagger.flush();
+    expect(deps.appended.some((a) => JSON.parse(a.line).requestHash === 'lone' && JSON.parse(a.line).tag === 'abandoned')).toBe(true);
+  });
+
+  it('writes one tag per requestHash (first-write wins)', async () => {
+    const dir = tmpLogDir();
+    const deps = makeDeps();
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' })); // tags h1 continued
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:20Z', requestHash: 'h1', sessionId: 's2' })); // would imply retried, but h1 already tagged
+    await tagger.flush();
+    const h1Lines = deps.appended.filter((a) => JSON.parse(a.line).requestHash === 'h1');
+    expect(h1Lines).toHaveLength(1);
+  });
+
+  it('rebuilds the tagged-hash set from existing outcomes.jsonl on startup', async () => {
+    const dir = tmpLogDir();
+    const sidecarPath = join(dir, 'outcomes.jsonl');
+    const seeded = new Map([[sidecarPath, JSON.stringify({ requestHash: 'preTagged', sessionId: 's0', tag: 'continued', ts: '2026-04-16T00:00:00Z' }) + '\n']]);
+    const deps = makeDeps(seeded);
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'preTagged', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' }));
+    await tagger.flush();
+    expect(deps.appended.some((a) => JSON.parse(a.line).requestHash === 'preTagged')).toBe(false);
+  });
+
+  it('never throws into the caller; logs warnings on internal errors', async () => {
+    const dir = tmpLogDir();
+    const warns: unknown[] = [];
+    const deps = makeDeps();
+    (deps.logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warns.push(a); };
+    deps.appendLine = async () => { throw new Error('disk gone'); };
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      deps,
+    );
+    await tagger.start();
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:00Z', requestHash: 'h1', sessionId: 's1' }));
+    tagger.ingest(rec({ ts: '2026-04-17T10:00:10Z', requestHash: 'h2', sessionId: 's1' }));
+    await tagger.flush();
+    expect(warns.length).toBeGreaterThan(0);
+  });
+
+  it('end-to-end: reads decision JSONL from a real file, writes outcomes sidecar', async () => {
+    const dir = tmpLogDir();
+    const decisionPath = join(dir, 'decisions-2026-04-17.jsonl');
+    const sidecarPath = join(dir, 'outcomes.jsonl');
+    writeFileSync(decisionPath, [
+      JSON.stringify({ ts: '2026-04-17T10:00:00Z', requestHash: 'r1', sessionId: 's1', signals: { frustration: false } }),
+      JSON.stringify({ ts: '2026-04-17T10:00:10Z', requestHash: 'r2', sessionId: 's1', signals: { frustration: false } }),
+    ].join('\n') + '\n', 'utf8');
+
+    // Use real fs deps for this case.
+    const { promises: fsp } = await import('node:fs');
+    const { createReadStream } = await import('node:fs');
+    const { createInterface } = await import('node:readline');
+    const realDeps = {
+      now: () => Date.now(),
+      logger: silentLogger(),
+      appendLine: async (path: string, line: string) => { await fsp.appendFile(path, line, 'utf8'); },
+      readLines: (path: string): AsyncIterable<string> => {
+        if (!existsSync(path)) {
+          return (async function* () { /* empty */ })();
+        }
+        const stream = createReadStream(path, { encoding: 'utf8' });
+        const rl = createInterface({ input: stream, crlfDelay: Infinity });
+        return rl;
+      },
+    };
+    tagger = createOutcomeTagger(
+      { logDir: dir, retryWindowSec: 60, idleTtlSec: 900, tailIntervalMs: 2000 },
+      realDeps,
+    );
+    await tagger.start();
+    // Manually feed the records (the file-tail wrapper lives elsewhere).
+    tagger.ingest({ ts: '2026-04-17T10:00:00Z', requestHash: 'r1', sessionId: 's1', frustration: false });
+    tagger.ingest({ ts: '2026-04-17T10:00:10Z', requestHash: 'r2', sessionId: 's1', frustration: false });
+    await tagger.stop();
+    tagger = null;
+    const sidecar = readFileSync(sidecarPath, 'utf8').trim();
+    expect(sidecar).toMatch(/"requestHash":"r1"/);
+    expect(sidecar).toMatch(/"tag":"continued"/);
+  });
+});
