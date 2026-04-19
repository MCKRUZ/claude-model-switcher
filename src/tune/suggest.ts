// Turn per-rule stats (from analyze.ts) into concrete escalation proposals.
// Heuristic: a rule is "weak" if it fires enough and a majority of its
// follow-ups show retries or frustration. The proposal is to move the rule's
// target one tier up in the haiku < sonnet < opus ordering.

import { nextTier, tierOf, compareTiers } from '../sticky/tiers.js';
import type { Tier } from '../classifier/types.js';
import type { RuleStats } from './analyze.js';

export const MIN_FIRES = 20;
export const WEAK_THRESHOLD = 0.5;

export interface Suggestion {
  readonly ruleId: string;
  readonly kind: 'escalate-target';
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
  const bad = stats.outcomeCounts.frustration_next_turn + stats.outcomeCounts.retried;
  if (bad / stats.fires < WEAK_THRESHOLD) return null;
  const currentModel = mostCommon(stats.chosenModels);
  if (currentModel === null) return null;
  let currentTier: Tier;
  try {
    currentTier = tierOf(currentModel, new Map());
  } catch {
    return null;
  }
  const proposedTier = nextTier(currentTier, 1);
  if (compareTiers(proposedTier, currentTier) === 0) return null;
  const frustPct = ((stats.outcomeCounts.frustration_next_turn / stats.fires) * 100).toFixed(1);
  const avgCost = stats.costCount > 0 ? stats.costSum / stats.costCount : 0;
  const rationale = `fires=${stats.fires} frustration=${frustPct}% avg_cost=$${avgCost.toFixed(4)}`;
  return {
    ruleId: stats.ruleId,
    kind: 'escalate-target',
    currentTier,
    proposedTier,
    rationale,
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
