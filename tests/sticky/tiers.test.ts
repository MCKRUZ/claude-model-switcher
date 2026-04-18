import { describe, it, expect } from 'vitest';
import { compareTiers, tierOf, firstModelIdForTier } from '../../src/sticky/tiers.js';
import type { Tier } from '../../src/sticky/types.js';

describe('compareTiers', () => {
  it('returns -1 / 0 / 1 for all 9 ordered pairs', () => {
    const tiers: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
    for (let i = 0; i < tiers.length; i++) {
      for (let j = 0; j < tiers.length; j++) {
        const a = tiers[i]!;
        const b = tiers[j]!;
        const got = compareTiers(a, b);
        const expected = i < j ? -1 : i > j ? 1 : 0;
        expect(got).toBe(expected);
      }
    }
  });
});

describe('tierOf', () => {
  const emptyMap: ReadonlyMap<string, Tier> = new Map();

  it('resolves claude-haiku-* to haiku via family-name substring', () => {
    expect(tierOf('claude-haiku-4-5-20251001', emptyMap)).toBe('haiku');
  });

  it('resolves claude-sonnet-* to sonnet', () => {
    expect(tierOf('claude-sonnet-4-5', emptyMap)).toBe('sonnet');
  });

  it('resolves claude-opus-* to opus', () => {
    expect(tierOf('claude-opus-4-7', emptyMap)).toBe('opus');
  });

  it('throws on unmapped unknown family (no override)', () => {
    expect(() => tierOf('some-custom-fine-tune', emptyMap)).toThrow();
  });

  it('resolves unknown family via config override map', () => {
    const overrides = new Map<string, Tier>([['some-custom-fine-tune', 'sonnet']]);
    expect(tierOf('some-custom-fine-tune', overrides)).toBe('sonnet');
  });

  it('override map takes precedence over family substring', () => {
    const overrides = new Map<string, Tier>([['claude-haiku-magic', 'opus']]);
    expect(tierOf('claude-haiku-magic', overrides)).toBe('opus');
  });
});

describe('firstModelIdForTier', () => {
  it('returns the first modelId whose tier matches by insertion order', () => {
    const tierMap = new Map<string, Tier>([
      ['claude-haiku-4-5-20251001', 'haiku'],
      ['claude-haiku-older', 'haiku'],
      ['claude-sonnet-4-5', 'sonnet'],
      ['claude-opus-4-7', 'opus'],
    ]);
    expect(firstModelIdForTier('haiku', tierMap)).toBe('claude-haiku-4-5-20251001');
    expect(firstModelIdForTier('sonnet', tierMap)).toBe('claude-sonnet-4-5');
    expect(firstModelIdForTier('opus', tierMap)).toBe('claude-opus-4-7');
  });

  it('returns undefined if no modelId has the requested tier', () => {
    const tierMap = new Map<string, Tier>([['claude-haiku-4-5-20251001', 'haiku']]);
    expect(firstModelIdForTier('opus', tierMap)).toBeUndefined();
  });
});
