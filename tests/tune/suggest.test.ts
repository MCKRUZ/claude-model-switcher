import { describe, it, expect } from 'vitest';
import { suggest, MIN_FIRES, WEAK_THRESHOLD } from '../../src/tune/suggest.js';
import type { RuleStats } from '../../src/tune/analyze.js';

function mkStats(over: Partial<RuleStats> & { ruleId: string }): RuleStats {
  return {
    fires: 0,
    outcomeCounts: {
      continued: 0,
      retried: 0,
      frustration_next_turn: 0,
      abandoned: 0,
      unknown: 0,
    },
    costSum: 0,
    costCount: 0,
    latencySum: 0,
    latencyCount: 0,
    chosenModels: new Map(),
    ...over,
  };
}

describe('suggest', () => {
  it('flags a weak rule with proposed tier one above current', () => {
    const stats = mkStats({
      ruleId: 'R',
      fires: 100,
      outcomeCounts: { continued: 20, retried: 10, frustration_next_turn: 70, abandoned: 0, unknown: 0 },
      chosenModels: new Map([['claude-haiku-4-5-20251001', 100]]),
    });
    const out = suggest(new Map([['R', stats]]));
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.ruleId).toBe('R');
    expect(s.kind).toBe('escalate-target');
    expect(s.currentTier).toBe('haiku');
    expect(s.proposedTier).toBe('sonnet');
  });

  it('does not flag rules below MIN_FIRES', () => {
    const stats = mkStats({
      ruleId: 'R',
      fires: 5,
      outcomeCounts: { continued: 0, retried: 0, frustration_next_turn: 5, abandoned: 0, unknown: 0 },
      chosenModels: new Map([['claude-haiku-4-5-20251001', 5]]),
    });
    expect(MIN_FIRES).toBeGreaterThan(5);
    const out = suggest(new Map([['R', stats]]));
    expect(out).toHaveLength(0);
  });

  it('respects WEAK_THRESHOLD', () => {
    expect(WEAK_THRESHOLD).toBeGreaterThan(0);
    const stats = mkStats({
      ruleId: 'R',
      fires: MIN_FIRES + 10,
      outcomeCounts: {
        continued: MIN_FIRES + 10,
        retried: 0,
        frustration_next_turn: 0,
        abandoned: 0,
        unknown: 0,
      },
      chosenModels: new Map([['claude-haiku-4-5-20251001', MIN_FIRES + 10]]),
    });
    const out = suggest(new Map([['R', stats]]));
    expect(out).toHaveLength(0);
  });

  it('does not propose beyond opus', () => {
    const stats = mkStats({
      ruleId: 'opus-rule',
      fires: 100,
      outcomeCounts: { continued: 10, retried: 10, frustration_next_turn: 80, abandoned: 0, unknown: 0 },
      chosenModels: new Map([['claude-opus-4-7', 100]]),
    });
    const out = suggest(new Map([['opus-rule', stats]]));
    // No escalation available above opus, so no suggestion.
    expect(out).toHaveLength(0);
  });

  it('de-escalates an over-provisioned rule with consistently good outcomes', () => {
    const stats = mkStats({
      ruleId: 'sonnet-rule',
      fires: 100,
      outcomeCounts: { continued: 95, retried: 1, frustration_next_turn: 1, abandoned: 0, unknown: 3 },
      chosenModels: new Map([['claude-sonnet-4-6', 100]]),
    });
    const out = suggest(new Map([['sonnet-rule', stats]]));
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.kind).toBe('deescalate-target');
    expect(s.currentTier).toBe('sonnet');
    expect(s.proposedTier).toBe('haiku');
  });

  it('does not de-escalate when there is any meaningful friction', () => {
    const stats = mkStats({
      ruleId: 'sonnet-rule',
      fires: 100,
      // 10% friction — above the conservative de-escalation ceiling.
      outcomeCounts: { continued: 85, retried: 5, frustration_next_turn: 5, abandoned: 0, unknown: 5 },
      chosenModels: new Map([['claude-sonnet-4-6', 100]]),
    });
    expect(suggest(new Map([['sonnet-rule', stats]]))).toHaveLength(0);
  });

  it('does not de-escalate without positive outcome evidence (mostly unknown)', () => {
    const stats = mkStats({
      ruleId: 'sonnet-rule',
      fires: 100,
      // Low friction but no evidence it went well — almost all untagged.
      outcomeCounts: { continued: 5, retried: 0, frustration_next_turn: 0, abandoned: 0, unknown: 95 },
      chosenModels: new Map([['claude-sonnet-4-6', 100]]),
    });
    expect(suggest(new Map([['sonnet-rule', stats]]))).toHaveLength(0);
  });

  it('does not de-escalate a haiku rule (already the floor)', () => {
    const stats = mkStats({
      ruleId: 'haiku-rule',
      fires: 100,
      outcomeCounts: { continued: 98, retried: 1, frustration_next_turn: 1, abandoned: 0, unknown: 0 },
      chosenModels: new Map([['claude-haiku-4-5-20251001', 100]]),
    });
    expect(suggest(new Map([['haiku-rule', stats]]))).toHaveLength(0);
  });
});
