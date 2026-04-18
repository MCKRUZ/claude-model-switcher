diff --git a/src/sticky/index.ts b/src/sticky/index.ts
new file mode 100644
index 0000000..03a81dd
--- /dev/null
+++ b/src/sticky/index.ts
@@ -0,0 +1,7 @@
+export type { StickyEntry, StickyDecision, StickyChosenBy, StickyAbstainReason, Tier } from './types.js';
+export type { StickyStore, StickyStoreOptions } from './store.js';
+export type { ResolveInput } from './policy.js';
+
+export { createStickyStore } from './store.js';
+export { resolveStickyDecision } from './policy.js';
+export { compareTiers, tierOf, firstModelIdForTier, nextTier } from './tiers.js';
diff --git a/src/sticky/policy.ts b/src/sticky/policy.ts
index 193d1c6..3ec5120 100644
--- a/src/sticky/policy.ts
+++ b/src/sticky/policy.ts
@@ -1,2 +1,134 @@
-// Populated in section-09. Do not import.
-export {};
+import type { ModelChoice, PolicyResult, MatchedResult } from '../policy/index.js';
+import type { StickyStore } from './store.js';
+import type { StickyChosenBy, StickyDecision, StickyEntry, Tier } from './types.js';
+import { compareTiers, firstModelIdForTier, nextTier, tierOf } from './tiers.js';
+
+export interface ResolveInput {
+  readonly sessionId: string;
+  readonly policyResult: PolicyResult;
+  readonly explicitModel: string | null;
+  readonly defaultTier: Tier;
+  readonly tierMap: ReadonlyMap<string, Tier>;
+  readonly now: number;
+}
+
+// Explicit note: explicit wins over sticky even when it would downgrade. Explicit is the
+// strongest client signal. A rule `{choice}` still beats explicit (rules are operator policy).
+export function resolveStickyDecision(
+  store: StickyStore,
+  input: ResolveInput
+): StickyDecision {
+  const existed = store.peek(input.sessionId);
+  const current = existed === undefined ? undefined : store.get(input.sessionId, input.now);
+
+  if (input.policyResult.kind === 'matched') {
+    const result: MatchedResult = input.policyResult.result;
+    if ('choice' in result) {
+      return handleChoice(store, input, current, result);
+    }
+    return handleEscalate(store, input, current, result.escalate);
+  }
+
+  if (input.explicitModel !== null) {
+    return handleExplicit(store, input, current);
+  }
+
+  if (current !== undefined) {
+    store.touch(input.sessionId, input.now);
+    return {
+      kind: 'chosen',
+      modelId: current.modelId,
+      tier: current.tier,
+      chosenBy: 'sticky',
+    };
+  }
+
+  if (existed !== undefined) {
+    return { kind: 'abstain', reason: 'ttl-expired' };
+  }
+  return { kind: 'abstain', reason: 'no-sticky' };
+}
+
+function handleChoice(
+  store: StickyStore,
+  input: ResolveInput,
+  current: StickyEntry | undefined,
+  rule: Extract<MatchedResult, { readonly choice: ModelChoice }>
+): StickyDecision {
+  const modelId = resolveChoiceModelId(rule.choice, input.tierMap);
+  const tier = tierOf(modelId, input.tierMap);
+  if (current !== undefined) {
+    const cmp = compareTiers(tier, current.tier);
+    if (cmp < 0 && rule.allowDowngrade !== true) {
+      return { kind: 'abstain', reason: 'downgrade-blocked', sticky: current };
+    }
+  }
+  writeSticky(store, input, tier, modelId, current);
+  return { kind: 'chosen', modelId, tier, chosenBy: 'policy' };
+}
+
+function handleEscalate(
+  store: StickyStore,
+  input: ResolveInput,
+  current: StickyEntry | undefined,
+  steps: number
+): StickyDecision {
+  const fromTier = current?.tier ?? input.defaultTier;
+  const targetTier = nextTier(fromTier, steps);
+  const modelId =
+    firstModelIdForTier(targetTier, input.tierMap) ?? fallbackFamilyModelId(targetTier);
+  writeSticky(store, input, targetTier, modelId, current);
+  return { kind: 'chosen', modelId, tier: targetTier, chosenBy: 'escalate' };
+}
+
+function handleExplicit(
+  store: StickyStore,
+  input: ResolveInput,
+  current: StickyEntry | undefined
+): StickyDecision {
+  const modelId = input.explicitModel!;
+  const tier = tierOf(modelId, input.tierMap);
+  writeSticky(store, input, tier, modelId, current);
+  return { kind: 'chosen', modelId, tier, chosenBy: 'explicit' };
+}
+
+function writeSticky(
+  store: StickyStore,
+  input: ResolveInput,
+  tier: Tier,
+  modelId: string,
+  prior: StickyEntry | undefined
+): void {
+  const createdAt = prior?.createdAt ?? input.now;
+  const turnCount = (prior?.turnCount ?? 0) + 1;
+  store.set({
+    sessionId: input.sessionId,
+    tier,
+    modelId,
+    createdAt,
+    lastSeenAt: input.now,
+    turnCount,
+  });
+}
+
+function resolveChoiceModelId(
+  choice: ModelChoice,
+  tierMap: ReadonlyMap<string, Tier>
+): string {
+  if (typeof choice === 'string') {
+    // Tier shorthand: look up first modelId for that tier in config.modelTiers.
+    const found = firstModelIdForTier(choice, tierMap);
+    return found ?? fallbackFamilyModelId(choice);
+  }
+  return choice.modelId;
+}
+
+// Fallback when config.modelTiers has no entry for a tier. Gives a well-formed
+// model family name so downstream log/explain stays readable. Section-03 config
+// validation is expected to warn when modelTiers is sparse.
+function fallbackFamilyModelId(tier: Tier): string {
+  return `claude-${tier}-latest`;
+}
+
+// Internal re-use for StickyChosenBy ensures the union is exhaustive.
+export type { StickyChosenBy };
diff --git a/src/sticky/store.ts b/src/sticky/store.ts
index 193d1c6..c5b1c8d 100644
--- a/src/sticky/store.ts
+++ b/src/sticky/store.ts
@@ -1,2 +1,75 @@
-// Populated in section-09. Do not import.
-export {};
+import type { StickyEntry } from './types.js';
+
+const DEFAULT_MAX_ENTRIES = 10_000;
+
+export interface StickyStore {
+  get(sessionId: string, now: number): StickyEntry | undefined;
+  peek(sessionId: string): StickyEntry | undefined;
+  set(entry: StickyEntry): void;
+  touch(sessionId: string, now: number): void;
+  delete(sessionId: string): boolean;
+  size(): number;
+}
+
+export interface StickyStoreOptions {
+  readonly ttlMs: number;
+  readonly maxEntries?: number;
+}
+
+export function createStickyStore(opts: StickyStoreOptions): StickyStore {
+  const ttlMs = opts.ttlMs;
+  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
+  const map = new Map<string, StickyEntry>();
+
+  function isExpired(entry: StickyEntry, now: number): boolean {
+    return now - entry.lastSeenAt > ttlMs;
+  }
+
+  function evictOldest(): void {
+    let oldestKey: string | undefined;
+    let oldestSeen = Number.POSITIVE_INFINITY;
+    for (const [k, v] of map) {
+      if (v.lastSeenAt < oldestSeen) {
+        oldestSeen = v.lastSeenAt;
+        oldestKey = k;
+      }
+    }
+    if (oldestKey !== undefined) map.delete(oldestKey);
+  }
+
+  return {
+    get(sessionId, now) {
+      const entry = map.get(sessionId);
+      if (entry === undefined) return undefined;
+      if (isExpired(entry, now)) {
+        map.delete(sessionId);
+        return undefined;
+      }
+      return entry;
+    },
+    peek(sessionId) {
+      return map.get(sessionId);
+    },
+    set(entry) {
+      if (!map.has(entry.sessionId) && map.size >= maxEntries) {
+        evictOldest();
+      }
+      map.set(entry.sessionId, entry);
+    },
+    touch(sessionId, now) {
+      const entry = map.get(sessionId);
+      if (entry === undefined) return;
+      map.set(sessionId, {
+        ...entry,
+        lastSeenAt: now,
+        turnCount: entry.turnCount + 1,
+      });
+    },
+    delete(sessionId) {
+      return map.delete(sessionId);
+    },
+    size() {
+      return map.size;
+    },
+  };
+}
diff --git a/src/sticky/tiers.ts b/src/sticky/tiers.ts
new file mode 100644
index 0000000..cc55cc4
--- /dev/null
+++ b/src/sticky/tiers.ts
@@ -0,0 +1,42 @@
+import type { Tier } from './types.js';
+
+const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
+  haiku: 0,
+  sonnet: 1,
+  opus: 2,
+});
+
+const TIER_FAMILIES: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
+
+export function compareTiers(a: Tier, b: Tier): -1 | 0 | 1 {
+  const delta = TIER_RANK[a] - TIER_RANK[b];
+  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
+}
+
+export function tierOf(modelId: string, overrides: ReadonlyMap<string, Tier>): Tier {
+  const override = overrides.get(modelId);
+  if (override !== undefined) return override;
+  const lower = modelId.toLowerCase();
+  for (const family of TIER_FAMILIES) {
+    if (lower.includes(family)) return family;
+  }
+  throw new Error(
+    `tierOf: cannot resolve tier for "${modelId}" — not a known Anthropic family and not in modelTiers override map`
+  );
+}
+
+export function firstModelIdForTier(
+  tier: Tier,
+  tierMap: ReadonlyMap<string, Tier>
+): string | undefined {
+  for (const [modelId, t] of tierMap) {
+    if (t === tier) return modelId;
+  }
+  return undefined;
+}
+
+export function nextTier(current: Tier, steps: number): Tier {
+  const target = TIER_RANK[current] + steps;
+  const clamped = Math.max(0, Math.min(TIER_RANK.opus, target));
+  return TIER_FAMILIES[clamped]!;
+}
diff --git a/src/sticky/types.ts b/src/sticky/types.ts
new file mode 100644
index 0000000..71fb3c2
--- /dev/null
+++ b/src/sticky/types.ts
@@ -0,0 +1,28 @@
+import type { Tier } from '../config/schema.js';
+
+export type { Tier };
+
+export interface StickyEntry {
+  readonly sessionId: string;
+  readonly tier: Tier;
+  readonly modelId: string;
+  readonly createdAt: number;
+  readonly lastSeenAt: number;
+  readonly turnCount: number;
+}
+
+export type StickyChosenBy = 'explicit' | 'policy' | 'sticky' | 'escalate';
+export type StickyAbstainReason = 'no-sticky' | 'ttl-expired' | 'downgrade-blocked';
+
+export type StickyDecision =
+  | {
+      readonly kind: 'chosen';
+      readonly modelId: string;
+      readonly tier: Tier;
+      readonly chosenBy: StickyChosenBy;
+    }
+  | {
+      readonly kind: 'abstain';
+      readonly reason: StickyAbstainReason;
+      readonly sticky?: StickyEntry;
+    };
diff --git a/tests/sticky/policy.test.ts b/tests/sticky/policy.test.ts
new file mode 100644
index 0000000..921c2c9
--- /dev/null
+++ b/tests/sticky/policy.test.ts
@@ -0,0 +1,234 @@
+import { describe, it, expect } from 'vitest';
+import { createStickyStore } from '../../src/sticky/store.js';
+import { resolveStickyDecision } from '../../src/sticky/policy.js';
+import type { ResolveInput } from '../../src/sticky/policy.js';
+import type { StickyEntry, Tier } from '../../src/sticky/types.js';
+import type { PolicyResult } from '../../src/policy/index.js';
+
+const HAIKU = 'claude-haiku-4-5-20251001';
+const SONNET = 'claude-sonnet-4-5';
+const OPUS = 'claude-opus-4-7';
+
+const TIER_MAP: ReadonlyMap<string, Tier> = new Map([
+  [HAIKU, 'haiku'],
+  [SONNET, 'sonnet'],
+  [OPUS, 'opus'],
+]);
+
+function baseInput(overrides: Partial<ResolveInput>): ResolveInput {
+  return {
+    sessionId: 's1',
+    policyResult: { kind: 'abstain' },
+    explicitModel: null,
+    defaultTier: 'sonnet',
+    tierMap: TIER_MAP,
+    now: 500,
+    ...overrides,
+  };
+}
+
+function seedSticky(tier: Tier, modelId: string, lastSeenAt = 0, sessionId = 's1'): StickyEntry {
+  return {
+    sessionId,
+    tier,
+    modelId,
+    createdAt: lastSeenAt,
+    lastSeenAt,
+    turnCount: 1,
+  };
+}
+
+function choiceModelResult(modelId: string, allowDowngrade?: boolean): PolicyResult {
+  const result = allowDowngrade !== undefined
+    ? { choice: { modelId }, allowDowngrade }
+    : { choice: { modelId } };
+  return { kind: 'matched', ruleId: 'r1', result: result as never };
+}
+
+function escalateResult(n: number): PolicyResult {
+  return { kind: 'matched', ruleId: 'r1', result: { escalate: n } };
+}
+
+describe('resolveStickyDecision — tier ordering and downgrade', () => {
+  it('blocks downgrade when allowDowngrade is not set', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('sonnet', SONNET));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: choiceModelResult(HAIKU) })
+    );
+    expect(dec.kind).toBe('abstain');
+    if (dec.kind === 'abstain') {
+      expect(dec.reason).toBe('downgrade-blocked');
+      expect(dec.sticky?.tier).toBe('sonnet');
+    }
+    // Sticky preserved
+    expect(store.peek('s1')?.tier).toBe('sonnet');
+  });
+
+  it('permits downgrade when allowDowngrade is true', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('sonnet', SONNET));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: choiceModelResult(HAIKU, true) })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'policy', modelId: HAIKU });
+    expect(store.peek('s1')?.tier).toBe('haiku');
+  });
+
+  it('escalation (cheap→expensive) is always free', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('haiku', HAIKU));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: choiceModelResult(OPUS) })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
+  });
+
+  it('equal tier choice refreshes sticky modelId and lastSeenAt', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('sonnet', SONNET, 0));
+    const SONNET2 = 'claude-sonnet-alt';
+    const tierMap = new Map<string, Tier>([...TIER_MAP, [SONNET2, 'sonnet']]);
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: choiceModelResult(SONNET2), tierMap, now: 500 })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'sonnet', chosenBy: 'policy', modelId: SONNET2 });
+    const got = store.get('s1', 500);
+    expect(got?.modelId).toBe(SONNET2);
+    expect(got?.lastSeenAt).toBe(500);
+  });
+});
+
+describe('resolveStickyDecision — explicit model', () => {
+  it('honors explicit model when policy abstains and no sticky exists', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ explicitModel: OPUS, policyResult: { kind: 'abstain' } })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'explicit', modelId: OPUS });
+    expect(store.peek('s1')?.tier).toBe('opus');
+  });
+
+  it('explicit model does NOT override a rule {choice}', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ explicitModel: HAIKU, policyResult: choiceModelResult(OPUS) })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
+  });
+
+  it('explicit wins over sticky even when it downgrades (explicit is strongest client signal)', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('opus', OPUS));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ explicitModel: HAIKU, policyResult: { kind: 'abstain' } })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'explicit', modelId: HAIKU });
+  });
+});
+
+describe('resolveStickyDecision — escalate', () => {
+  it('escalate with no sticky uses defaultTier', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: escalateResult(1), defaultTier: 'sonnet' })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'escalate', modelId: OPUS });
+  });
+
+  it('escalate clamps at opus', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('opus', OPUS));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: escalateResult(2) })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'escalate', modelId: OPUS });
+  });
+
+  it('escalate with N=0 from sticky=haiku stays haiku and refreshes sticky', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('haiku', HAIKU, 0));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: escalateResult(0), now: 500 })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'escalate', modelId: HAIKU });
+    expect(store.get('s1', 500)?.lastSeenAt).toBe(500);
+  });
+});
+
+describe('resolveStickyDecision — abstain paths', () => {
+  it('abstain + sticky + within TTL returns sticky', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    store.set(seedSticky('sonnet', SONNET, 0));
+    const sizeBefore = store.size();
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: { kind: 'abstain' }, now: 5_000 })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', chosenBy: 'sticky', modelId: SONNET, tier: 'sonnet' });
+    expect(store.size()).toBe(sizeBefore);
+  });
+
+  it('abstain + sticky + TTL expired returns abstain and removes sticky', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(seedSticky('sonnet', SONNET, 0));
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: { kind: 'abstain' }, now: 2000 })
+    );
+    expect(dec.kind).toBe('abstain');
+    if (dec.kind === 'abstain') {
+      expect(dec.reason).toBe('ttl-expired');
+    }
+    expect(store.size()).toBe(0);
+  });
+
+  it('abstain + no sticky returns abstain/no-sticky', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    const sizeBefore = store.size();
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: { kind: 'abstain' } })
+    );
+    expect(dec).toEqual({ kind: 'abstain', reason: 'no-sticky' });
+    expect(store.size()).toBe(sizeBefore);
+  });
+
+  it('abstain outcomes (no-sticky, downgrade-blocked) never mutate the store', () => {
+    // no-sticky path
+    const storeA = createStickyStore({ ttlMs: 10_000 });
+    resolveStickyDecision(storeA, baseInput({ policyResult: { kind: 'abstain' } }));
+    expect(storeA.size()).toBe(0);
+
+    // downgrade-blocked path
+    const storeB = createStickyStore({ ttlMs: 10_000 });
+    storeB.set(seedSticky('sonnet', SONNET, 0));
+    const snapshot = storeB.peek('s1');
+    resolveStickyDecision(
+      storeB,
+      baseInput({ policyResult: choiceModelResult(HAIKU), now: 500 })
+    );
+    expect(storeB.peek('s1')).toEqual(snapshot);
+  });
+});
+
+describe('resolveStickyDecision — Tier-shorthand {choice: Tier}', () => {
+  it('accepts bare-tier choice and looks up first modelId for that tier', () => {
+    const store = createStickyStore({ ttlMs: 10_000 });
+    const dec = resolveStickyDecision(
+      store,
+      baseInput({ policyResult: { kind: 'matched', ruleId: 'r1', result: { choice: 'opus' } } })
+    );
+    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
+  });
+});
diff --git a/tests/sticky/store.test.ts b/tests/sticky/store.test.ts
new file mode 100644
index 0000000..fdd8d37
--- /dev/null
+++ b/tests/sticky/store.test.ts
@@ -0,0 +1,87 @@
+import { describe, it, expect } from 'vitest';
+import { createStickyStore } from '../../src/sticky/store.js';
+import type { StickyEntry } from '../../src/sticky/types.js';
+
+function mkEntry(partial: Partial<StickyEntry> & { sessionId: string; lastSeenAt: number }): StickyEntry {
+  return {
+    tier: 'sonnet',
+    modelId: 'claude-sonnet-4-5',
+    createdAt: partial.lastSeenAt,
+    turnCount: 1,
+    ...partial,
+  };
+}
+
+describe('StickyStore', () => {
+  it('returns undefined for unknown sessionId', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    expect(store.get('unknown', 0)).toBeUndefined();
+  });
+
+  it('set then get within TTL returns the same entry', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    const entry = mkEntry({ sessionId: 's1', lastSeenAt: 100 });
+    store.set(entry);
+    expect(store.get('s1', 500)).toEqual(entry);
+  });
+
+  it('get after lastSeenAt + ttl returns undefined AND removes the entry', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
+    expect(store.size()).toBe(1);
+    expect(store.get('s1', 1001)).toBeUndefined();
+    expect(store.size()).toBe(0);
+  });
+
+  it('get at exactly lastSeenAt + ttl is considered expired', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
+    // boundary: now - lastSeenAt > ttl means >1000 expired; 1001 is expired (test above).
+    // At exactly 1000 it must still be considered valid (strict > ttl). Test that.
+    expect(store.get('s1', 1000)).toBeDefined();
+  });
+
+  it('touch updates lastSeenAt to now and increments turnCount by 1', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0, turnCount: 1 }));
+    store.touch('s1', 500);
+    const got = store.get('s1', 500);
+    expect(got?.lastSeenAt).toBe(500);
+    expect(got?.turnCount).toBe(2);
+  });
+
+  it('touch on unknown sessionId is a no-op (does not create an entry)', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.touch('ghost', 100);
+    expect(store.size()).toBe(0);
+    expect(store.get('ghost', 100)).toBeUndefined();
+  });
+
+  it('size cap evicts the entry with the oldest lastSeenAt on overflow', () => {
+    const store = createStickyStore({ ttlMs: 10_000, maxEntries: 2 });
+    store.set(mkEntry({ sessionId: 'a', lastSeenAt: 0 }));
+    store.set(mkEntry({ sessionId: 'b', lastSeenAt: 100 }));
+    store.set(mkEntry({ sessionId: 'c', lastSeenAt: 200 }));
+    expect(store.size()).toBe(2);
+    expect(store.get('a', 300)).toBeUndefined();
+    expect(store.get('b', 300)).toBeDefined();
+    expect(store.get('c', 300)).toBeDefined();
+  });
+
+  it('eviction is lazy — no timer fires without a call to get', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
+    // simulate a very long wait — no get/touch calls
+    expect(store.size()).toBe(1);
+  });
+
+  it('set overwrites existing entry for same sessionId', () => {
+    const store = createStickyStore({ ttlMs: 1000 });
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0, tier: 'haiku', modelId: 'claude-haiku-4-5-20251001' }));
+    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 100, tier: 'opus', modelId: 'claude-opus-4-7' }));
+    expect(store.size()).toBe(1);
+    const got = store.get('s1', 100);
+    expect(got?.tier).toBe('opus');
+    expect(got?.modelId).toBe('claude-opus-4-7');
+  });
+});
diff --git a/tests/sticky/tiers.test.ts b/tests/sticky/tiers.test.ts
new file mode 100644
index 0000000..c2c2dc3
--- /dev/null
+++ b/tests/sticky/tiers.test.ts
@@ -0,0 +1,67 @@
+import { describe, it, expect } from 'vitest';
+import { compareTiers, tierOf, firstModelIdForTier } from '../../src/sticky/tiers.js';
+import type { Tier } from '../../src/sticky/types.js';
+
+describe('compareTiers', () => {
+  it('returns -1 / 0 / 1 for all 9 ordered pairs', () => {
+    const tiers: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
+    for (let i = 0; i < tiers.length; i++) {
+      for (let j = 0; j < tiers.length; j++) {
+        const a = tiers[i]!;
+        const b = tiers[j]!;
+        const got = compareTiers(a, b);
+        const expected = i < j ? -1 : i > j ? 1 : 0;
+        expect(got).toBe(expected);
+      }
+    }
+  });
+});
+
+describe('tierOf', () => {
+  const emptyMap: ReadonlyMap<string, Tier> = new Map();
+
+  it('resolves claude-haiku-* to haiku via family-name substring', () => {
+    expect(tierOf('claude-haiku-4-5-20251001', emptyMap)).toBe('haiku');
+  });
+
+  it('resolves claude-sonnet-* to sonnet', () => {
+    expect(tierOf('claude-sonnet-4-5', emptyMap)).toBe('sonnet');
+  });
+
+  it('resolves claude-opus-* to opus', () => {
+    expect(tierOf('claude-opus-4-7', emptyMap)).toBe('opus');
+  });
+
+  it('throws on unmapped unknown family (no override)', () => {
+    expect(() => tierOf('some-custom-fine-tune', emptyMap)).toThrow();
+  });
+
+  it('resolves unknown family via config override map', () => {
+    const overrides = new Map<string, Tier>([['some-custom-fine-tune', 'sonnet']]);
+    expect(tierOf('some-custom-fine-tune', overrides)).toBe('sonnet');
+  });
+
+  it('override map takes precedence over family substring', () => {
+    const overrides = new Map<string, Tier>([['claude-haiku-magic', 'opus']]);
+    expect(tierOf('claude-haiku-magic', overrides)).toBe('opus');
+  });
+});
+
+describe('firstModelIdForTier', () => {
+  it('returns the first modelId whose tier matches by insertion order', () => {
+    const tierMap = new Map<string, Tier>([
+      ['claude-haiku-4-5-20251001', 'haiku'],
+      ['claude-haiku-older', 'haiku'],
+      ['claude-sonnet-4-5', 'sonnet'],
+      ['claude-opus-4-7', 'opus'],
+    ]);
+    expect(firstModelIdForTier('haiku', tierMap)).toBe('claude-haiku-4-5-20251001');
+    expect(firstModelIdForTier('sonnet', tierMap)).toBe('claude-sonnet-4-5');
+    expect(firstModelIdForTier('opus', tierMap)).toBe('claude-opus-4-7');
+  });
+
+  it('returns undefined if no modelId has the requested tier', () => {
+    const tierMap = new Map<string, Tier>([['claude-haiku-4-5-20251001', 'haiku']]);
+    expect(firstModelIdForTier('opus', tierMap)).toBeUndefined();
+  });
+});
