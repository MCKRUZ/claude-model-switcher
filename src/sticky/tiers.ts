import type { Tier } from './types.js';

const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  haiku: 0,
  sonnet: 1,
  opus: 2,
});

// Iteration order is haiku → sonnet → opus. If a modelId string contains multiple
// family names (hypothetical compound names), the earliest match wins. Override
// map is the escape hatch for ambiguous cases.
const TIER_FAMILIES: readonly Tier[] = ['haiku', 'sonnet', 'opus'];

export function compareTiers(a: Tier, b: Tier): -1 | 0 | 1 {
  const delta = TIER_RANK[a] - TIER_RANK[b];
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

export function tierOf(modelId: string, overrides: ReadonlyMap<string, Tier>): Tier {
  const override = overrides.get(modelId);
  if (override !== undefined) return override;
  const lower = modelId.toLowerCase();
  for (const family of TIER_FAMILIES) {
    if (lower.includes(family)) return family;
  }
  throw new Error(
    `tierOf: cannot resolve tier for "${modelId}" — not a known Anthropic family and not in modelTiers override map`
  );
}

// Iterates tierMap in insertion order. Section-03 config loader MUST preserve
// YAML insertion order when constructing modelTiers so this selection is
// deterministic across restarts.
export function firstModelIdForTier(
  tier: Tier,
  tierMap: ReadonlyMap<string, Tier>
): string | undefined {
  for (const [modelId, t] of tierMap) {
    if (t === tier) return modelId;
  }
  return undefined;
}

export function nextTier(current: Tier, steps: number): Tier {
  const target = TIER_RANK[current] + steps;
  const clamped = Math.max(0, Math.min(TIER_RANK.opus, target));
  return TIER_FAMILIES[clamped]!;
}
