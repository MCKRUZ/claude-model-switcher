// Strict rule-DSL loader. Validates shape, compiles regex, and enforces the
// signal allow-list and known modelIds. Returns Result<readonly Rule[], errors>.

import { fail, ok, type Result } from '../types/result.js';
import type {
  Condition,
  FieldCond,
  Leaf,
  LeafOp,
  ModelChoice,
  Rule,
  RuleResult,
  Tier,
} from './dsl.js';
import { isKnownSignal } from './signals-schema.js';

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface LoadOptions {
  readonly modelTiers: Readonly<Record<string, Tier>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const RULE_KEYS = ['id', 'when', 'then'] as const;
const CHOICE_TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
const NUMERIC_OPS = ['lt', 'lte', 'gt', 'gte'] as const;
const EQUALITY_OPS = ['eq', 'ne'] as const;

class Sink {
  readonly errors: ValidationError[] = [];
  err(path: string, message: string): void {
    this.errors.push({ path, message });
  }
}

export function loadRules(
  raw: unknown,
  opts: LoadOptions,
): Result<readonly Rule[], readonly ValidationError[]> {
  const sink = new Sink();
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) {
    sink.err('/rules', 'must be an array');
    return fail(sink.errors);
  }
  const seen = new Set<string>();
  const out: Rule[] = [];
  raw.forEach((item, i) => {
    const rule = parseRule(item, `/rules/${i}`, opts, sink, seen);
    if (rule) out.push(rule);
  });
  return sink.errors.length > 0 ? fail(sink.errors) : ok(out);
}

function parseRule(
  item: unknown,
  path: string,
  opts: LoadOptions,
  sink: Sink,
  seen: Set<string>,
): Rule | null {
  if (!isObj(item)) {
    sink.err(path, 'rule must be an object');
    return null;
  }
  for (const key of Object.keys(item)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) {
      sink.err(`${path}/${key}`, 'unknown key');
    }
  }
  const id = parseId(item['id'], path, sink);
  const when = parseCondition(item['when'], `${path}/when`, sink);
  const then = parseThen(item['then'], `${path}/then`, opts, sink);
  if (id === null || when === null || then === null) return null;
  if (seen.has(id)) {
    sink.err(`${path}/id`, `duplicate rule id "${id}"`);
    return null;
  }
  seen.add(id);
  return { id, when, then };
}

function parseId(raw: unknown, path: string, sink: Sink): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    sink.err(`${path}/id`, 'required non-empty string');
    return null;
  }
  return raw;
}

function parseCondition(raw: unknown, path: string, sink: Sink): Condition | null {
  if (!isObj(raw)) {
    sink.err(path, 'condition must be an object');
    return null;
  }
  if ('all' in raw || 'any' in raw || 'not' in raw) {
    return parseComposite(raw, path, sink);
  }
  return parseFieldCond(raw, path, sink);
}

function parseComposite(raw: Obj, path: string, sink: Sink): Condition | null {
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    sink.err(path, 'composite must have exactly one of all|any|not');
    return null;
  }
  const key = keys[0]!;
  if (key === 'all' || key === 'any') {
    const arr = raw[key];
    if (!Array.isArray(arr)) {
      sink.err(`${path}/${key}`, 'must be an array');
      return null;
    }
    const children: Condition[] = [];
    arr.forEach((child, i) => {
      const c = parseCondition(child, `${path}/${key}/${i}`, sink);
      if (c) children.push(c);
    });
    return key === 'all' ? { all: children } : { any: children };
  }
  if (key === 'not') {
    const inner = parseCondition(raw['not'], `${path}/not`, sink);
    if (!inner) return null;
    return { not: inner };
  }
  sink.err(`${path}/${key}`, 'unknown composite key');
  return null;
}

function parseFieldCond(raw: Obj, path: string, sink: Sink): FieldCond | null {
  const out: Record<string, Leaf> = {};
  let anyBad = false;
  for (const [name, leafRaw] of Object.entries(raw)) {
    if (!isKnownSignal(name)) {
      sink.err(`${path}/${name}`, `unknown signal "${name}"`);
      anyBad = true;
      continue;
    }
    const leaf = parseLeaf(leafRaw, `${path}/${name}`, sink);
    if (leaf === null) {
      anyBad = true;
      continue;
    }
    out[name] = leaf;
  }
  return anyBad ? null : out;
}

