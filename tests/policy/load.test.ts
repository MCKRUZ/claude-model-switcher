import { describe, it, expect } from 'vitest';
import { loadRules } from '../../src/policy/load.js';

const EMPTY_TIERS = Object.freeze({});
const OPTS = { modelTiers: EMPTY_TIERS };

describe('loadRules — valid shapes', () => {
  it('loadRules_minimalChoice_returnsOk', () => {
    const r = loadRules(
      [{ id: 'r1', when: { planMode: true }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.id).toBe('r1');
    }
  });

  it('loadRules_escalateRule_returnsOk', () => {
    const r = loadRules(
      [{ id: 'e', when: { frustration: true }, then: { escalate: 1 } }],
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.then).toEqual({ escalate: 1 });
  });

  it('loadRules_abstainRule_returnsOk', () => {
    const r = loadRules(
      [{ id: 'a', when: { planMode: true }, then: { abstain: true } }],
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]?.then).toEqual({ abstain: true });
  });

  it('loadRules_allAnyNotComposition_returnsOk', () => {
    const r = loadRules(
      [
        {
          id: 'c',
          when: { all: [{ any: [{ planMode: true }] }, { not: { frustration: true } }] },
          then: { choice: 'sonnet' },
        },
      ],
      OPTS,
    );
    expect(r.ok).toBe(true);
  });

  it('loadRules_undefinedInput_returnsEmpty', () => {
    const r = loadRules(undefined, OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});

describe('loadRules — validation errors', () => {
  it('loadRules_duplicateId_errorsAtSecondOccurrence', () => {
    const r = loadRules(
      [
        { id: 'same', when: { planMode: true }, then: { choice: 'opus' } },
        { id: 'same', when: { planMode: false }, then: { choice: 'haiku' } },
      ],
      OPTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dup = r.error.find((e) => e.path === '/rules/1/id');
      expect(dup).toBeDefined();
      expect(dup?.message).toMatch(/duplicate/);
    }
  });

  it('loadRules_unknownSignalName_errors', () => {
    const r = loadRules(
      [{ id: 'x', when: { notARealSignal: true }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.error.find((e) => e.path.includes('notARealSignal'));
      expect(err).toBeDefined();
    }
  });

  it('loadRules_wrongLeafValueType_errors', () => {
    const r = loadRules(
      [{ id: 'x', when: { messageCount: { lt: 'not-a-number' } }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
  });

  it('loadRules_unparseableMatchesRegex_errors', () => {
    const r = loadRules(
      [{ id: 'x', when: { explicitModel: { matches: '(((' } }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
  });

  it('loadRules_modelIdWithNoTier_errors', () => {
    const r = loadRules(
      [{ id: 'x', when: { planMode: true }, then: { choice: { modelId: 'custom-x' } } }],
      { modelTiers: {} },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.error.find((e) => e.message.toLowerCase().includes('modeltiers'));
      expect(err).toBeDefined();
    }
  });

  it('loadRules_modelIdPresentInTiers_returnsOk', () => {
    const r = loadRules(
      [{ id: 'x', when: { planMode: true }, then: { choice: { modelId: 'custom-x' } } }],
      { modelTiers: { 'custom-x': 'opus' } },
    );
    expect(r.ok).toBe(true);
  });

  it('loadRules_unknownKeyInsideRule_errors', () => {
    const r = loadRules(
      [
        {
          id: 'x',
          when: { planMode: true },
          then: { choice: 'opus' },
          somethingElse: 42,
        },
      ],
      OPTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.error.find((e) => e.path.includes('somethingElse'));
      expect(err).toBeDefined();
    }
  });

  it('loadRules_escalateNonPositive_errors', () => {
    const r = loadRules(
      [{ id: 'e', when: { planMode: true }, then: { escalate: 0 } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
    const r2 = loadRules(
      [{ id: 'e', when: { planMode: true }, then: { escalate: 1.5 } }],
      OPTS,
    );
    expect(r2.ok).toBe(false);
  });

  it('loadRules_unknownConditionKey_errors', () => {
    const r = loadRules(
      [{ id: 'x', when: { weird: { lt: 1 }, planMode: true }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
  });

  it('loadRules_missingId_errors', () => {
    const r = loadRules(
      [{ when: { planMode: true }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(false);
  });
});

describe('loadRules — matches regex compilation', () => {
  it('loadRules_matchesRegex_compiledOnceAtLoad', () => {
    const r = loadRules(
      [{ id: 'r', when: { explicitModel: { matches: '^claude-' } }, then: { choice: 'opus' } }],
      OPTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const when = r.value[0]?.when as Record<string, unknown>;
      const leaf = when['explicitModel'] as { matches: RegExp };
      expect(leaf.matches).toBeInstanceOf(RegExp);
      expect(leaf.matches.source).toBe('^claude-');
    }
  });
});
