import { describe, it, expect } from 'vitest';
import { matchLeaf } from '../../src/policy/predicates.js';
import type { Leaf } from '../../src/policy/dsl.js';

describe('predicates — numeric comparisons', () => {
  it('matchLeaf_lt_numericTrueAndFalse', () => {
    expect(matchLeaf({ lt: 5 } as Leaf, 3)).toBe(true);
    expect(matchLeaf({ lt: 5 } as Leaf, 5)).toBe(false);
    expect(matchLeaf({ lt: 5 } as Leaf, 6)).toBe(false);
  });

  it('matchLeaf_lte_numericBoundary', () => {
    expect(matchLeaf({ lte: 5 } as Leaf, 5)).toBe(true);
    expect(matchLeaf({ lte: 5 } as Leaf, 6)).toBe(false);
  });

  it('matchLeaf_gt_numericBoundary', () => {
    expect(matchLeaf({ gt: 5 } as Leaf, 6)).toBe(true);
    expect(matchLeaf({ gt: 5 } as Leaf, 5)).toBe(false);
  });

  it('matchLeaf_gte_numericBoundary', () => {
    expect(matchLeaf({ gte: 5 } as Leaf, 5)).toBe(true);
    expect(matchLeaf({ gte: 5 } as Leaf, 4)).toBe(false);
  });

  it('matchLeaf_numericOpsAgainstNonNumber_returnFalse', () => {
    expect(matchLeaf({ lt: 5 } as Leaf, 'three')).toBe(false);
    expect(matchLeaf({ gte: 0 } as Leaf, true)).toBe(false);
  });
});

describe('predicates — equality', () => {
  it('matchLeaf_eq_primitiveMatch', () => {
    expect(matchLeaf({ eq: 'opus' } as Leaf, 'opus')).toBe(true);
    expect(matchLeaf({ eq: 'opus' } as Leaf, 'sonnet')).toBe(false);
    expect(matchLeaf({ eq: 42 } as Leaf, 42)).toBe(true);
  });

  it('matchLeaf_ne_primitiveMismatch', () => {
    expect(matchLeaf({ ne: 'opus' } as Leaf, 'haiku')).toBe(true);
    expect(matchLeaf({ ne: 'opus' } as Leaf, 'opus')).toBe(false);
  });
});

describe('predicates — in', () => {
  it('matchLeaf_in_primitiveArray', () => {
    expect(matchLeaf({ in: ['haiku', 'sonnet'] } as Leaf, 'haiku')).toBe(true);
    expect(matchLeaf({ in: ['haiku', 'sonnet'] } as Leaf, 'opus')).toBe(false);
  });
});

describe('predicates — matches', () => {
  it('matchLeaf_matches_stringSignal', () => {
    const leaf: Leaf = { matches: /foo.+bar/ };
    expect(matchLeaf(leaf, 'foo-and-bar')).toBe(true);
    expect(matchLeaf(leaf, 'no match here')).toBe(false);
  });

  it('matchLeaf_matches_nonStringSignal_returnsFalse', () => {
    const leaf: Leaf = { matches: /./ };
    expect(matchLeaf(leaf, 123)).toBe(false);
    expect(matchLeaf(leaf, ['a'])).toBe(false);
  });
});

describe('predicates — boolean shorthand', () => {
  it('matchLeaf_booleanTrue_matchesOnlyTrue', () => {
    expect(matchLeaf(true as Leaf, true)).toBe(true);
    expect(matchLeaf(true as Leaf, false)).toBe(false);
    expect(matchLeaf(true as Leaf, 1)).toBe(false);
  });

  it('matchLeaf_booleanFalse_matchesOnlyFalse', () => {
    expect(matchLeaf(false as Leaf, false)).toBe(true);
    expect(matchLeaf(false as Leaf, true)).toBe(false);
    expect(matchLeaf(false as Leaf, 0)).toBe(false);
  });
});

describe('predicates — null signal', () => {
  it('matchLeaf_nullSignal_allOpsReturnFalse', () => {
    const ops: Leaf[] = [
      true,
      false,
      { lt: 5 },
      { lte: 5 },
      { gt: 5 },
      { gte: 5 },
      { eq: 'x' },
      { ne: 'x' },
      { in: ['x'] },
      { matches: /./ },
    ];
    for (const op of ops) {
      expect(matchLeaf(op, null)).toBe(false);
      expect(matchLeaf(op, undefined)).toBe(false);
    }
  });
});
