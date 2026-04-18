// Rule DSL — types consumed by the evaluator and load-time validator.
// After load, `matches` leaves hold a compiled RegExp; authoring YAML uses string sources.

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type ModelChoice = Tier | { readonly modelId: string };

export type LeafOp =
  | { readonly lt: number }
  | { readonly lte: number }
  | { readonly gt: number }
  | { readonly gte: number }
  | { readonly eq: unknown }
  | { readonly ne: unknown }
  | { readonly in: readonly unknown[] }
  | { readonly matches: RegExp };

export type Leaf = boolean | LeafOp;
export type FieldCond = Readonly<Record<string, Leaf>>;

export type Condition =
  | FieldCond
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition };

export type RuleResult =
  | { readonly choice: ModelChoice; readonly allowDowngrade?: boolean }
  | { readonly escalate: number }
  | { readonly abstain: true };

export interface Rule {
  readonly id: string;
  readonly when: Condition;
  readonly then: RuleResult;
}

export type MatchedResult = Exclude<RuleResult, { readonly abstain: true }>;

export type PolicyResult =
  | { readonly kind: 'matched'; readonly ruleId: string; readonly result: MatchedResult }
  | { readonly kind: 'abstain' };
