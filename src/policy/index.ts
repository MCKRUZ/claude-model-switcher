// Barrel exports for the policy engine.

export type {
  Condition,
  FieldCond,
  Leaf,
  LeafOp,
  MatchedResult,
  ModelChoice,
  PolicyResult,
  Rule,
  RuleResult,
  Tier,
} from './dsl.js';
export { evaluate } from './evaluate.js';
export { matchLeaf } from './predicates.js';
export { loadRules, type LoadOptions, type ValidationError } from './load.js';
export { KNOWN_SIGNALS, isKnownSignal, type KnownSignal } from './signals-schema.js';
