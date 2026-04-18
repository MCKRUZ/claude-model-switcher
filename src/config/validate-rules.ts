// Rule-shape validation at load time. Full rule-DSL semantics live in section-08-policy.

import type { CcmuxRule, ConfigError } from './schema.js';

type Obj = Record<string, unknown>;

interface ErrorSink {
  err(path: string, message: string): void;
  warn(path: string, message: string): void;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function warnUnknownKeys(
  v: Obj,
  known: readonly string[],
  base: string,
  sink: ErrorSink,
): void {
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) {
      sink.warn(`${base}/${k}`, 'unknown key (forward-compat)');
    }
  }
}

function readRuleThen(
  v: Obj,
  path: string,
  sink: ErrorSink,
): { then: Obj; valid: boolean } {
  const raw = v['then'];
  if (raw === undefined) {
    sink.err(`${path}/then`, 'required object');
    return { then: {}, valid: false };
  }
  if (!isObj(raw)) {
    sink.err(`${path}/then`, 'must be an object');
    return { then: {}, valid: false };
  }
  if ('choice' in raw) {
    const choice = raw['choice'];
    const okChoice =
      (typeof choice === 'string' && choice.length > 0) ||
      (isObj(choice) && typeof choice['modelId'] === 'string');
    if (!okChoice) {
      sink.err(`${path}/then/choice`, 'must be a tier string or { modelId }');
      return { then: raw, valid: false };
    }
    return { then: raw, valid: true };
  }
  if ('escalate' in raw) {
    const n = raw['escalate'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      sink.err(`${path}/then/escalate`, 'must be a positive integer');
      return { then: raw, valid: false };
    }
    return { then: raw, valid: true };
  }
  if ('abstain' in raw) {
    if (raw['abstain'] !== true) {
      sink.err(`${path}/then/abstain`, 'must be literal true');
      return { then: raw, valid: false };
    }
    return { then: raw, valid: true };
  }
  sink.err(`${path}/then/choice`, 'required non-empty string');
  return { then: raw, valid: false };
}

function readRuleWhen(v: Obj, path: string, sink: ErrorSink): Obj {
  const raw = v['when'];
  if (raw === undefined) {
    sink.err(`${path}/when`, 'required object');
    return {};
  }
  if (!isObj(raw)) {
    sink.err(`${path}/when`, 'must be an object');
    return {};
  }
  return raw;
}

function readRuleId(v: Obj, path: string, sink: ErrorSink): string {
  const raw = v['id'];
  if (typeof raw !== 'string' || raw.length === 0) {
    sink.err(`${path}/id`, 'required non-empty string');
    return '';
  }
  return raw;
}

export function validateRule(
  v: unknown,
  path: string,
  sink: ErrorSink,
): CcmuxRule | null {
  if (!isObj(v)) {
    sink.err(path, 'rule must be an object');
    return null;
  }
  warnUnknownKeys(v, ['id', 'when', 'then', 'allowDowngrade'], path, sink);
  const id = readRuleId(v, path, sink);
  const when = readRuleWhen(v, path, sink);
  const { then, valid } = readRuleThen(v, path, sink);
  if (!valid || id.length === 0) return null;
  const base: CcmuxRule = { id, when, then };
  if (typeof v['allowDowngrade'] === 'boolean') {
    return { ...base, allowDowngrade: v['allowDowngrade'] };
  }
  return base;
}

export function validateRules(
  v: unknown,
  path: string,
  sink: ErrorSink,
): readonly CcmuxRule[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    sink.err(path, 'must be an array');
    return [];
  }
  const seen = new Set<string>();
  const out: CcmuxRule[] = [];
  v.forEach((item, i) => {
    const rule = validateRule(item, `${path}/${i}`, sink);
    if (!rule) return;
    if (seen.has(rule.id)) {
      sink.err(`${path}/${i}/id`, `duplicate rule id "${rule.id}"`);
      return;
    }
    seen.add(rule.id);
    out.push(rule);
  });
  return out;
}

export type { ConfigError };
