import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/policy/evaluate.js';
import type { Rule } from '../../src/policy/dsl.js';
import { makeSignals } from './helpers.js';

describe('evaluate — first-match-wins', () => {
  it('evaluate_twoTruthyRules_onlyFirstWins', () => {
    const rules: readonly Rule[] = [
      { id: 'first', when: { planMode: true }, then: { choice: 'opus' } },
      { id: 'second', when: { planMode: true }, then: { choice: 'haiku' } },
    ];
    const r = evaluate(rules, makeSignals({ planMode: true }));
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') {
      expect(r.ruleId).toBe('first');
      expect(r.result).toEqual({ choice: 'opus' });
    }
  });
});

describe('evaluate — abstain fall-through', () => {
  it('evaluate_abstainRule_fallsThroughToNextMatch', () => {
    const rules: readonly Rule[] = [
      { id: 'a', when: { planMode: true }, then: { abstain: true } },
      { id: 'b', when: { planMode: true }, then: { choice: 'haiku' } },
    ];
    const r = evaluate(rules, makeSignals({ planMode: true }));
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') expect(r.ruleId).toBe('b');
  });

  it('evaluate_onlyAbstainRules_resultIsAbstain', () => {
    const rules: readonly Rule[] = [
      { id: 'a', when: { planMode: true }, then: { abstain: true } },
    ];
    const r = evaluate(rules, makeSignals({ planMode: true }));
    expect(r.kind).toBe('abstain');
  });
});

describe('evaluate — no match', () => {
  it('evaluate_noRuleMatches_abstain', () => {
    const rules: readonly Rule[] = [
      { id: 'a', when: { planMode: true }, then: { choice: 'opus' } },
    ];
    const r = evaluate(rules, makeSignals({ planMode: false }));
    expect(r.kind).toBe('abstain');
  });

  it('evaluate_emptyRuleList_abstain', () => {
    const r = evaluate([], makeSignals({}));
    expect(r.kind).toBe('abstain');
  });
});

describe('evaluate — escalate passthrough', () => {
  it('evaluate_escalateRule_returnsEscalateRaw', () => {
    const rules: readonly Rule[] = [
      { id: 'bump', when: { frustration: true }, then: { escalate: 1 } },
    ];
    const r = evaluate(rules, makeSignals({ frustration: true }));
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') {
      expect(r.result).toEqual({ escalate: 1 });
      expect(r.ruleId).toBe('bump');
    }
  });
});

describe('evaluate — null signals do not fire', () => {
  it('evaluate_nullSignal_ruleReferencingItDoesNotFire', () => {
    const rules: readonly Rule[] = [
      { id: 'plan', when: { planMode: true }, then: { choice: 'opus' } },
    ];
    const r = evaluate(rules, makeSignals({ planMode: null }));
    expect(r.kind).toBe('abstain');
  });

  it('evaluate_nullPoisonInAll_treatedAsFalse', () => {
    const rules: readonly Rule[] = [
      {
        id: 'combo',
        when: { all: [{ planMode: true }, { messageCount: { lt: 5 } }] },
        then: { choice: 'haiku' },
      },
    ];
    const r = evaluate(rules, makeSignals({ planMode: null, messageCount: 2 }));
    expect(r.kind).toBe('abstain');
  });
});

describe('evaluate — result immutability', () => {
  it('evaluate_result_isFrozen', () => {
    const rules: readonly Rule[] = [
      { id: 'r', when: { all: [] }, then: { choice: 'opus' } },
    ];
    const r = evaluate(rules, makeSignals({}));
    expect(Object.isFrozen(r)).toBe(true);
  });
});
