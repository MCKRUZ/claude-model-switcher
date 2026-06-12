import { describe, it, expect } from 'vitest';
import { decideRoute, type ClassifyFn } from '../../src/proxy/route.js';
import { createStickyStore } from '../../src/sticky/store.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { makeSignals } from '../policy/helpers.js';
import type { CcmuxConfig, CcmuxRule } from '../../src/config/schema.js';
import type { ClassifierResult } from '../../src/classifier/types.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-7';

function cfg(over: Partial<CcmuxConfig>): CcmuxConfig {
  return { ...defaultConfig(), ...over };
}

const planToOpus: CcmuxRule = { id: 'plan-opus', when: { planMode: true }, then: { choice: 'opus' } };
const trivialToHaiku: CcmuxRule = { id: 'trivial-haiku', when: { toolUseCount: { eq: 0 } }, then: { choice: 'haiku' } };

function classifyTo(result: ClassifierResult | null, spy?: { calls: number }): ClassifyFn {
  return async () => {
    if (spy) spy.calls += 1;
    return result;
  };
}

function clsResult(over: Partial<ClassifierResult>): ClassifierResult {
  return { score: 5, suggestedModel: 'sonnet', confidence: 0.9, source: 'haiku', latencyMs: 5, ...over };
}

describe('decideRoute — sticky disabled', () => {
  it('applies a policy choice with no stickiness', async () => {
    const config = cfg({ stickyModel: { enabled: false, sessionTtlMs: 1 }, rules: [trivialToHaiku] });
    const store = createStickyStore({ ttlMs: 1000 });
    const d = await decideRoute(makeSignals({ toolUseCount: 0 }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(HAIKU);
    expect(d.chosenBy).toBe('policy');
    expect(d.stickyHit).toBe(false);
    expect(d.mode).toBe('live');
  });

  it('falls back to the requested model when no rule matches', async () => {
    const config = cfg({ stickyModel: { enabled: false, sessionTtlMs: 1 }, rules: [] });
    const store = createStickyStore({ ttlMs: 1000 });
    const d = await decideRoute(makeSignals({}), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(SONNET);
    expect(d.chosenBy).toBe('fallback');
  });
});

describe('decideRoute — sticky enabled', () => {
  it('a policy choice establishes stickiness; a later abstain returns the stuck model', async () => {
    const config = cfg({ rules: [planToOpus] });
    const store = createStickyStore({ ttlMs: 100_000 });

    const first = await decideRoute(makeSignals({ planMode: true, sessionId: 'sess-A' }), SONNET, config, store, 1000);
    expect(first.forwardedModel).toBe(OPUS);
    expect(first.chosenBy).toBe('policy');
    expect(first.stickyHit).toBe(false);

    // Next turn: planMode false → policy abstains → sticky must keep OPUS (no cache-destroying flap).
    const next = await decideRoute(makeSignals({ planMode: false, sessionId: 'sess-A' }), SONNET, config, store, 2000);
    expect(next.forwardedModel).toBe(OPUS);
    expect(next.chosenBy).toBe('sticky');
    expect(next.stickyHit).toBe(true);
  });

  it('blocks a downgrade and keeps the higher sticky tier', async () => {
    const config = cfg({ rules: [trivialToHaiku] });
    const store = createStickyStore({ ttlMs: 100_000 });
    store.set({ sessionId: 'sess-B', tier: 'opus', modelId: OPUS, createdAt: 0, lastSeenAt: 0, turnCount: 1 });

    const d = await decideRoute(makeSignals({ toolUseCount: 0, sessionId: 'sess-B' }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('sticky');
    expect(d.stickyHit).toBe(true);
  });

  it('honors an explicit model on abstain', async () => {
    const config = cfg({ rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = await decideRoute(makeSignals({ explicitModel: OPUS, sessionId: 'sess-C' }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('explicit');
  });
});

describe('decideRoute — shadow mode', () => {
  it('forwards the original model unchanged but records the would-be choice', async () => {
    const config = cfg({ mode: 'shadow', rules: [planToOpus] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = await decideRoute(makeSignals({ planMode: true }), SONNET, config, store, 1000);
    expect(d.mode).toBe('shadow');
    expect(d.forwardedModel).toBe(SONNET); // live traffic untouched
    expect(d.shadowChoice).toBe(OPUS); // what the router WOULD have done
    expect(d.chosenBy).toBe('shadow');
  });

  it('records a null shadowChoice when the router would not have changed the model', async () => {
    const config = cfg({ mode: 'shadow', rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = await decideRoute(makeSignals({}), SONNET, config, store, 1000);
    expect(d.mode).toBe('shadow');
    expect(d.forwardedModel).toBe(SONNET);
    expect(d.shadowChoice).toBeNull();
  });
});

describe('decideRoute — classifier', () => {
  it('applies a confident classifier suggestion for a new abstaining session', async () => {
    const config = cfg({ rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const classify = classifyTo(clsResult({ suggestedModel: 'opus', confidence: 0.9, source: 'haiku' }));
    const d = await decideRoute(makeSignals({ sessionId: 'cls-A' }), SONNET, config, store, 1000, classify);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('classifier');
    expect(d.classifierResult?.suggestedModel).toBe('opus');
  });

  it('ignores a low-confidence suggestion but still records it', async () => {
    const config = cfg({ rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const classify = classifyTo(clsResult({ suggestedModel: 'opus', confidence: 0.3, source: 'haiku' }));
    const d = await decideRoute(makeSignals({ sessionId: 'cls-B' }), SONNET, config, store, 1000, classify);
    expect(d.forwardedModel).toBe(SONNET);
    expect(d.chosenBy).toBe('fallback');
    expect(d.classifierResult?.confidence).toBe(0.3);
  });

  it('applies a heuristic result that clears the lower heuristic threshold', async () => {
    const config = cfg({ rules: [] }); // heuristic threshold defaults to 0.4
    const store = createStickyStore({ ttlMs: 100_000 });
    const classify = classifyTo(clsResult({ suggestedModel: 'haiku', confidence: 0.5, source: 'heuristic' }));
    const d = await decideRoute(makeSignals({ sessionId: 'cls-C' }), SONNET, config, store, 1000, classify);
    expect(d.forwardedModel).toBe(HAIKU);
    expect(d.chosenBy).toBe('classifier');
  });

  it('does not consult the classifier when a rule matches', async () => {
    const config = cfg({ rules: [planToOpus] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const spy = { calls: 0 };
    const classify = classifyTo(clsResult({ suggestedModel: 'haiku', confidence: 0.9 }), spy);
    const d = await decideRoute(makeSignals({ planMode: true }), SONNET, config, store, 1000, classify);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('policy');
    expect(spy.calls).toBe(0);
  });

  it('does not consult the classifier when the session is already sticky', async () => {
    const config = cfg({ rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    store.set({ sessionId: 'cls-sticky', tier: 'sonnet', modelId: SONNET, createdAt: 0, lastSeenAt: 0, turnCount: 1 });
    const spy = { calls: 0 };
    const classify = classifyTo(clsResult({ suggestedModel: 'opus', confidence: 0.9 }), spy);
    const d = await decideRoute(makeSignals({ sessionId: 'cls-sticky' }), SONNET, config, store, 1000, classify);
    expect(d.chosenBy).toBe('sticky');
    expect(spy.calls).toBe(0);
  });

  it('does not consult the classifier when classifier.enabled is false', async () => {
    const config = cfg({ rules: [], classifier: { ...defaultConfig().classifier, enabled: false } });
    const store = createStickyStore({ ttlMs: 100_000 });
    const spy = { calls: 0 };
    const classify = classifyTo(clsResult({ suggestedModel: 'opus', confidence: 0.9 }), spy);
    const d = await decideRoute(makeSignals({ sessionId: 'cls-off' }), SONNET, config, store, 1000, classify);
    expect(d.chosenBy).toBe('fallback');
    expect(spy.calls).toBe(0);
  });
});
