import { describe, it, expect } from 'vitest';
import { createStickyStore } from '../../src/sticky/store.js';
import { resolveStickyDecision } from '../../src/sticky/policy.js';
import type { ResolveInput } from '../../src/sticky/policy.js';
import type { StickyEntry, Tier } from '../../src/sticky/types.js';
import type { PolicyResult } from '../../src/policy/index.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-5';
const OPUS = 'claude-opus-4-7';

const TIER_MAP: ReadonlyMap<string, Tier> = new Map([
  [HAIKU, 'haiku'],
  [SONNET, 'sonnet'],
  [OPUS, 'opus'],
]);

function baseInput(overrides: Partial<ResolveInput>): ResolveInput {
  return {
    sessionId: 's1',
    policyResult: { kind: 'abstain' },
    explicitModel: null,
    defaultTier: 'sonnet',
    tierMap: TIER_MAP,
    now: 500,
    ...overrides,
  };
}

function seedSticky(tier: Tier, modelId: string, lastSeenAt = 0, sessionId = 's1'): StickyEntry {
  return {
    sessionId,
    tier,
    modelId,
    createdAt: lastSeenAt,
    lastSeenAt,
    turnCount: 1,
  };
}

function choiceModelResult(modelId: string, allowDowngrade?: boolean): PolicyResult {
  const result = allowDowngrade !== undefined
    ? { choice: { modelId }, allowDowngrade }
    : { choice: { modelId } };
  return { kind: 'matched', ruleId: 'r1', result: result as never };
}

function escalateResult(n: number): PolicyResult {
  return { kind: 'matched', ruleId: 'r1', result: { escalate: n } };
}

describe('resolveStickyDecision — tier ordering and downgrade', () => {
  it('blocks downgrade when allowDowngrade is not set', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('sonnet', SONNET));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: choiceModelResult(HAIKU) })
    );
    expect(dec.kind).toBe('abstain');
    if (dec.kind === 'abstain') {
      expect(dec.reason).toBe('downgrade-blocked');
      expect(dec.sticky?.tier).toBe('sonnet');
    }
    // Sticky preserved
    expect(store.peek('s1')?.tier).toBe('sonnet');
  });

  it('permits downgrade when allowDowngrade is true', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('sonnet', SONNET));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: choiceModelResult(HAIKU, true) })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'policy', modelId: HAIKU });
    expect(store.peek('s1')?.tier).toBe('haiku');
  });

  it('escalation (cheap→expensive) is always free', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('haiku', HAIKU));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: choiceModelResult(OPUS) })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
  });

  it('equal tier choice refreshes sticky modelId and lastSeenAt', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('sonnet', SONNET, 0));
    const SONNET2 = 'claude-sonnet-alt';
    const tierMap = new Map<string, Tier>([...TIER_MAP, [SONNET2, 'sonnet']]);
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: choiceModelResult(SONNET2), tierMap, now: 500 })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'sonnet', chosenBy: 'policy', modelId: SONNET2 });
    const got = store.get('s1', 500);
    expect(got?.modelId).toBe(SONNET2);
    expect(got?.lastSeenAt).toBe(500);
  });
});

describe('resolveStickyDecision — explicit model', () => {
  it('honors explicit model when policy abstains and no sticky exists', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const dec = resolveStickyDecision(
      store,
      baseInput({ explicitModel: OPUS, policyResult: { kind: 'abstain' } })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'explicit', modelId: OPUS });
    expect(store.peek('s1')?.tier).toBe('opus');
  });

  it('explicit model does NOT override a rule {choice}', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const dec = resolveStickyDecision(
      store,
      baseInput({ explicitModel: HAIKU, policyResult: choiceModelResult(OPUS) })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
  });

  it('explicit wins over sticky even when it downgrades (explicit is strongest client signal)', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('opus', OPUS));
    const dec = resolveStickyDecision(
      store,
      baseInput({ explicitModel: HAIKU, policyResult: { kind: 'abstain' } })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'explicit', modelId: HAIKU });
  });
});

