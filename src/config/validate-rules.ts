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
): { choice: string; rest: Obj } {
  const raw = v['then'];
  if (raw === undefined) {
    sink.err(`${path}/then`, 'required object');
    return { choice: '', rest: {} };
  }
  if (!isObj(raw)) {
    sink.err(`${path}/then`, 'must be an object');
    return { choice: '', rest: {} };
  }
  const choice = raw['choice'];
  if (typeof choice !== 'string' || choice.length === 0) {
    sink.err(`${path}/then/choice`, 'required non-empty string');
    return { choice: '', rest: raw };
  }
  return { choice, rest: raw };
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
  const { choice, rest } = readRuleThen(v, path, sink);
  const base: CcmuxRule = { id, when, then: { ...rest, choice } };
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
    if (rule.id.length === 0 || rule.then.choice.length === 0) {
      return;
    }
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
