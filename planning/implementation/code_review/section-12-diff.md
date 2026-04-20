diff --git a/src/classifier/haiku.ts b/src/classifier/haiku.ts
index bb23f9b..2f0f1df 100644
--- a/src/classifier/haiku.ts
+++ b/src/classifier/haiku.ts
@@ -1,2 +1,272 @@
-// Populated in section-12. Do not import.
-export {};
+// Haiku-backed classifier (§12).
+//
+// Races the heuristic classifier; resolves to `null` on any failure so the
+// upstream user request is never affected. Outbound endpoint is hard-pinned
+// to api.anthropic.com/v1/messages — there is no config knob to relax this.
+
+import { fetch as undiciFetch } from 'undici';
+import type {
+  Classifier,
+  ClassifierInput,
+  ClassifierResult,
+  Tier,
+} from './types.js';
+import type { ClassifierConfig, PricingEntry } from '../config/schema.js';
+import { CLASSIFIER_PROMPT } from './prompt.js';
+
+export const HAIKU_ENDPOINT = 'https://api.anthropic.com/v1/messages';
+
+const MAX_USER_SUMMARY_CHARS = 2000;
+const MAX_HAIKU_OUTPUT_TOKENS = 256;
+
+type FetchImpl = (url: string, init: {
+  method: string;
+  headers: Record<string, string>;
+  body: string;
+  signal: AbortSignal;
+}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
+
+export interface HaikuClassifierDeps {
+  readonly config: ClassifierConfig;
+  /** Pricing table keyed by model id; see `PricingEntry` in config schema. */
+  readonly pricing: Readonly<Record<string, PricingEntry>>;
+  /**
+   * Optional override URL — must be exactly {@link HAIKU_ENDPOINT} or
+   * construction throws. Exposed for tests/init that want to assert
+   * symmetry with config plumbing.
+   */
+  readonly endpoint?: string;
+  readonly fetchImpl?: FetchImpl;
+  readonly now?: () => number;
+}
+
+/**
+ * Throws synchronously if `url` is not the single allowed Haiku endpoint.
+ * Exposed so tests and `init` can share the check.
+ */
+export function assertAllowedEndpoint(url: string): void {
+  if (url !== HAIKU_ENDPOINT) {
+    throw new Error(
+      `HaikuClassifier: outbound endpoint must be exactly "${HAIKU_ENDPOINT}", got "${url}"`,
+    );
+  }
+}
+
+interface HaikuJson {
+  readonly complexity: number;
+  readonly suggestedModel: Tier;
+  readonly confidence: number;
+  readonly rationale?: string;
+}
+
+function isValidHaikuJson(x: unknown): x is HaikuJson {
+  if (!x || typeof x !== 'object') return false;
+  const o = x as Record<string, unknown>;
+  if (typeof o['complexity'] !== 'number' || !Number.isFinite(o['complexity'])) return false;
+  if (o['complexity'] < 0 || o['complexity'] > 10) return false;
+  if (typeof o['confidence'] !== 'number' || !Number.isFinite(o['confidence'])) return false;
+  if (o['confidence'] < 0 || o['confidence'] > 1) return false;
+  const sm = o['suggestedModel'];
+  if (sm !== 'opus' && sm !== 'sonnet' && sm !== 'haiku') return false;
+  if (o['rationale'] !== undefined && typeof o['rationale'] !== 'string') return false;
+  return true;
+}
+
+interface AuthHeaders {
+  readonly headers: Record<string, string>;
+}
+
+function selectAuthHeaders(
+  incoming: Readonly<Record<string, string>> | undefined,
+): AuthHeaders | null {
+  if (!incoming) return null;
+  const out: Record<string, string> = {};
+  const xKey = incoming['x-api-key'];
+  const auth = incoming['authorization'];
+  // Never both; never substituted.
+  if (typeof xKey === 'string' && xKey.length > 0) {
+    out['x-api-key'] = xKey;
+  } else if (typeof auth === 'string' && auth.length > 0) {
+    out['authorization'] = auth;
+  } else {
+    return null;
+  }
+  const ver = incoming['anthropic-version'];
+  if (typeof ver === 'string' && ver.length > 0) out['anthropic-version'] = ver;
+  const beta = incoming['anthropic-beta'];
+  if (typeof beta === 'string' && beta.length > 0) out['anthropic-beta'] = beta;
+  out['content-type'] = 'application/json';
+  return { headers: out };
+}
+
+function flattenText(content: unknown): string {
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
+function summarizeRequest(body: unknown): string {
+  if (!body || typeof body !== 'object') return '';
+  const messages = (body as { messages?: unknown }).messages;
+  if (!Array.isArray(messages)) return '';
+  for (let i = messages.length - 1; i >= 0; i--) {
+    const msg = messages[i];
+    if (!msg || typeof msg !== 'object') continue;
+    const m = msg as { role?: unknown; content?: unknown };
+    if (m.role !== 'user') continue;
+    const text = flattenText(m.content);
+    return text.length > MAX_USER_SUMMARY_CHARS
+      ? text.slice(0, MAX_USER_SUMMARY_CHARS)
+      : text;
+  }
+  return '';
+}
+
+interface HaikuUsage {
+  readonly input_tokens?: number;
+  readonly output_tokens?: number;
+  readonly cache_read_input_tokens?: number;
+  readonly cache_creation_input_tokens?: number;
+}
+
+function toFiniteNonNegative(n: unknown): number {
+  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
+  return n;
+}
+
+function computeClassifierCost(
+  usage: HaikuUsage | undefined,
+  pricing: PricingEntry | undefined,
+): number {
+  if (!pricing) return 0;
+  const input = toFiniteNonNegative(usage?.input_tokens);
+  const output = toFiniteNonNegative(usage?.output_tokens);
+  const cacheRead = toFiniteNonNegative(usage?.cache_read_input_tokens);
+  const cacheCreate = toFiniteNonNegative(usage?.cache_creation_input_tokens);
+  return (
+    input * pricing.input +
+    cacheCreate * pricing.cacheCreate +
+    cacheRead * pricing.cacheRead +
+    output * pricing.output
+  );
+}
+
+function extractAssistantText(data: unknown): string {
+  if (!data || typeof data !== 'object') return '';
+  const content = (data as { content?: unknown }).content;
+  if (!Array.isArray(content)) return '';
+  for (const block of content) {
+    if (!block || typeof block !== 'object') continue;
+    const b = block as { type?: unknown; text?: unknown };
+    if (b.type === 'text' && typeof b.text === 'string') return b.text;
+  }
+  return '';
+}
+
+function safeParseJson(text: string): unknown {
+  if (!text) return null;
+  try {
+    return JSON.parse(text);
+  } catch {
+    return null;
+  }
+}
+
+interface InternalDeps {
+  readonly config: ClassifierConfig;
+  readonly pricing: Readonly<Record<string, PricingEntry>>;
+  readonly fetchImpl: FetchImpl;
+  readonly now: () => number;
+}
+
+class HaikuClassifier implements Classifier {
+  constructor(private readonly deps: InternalDeps) {}
+
+  async classify(
+    input: ClassifierInput,
+    deadline: AbortSignal,
+  ): Promise<ClassifierResult | null> {
+    const start = this.deps.now();
+    try {
+      const auth = selectAuthHeaders(input.incomingHeaders);
+      if (!auth) return null;
+
+      const localCtl = new AbortController();
+      const timer: NodeJS.Timeout = setTimeout(
+        () => localCtl.abort(),
+        this.deps.config.timeoutMs,
+      );
+      // `unref` so a hung fetch never blocks process exit.
+      timer.unref?.();
+      const signal = AbortSignal.any([deadline, localCtl.signal]);
+
+      const outbound = {
+        model: this.deps.config.model,
+        max_tokens: MAX_HAIKU_OUTPUT_TOKENS,
+        system: [
+          {
+            type: 'text',
+            text: CLASSIFIER_PROMPT,
+            cache_control: { type: 'ephemeral' },
+          },
+        ],
+        messages: [
+          { role: 'user', content: summarizeRequest(input.body) },
+        ],
+      };
+
+      let response: Awaited<ReturnType<FetchImpl>>;
+      try {
+        response = await this.deps.fetchImpl(HAIKU_ENDPOINT, {
+          method: 'POST',
+          headers: auth.headers,
+          body: JSON.stringify(outbound),
+          signal,
+        });
+      } finally {
+        clearTimeout(timer);
+      }
+
+      if (!response.ok) return null;
+
+      const data = (await response.json()) as { content?: unknown; usage?: HaikuUsage };
+      const parsed = safeParseJson(extractAssistantText(data));
+      if (!isValidHaikuJson(parsed)) return null;
+
+      const pricingEntry = this.deps.pricing[this.deps.config.model];
+      const classifierCostUsd = computeClassifierCost(data.usage, pricingEntry);
+
+      const base: ClassifierResult = {
+        score: parsed.complexity,
+        suggestedModel: parsed.suggestedModel,
+        confidence: parsed.confidence,
+        source: 'haiku',
+        latencyMs: this.deps.now() - start,
+        classifierCostUsd,
+      };
+      return parsed.rationale !== undefined
+        ? { ...base, rationale: parsed.rationale }
+        : base;
+    } catch {
+      return null;
+    }
+  }
+}
+
+export function createHaikuClassifier(deps: HaikuClassifierDeps): Classifier {
+  // Synchronous startup assertion — failure here is a configuration error,
+  // not a per-request fallback.
+  assertAllowedEndpoint(deps.endpoint ?? HAIKU_ENDPOINT);
+  return new HaikuClassifier({
+    config: deps.config,
+    pricing: deps.pricing,
+    fetchImpl: (deps.fetchImpl ?? (undiciFetch as unknown as FetchImpl)),
+    now: deps.now ?? (() => performance.now()),
+  });
+}
diff --git a/src/classifier/prompt.ts b/src/classifier/prompt.ts
new file mode 100644
index 0000000..9b1a65f
--- /dev/null
+++ b/src/classifier/prompt.ts
@@ -0,0 +1,34 @@
+// Static classifier prompt for the Haiku-backed classifier (§12).
+//
+// IMPORTANT: changes here invalidate Anthropic's prompt cache for the
+// classifier path. Bump CLASSIFIER_PROMPT_VERSION on every edit so cache
+// metrics in §17 can attribute hit-rate drops to a known revision.
+//
+// The exported constants are consumed verbatim by `src/classifier/haiku.ts`
+// to construct an outbound body that is byte-stable across calls (only the
+// last user message varies).
+
+export const CLASSIFIER_PROMPT_VERSION = 'v1' as const;
+
+/**
+ * System-prompt body marked with `cache_control: { type: 'ephemeral' }` in
+ * the outbound `system` block. Keep under ~500 tokens so cache-hit ratios
+ * dominate cost.
+ */
+export const CLASSIFIER_PROMPT = [
+  'You classify a Claude Code request by complexity and recommend a model tier.',
+  '',
+  'Tiers:',
+  '- "haiku": trivial, lookup, formatting, single-line edits, simple Q&A.',
+  '- "sonnet": ordinary coding, single-file changes, normal reasoning.',
+  '- "opus": multi-file refactors, architectural decisions, deep debugging,',
+  '  long contexts, broad tool use, or anything requiring sustained reasoning.',
+  '',
+  'Score complexity on a 0-10 scale (0 trivial, 10 requires Opus-level depth).',
+  'Confidence is your self-reported certainty in [0, 1].',
+  '',
+  'Respond with STRICT JSON ONLY, on a single line, no markdown fences,',
+  'no commentary. Schema:',
+  '{"complexity":<0-10 number>,"suggestedModel":"opus"|"sonnet"|"haiku",',
+  '"confidence":<0-1 number>,"rationale":"<short string, optional>"}',
+].join('\n');
diff --git a/src/classifier/types.ts b/src/classifier/types.ts
index 897dfb0..aeb97cb 100644
--- a/src/classifier/types.ts
+++ b/src/classifier/types.ts
@@ -13,6 +13,12 @@ export interface ClassifierInput {
   readonly body: unknown;
   /** Canonical hash from §7.2, used for cache keying by §12. */
   readonly requestHash: string;
+  /**
+   * Sanitized intercepted-request headers (lower-cased keys). Required by
+   * §12 to forward auth/anthropic-version/anthropic-beta to Haiku. The
+   * heuristic classifier ignores this field.
+   */
+  readonly incomingHeaders?: Readonly<Record<string, string>>;
 }
 
 export interface ClassifierResult {
@@ -24,6 +30,8 @@ export interface ClassifierResult {
   readonly source: 'haiku' | 'heuristic';
   readonly latencyMs: number;
   readonly rationale?: string;
+  /** USD cost of the classifier call itself. Present only when source === 'haiku'. */
+  readonly classifierCostUsd?: number;
 }
 
 export interface Classifier {
diff --git a/tests/classifier/fixtures/haiku/large.json b/tests/classifier/fixtures/haiku/large.json
new file mode 100644
index 0000000..18cb2d6
--- /dev/null
+++ b/tests/classifier/fixtures/haiku/large.json
@@ -0,0 +1,30 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 12,
+    "tools": ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
+    "toolUseCount": 7,
+    "estInputTokens": 9500,
+    "fileRefCount": 6,
+    "retryCount": 0,
+    "frustration": null,
+    "explicitModel": null,
+    "projectPath": "/repo",
+    "sessionDurationMs": 600000,
+    "betaFlags": [],
+    "sessionId": "s-large",
+    "requestHash": "h-large"
+  },
+  "body": {
+    "messages": [
+      { "role": "user", "content": "Refactor the auth middleware across all three services to use the new shared session token store; update all tests and migrations accordingly." }
+    ]
+  },
+  "requestHash": "h-large",
+  "incomingHeaders": {
+    "authorization": "Bearer sk-test-bearer",
+    "anthropic-version": "2023-06-01",
+    "anthropic-beta": "prompt-caching-2024-07-31,tools-2024-05-16",
+    "content-type": "application/json"
+  }
+}
diff --git a/tests/classifier/fixtures/haiku/multi-tool.json b/tests/classifier/fixtures/haiku/multi-tool.json
new file mode 100644
index 0000000..d50537e
--- /dev/null
+++ b/tests/classifier/fixtures/haiku/multi-tool.json
@@ -0,0 +1,29 @@
+{
+  "signals": {
+    "planMode": false,
+    "messageCount": 4,
+    "tools": ["Read", "Edit", "Bash", "Grep"],
+    "toolUseCount": 3,
+    "estInputTokens": 2400,
+    "fileRefCount": 2,
+    "retryCount": 0,
+    "frustration": null,
+    "explicitModel": null,
+    "projectPath": "/repo",
+    "sessionDurationMs": 120000,
+    "betaFlags": [],
+    "sessionId": "s-multi",
+    "requestHash": "h-multi"
+  },
+  "body": {
+    "messages": [
+      { "role": "user", "content": "Investigate why the test suite is flaking on CI and propose a fix." }
+    ]
+  },
+  "requestHash": "h-multi",
+  "incomingHeaders": {
+    "x-api-key": "sk-test-xkey",
+    "anthropic-version": "2023-06-01",
+    "content-type": "application/json"
+  }
+}
diff --git a/tests/classifier/fixtures/haiku/small.json b/tests/classifier/fixtures/haiku/small.json
new file mode 100644
index 0000000..9b92c34
--- /dev/null
+++ b/tests/classifier/fixtures/haiku/small.json
@@ -0,0 +1,29 @@
+{
+  "signals": {
+    "planMode": null,
+    "messageCount": 1,
+    "tools": ["Read"],
+    "toolUseCount": 0,
+    "estInputTokens": 120,
+    "fileRefCount": 0,
+    "retryCount": 0,
+    "frustration": null,
+    "explicitModel": null,
+    "projectPath": null,
+    "sessionDurationMs": 0,
+    "betaFlags": [],
+    "sessionId": "s-small",
+    "requestHash": "h-small"
+  },
+  "body": {
+    "messages": [
+      { "role": "user", "content": "What is 2+2?" }
+    ]
+  },
+  "requestHash": "h-small",
+  "incomingHeaders": {
+    "x-api-key": "sk-test-xkey",
+    "anthropic-version": "2023-06-01",
+    "content-type": "application/json"
+  }
+}
diff --git a/tests/classifier/haiku.test.ts b/tests/classifier/haiku.test.ts
new file mode 100644
index 0000000..2da68b7
--- /dev/null
+++ b/tests/classifier/haiku.test.ts
@@ -0,0 +1,444 @@
+import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { join } from 'node:path';
+import {
+  HAIKU_ENDPOINT,
+  assertAllowedEndpoint,
+  createHaikuClassifier,
+  type HaikuClassifierDeps,
+} from '../../src/classifier/haiku.js';
+import type { ClassifierInput } from '../../src/classifier/types.js';
+import type { ClassifierConfig, PricingEntry } from '../../src/config/schema.js';
+
+const FIX_DIR = join(__dirname, 'fixtures', 'haiku');
+
+function loadFixture(name: string): ClassifierInput {
+  return JSON.parse(readFileSync(join(FIX_DIR, name), 'utf8')) as ClassifierInput;
+}
+
+function noDeadline(): AbortSignal {
+  return new AbortController().signal;
+}
+
+const TEST_MODEL = 'claude-haiku-4-5-20251001';
+
+const TEST_CONFIG: ClassifierConfig = {
+  enabled: true,
+  model: TEST_MODEL,
+  timeoutMs: 800,
+  confidenceThresholds: { haiku: 0.6, heuristic: 0.4 },
+};
+
+const TEST_PRICING: Readonly<Record<string, PricingEntry>> = {
+  [TEST_MODEL]: {
+    input: 0.000001,
+    output: 0.000005,
+    cacheCreate: 0.00000125,
+    cacheRead: 0.0000001,
+  },
+};
+
+interface MockFetchCall {
+  url: string;
+  init: {
+    method: string;
+    headers: Record<string, string>;
+    body: string;
+    signal: AbortSignal;
+  };
+}
+
+interface MockFetchOptions {
+  status?: number;
+  ok?: boolean;
+  json?: unknown;
+  /** If provided, fetch never resolves until aborted. */
+  hang?: boolean;
+  /** Throw a synthetic error on call (e.g., simulate network 5xx after 'fetch' rejects). */
+  reject?: Error;
+}
+
+function makeMockFetch(opts: MockFetchOptions = {}) {
+  const calls: MockFetchCall[] = [];
+  const fn = vi.fn((url: string, init: MockFetchCall['init']) => {
+    calls.push({ url, init });
+    if (opts.reject) return Promise.reject(opts.reject);
+    if (opts.hang) {
+      return new Promise<never>((_, reject) => {
+        init.signal.addEventListener('abort', () => {
+          const err = new Error('aborted') as Error & { name: string };
+          err.name = 'AbortError';
+          reject(err);
+        });
+      });
+    }
+    return Promise.resolve({
+      ok: opts.ok ?? true,
+      status: opts.status ?? 200,
+      json: () => Promise.resolve(opts.json ?? {}),
+    });
+  });
+  return { fn, calls };
+}
+
+function defaultHaikuResponse(overrides: Record<string, unknown> = {}) {
+  return {
+    content: [
+      {
+        type: 'text',
+        text: JSON.stringify({
+          complexity: 4.2,
+          suggestedModel: 'sonnet',
+          confidence: 0.7,
+          rationale: 'mid-complexity task',
+          ...overrides,
+        }),
+      },
+    ],
+    usage: {
+      input_tokens: 50,
+      output_tokens: 30,
+      cache_read_input_tokens: 400,
+      cache_creation_input_tokens: 100,
+    },
+  };
+}
+
+describe('assertAllowedEndpoint', () => {
+  it('accepts https://api.anthropic.com/v1/messages', () => {
+    expect(() => assertAllowedEndpoint(HAIKU_ENDPOINT)).not.toThrow();
+  });
+
+  it.each([
+    'https://api.anthropic.com/v1/messages/',
+    'http://api.anthropic.com/v1/messages',
+    'https://api.anthropic.com/v1/complete',
+    'https://evil.example.com/v1/messages',
+    'https://api.anthropic.com:8443/v1/messages',
+    '',
+  ])('throws on %s', (url) => {
+    expect(() => assertAllowedEndpoint(url)).toThrow(/outbound endpoint must be exactly/);
+  });
+});
+
+describe('createHaikuClassifier', () => {
+  it('throws at construction when configured endpoint is not api.anthropic.com/v1/messages', () => {
+    expect(() =>
+      createHaikuClassifier({
+        config: TEST_CONFIG,
+        pricing: TEST_PRICING,
+        endpoint: 'https://evil.example.com/v1/messages',
+      }),
+    ).toThrow(/outbound endpoint must be exactly/);
+  });
+
+  it('does not throw when endpoint is omitted', () => {
+    expect(() =>
+      createHaikuClassifier({ config: TEST_CONFIG, pricing: TEST_PRICING }),
+    ).not.toThrow();
+  });
+});
+
+describe('haiku classifier — header forwarding', () => {
+  it('forwards x-api-key, anthropic-version, anthropic-beta from the intercepted request', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const input = loadFixture('multi-tool.json');
+    // augment with anthropic-beta to assert pass-through
+    const withBeta: ClassifierInput = {
+      ...input,
+      incomingHeaders: { ...input.incomingHeaders!, 'anthropic-beta': 'b1,b2' },
+    };
+    await c.classify(withBeta, noDeadline());
+    expect(calls).toHaveLength(1);
+    const headers = calls[0]!.init.headers;
+    expect(headers['x-api-key']).toBe('sk-test-xkey');
+    expect(headers['anthropic-version']).toBe('2023-06-01');
+    expect(headers['anthropic-beta']).toBe('b1,b2');
+    expect(headers['authorization']).toBeUndefined();
+    expect(headers['content-type']).toBe('application/json');
+  });
+
+  it('forwards authorization when x-api-key is absent', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    await c.classify(loadFixture('large.json'), noDeadline());
+    const headers = calls[0]!.init.headers;
+    expect(headers['authorization']).toBe('Bearer sk-test-bearer');
+    expect(headers['x-api-key']).toBeUndefined();
+    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31,tools-2024-05-16');
+  });
+
+  it('resolves to null when neither x-api-key nor authorization is present (no network call)', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const input = loadFixture('small.json');
+    const stripped: ClassifierInput = {
+      ...input,
+      incomingHeaders: { 'anthropic-version': '2023-06-01' },
+    };
+    const result = await c.classify(stripped, noDeadline());
+    expect(result).toBeNull();
+    expect(calls).toHaveLength(0);
+  });
+
+  it('resolves to null when incomingHeaders is undefined (no network call)', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const input = loadFixture('small.json');
+    const stripped = { ...input } as ClassifierInput & {
+      incomingHeaders?: Readonly<Record<string, string>>;
+    };
+    delete stripped.incomingHeaders;
+    const result = await c.classify(stripped, noDeadline());
+    expect(result).toBeNull();
+    expect(calls).toHaveLength(0);
+  });
+
+  it('does not synthesize anthropic-version when absent', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const input = loadFixture('small.json');
+    const noVer: ClassifierInput = {
+      ...input,
+      incomingHeaders: { 'x-api-key': 'sk-test-xkey' },
+    };
+    await c.classify(noVer, noDeadline());
+    expect(calls[0]!.init.headers['anthropic-version']).toBeUndefined();
+  });
+});
+
+describe('haiku classifier — outbound body', () => {
+  it('contains cache_control marker on the system prompt prefix', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    await c.classify(loadFixture('multi-tool.json'), noDeadline());
+    const body = JSON.parse(calls[0]!.init.body) as {
+      model: string;
+      system: Array<{ type: string; cache_control?: { type: string } }>;
+    };
+    expect(body.model).toBe(TEST_MODEL);
+    expect(body.system).toHaveLength(1);
+    expect(body.system[0]!.type).toBe('text');
+    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
+  });
+
+  it('targets exactly HAIKU_ENDPOINT', async () => {
+    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    await c.classify(loadFixture('small.json'), noDeadline());
+    expect(calls[0]!.url).toBe(HAIKU_ENDPOINT);
+  });
+});
+
+describe('haiku classifier — timeout', () => {
+  beforeEach(() => {
+    vi.useFakeTimers();
+  });
+  afterEach(() => {
+    vi.useRealTimers();
+  });
+
+  it('hard-timeout at 800ms resolves to null and aborts its own fetch only', async () => {
+    const upstreamCtl = new AbortController();
+    const upstreamAborted = vi.fn();
+    upstreamCtl.signal.addEventListener('abort', upstreamAborted);
+
+    const { fn } = makeMockFetch({ hang: true });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const promise = c.classify(loadFixture('multi-tool.json'), noDeadline());
+    await vi.advanceTimersByTimeAsync(801);
+    const result = await promise;
+    expect(result).toBeNull();
+    // Independent "upstream" controller untouched.
+    expect(upstreamAborted).not.toHaveBeenCalled();
+    expect(upstreamCtl.signal.aborted).toBe(false);
+  });
+
+  it('respects the race-level deadline signal', async () => {
+    const deadlineCtl = new AbortController();
+    const { fn } = makeMockFetch({ hang: true });
+    const c = createHaikuClassifier({
+      config: { ...TEST_CONFIG, timeoutMs: 60_000 },
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const promise = c.classify(loadFixture('multi-tool.json'), deadlineCtl.signal);
+    deadlineCtl.abort();
+    const result = await promise;
+    expect(result).toBeNull();
+  });
+});
+
+describe('haiku classifier — response parsing', () => {
+  it('parses valid JSON response into ClassifierResult with source: "haiku"', async () => {
+    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('multi-tool.json'), noDeadline());
+    expect(result).not.toBeNull();
+    expect(result!.source).toBe('haiku');
+    expect(result!.score).toBe(4.2);
+    expect(result!.suggestedModel).toBe('sonnet');
+    expect(result!.confidence).toBe(0.7);
+    expect(result!.rationale).toBe('mid-complexity task');
+    expect(typeof result!.latencyMs).toBe('number');
+    expect(typeof result!.classifierCostUsd).toBe('number');
+  });
+
+  it('omits rationale when model omits it', async () => {
+    const resp = defaultHaikuResponse();
+    resp.content[0]!.text = JSON.stringify({
+      complexity: 1, suggestedModel: 'haiku', confidence: 0.9,
+    });
+    const { fn } = makeMockFetch({ json: resp });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('small.json'), noDeadline());
+    expect(result).not.toBeNull();
+    expect(result!.rationale).toBeUndefined();
+  });
+
+  it('returns null on malformed JSON in model response', async () => {
+    const { fn } = makeMockFetch({
+      json: { content: [{ type: 'text', text: 'not json at all {' }] },
+    });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('small.json'), noDeadline());
+    expect(result).toBeNull();
+  });
+
+  it('returns null when JSON is structurally valid but fails schema check', async () => {
+    const { fn } = makeMockFetch({
+      json: {
+        content: [{ type: 'text', text: JSON.stringify({ complexity: 5, suggestedModel: 'gpt-5', confidence: 0.8 }) }],
+      },
+    });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('small.json'), noDeadline());
+    expect(result).toBeNull();
+  });
+
+  it('returns null when complexity is out of range', async () => {
+    const { fn } = makeMockFetch({
+      json: {
+        content: [{ type: 'text', text: JSON.stringify({ complexity: 11, suggestedModel: 'opus', confidence: 0.9 }) }],
+      },
+    });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
+  });
+
+  it('does not throw on upstream 5xx — returns null', async () => {
+    const { fn } = makeMockFetch({ ok: false, status: 503, json: { error: 'overloaded' } });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
+  });
+
+  it('does not throw when the fetch itself rejects — returns null', async () => {
+    const { fn } = makeMockFetch({ reject: new Error('ECONNRESET') });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
+  });
+});
+
+describe('haiku classifier — cost reporting', () => {
+  it('computes classifierCostUsd from usage fields (including cache tokens) using pricing table', async () => {
+    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('multi-tool.json'), noDeadline());
+    expect(result).not.toBeNull();
+    // 50*1e-6 + 100*1e-6*1.25 + 400*1e-6*0.1 + 30*5e-6
+    // = 5e-5 + 1.25e-4 + 4e-5 + 1.5e-4 = 3.65e-4
+    expect(result!.classifierCostUsd).toBeCloseTo(3.65e-4, 10);
+  });
+
+  it('classifierCostUsd is 0 when no pricing entry for the model', async () => {
+    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: {},
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('small.json'), noDeadline());
+    expect(result).not.toBeNull();
+    expect(result!.classifierCostUsd).toBe(0);
+  });
+
+  it('classifierCostUsd handles missing usage fields gracefully', async () => {
+    const resp = {
+      content: [{ type: 'text', text: JSON.stringify({ complexity: 2, suggestedModel: 'haiku', confidence: 0.8 }) }],
+    };
+    const { fn } = makeMockFetch({ json: resp });
+    const c = createHaikuClassifier({
+      config: TEST_CONFIG,
+      pricing: TEST_PRICING,
+      fetchImpl: fn,
+    } as HaikuClassifierDeps);
+    const result = await c.classify(loadFixture('small.json'), noDeadline());
+    expect(result).not.toBeNull();
+    expect(result!.classifierCostUsd).toBe(0);
+  });
+});
