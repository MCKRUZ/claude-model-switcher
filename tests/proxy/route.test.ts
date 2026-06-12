import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../src/proxy/route.js';
import { createStickyStore } from '../../src/sticky/store.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { makeSignals } from '../policy/helpers.js';
import type { CcmuxConfig, CcmuxRule } from '../../src/config/schema.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-7';

function cfg(over: Partial<CcmuxConfig>): CcmuxConfig {
  return { ...defaultConfig(), ...over };
}

const planToOpus: CcmuxRule = { id: 'plan-opus', when: { planMode: true }, then: { choice: 'opus' } };
const trivialToHaiku: CcmuxRule = { id: 'trivial-haiku', when: { toolUseCount: { eq: 0 } }, then: { choice: 'haiku' } };

describe('decideRoute — sticky disabled', () => {
  it('applies a policy choice with no stickiness', () => {
    const config = cfg({ stickyModel: { enabled: false, sessionTtlMs: 1 }, rules: [trivialToHaiku] });
    const store = createStickyStore({ ttlMs: 1000 });
    const d = decideRoute(makeSignals({ toolUseCount: 0 }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(HAIKU);
    expect(d.chosenBy).toBe('policy');
    expect(d.stickyHit).toBe(false);
    expect(d.mode).toBe('live');
  });

  it('falls back to the requested model when no rule matches', () => {
    const config = cfg({ stickyModel: { enabled: false, sessionTtlMs: 1 }, rules: [] });
    const store = createStickyStore({ ttlMs: 1000 });
    const d = decideRoute(makeSignals({}), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(SONNET);
    expect(d.chosenBy).toBe('fallback');
  });
});

describe('decideRoute — sticky enabled', () => {
  it('a policy choice establishes stickiness; a later abstain returns the stuck model', () => {
    const config = cfg({ rules: [planToOpus] });
    const store = createStickyStore({ ttlMs: 100_000 });

    const first = decideRoute(makeSignals({ planMode: true, sessionId: 'sess-A' }), SONNET, config, store, 1000);
    expect(first.forwardedModel).toBe(OPUS);
    expect(first.chosenBy).toBe('policy');
    expect(first.stickyHit).toBe(false);

    // Next turn: planMode false → policy abstains → sticky must keep OPUS (no cache-destroying flap).
    const next = decideRoute(makeSignals({ planMode: false, sessionId: 'sess-A' }), SONNET, config, store, 2000);
    expect(next.forwardedModel).toBe(OPUS);
    expect(next.chosenBy).toBe('sticky');
    expect(next.stickyHit).toBe(true);
  });

  it('blocks a downgrade and keeps the higher sticky tier', () => {
    const config = cfg({ rules: [trivialToHaiku] });
    const store = createStickyStore({ ttlMs: 100_000 });
    store.set({ sessionId: 'sess-B', tier: 'opus', modelId: OPUS, createdAt: 0, lastSeenAt: 0, turnCount: 1 });

    const d = decideRoute(makeSignals({ toolUseCount: 0, sessionId: 'sess-B' }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('sticky');
    expect(d.stickyHit).toBe(true);
  });

  it('honors an explicit model on abstain', () => {
    const config = cfg({ rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = decideRoute(makeSignals({ explicitModel: OPUS, sessionId: 'sess-C' }), SONNET, config, store, 1000);
    expect(d.forwardedModel).toBe(OPUS);
    expect(d.chosenBy).toBe('explicit');
  });
});

describe('decideRoute — shadow mode', () => {
  it('forwards the original model unchanged but records the would-be choice', () => {
    const config = cfg({ mode: 'shadow', rules: [planToOpus] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = decideRoute(makeSignals({ planMode: true }), SONNET, config, store, 1000);
    expect(d.mode).toBe('shadow');
    expect(d.forwardedModel).toBe(SONNET); // live traffic untouched
    expect(d.shadowChoice).toBe(OPUS); // what the router WOULD have done
    expect(d.chosenBy).toBe('shadow');
  });

  it('records a null shadowChoice when the router would not have changed the model', () => {
    const config = cfg({ mode: 'shadow', rules: [] });
    const store = createStickyStore({ ttlMs: 100_000 });
    const d = decideRoute(makeSignals({}), SONNET, config, store, 1000);
    expect(d.mode).toBe('shadow');
    expect(d.forwardedModel).toBe(SONNET);
    expect(d.shadowChoice).toBeNull();
  });
});