describe('resolveStickyDecision — escalate', () => {
  it('escalate with no sticky uses defaultTier', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: escalateResult(1), defaultTier: 'sonnet' })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'escalate', modelId: OPUS });
  });

  it('escalate clamps at opus', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('opus', OPUS));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: escalateResult(2) })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'escalate', modelId: OPUS });
  });

  it('escalate with N=0 from sticky=haiku stays haiku and refreshes sticky', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('haiku', HAIKU, 0));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: escalateResult(0), now: 500 })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'haiku', chosenBy: 'escalate', modelId: HAIKU });
    expect(store.get('s1', 500)?.lastSeenAt).toBe(500);
  });
});

describe('resolveStickyDecision — abstain paths', () => {
  it('abstain + sticky + within TTL returns sticky', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    store.set(seedSticky('sonnet', SONNET, 0));
    const sizeBefore = store.size();
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: { kind: 'abstain' }, now: 5_000 })
    );
    expect(dec).toMatchObject({ kind: 'chosen', chosenBy: 'sticky', modelId: SONNET, tier: 'sonnet' });
    expect(store.size()).toBe(sizeBefore);
  });

  it('abstain + sticky + TTL expired returns abstain and removes sticky', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(seedSticky('sonnet', SONNET, 0));
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: { kind: 'abstain' }, now: 2000 })
    );
    expect(dec.kind).toBe('abstain');
    if (dec.kind === 'abstain') {
      expect(dec.reason).toBe('ttl-expired');
    }
    expect(store.size()).toBe(0);
  });

  it('abstain + no sticky returns abstain/no-sticky', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const sizeBefore = store.size();
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: { kind: 'abstain' } })
    );
    expect(dec).toEqual({ kind: 'abstain', reason: 'no-sticky' });
    expect(store.size()).toBe(sizeBefore);
  });

  it('abstain outcomes (no-sticky, downgrade-blocked) never mutate the store', () => {
    // no-sticky path
    const storeA = createStickyStore({ ttlMs: 10_000 });
    resolveStickyDecision(storeA, baseInput({ policyResult: { kind: 'abstain' } }));
    expect(storeA.size()).toBe(0);

    // downgrade-blocked path
    const storeB = createStickyStore({ ttlMs: 10_000 });
    storeB.set(seedSticky('sonnet', SONNET, 0));
    const snapshot = storeB.peek('s1');
    resolveStickyDecision(
      storeB,
      baseInput({ policyResult: choiceModelResult(HAIKU), now: 500 })
    );
    expect(storeB.peek('s1')).toEqual(snapshot);
  });
});

describe('resolveStickyDecision — Tier-shorthand {choice: Tier}', () => {
  it('accepts bare-tier choice and looks up first modelId for that tier', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const dec = resolveStickyDecision(
      store,
      baseInput({ policyResult: { kind: 'matched', ruleId: 'r1', result: { choice: 'opus' } } })
    );
    expect(dec).toMatchObject({ kind: 'chosen', tier: 'opus', chosenBy: 'policy', modelId: OPUS });
  });

  it('throws when tier-shorthand resolves to a tier with no modelId in tierMap', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const sparseMap = new Map<string, Tier>([[HAIKU, 'haiku']]); // no opus entry
    expect(() =>
      resolveStickyDecision(
        store,
        baseInput({
          policyResult: { kind: 'matched', ruleId: 'r1', result: { choice: 'opus' } },
          tierMap: sparseMap,
        })
      )
    ).toThrow(/modelTiers/);
  });

  it('throws when escalate targets a tier with no modelId in tierMap', () => {
    const store = createStickyStore({ ttlMs: 10_000 });
    const sparseMap = new Map<string, Tier>([[HAIKU, 'haiku']]); // no sonnet/opus entries
    expect(() =>
      resolveStickyDecision(
        store,
        baseInput({
          policyResult: escalateResult(1),
          defaultTier: 'haiku',
          tierMap: sparseMap,
        })
      )
    ).toThrow(/modelTiers/);
  });
});
