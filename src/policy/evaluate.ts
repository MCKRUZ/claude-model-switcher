// Pure rule evaluator. First-match-wins; `abstain` falls through.

import type { Signals } from '../signals/types.js';
import type { Condition, FieldCond, Leaf, PolicyResult, Rule } from './dsl.js';
import { matchLeaf } from './predicates.js';

type Tri = 'true' | 'false' | 'null';

const ABSTAIN_RESULT: PolicyResult = Object.freeze({ kind: 'abstain' });

export function evaluate(rules: readonly Rule[], signals: Signals): PolicyResult {
  for (const rule of rules) {
    if (evalCondition(rule.when, signals) !== 'true') continue;
    if ('abstain' in rule.then) continue;
    return Object.freeze({ kind: 'matched', ruleId: rule.id, result: rule.then });
  }
  return ABSTAIN_RESULT;
}

function evalCondition(cond: Condition, signals: Signals): Tri {
  const anyCond = cond as { readonly all?: unknown; readonly any?: unknown; readonly not?: Condition };
  const isComposite =
    anyCond.all !== undefined || anyCond.any !== undefined || anyCond.not !== undefined;
  if (isComposite) {
    const keyCount = Object.keys(cond).length;
    if (keyCount !== 1) {
      throw new Error('composite condition must have exactly one of all|any|not');
    }
    if (Array.isArray(anyCond.all)) return evalAll(anyCond.all as readonly Condition[], signals);
    if (Array.isArray(anyCond.any)) return evalAny(anyCond.any as readonly Condition[], signals);
    return evalNot(anyCond.not as Condition, signals);
  }
  return evalFieldCond(cond as FieldCond, signals);
}

function evalAll(children: readonly Condition[], signals: Signals): Tri {
  for (const c of children) {
    const r = evalCondition(c, signals);
    if (r !== 'true') return 'false';
  }
  return 'true';
}

function evalAny(children: readonly Condition[], signals: Signals): Tri {
  for (const c of children) {
    if (evalCondition(c, signals) === 'true') return 'true';
  }
  return 'false';
}

function evalNot(inner: Condition, signals: Signals): Tri {
  const r = evalCondition(inner, signals);
  return r === 'false' ? 'true' : 'false';
}

function evalFieldCond(fc: FieldCond, signals: Signals): Tri {
  const rec = signals as unknown as Record<string, unknown>;
  let anyNull = false;
  for (const [key, leaf] of Object.entries(fc)) {
    const value = rec[key];
    if (value === null || value === undefined) {
      anyNull = true;
      continue;
    }
    if (!matchLeaf(leaf as Leaf, value)) return 'false';
  }
  return anyNull ? 'null' : 'true';
}
