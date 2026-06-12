import { describe, it, expect } from 'vitest';
import { createClassifierCache } from '../../src/classifier/cache.js';
import type { ClassifierResult } from '../../src/classifier/types.js';

function res(over: Partial<ClassifierResult> = {}): ClassifierResult {
  return { score: 5, suggestedModel: 'sonnet', confidence: 0.7, source: 'heuristic', latencyMs: 1, ...over };
}

describe('createClassifierCache', () => {
  it('returns undefined on miss and the stored result on hit', () => {
    const cache = createClassifierCache();
    expect(cache.get('h1')).toBeUndefined();
    const r = res();
    cache.set('h1', r);
    expect(cache.get('h1')).toBe(r);
  });

  it('evicts the oldest entry once maxEntries is exceeded', () => {
    const cache = createClassifierCache({ maxEntries: 2 });
    cache.set('a', res());
    cache.set('b', res());
    cache.set('c', res());
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.size()).toBe(2);
  });

  it('overwriting an existing key does not trigger eviction', () => {
    const cache = createClassifierCache({ maxEntries: 2 });
    cache.set('a', res({ score: 1 }));
    cache.set('b', res({ score: 2 }));
    cache.set('a', res({ score: 9 }));
    expect(cache.get('a')?.score).toBe(9);
    expect(cache.get('b')).toBeDefined();
    expect(cache.size()).toBe(2);
  });
});
