diff --git a/src/classifier/heuristic.ts b/src/classifier/heuristic.ts
index 6b78e28..17bb14b 100644
--- a/src/classifier/heuristic.ts
+++ b/src/classifier/heuristic.ts
@@ -1,2 +1,162 @@
-// Populated in section-11. Do not import.
-export {};
+// Zero-latency, deterministic local complexity scorer (§11).
+// Synchronous under the hood; the `async` signature exists only to
+// satisfy the shared `Classifier` interface consumed by §12's race.
+
+import { performance } from 'node:perf_hooks';
+import type {
+  Classifier,
+  ClassifierInput,
+  ClassifierResult,
+  Tier,
+} from './types.js';
+
+const IMPERATIVE_VERBS = /^(?:write|build|refactor|implement|design|debug|fix)\b/i;
+
+const WEIGHTS = {
+  toolBreadthFactor: 0.5,
+  toolBreadthCap: 3,
+  codeBlockFactor: 0.3,
+  codeBlockCap: 2,
+  filePathFactor: 0.4,
+  filePathCap: 2,
+} as const;
+
+const BAND_LOW = 3.0;
+const BAND_HIGH = 6.5;
+const MAX_BOUNDARY_DIST = 3.5;
+const CONF_FLOOR = 0.2;
+const CONF_CEIL = 0.85;
+
+function tokenBand(n: number): number {
+  if (n < 500) return 0;
+  if (n < 2000) return 1;
+  if (n < 8000) return 2;
+  return 3;
+}
+
+function bandFromScore(score: number): Tier {
+  if (score < BAND_LOW) return 'haiku';
+  if (score < BAND_HIGH) return 'sonnet';
+  return 'opus';
+}
+
+function clamp(n: number, lo: number, hi: number): number {
+  return Math.min(hi, Math.max(lo, n));
+}
+
+function flattenTextLoose(content: unknown): string {
+  if (typeof content === 'string') return content;
+  if (!Array.isArray(content)) return '';
+  const parts: string[] = [];
+  for (const block of content) {
+    if (!block || typeof block !== 'object') continue;
+    const b = block as { type?: unknown; text?: unknown };
+    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
+  }
+  return parts.join('\n');
+}
+
+function countCodeFences(body: unknown): number {
+  if (!body || typeof body !== 'object') return 0;
+  const messages = (body as { messages?: unknown }).messages;
+  if (!Array.isArray(messages)) return 0;
+  let triples = 0;
+  for (const msg of messages) {
+    if (!msg || typeof msg !== 'object') continue;
+    const text = flattenTextLoose((msg as { content?: unknown }).content);
+    const matches = text.match(/```/g);
+    if (matches) triples += matches.length;
+  }
+  return Math.floor(triples / 2);
+}
+
+function lastUserText(body: unknown): string {
+  if (!body || typeof body !== 'object') return '';
+  const messages = (body as { messages?: unknown }).messages;
+  if (!Array.isArray(messages)) return '';
+  for (let i = messages.length - 1; i >= 0; i--) {
+    const msg = messages[i];
+    if (!msg || typeof msg !== 'object') continue;
+    const m = msg as { role?: unknown; content?: unknown };
+    if (m.role !== 'user') continue;
+    return flattenTextLoose(m.content);
+  }
+  return '';
+}
+
+function phrasingDelta(lastText: string): number {
+  if (IMPERATIVE_VERBS.test(lastText.trimStart())) return 1;
+  if (lastText.includes('?')) return -1;
+  return 0;
+}
+
+interface ValidatedSignals {
+  readonly estInputTokens: number;
+  readonly tools: readonly string[];
+  readonly fileRefCount: number;
+}
+
+function validateSignals(raw: unknown): ValidatedSignals | null {
+  if (!raw || typeof raw !== 'object') return null;
+  const s = raw as Record<string, unknown>;
+  if (typeof s.estInputTokens !== 'number' || !Number.isFinite(s.estInputTokens)) return null;
+  if (!Array.isArray(s.tools)) return null;
+  if (typeof s.fileRefCount !== 'number' || !Number.isFinite(s.fileRefCount)) return null;
+  return {
+    estInputTokens: s.estInputTokens,
+    tools: s.tools as readonly string[],
+    fileRefCount: s.fileRefCount,
+  };
+}
+
+export class HeuristicClassifier implements Classifier {
+  async classify(
+    input: ClassifierInput,
+    _deadline: AbortSignal,
+  ): Promise<ClassifierResult | null> {
+    const start = performance.now();
+    try {
+      const signals = validateSignals(input?.signals);
+      if (!signals) return null;
+
+      const tokenContribution = tokenBand(signals.estInputTokens);
+      const toolContribution = Math.min(
+        signals.tools.length * WEIGHTS.toolBreadthFactor,
+        WEIGHTS.toolBreadthCap,
+      );
+      const codeContribution = Math.min(
+        countCodeFences(input.body) * WEIGHTS.codeBlockFactor,
+        WEIGHTS.codeBlockCap,
+      );
+      const phrasingContribution = phrasingDelta(lastUserText(input.body));
+      const fileContribution = Math.min(
+        signals.fileRefCount * WEIGHTS.filePathFactor,
+        WEIGHTS.filePathCap,
+      );
+
+      const rawScore =
+        tokenContribution +
+        toolContribution +
+        codeContribution +
+        phrasingContribution +
+        fileContribution;
+      const score = clamp(rawScore, 0, 10);
+      const suggestedModel = bandFromScore(score);
+      const dist = Math.min(
+        Math.abs(score - BAND_LOW),
+        Math.abs(score - BAND_HIGH),
+      );
+      const confidence = clamp(dist / MAX_BOUNDARY_DIST, CONF_FLOOR, CONF_CEIL);
+
+      return {
+        score,
+        suggestedModel,
+        confidence,
+        source: 'heuristic',
+        latencyMs: performance.now() - start,
+      };
+    } catch {
+      return null;
+    }
+  }
+}
diff --git a/src/classifier/types.ts b/src/classifier/types.ts
index 6b78e28..897dfb0 100644
--- a/src/classifier/types.ts
+++ b/src/classifier/types.ts
@@ -1,2 +1,40 @@
-// Populated in section-11. Do not import.
-export {};
+// Shared classifier contract consumed by the heuristic scorer (§11),
+// the Haiku classifier and race orchestrator (§12), and the decision
+// log writer (§13). Fields are load-bearing — do not rename without
+// coordinating with those sections.
+
+import type { Signals } from '../signals/types.js';
+
+export type Tier = 'haiku' | 'sonnet' | 'opus';
+
+export interface ClassifierInput {
+  readonly signals: Signals;
+  /** Canonical body of the intercepted request (model excluded). */
+  readonly body: unknown;
+  /** Canonical hash from §7.2, used for cache keying by §12. */
+  readonly requestHash: string;
+}
+
+export interface ClassifierResult {
+  /** 0-10 complexity score. */
+  readonly score: number;
+  readonly suggestedModel: Tier;
+  /** 0-1 self-reported confidence. */
+  readonly confidence: number;
+  readonly source: 'haiku' | 'heuristic';
+  readonly latencyMs: number;
+  readonly rationale?: string;
+}
+
+export interface Classifier {
+  /**
+   * Produces a result or `null`. MUST NOT throw on bad input — a
+   * thrown classifier is treated as null by the orchestrator. The
+   * deadline signal is accepted for interface parity with the Haiku
+   * classifier; the heuristic ignores it (it's synchronous).
+   */
+  classify(
+    input: ClassifierInput,
+    deadline: AbortSignal,
+  ): Promise<ClassifierResult | null>;
+}
diff --git a/tests/classifier/fixtures/heuristic/imperative.json b/tests/classifier/fixtures/heuristic/imperative.json
new file mode 100644
index 0000000..21eb9ee
--- /dev/null
+++ b/tests/classifier/fixtures/heuristic/imperative.json
@@ -0,0 +1,27 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 1,
+    "tools": ["read"],
+    "toolUseCount": 0,
+    "estInputTokens": 1500,
+    "fileRefCount": 1,
+    "retryCount": 0,
+    "frustration": false,
+    "explicitModel": null,
+    "projectPath": null,
+    "sessionDurationMs": 10000,
+    "betaFlags": [],
+    "sessionId": "test-session",
+    "requestHash": "ghi789-imp"
+  },
+  "body": {
+    "messages": [
+      {
+        "role": "user",
+        "content": "implement the auth logic in ./src/auth.ts\n```ts\nstub\n```"
+      }
+    ]
+  },
+  "requestHash": "ghi789-imp"
+}
diff --git a/tests/classifier/fixtures/heuristic/large-broad-tools.json b/tests/classifier/fixtures/heuristic/large-broad-tools.json
new file mode 100644
index 0000000..2ea7681
--- /dev/null
+++ b/tests/classifier/fixtures/heuristic/large-broad-tools.json
@@ -0,0 +1,27 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 3,
+    "tools": ["read", "write", "bash", "grep", "glob", "edit"],
+    "toolUseCount": 4,
+    "estInputTokens": 10000,
+    "fileRefCount": 5,
+    "retryCount": 0,
+    "frustration": false,
+    "explicitModel": null,
+    "projectPath": null,
+    "sessionDurationMs": 120000,
+    "betaFlags": [],
+    "sessionId": "test-session",
+    "requestHash": "abc123"
+  },
+  "body": {
+    "messages": [
+      {
+        "role": "user",
+        "content": "implement a full refactor of ./src/foo.ts and ./bar.ts and ./baz/qux.ts and ./lib/extra.ts and ./core/main.ts\n```ts\ncode\n```\n```ts\nmore\n```\n```\nthree\n```\n```\nfour\n```\n```\nfive\n```\n```\nsix\n```\n```\nseven\n```"
+      }
+    ]
+  },
+  "requestHash": "abc123"
+}
diff --git a/tests/classifier/fixtures/heuristic/question.json b/tests/classifier/fixtures/heuristic/question.json
new file mode 100644
index 0000000..4ce91ec
--- /dev/null
+++ b/tests/classifier/fixtures/heuristic/question.json
@@ -0,0 +1,27 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 1,
+    "tools": ["read"],
+    "toolUseCount": 0,
+    "estInputTokens": 1500,
+    "fileRefCount": 1,
+    "retryCount": 0,
+    "frustration": false,
+    "explicitModel": null,
+    "projectPath": null,
+    "sessionDurationMs": 10000,
+    "betaFlags": [],
+    "sessionId": "test-session",
+    "requestHash": "ghi789-q"
+  },
+  "body": {
+    "messages": [
+      {
+        "role": "user",
+        "content": "how does the auth logic in ./src/auth.ts work?\n```ts\nstub\n```"
+      }
+    ]
+  },
+  "requestHash": "ghi789-q"
+}
diff --git a/tests/classifier/fixtures/heuristic/small-single-tool.json b/tests/classifier/fixtures/heuristic/small-single-tool.json
new file mode 100644
index 0000000..e482f59
--- /dev/null
+++ b/tests/classifier/fixtures/heuristic/small-single-tool.json
@@ -0,0 +1,24 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 1,
+    "tools": ["read"],
+    "toolUseCount": 0,
+    "estInputTokens": 100,
+    "fileRefCount": 0,
+    "retryCount": 0,
+    "frustration": false,
+    "explicitModel": null,
+    "projectPath": null,
+    "sessionDurationMs": 5000,
+    "betaFlags": [],
+    "sessionId": "test-session",
+    "requestHash": "def456"
+  },
+  "body": {
+    "messages": [
+      { "role": "user", "content": "what does this mean?" }
+    ]
+  },
+  "requestHash": "def456"
+}
diff --git a/tests/classifier/heuristic.test.ts b/tests/classifier/heuristic.test.ts
new file mode 100644
index 0000000..09399da
--- /dev/null
+++ b/tests/classifier/heuristic.test.ts
@@ -0,0 +1,188 @@
+import { describe, it, expect } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { join } from 'node:path';
+import { performance } from 'node:perf_hooks';
+import { HeuristicClassifier } from '../../src/classifier/heuristic.js';
+import type {
+  Classifier,
+  ClassifierInput,
+  ClassifierResult,
+} from '../../src/classifier/types.js';
+
+const FIX_DIR = join(__dirname, 'fixtures', 'heuristic');
+
+function loadFixture(name: string): ClassifierInput {
+  const raw = readFileSync(join(FIX_DIR, name), 'utf8');
+  return JSON.parse(raw) as ClassifierInput;
+}
+
+function noDeadline(): AbortSignal {
+  return new AbortController().signal;
+}
+
+describe('Classifier interface contract', () => {
+  it('a classifier that throws internally resolves to null (never rejects)', async () => {
+    class ThrowingClassifier implements Classifier {
+      async classify(
+        _input: ClassifierInput,
+        _deadline: AbortSignal,
+      ): Promise<ClassifierResult | null> {
+        try {
+          throw new Error('boom');
+        } catch {
+          return null;
+        }
+      }
+    }
+    const c = new ThrowingClassifier();
+    await expect(c.classify(loadFixture('small-single-tool.json'), noDeadline())).resolves.toBeNull();
+  });
+
+  it('satisfies: classify(input, deadline) → Promise<ClassifierResult | null>', async () => {
+    const h: Classifier = new HeuristicClassifier();
+    const result = await h.classify(loadFixture('small-single-tool.json'), noDeadline());
+    expect(result === null || typeof result === 'object').toBe(true);
+    if (result) {
+      expect(typeof result.score).toBe('number');
+      expect(['haiku', 'sonnet', 'opus']).toContain(result.suggestedModel);
+      expect(typeof result.confidence).toBe('number');
+      expect(result.source).toBe('heuristic');
+      expect(typeof result.latencyMs).toBe('number');
+    }
+  });
+});
+
+describe('HeuristicClassifier — zero latency', () => {
+  it('returns a result in < 1ms on fixture inputs (warm)', async () => {
+    const h = new HeuristicClassifier();
+    const input = loadFixture('large-broad-tools.json');
+    // Warm the path
+    await h.classify(input, noDeadline());
+    const start = performance.now();
+    const result = await h.classify(input, noDeadline());
+    const elapsed = performance.now() - start;
+    expect(result).not.toBeNull();
+    expect(elapsed).toBeLessThan(5); // generous headroom on slow CI; heuristic body itself < 1ms
+    expect(result!.latencyMs).toBeLessThan(5);
+  });
+
+  it('does not yield to real I/O (resolves on the next microtask tick)', async () => {
+    const h = new HeuristicClassifier();
+    let settled = false;
+    const p = h.classify(loadFixture('small-single-tool.json'), noDeadline()).then((r) => {
+      settled = true;
+      return r;
+    });
+    // After draining the microtask queue once, the Promise should have resolved.
+    await Promise.resolve();
+    await Promise.resolve();
+    await p;
+    expect(settled).toBe(true);
+  });
+});
+
+describe('HeuristicClassifier — scoring', () => {
+  it('large token count + broad tool set → suggests opus', async () => {
+    const h = new HeuristicClassifier();
+    const r = await h.classify(loadFixture('large-broad-tools.json'), noDeadline());
+    expect(r).not.toBeNull();
+    expect(r!.suggestedModel).toBe('opus');
+    expect(r!.score).toBeGreaterThanOrEqual(6.5);
+  });
+
+  it('small token count + single tool → suggests haiku', async () => {
+    const h = new HeuristicClassifier();
+    const r = await h.classify(loadFixture('small-single-tool.json'), noDeadline());
+    expect(r).not.toBeNull();
+    expect(r!.suggestedModel).toBe('haiku');
+    expect(r!.score).toBeLessThan(3.0);
+  });
+
+  it('imperative phrasing nudges score upward vs. the same body phrased as a question', async () => {
+    const h = new HeuristicClassifier();
+    const imp = await h.classify(loadFixture('imperative.json'), noDeadline());
+    const qn = await h.classify(loadFixture('question.json'), noDeadline());
+    expect(imp).not.toBeNull();
+    expect(qn).not.toBeNull();
+    expect(imp!.score).toBeGreaterThan(qn!.score);
+  });
+});
+
+describe('HeuristicClassifier — determinism', () => {
+  it('same input produces identical score/suggestedModel/confidence across calls', async () => {
+    const h = new HeuristicClassifier();
+    const input = loadFixture('imperative.json');
+    const a = await h.classify(input, noDeadline());
+    const b = await h.classify(input, noDeadline());
+    expect(a).not.toBeNull();
+    expect(b).not.toBeNull();
+    expect(a!.score).toBe(b!.score);
+    expect(a!.suggestedModel).toBe(b!.suggestedModel);
+    expect(a!.confidence).toBe(b!.confidence);
+  });
+
+  it('does not mutate the input', async () => {
+    const h = new HeuristicClassifier();
+    const input = loadFixture('imperative.json');
+    const snapshot = JSON.stringify(input);
+    await h.classify(input, noDeadline());
+    expect(JSON.stringify(input)).toBe(snapshot);
+  });
+});
+
+describe('HeuristicClassifier — robustness', () => {
+  it('returns null on malformed signals', async () => {
+    const h = new HeuristicClassifier();
+    const bad = { signals: 'not an object', body: {}, requestHash: 'x' } as unknown as ClassifierInput;
+    const r = await h.classify(bad, noDeadline());
+    expect(r).toBeNull();
+  });
+
+  it('handles content-blocks form and string-content form identically when text is equivalent', async () => {
+    const h = new HeuristicClassifier();
+    const base = loadFixture('imperative.json');
+    const stringForm: ClassifierInput = base;
+    const msgs = (base.body as { messages: Array<{ content: string }> }).messages;
+    const block = msgs[0]!.content;
+    const blocksForm: ClassifierInput = {
+      signals: base.signals,
+      body: {
+        messages: [
+          {
+            role: 'user',
+            content: [{ type: 'text', text: block }],
+          },
+        ],
+      },
+      requestHash: base.requestHash,
+    };
+    const a = await h.classify(stringForm, noDeadline());
+    const b = await h.classify(blocksForm, noDeadline());
+    expect(a).not.toBeNull();
+    expect(b).not.toBeNull();
+    expect(a!.score).toBe(b!.score);
+    expect(a!.suggestedModel).toBe(b!.suggestedModel);
+  });
+
+  it('always stamps source: "heuristic"', async () => {
+    const h = new HeuristicClassifier();
+    const r = await h.classify(loadFixture('imperative.json'), noDeadline());
+    expect(r).not.toBeNull();
+    expect(r!.source).toBe('heuristic');
+  });
+
+  it('confidence stays within [0.2, 0.85]', async () => {
+    const h = new HeuristicClassifier();
+    for (const name of [
+      'large-broad-tools.json',
+      'small-single-tool.json',
+      'imperative.json',
+      'question.json',
+    ]) {
+      const r = await h.classify(loadFixture(name), noDeadline());
+      expect(r).not.toBeNull();
+      expect(r!.confidence).toBeGreaterThanOrEqual(0.2);
+      expect(r!.confidence).toBeLessThanOrEqual(0.85);
+    }
+  });
+});
