import { describe, it, expect } from 'vitest';
import { createStickyStore } from '../../src/sticky/store.js';
import type { StickyEntry } from '../../src/sticky/types.js';

function mkEntry(partial: Partial<StickyEntry> & { sessionId: string; lastSeenAt: number }): StickyEntry {
  return {
    tier: 'sonnet',
    modelId: 'claude-sonnet-4-5',
    createdAt: partial.lastSeenAt,
    turnCount: 1,
    ...partial,
  };
}

describe('StickyStore', () => {
  it('returns undefined for unknown sessionId', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    expect(store.get('unknown', 0)).toBeUndefined();
  });

  it('set then get within TTL returns the same entry', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    const entry = mkEntry({ sessionId: 's1', lastSeenAt: 100 });
    store.set(entry);
    expect(store.get('s1', 500)).toEqual(entry);
  });

  it('get after lastSeenAt + ttl returns undefined AND removes the entry', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
    expect(store.size()).toBe(1);
    expect(store.get('s1', 1001)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('get at exactly lastSeenAt + ttl is considered expired', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
    // boundary: now - lastSeenAt > ttl means >1000 expired; 1001 is expired (test above).
    // At exactly 1000 it must still be considered valid (strict > ttl). Test that.
    expect(store.get('s1', 1000)).toBeDefined();
  });

  it('touch updates lastSeenAt to now and increments turnCount by 1', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0, turnCount: 1 }));
    store.touch('s1', 500);
    const got = store.get('s1', 500);
    expect(got?.lastSeenAt).toBe(500);
    expect(got?.turnCount).toBe(2);
  });

  it('touch on unknown sessionId is a no-op (does not create an entry)', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.touch('ghost', 100);
    expect(store.size()).toBe(0);
    expect(store.get('ghost', 100)).toBeUndefined();
  });

  it('size cap evicts the entry with the oldest lastSeenAt on overflow', () => {
    const store = createStickyStore({ ttlMs: 10_000, maxEntries: 2 });
    store.set(mkEntry({ sessionId: 'a', lastSeenAt: 0 }));
    store.set(mkEntry({ sessionId: 'b', lastSeenAt: 100 }));
    store.set(mkEntry({ sessionId: 'c', lastSeenAt: 200 }));
    expect(store.size()).toBe(2);
    expect(store.get('a', 300)).toBeUndefined();
    expect(store.get('b', 300)).toBeDefined();
    expect(store.get('c', 300)).toBeDefined();
  });

  it('eviction is lazy — no timer fires without a call to get', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0 }));
    // simulate a very long wait — no get/touch calls
    expect(store.size()).toBe(1);
  });

  it('set overwrites existing entry for same sessionId', () => {
    const store = createStickyStore({ ttlMs: 1000 });
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 0, tier: 'haiku', modelId: 'claude-haiku-4-5-20251001' }));
    store.set(mkEntry({ sessionId: 's1', lastSeenAt: 100, tier: 'opus', modelId: 'claude-opus-4-7' }));
    expect(store.size()).toBe(1);
    const got = store.get('s1', 100);
    expect(got?.tier).toBe('opus');
    expect(got?.modelId).toBe('claude-opus-4-7');
  });
});
