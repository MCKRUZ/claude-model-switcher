import type { ModelChoice, PolicyResult, MatchedResult } from '../policy/index.js';
import type { StickyStore } from './store.js';
import type { StickyDecision, StickyEntry, Tier } from './types.js';
import { compareTiers, firstModelIdForTier, nextTier, tierOf } from './tiers.js';

export interface ResolveInput {
  readonly sessionId: string;
  readonly policyResult: PolicyResult;
  readonly explicitModel: string | null;
  readonly defaultTier: Tier;
  readonly tierMap: ReadonlyMap<string, Tier>;
  readonly now: number;
}

// Explicit note: explicit wins over sticky even when it would downgrade. Explicit is the
// strongest client signal. A rule `{choice}` still beats explicit (rules are operator policy).
export function resolveStickyDecision(
  store: StickyStore,
  input: ResolveInput
): StickyDecision {
  // store.get triggers lazy TTL eviction — this is the one allowed mutation on the
  // abstain path. Spec's "abstain never mutates" rule means never call store.set or
  // store.touch on an abstain outcome; eviction-on-read is intentional.
  const existed = store.peek(input.sessionId);
  const current = existed === undefined ? undefined : store.get(input.sessionId, input.now);

  if (input.policyResult.kind === 'matched') {
    const result: MatchedResult = input.policyResult.result;
    if ('choice' in result) {
      return handleChoice(store, input, current, result);
    }
    return handleEscalate(store, input, current, result.escalate);
  }

  if (input.explicitModel !== null) {
    return handleExplicit(store, input, current, input.explicitModel);
  }

  if (current !== undefined) {
    store.touch(input.sessionId, input.now);
    return {
      kind: 'chosen',
      modelId: current.modelId,
      tier: current.tier,
      chosenBy: 'sticky',
    };
  }

  if (existed !== undefined) {
    return { kind: 'abstain', reason: 'ttl-expired' };
  }
  return { kind: 'abstain', reason: 'no-sticky' };
}

function handleChoice(
  store: StickyStore,
  input: ResolveInput,
  current: StickyEntry | undefined,
  rule: Extract<MatchedResult, { readonly choice: ModelChoice }>
): StickyDecision {
  const modelId = resolveChoiceModelId(rule.choice, input.tierMap);
  const tier = tierOf(modelId, input.tierMap);
  if (current !== undefined) {
    const cmp = compareTiers(tier, current.tier);
    if (cmp < 0 && rule.allowDowngrade !== true) {
      return { kind: 'abstain', reason: 'downgrade-blocked', sticky: current };
    }
  }
  writeSticky(store, input, tier, modelId, current);
  return { kind: 'chosen', modelId, tier, chosenBy: 'policy' };
}

function handleEscalate(
  store: StickyStore,
  input: ResolveInput,
  current: StickyEntry | undefined,
  steps: number
): StickyDecision {
  const fromTier = current?.tier ?? input.defaultTier;
  const targetTier = nextTier(fromTier, steps);
  const modelId = requireModelIdForTier(targetTier, input.tierMap);
  writeSticky(store, input, targetTier, modelId, current);
  return { kind: 'chosen', modelId, tier: targetTier, chosenBy: 'escalate' };
}

function handleExplicit(
  store: StickyStore,
  input: ResolveInput,
  current: StickyEntry | undefined,
  explicitModel: string
): StickyDecision {
  const tier = tierOf(explicitModel, input.tierMap);
  writeSticky(store, input, tier, explicitModel, current);
  return { kind: 'chosen', modelId: explicitModel, tier, chosenBy: 'explicit' };
}

// turnCount increments on every chosen outcome (policy / explicit / escalate) AND on
// every sticky-hit touch. It does NOT increment on abstain outcomes. Semantically:
// "number of times this session produced a chosen routing decision."
function writeSticky(
  store: StickyStore,
  input: ResolveInput,
  tier: Tier,
  modelId: string,
  prior: StickyEntry | undefined
): void {
  const createdAt = prior?.createdAt ?? input.now;
  const turnCount = (prior?.turnCount ?? 0) + 1;
  store.set({
    sessionId: input.sessionId,
    tier,
    modelId,
    createdAt,
    lastSeenAt: input.now,
    turnCount,
  });
}

function resolveChoiceModelId(
  choice: ModelChoice,
  tierMap: ReadonlyMap<string, Tier>
): string {
  if (typeof choice === 'string') {
    // Tier shorthand: look up first modelId for that tier in config.modelTiers.
    const found = firstModelIdForTier(choice, tierMap);
    if (found === undefined) {
      throw new Error(
        `resolveChoiceModelId: config.modelTiers has no modelId for tier "${choice}" ` +
        `— configure at least one model per tier used by rules`
      );
    }
    return found;
  }
  return choice.modelId;
}

function requireModelIdForTier(
  tier: Tier,
  tierMap: ReadonlyMap<string, Tier>
): string {
  const found = firstModelIdForTier(tier, tierMap);
  if (found === undefined) {
    throw new Error(
      `resolveStickyDecision: escalation needs a modelId for tier "${tier}" but ` +
      `config.modelTiers has none — add a concrete model for each tier used`
    );
  }
  return found;
}
