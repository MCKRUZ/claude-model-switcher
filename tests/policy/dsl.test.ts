import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/policy/evaluate.js';
import type { Rule } from '../../src/policy/dsl.js';
import { makeSignals } from './helpers.js';

function matches(rule: Rule, signals: ReturnType<typeof makeSignals>): boolean {
  const result = evaluate([rule], signals);
  return result.kind === 'matched';
}

describe('dsl — all / any / not composition', () => {
  it('dsl_all_shortCircuitsOnFirstFalse', () => {
    const rule: Rule = {
      id: 'r',
      when: { all: [{ planMode: true }, { messageCount: { lt: 3 } }] },
      then: { choice: 'haiku' },
    };
    expect(matches(rule, makeSignals({ planMode: true, messageCount: 2 }))).toBe(true);
    expect(matches(rule, makeSignals({ planMode: true, messageCount: 5 }))).toBe(false);
    expect(matches(rule, makeSignals({ planMode: false, messageCount: 2 }))).toBe(false);
  });

  it('dsl_any_shortCircuitsOnFirstTrue', () => {
    const rule: Rule = {
      id: 'r',
      when: { any: [{ planMode: true }, { messageCount: { gt: 10 } }] },
      then: { choice: 'opus' },
    };
    expect(matches(rule, makeSignals({ planMode: true, messageCount: 0 }))).toBe(true);
    expect(matches(rule, makeSignals({ planMode: false, messageCount: 11 }))).toBe(true);
    expect(matches(rule, makeSignals({ planMode: false, messageCount: 5 }))).toBe(false);
  });

  it('dsl_not_invertsTruthValue', () => {
    const rule: Rule = {
      id: 'r',
      when: { not: { planMode: true } },
      then: { choice: 'sonnet' },
    };
    expect(matches(rule, makeSignals({ planMode: false }))).toBe(true);
    expect(matches(rule, makeSignals({ planMode: true }))).toBe(false);
  });

  it('dsl_notOfNullLeaf_returnsFalse', () => {
    const rule: Rule = {
      id: 'r',
      when: { not: { planMode: true } },
      then: { choice: 'sonnet' },
    };
    expect(matches(rule, makeSignals({ planMode: null }))).toBe(false);
  });

  it('dsl_deeplyNested_composition', () => {
    const rule: Rule = {
      id: 'r',
      when: {
        all: [
          { any: [{ planMode: true }, { frustration: true }] },
          { not: { retryCount: { gte: 5 } } },
        ],
      },
      then: { choice: 'opus' },
    };
    expect(matches(rule, makeSignals({ planMode: true, retryCount: 2 }))).toBe(true);
    expect(matches(rule, makeSignals({ frustration: true, retryCount: 2 }))).toBe(true);
    expect(matches(rule, makeSignals({ planMode: false, retryCount: 6 }))).toBe(false);
    expect(matches(rule, makeSignals({ planMode: false, frustration: false }))).toBe(false);
  });

  it('dsl_emptyAll_matchesEverything', () => {
    const rule: Rule = { id: 'r', when: { all: [] }, then: { choice: 'opus' } };
    expect(matches(rule, makeSignals({}))).toBe(true);
  });

  it('dsl_emptyAny_matchesNothing', () => {
    const rule: Rule = { id: 'r', when: { any: [] }, then: { choice: 'opus' } };
    expect(matches(rule, makeSignals({}))).toBe(false);
  });
});