function parseLeaf(raw: unknown, path: string, sink: Sink): Leaf | null {
  if (typeof raw === 'boolean') return raw;
  if (!isObj(raw)) {
    sink.err(path, 'leaf must be a boolean or operator object');
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    sink.err(path, 'leaf operator must have exactly one key');
    return null;
  }
  const op = keys[0]!;
  const value = raw[op];
  return parseLeafOp(op, value, path, sink);
}

function parseLeafOp(op: string, value: unknown, path: string, sink: Sink): LeafOp | null {
  if ((NUMERIC_OPS as readonly string[]).includes(op)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      sink.err(`${path}/${op}`, 'must be a finite number');
      return null;
    }
    return { [op]: value } as LeafOp;
  }
  if ((EQUALITY_OPS as readonly string[]).includes(op)) {
    return { [op]: value } as LeafOp;
  }
  if (op === 'in') {
    if (!Array.isArray(value)) {
      sink.err(`${path}/in`, 'must be an array');
      return null;
    }
    return { in: value };
  }
  if (op === 'matches') {
    if (typeof value !== 'string') {
      sink.err(`${path}/matches`, 'must be a string regex source');
      return null;
    }
    try {
      return { matches: new RegExp(value) };
    } catch {
      sink.err(`${path}/matches`, `unparseable regex "${value}"`);
      return null;
    }
  }
  sink.err(`${path}/${op}`, `unknown leaf operator "${op}"`);
  return null;
}

function parseThen(
  raw: unknown,
  path: string,
  opts: LoadOptions,
  sink: Sink,
): RuleResult | null {
  if (!isObj(raw)) {
    sink.err(path, 'then must be an object');
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.includes('choice')) return parseChoiceThen(raw, path, opts, sink);
  if (keys.includes('escalate')) return parseEscalateThen(raw, path, sink);
  if (keys.includes('abstain')) return parseAbstainThen(raw, path, sink);
  sink.err(`${path}/choice`, 'then must specify choice, escalate, or abstain');
  return null;
}

function parseChoiceThen(
  raw: Obj,
  path: string,
  opts: LoadOptions,
  sink: Sink,
): RuleResult | null {
  for (const k of Object.keys(raw)) {
    if (k !== 'choice' && k !== 'allowDowngrade') {
      sink.err(`${path}/${k}`, 'unknown key in choice result');
    }
  }
  const choice = parseChoice(raw['choice'], `${path}/choice`, opts, sink);
  if (choice === null) return null;
  if ('allowDowngrade' in raw) {
    const ad = raw['allowDowngrade'];
    if (typeof ad !== 'boolean') {
      sink.err(`${path}/allowDowngrade`, 'must be a boolean');
      return null;
    }
    return { choice, allowDowngrade: ad };
  }
  return { choice };
}

function parseChoice(
  raw: unknown,
  path: string,
  opts: LoadOptions,
  sink: Sink,
): ModelChoice | null {
  if (typeof raw === 'string') {
    if (!(CHOICE_TIERS as readonly string[]).includes(raw)) {
      sink.err(path, `choice "${raw}" must be one of haiku|sonnet|opus`);
      return null;
    }
    return raw as Tier;
  }
  if (isObj(raw) && typeof raw['modelId'] === 'string') {
    for (const k of Object.keys(raw)) {
      if (k !== 'modelId') {
        sink.err(`${path}/${k}`, `unknown key in modelId choice`);
        return null;
      }
    }
    const id = raw['modelId'];
    if (!(id in opts.modelTiers)) {
      sink.err(path, `modelId "${id}" not present in modelTiers`);
      return null;
    }
    return { modelId: id };
  }
  sink.err(path, 'choice must be a tier string or { modelId }');
  return null;
}

function parseEscalateThen(raw: Obj, path: string, sink: Sink): RuleResult | null {
  for (const k of Object.keys(raw)) {
    if (k !== 'escalate') sink.err(`${path}/${k}`, 'unknown key in escalate result');
  }
  const n = raw['escalate'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    sink.err(`${path}/escalate`, 'must be a positive integer');
    return null;
  }
  return { escalate: n };
}

function parseAbstainThen(raw: Obj, path: string, sink: Sink): RuleResult | null {
  for (const k of Object.keys(raw)) {
    if (k !== 'abstain') sink.err(`${path}/${k}`, 'unknown key in abstain result');
  }
  if (raw['abstain'] !== true) {
    sink.err(`${path}/abstain`, 'must be literal true');
    return null;
  }
  return { abstain: true };
}
