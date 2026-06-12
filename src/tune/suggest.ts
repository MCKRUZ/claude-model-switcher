// Turn per-rule stats (from analyze.ts) into concrete tier proposals in the
// haiku < sonnet < opus ordering. Two directions:
//   - Escalate a "weak" rule: it fires enough and a majority of follow-ups
//     show retries or frustration → move one tier up (protect quality).
//   - De-escalate an "over-provisioned" rule: it fires enough, almost never
//     shows friction, and has positive evidence it went well → move one tier
//     down (recover cost). Deliberately conservative — a wrong downgrade hurts.

import { nextTier, tierOf, compareTiers } from '../sticky/tiers.js';
import type { Tier } from '../classifier/types.js';
import type { RuleStats } from './analyze.js';

export const MIN_FIRES = 20;
export const WEAK_THRESHOLD = 0.5;
// De-escalation is risk-asymmetric, so the bars are strict: friction must be
// near-zero and there must be positive (not merely absent) evidence of success.
export const DEESCALATE_MAX_BAD = 0.05;
export const DEESCALATE_MIN_CONTINUED = 0.5;

const TIER_ORDER: readonly Tier[] = ['haiku', 'sonnet', 'opus'];

function prevTier(tier: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? (TIER_ORDER[i - 1] ?? null) : null;
}

export interface Suggestion {
  readonly ruleId: string;
  readonly kind: 'escalate-target' | 'deescalate-target';
  readonly currentTier: Tier;
  readonly proposedTier: Tier;
  readonly rationale: string;
}

export function suggest(
  rules: ReadonlyMap<string, RuleStats>,
): readonly Suggestion[] {
  const out: Suggestion[] = [];
  for (const stats of rules.values()) {
    const s = suggestOne(stats);
    if (s !== null) out.push(s);
  }
  return out.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function suggestOne(stats: RuleStats): Suggestion | null {
  if (stats.fires < MIN_FIRES) return null;
  const currentModel = mostCommon(stats.chosenModels);
  if (currentModel === null) return null;
  let currentTier: Tier;
  try {
    currentTier = tierOf(currentModel, new Map());
  } catch {
    return null;
  }

  const badRatio = (stats.outcomeCounts.frustration_next_turn + stats.outcomeCounts.retried) / stats.fires;
  if (badRatio >= WEAK_THRESHOLD) return escalate(stats, currentTier);
  return deescalate(stats, currentTier, badRatio);
}

function escalate(stats: RuleStats, currentTier: Tier): Suggestion | null {
  const proposedTier = nextTier(currentTier, 1);
  if (compareTiers(proposedTier, currentTier) === 0) return null;
  const frustPct = ((stats.outcomeCounts.frustration_next_turn / stats.fires) * 100).toFixed(1);
  const avgCost = stats.costCount > 0 ? stats.costSum / stats.costCount : 0;
  return {
    ruleId: stats.ruleId,
    kind: 'escalate-target',
    currentTier,
    proposedTier,
    rationale: `fires=${stats.fires} frustration=${frustPct}% avg_cost=$${avgCost.toFixed(4)}`,
  };
}

function deescalate(stats: RuleStats, currentTier: Tier, badRatio: number): Suggestion | null {
  const proposedTier = prevTier(currentTier);
  if (proposedTier === null) return null;
  const continuedRatio = stats.outcomeCounts.continued / stats.fires;
  if (badRatio > DEESCALATE_MAX_BAD || continuedRatio < DEESCALATE_MIN_CONTINUED) return null;
  const contPct = (continuedRatio * 100).toFixed(1);
  const avgCost = stats.costCount > 0 ? stats.costSum / stats.costCount : 0;
  return {
    ruleId: stats.ruleId,
    kind: 'deescalate-target',
    currentTier,
    proposedTier,
    rationale: `fires=${stats.fires} continued=${contPct}% avg_cost=$${avgCost.toFixed(4)} — try a cheaper tier`,
  };
}

function mostCommon(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [key, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && key < best)) {
      best = key;
      bestCount = n;
    }
  }
  return best;
}
