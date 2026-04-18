diff --git a/src/config/schema.ts b/src/config/schema.ts
index b613d77..b7dd0ef 100644
--- a/src/config/schema.ts
+++ b/src/config/schema.ts
@@ -15,7 +15,7 @@ export type Tier = 'haiku' | 'sonnet' | 'opus';
 export interface CcmuxRule {
   readonly id: string;
   readonly when: Readonly<Record<string, unknown>>;
-  readonly then: { readonly choice: string; readonly [key: string]: unknown };
+  readonly then: Readonly<Record<string, unknown>>;
   readonly allowDowngrade?: boolean;
 }
 
diff --git a/src/config/validate-rules.ts b/src/config/validate-rules.ts
index a137527..18cea55 100644
--- a/src/config/validate-rules.ts
+++ b/src/config/validate-rules.ts
@@ -30,22 +30,44 @@ function readRuleThen(
   v: Obj,
   path: string,
   sink: ErrorSink,
-): { choice: string; rest: Obj } {
+): { then: Obj; valid: boolean } {
   const raw = v['then'];
   if (raw === undefined) {
     sink.err(`${path}/then`, 'required object');
-    return { choice: '', rest: {} };
+    return { then: {}, valid: false };
   }
   if (!isObj(raw)) {
     sink.err(`${path}/then`, 'must be an object');
-    return { choice: '', rest: {} };
+    return { then: {}, valid: false };
   }
-  const choice = raw['choice'];
-  if (typeof choice !== 'string' || choice.length === 0) {
-    sink.err(`${path}/then/choice`, 'required non-empty string');
-    return { choice: '', rest: raw };
+  if ('choice' in raw) {
+    const choice = raw['choice'];
+    const okChoice =
+      (typeof choice === 'string' && choice.length > 0) ||
+      (isObj(choice) && typeof choice['modelId'] === 'string');
+    if (!okChoice) {
+      sink.err(`${path}/then/choice`, 'must be a tier string or { modelId }');
+      return { then: raw, valid: false };
+    }
+    return { then: raw, valid: true };
+  }
+  if ('escalate' in raw) {
+    const n = raw['escalate'];
+    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
+      sink.err(`${path}/then/escalate`, 'must be a positive integer');
+      return { then: raw, valid: false };
+    }
+    return { then: raw, valid: true };
   }
-  return { choice, rest: raw };
+  if ('abstain' in raw) {
+    if (raw['abstain'] !== true) {
+      sink.err(`${path}/then/abstain`, 'must be literal true');
+      return { then: raw, valid: false };
+    }
+    return { then: raw, valid: true };
+  }
+  sink.err(`${path}/then/choice`, 'required non-empty string');
+  return { then: raw, valid: false };
 }
 
 function readRuleWhen(v: Obj, path: string, sink: ErrorSink): Obj {
@@ -82,8 +104,9 @@ export function validateRule(
   warnUnknownKeys(v, ['id', 'when', 'then', 'allowDowngrade'], path, sink);
   const id = readRuleId(v, path, sink);
   const when = readRuleWhen(v, path, sink);
-  const { choice, rest } = readRuleThen(v, path, sink);
-  const base: CcmuxRule = { id, when, then: { ...rest, choice } };
+  const { then, valid } = readRuleThen(v, path, sink);
+  if (!valid || id.length === 0) return null;
+  const base: CcmuxRule = { id, when, then };
   if (typeof v['allowDowngrade'] === 'boolean') {
     return { ...base, allowDowngrade: v['allowDowngrade'] };
   }
@@ -105,9 +128,6 @@ export function validateRules(
   v.forEach((item, i) => {
     const rule = validateRule(item, `${path}/${i}`, sink);
     if (!rule) return;
-    if (rule.id.length === 0 || rule.then.choice.length === 0) {
-      return;
-    }
     if (seen.has(rule.id)) {
       sink.err(`${path}/${i}/id`, `duplicate rule id "${rule.id}"`);
       return;
diff --git a/src/policy/conditions.ts b/src/policy/conditions.ts
deleted file mode 100644
index 5e630a6..0000000
--- a/src/policy/conditions.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// Populated in section-08. Do not import.
-export {};
diff --git a/src/policy/dsl.ts b/src/policy/dsl.ts
index 5e630a6..9eb0617 100644
--- a/src/policy/dsl.ts
+++ b/src/policy/dsl.ts
@@ -1,2 +1,41 @@
-// Populated in section-08. Do not import.
-export {};
+// Rule DSL — types consumed by the evaluator and load-time validator.
+// After load, `matches` leaves hold a compiled RegExp; authoring YAML uses string sources.
+
+export type Tier = 'haiku' | 'sonnet' | 'opus';
+export type ModelChoice = Tier | { readonly modelId: string };
+
+export type LeafOp =
+  | { readonly lt: number }
+  | { readonly lte: number }
+  | { readonly gt: number }
+  | { readonly gte: number }
+  | { readonly eq: unknown }
+  | { readonly ne: unknown }
+  | { readonly in: readonly unknown[] }
+  | { readonly matches: RegExp };
+
+export type Leaf = boolean | LeafOp;
+export type FieldCond = Readonly<Record<string, Leaf>>;
+
+export type Condition =
+  | FieldCond
+  | { readonly all: readonly Condition[] }
+  | { readonly any: readonly Condition[] }
+  | { readonly not: Condition };
+
+export type RuleResult =
+  | { readonly choice: ModelChoice; readonly allowDowngrade?: boolean }
+  | { readonly escalate: number }
+  | { readonly abstain: true };
+
+export interface Rule {
+  readonly id: string;
+  readonly when: Condition;
+  readonly then: RuleResult;
+}
+
+export type MatchedResult = Exclude<RuleResult, { readonly abstain: true }>;
+
+export type PolicyResult =
+  | { readonly kind: 'matched'; readonly ruleId: string; readonly result: MatchedResult }
+  | { readonly kind: 'abstain' };
diff --git a/src/policy/engine.ts b/src/policy/engine.ts
deleted file mode 100644
index 5e630a6..0000000
--- a/src/policy/engine.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// Populated in section-08. Do not import.
-export {};
diff --git a/src/policy/evaluate.ts b/src/policy/evaluate.ts
new file mode 100644
index 0000000..bb09bcb
--- /dev/null
+++ b/src/policy/evaluate.ts
@@ -0,0 +1,60 @@
+// Pure rule evaluator. First-match-wins; `abstain` falls through.
+
+import type { Signals } from '../signals/types.js';
+import type { Condition, FieldCond, Leaf, PolicyResult, Rule } from './dsl.js';
+import { matchLeaf } from './predicates.js';
+
+type Tri = 'true' | 'false' | 'null';
+
+const ABSTAIN_RESULT: PolicyResult = Object.freeze({ kind: 'abstain' });
+
+export function evaluate(rules: readonly Rule[], signals: Signals): PolicyResult {
+  for (const rule of rules) {
+    if (evalCondition(rule.when, signals) !== 'true') continue;
+    if ('abstain' in rule.then) continue;
+    return Object.freeze({ kind: 'matched', ruleId: rule.id, result: rule.then });
+  }
+  return ABSTAIN_RESULT;
+}
+
+function evalCondition(cond: Condition, signals: Signals): Tri {
+  const anyCond = cond as { readonly all?: unknown; readonly any?: unknown; readonly not?: Condition };
+  if (Array.isArray(anyCond.all)) return evalAll(anyCond.all as readonly Condition[], signals);
+  if (Array.isArray(anyCond.any)) return evalAny(anyCond.any as readonly Condition[], signals);
+  if (anyCond.not !== undefined) return evalNot(anyCond.not, signals);
+  return evalFieldCond(cond as FieldCond, signals);
+}
+
+function evalAll(children: readonly Condition[], signals: Signals): Tri {
+  for (const c of children) {
+    const r = evalCondition(c, signals);
+    if (r !== 'true') return 'false';
+  }
+  return 'true';
+}
+
+function evalAny(children: readonly Condition[], signals: Signals): Tri {
+  for (const c of children) {
+    if (evalCondition(c, signals) === 'true') return 'true';
+  }
+  return 'false';
+}
+
+function evalNot(inner: Condition, signals: Signals): Tri {
+  const r = evalCondition(inner, signals);
+  return r === 'false' ? 'true' : 'false';
+}
+
+function evalFieldCond(fc: FieldCond, signals: Signals): Tri {
+  const rec = signals as unknown as Record<string, unknown>;
+  let anyNull = false;
+  for (const [key, leaf] of Object.entries(fc)) {
+    const value = rec[key];
+    if (value === null || value === undefined) {
+      anyNull = true;
+      continue;
+    }
+    if (!matchLeaf(leaf as Leaf, value)) return 'false';
+  }
+  return anyNull ? 'null' : 'true';
+}
diff --git a/src/policy/index.ts b/src/policy/index.ts
new file mode 100644
index 0000000..26aa296
--- /dev/null
+++ b/src/policy/index.ts
@@ -0,0 +1,18 @@
+// Barrel exports for the policy engine.
+
+export type {
+  Condition,
+  FieldCond,
+  Leaf,
+  LeafOp,
+  MatchedResult,
+  ModelChoice,
+  PolicyResult,
+  Rule,
+  RuleResult,
+  Tier,
+} from './dsl.js';
+export { evaluate } from './evaluate.js';
+export { matchLeaf } from './predicates.js';
+export { loadRules, type LoadOptions, type ValidationError } from './load.js';
+export { KNOWN_SIGNALS, isKnownSignal, type KnownSignal } from './signals-schema.js';
diff --git a/src/policy/load.ts b/src/policy/load.ts
new file mode 100644
index 0000000..104a1ea
--- /dev/null
+++ b/src/policy/load.ts
@@ -0,0 +1,294 @@
+// Strict rule-DSL loader. Validates shape, compiles regex, and enforces the
+// signal allow-list and known modelIds. Returns Result<readonly Rule[], errors>.
+
+import { fail, ok, type Result } from '../types/result.js';
+import type {
+  Condition,
+  FieldCond,
+  Leaf,
+  LeafOp,
+  ModelChoice,
+  Rule,
+  RuleResult,
+  Tier,
+} from './dsl.js';
+import { isKnownSignal } from './signals-schema.js';
+
+export interface ValidationError {
+  readonly path: string;
+  readonly message: string;
+}
+
+export interface LoadOptions {
+  readonly modelTiers: Readonly<Record<string, Tier>>;
+}
+
+type Obj = Record<string, unknown>;
+const isObj = (v: unknown): v is Obj =>
+  typeof v === 'object' && v !== null && !Array.isArray(v);
+
+const RULE_KEYS = ['id', 'when', 'then'] as const;
+const CHOICE_TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
+const NUMERIC_OPS = ['lt', 'lte', 'gt', 'gte'] as const;
+const EQUALITY_OPS = ['eq', 'ne'] as const;
+
+class Sink {
+  readonly errors: ValidationError[] = [];
+  err(path: string, message: string): void {
+    this.errors.push({ path, message });
+  }
+}
+
+export function loadRules(
+  raw: unknown,
+  opts: LoadOptions,
+): Result<readonly Rule[], readonly ValidationError[]> {
+  const sink = new Sink();
+  if (raw === undefined || raw === null) return ok([]);
+  if (!Array.isArray(raw)) {
+    sink.err('/rules', 'must be an array');
+    return fail(sink.errors);
+  }
+  const seen = new Set<string>();
+  const out: Rule[] = [];
+  raw.forEach((item, i) => {
+    const rule = parseRule(item, `/rules/${i}`, opts, sink, seen);
+    if (rule) out.push(rule);
+  });
+  return sink.errors.length > 0 ? fail(sink.errors) : ok(out);
+}
+
+function parseRule(
+  item: unknown,
+  path: string,
+  opts: LoadOptions,
+  sink: Sink,
+  seen: Set<string>,
+): Rule | null {
+  if (!isObj(item)) {
+    sink.err(path, 'rule must be an object');
+    return null;
+  }
+  for (const key of Object.keys(item)) {
+    if (!(RULE_KEYS as readonly string[]).includes(key)) {
+      sink.err(`${path}/${key}`, 'unknown key');
+    }
+  }
+  const id = parseId(item['id'], path, sink);
+  const when = parseCondition(item['when'], `${path}/when`, sink);
+  const then = parseThen(item['then'], `${path}/then`, opts, sink);
+  if (id === null || when === null || then === null) return null;
+  if (seen.has(id)) {
+    sink.err(`${path}/id`, `duplicate rule id "${id}"`);
+    return null;
+  }
+  seen.add(id);
+  return { id, when, then };
+}
+
+function parseId(raw: unknown, path: string, sink: Sink): string | null {
+  if (typeof raw !== 'string' || raw.length === 0) {
+    sink.err(`${path}/id`, 'required non-empty string');
+    return null;
+  }
+  return raw;
+}
+
+function parseCondition(raw: unknown, path: string, sink: Sink): Condition | null {
+  if (!isObj(raw)) {
+    sink.err(path, 'condition must be an object');
+    return null;
+  }
+  if ('all' in raw || 'any' in raw || 'not' in raw) {
+    return parseComposite(raw, path, sink);
+  }
+  return parseFieldCond(raw, path, sink);
+}
+
+function parseComposite(raw: Obj, path: string, sink: Sink): Condition | null {
+  const keys = Object.keys(raw);
+  if (keys.length !== 1) {
+    sink.err(path, 'composite must have exactly one of all|any|not');
+    return null;
+  }
+  const key = keys[0]!;
+  if (key === 'all' || key === 'any') {
+    const arr = raw[key];
+    if (!Array.isArray(arr)) {
+      sink.err(`${path}/${key}`, 'must be an array');
+      return null;
+    }
+    const children: Condition[] = [];
+    arr.forEach((child, i) => {
+      const c = parseCondition(child, `${path}/${key}/${i}`, sink);
+      if (c) children.push(c);
+    });
+    return key === 'all' ? { all: children } : { any: children };
+  }
+  if (key === 'not') {
+    const inner = parseCondition(raw['not'], `${path}/not`, sink);
+    if (!inner) return null;
+    return { not: inner };
+  }
+  sink.err(`${path}/${key}`, 'unknown composite key');
+  return null;
+}
+
+function parseFieldCond(raw: Obj, path: string, sink: Sink): FieldCond | null {
+  const out: Record<string, Leaf> = {};
+  let anyBad = false;
+  for (const [name, leafRaw] of Object.entries(raw)) {
+    if (!isKnownSignal(name)) {
+      sink.err(`${path}/${name}`, `unknown signal "${name}"`);
+      anyBad = true;
+      continue;
+    }
+    const leaf = parseLeaf(leafRaw, `${path}/${name}`, sink);
+    if (leaf === null) {
+      anyBad = true;
+      continue;
+    }
+    out[name] = leaf;
+  }
+  return anyBad ? null : out;
+}
+
+function parseLeaf(raw: unknown, path: string, sink: Sink): Leaf | null {
+  if (typeof raw === 'boolean') return raw;
+  if (!isObj(raw)) {
+    sink.err(path, 'leaf must be a boolean or operator object');
+    return null;
+  }
+  const keys = Object.keys(raw);
+  if (keys.length !== 1) {
+    sink.err(path, 'leaf operator must have exactly one key');
+    return null;
+  }
+  const op = keys[0]!;
+  const value = raw[op];
+  return parseLeafOp(op, value, path, sink);
+}
+
+function parseLeafOp(op: string, value: unknown, path: string, sink: Sink): LeafOp | null {
+  if ((NUMERIC_OPS as readonly string[]).includes(op)) {
+    if (typeof value !== 'number' || !Number.isFinite(value)) {
+      sink.err(`${path}/${op}`, 'must be a finite number');
+      return null;
+    }
+    return { [op]: value } as LeafOp;
+  }
+  if ((EQUALITY_OPS as readonly string[]).includes(op)) {
+    return { [op]: value } as LeafOp;
+  }
+  if (op === 'in') {
+    if (!Array.isArray(value)) {
+      sink.err(`${path}/in`, 'must be an array');
+      return null;
+    }
+    return { in: value };
+  }
+  if (op === 'matches') {
+    if (typeof value !== 'string') {
+      sink.err(`${path}/matches`, 'must be a string regex source');
+      return null;
+    }
+    try {
+      return { matches: new RegExp(value) };
+    } catch {
+      sink.err(`${path}/matches`, `unparseable regex "${value}"`);
+      return null;
+    }
+  }
+  sink.err(`${path}/${op}`, `unknown leaf operator "${op}"`);
+  return null;
+}
+
+function parseThen(
+  raw: unknown,
+  path: string,
+  opts: LoadOptions,
+  sink: Sink,
+): RuleResult | null {
+  if (!isObj(raw)) {
+    sink.err(path, 'then must be an object');
+    return null;
+  }
+  const keys = Object.keys(raw);
+  if (keys.includes('choice')) return parseChoiceThen(raw, path, opts, sink);
+  if (keys.includes('escalate')) return parseEscalateThen(raw, path, sink);
+  if (keys.includes('abstain')) return parseAbstainThen(raw, path, sink);
+  sink.err(`${path}/choice`, 'then must specify choice, escalate, or abstain');
+  return null;
+}
+
+function parseChoiceThen(
+  raw: Obj,
+  path: string,
+  opts: LoadOptions,
+  sink: Sink,
+): RuleResult | null {
+  for (const k of Object.keys(raw)) {
+    if (k !== 'choice' && k !== 'allowDowngrade') {
+      sink.err(`${path}/${k}`, 'unknown key in choice result');
+    }
+  }
+  const choice = parseChoice(raw['choice'], `${path}/choice`, opts, sink);
+  if (choice === null) return null;
+  if ('allowDowngrade' in raw) {
+    const ad = raw['allowDowngrade'];
+    if (typeof ad !== 'boolean') {
+      sink.err(`${path}/allowDowngrade`, 'must be a boolean');
+      return null;
+    }
+    return { choice, allowDowngrade: ad };
+  }
+  return { choice };
+}
+
+function parseChoice(
+  raw: unknown,
+  path: string,
+  opts: LoadOptions,
+  sink: Sink,
+): ModelChoice | null {
+  if (typeof raw === 'string') {
+    if (!(CHOICE_TIERS as readonly string[]).includes(raw)) {
+      sink.err(path, `choice "${raw}" must be one of haiku|sonnet|opus`);
+      return null;
+    }
+    return raw as Tier;
+  }
+  if (isObj(raw) && typeof raw['modelId'] === 'string') {
+    const id = raw['modelId'];
+    if (!(id in opts.modelTiers)) {
+      sink.err(path, `modelId "${id}" not present in modelTiers`);
+      return null;
+    }
+    return { modelId: id };
+  }
+  sink.err(path, 'choice must be a tier string or { modelId }');
+  return null;
+}
+
+function parseEscalateThen(raw: Obj, path: string, sink: Sink): RuleResult | null {
+  for (const k of Object.keys(raw)) {
+    if (k !== 'escalate') sink.err(`${path}/${k}`, 'unknown key in escalate result');
+  }
+  const n = raw['escalate'];
+  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
+    sink.err(`${path}/escalate`, 'must be a positive integer');
+    return null;
+  }
+  return { escalate: n };
+}
+
+function parseAbstainThen(raw: Obj, path: string, sink: Sink): RuleResult | null {
+  for (const k of Object.keys(raw)) {
+    if (k !== 'abstain') sink.err(`${path}/${k}`, 'unknown key in abstain result');
+  }
+  if (raw['abstain'] !== true) {
+    sink.err(`${path}/abstain`, 'must be literal true');
+    return null;
+  }
+  return { abstain: true };
+}
diff --git a/src/policy/predicates.ts b/src/policy/predicates.ts
new file mode 100644
index 0000000..861e93b
--- /dev/null
+++ b/src/policy/predicates.ts
@@ -0,0 +1,21 @@
+// Leaf predicate matcher. Null/undefined signals never match.
+
+import type { Leaf, LeafOp } from './dsl.js';
+
+export function matchLeaf(leaf: Leaf, value: unknown): boolean {
+  if (value === null || value === undefined) return false;
+  if (typeof leaf === 'boolean') return value === leaf;
+  return matchLeafOp(leaf, value);
+}
+
+function matchLeafOp(op: LeafOp, value: unknown): boolean {
+  if ('lt' in op) return typeof value === 'number' && value < op.lt;
+  if ('lte' in op) return typeof value === 'number' && value <= op.lte;
+  if ('gt' in op) return typeof value === 'number' && value > op.gt;
+  if ('gte' in op) return typeof value === 'number' && value >= op.gte;
+  if ('eq' in op) return value === op.eq;
+  if ('ne' in op) return value !== op.ne;
+  if ('in' in op) return op.in.some((x) => value === x);
+  if ('matches' in op) return typeof value === 'string' && op.matches.test(value);
+  return false;
+}
diff --git a/src/policy/recipes/balanced.yaml b/src/policy/recipes/balanced.yaml
new file mode 100644
index 0000000..a015ece
--- /dev/null
+++ b/src/policy/recipes/balanced.yaml
@@ -0,0 +1,27 @@
+# Recipe: balanced — `ccmux init` default. Haiku for trivial, Opus for plan, escalate on friction.
+port: 7879
+mode: live
+rules:
+  # Plan mode deserves Opus.
+  - id: plan-to-opus
+    when: { planMode: true }
+    then: { choice: opus }
+
+  # Trivial turns: short, no tools, small context → Haiku.
+  - id: trivial-to-haiku
+    when:
+      all:
+        - { messageCount: { lt: 5 } }
+        - { toolUseCount: { eq: 0 } }
+        - { estInputTokens: { lt: 2000 } }
+    then: { choice: haiku }
+
+  # Retries suggest the first tier couldn't cope.
+  - id: retry-escalate
+    when: { retryCount: { gte: 2 } }
+    then: { escalate: 1 }
+
+  # Frustration signal → bump a tier.
+  - id: frustration-escalate
+    when: { frustration: true }
+    then: { escalate: 1 }
diff --git a/src/policy/recipes/frugal.yaml b/src/policy/recipes/frugal.yaml
new file mode 100644
index 0000000..c8b72e9
--- /dev/null
+++ b/src/policy/recipes/frugal.yaml
@@ -0,0 +1,21 @@
+# Recipe: frugal — aggressive Haiku, Opus only for plan mode.
+port: 7879
+mode: live
+rules:
+  # Plan mode deserves the best reasoning.
+  - id: plan-to-opus
+    when: { planMode: true }
+    then: { choice: opus }
+
+  # Short, tool-free chats are cheap by default.
+  - id: tiny-to-haiku
+    when:
+      all:
+        - { messageCount: { lt: 6 } }
+        - { toolUseCount: { eq: 0 } }
+    then: { choice: haiku }
+
+  # Frustrated users get one tier bump.
+  - id: frustration-escalate
+    when: { frustration: true }
+    then: { escalate: 1 }
diff --git a/src/policy/recipes/opus-forward.yaml b/src/policy/recipes/opus-forward.yaml
new file mode 100644
index 0000000..c1fbcd9
--- /dev/null
+++ b/src/policy/recipes/opus-forward.yaml
@@ -0,0 +1,18 @@
+# Recipe: opus-forward — default Opus, Haiku only for trivial fast-path.
+port: 7879
+mode: live
+rules:
+  # Only tiny, tool-free openers get Haiku.
+  - id: trivial-to-haiku
+    when:
+      all:
+        - { messageCount: { lt: 2 } }
+        - { estInputTokens: { lt: 500 } }
+        - { toolUseCount: { eq: 0 } }
+    then: { choice: haiku }
+
+  # Everything else routes straight to Opus.
+  - id: default-opus
+    when:
+      all: []
+    then: { choice: opus }
diff --git a/src/policy/signals-schema.ts b/src/policy/signals-schema.ts
new file mode 100644
index 0000000..7063da0
--- /dev/null
+++ b/src/policy/signals-schema.ts
@@ -0,0 +1,24 @@
+// Allow-list of signal names referenced by rules. Must stay in sync with src/signals/types.ts.
+
+export const KNOWN_SIGNALS = Object.freeze([
+  'planMode',
+  'messageCount',
+  'tools',
+  'toolUseCount',
+  'estInputTokens',
+  'fileRefCount',
+  'retryCount',
+  'frustration',
+  'explicitModel',
+  'projectPath',
+  'sessionDurationMs',
+  'betaFlags',
+  'sessionId',
+  'requestHash',
+] as const);
+
+export type KnownSignal = (typeof KNOWN_SIGNALS)[number];
+
+export function isKnownSignal(name: string): name is KnownSignal {
+  return (KNOWN_SIGNALS as readonly string[]).includes(name);
+}
diff --git a/src/policy/tiers.ts b/src/policy/tiers.ts
deleted file mode 100644
index 193d1c6..0000000
--- a/src/policy/tiers.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// Populated in section-09. Do not import.
-export {};
diff --git a/tests/policy/dsl.test.ts b/tests/policy/dsl.test.ts
new file mode 100644
index 0000000..d66ffba
--- /dev/null
+++ b/tests/policy/dsl.test.ts
@@ -0,0 +1,79 @@
+import { describe, it, expect } from 'vitest';
+import { evaluate } from '../../src/policy/evaluate.js';
+import type { Rule } from '../../src/policy/dsl.js';
+import { makeSignals } from './helpers.js';
+
+function matches(rule: Rule, signals: ReturnType<typeof makeSignals>): boolean {
+  const result = evaluate([rule], signals);
+  return result.kind === 'matched';
+}
+
+describe('dsl — all / any / not composition', () => {
+  it('dsl_all_shortCircuitsOnFirstFalse', () => {
+    const rule: Rule = {
+      id: 'r',
+      when: { all: [{ planMode: true }, { messageCount: { lt: 3 } }] },
+      then: { choice: 'haiku' },
+    };
+    expect(matches(rule, makeSignals({ planMode: true, messageCount: 2 }))).toBe(true);
+    expect(matches(rule, makeSignals({ planMode: true, messageCount: 5 }))).toBe(false);
+    expect(matches(rule, makeSignals({ planMode: false, messageCount: 2 }))).toBe(false);
+  });
+
+  it('dsl_any_shortCircuitsOnFirstTrue', () => {
+    const rule: Rule = {
+      id: 'r',
+      when: { any: [{ planMode: true }, { messageCount: { gt: 10 } }] },
+      then: { choice: 'opus' },
+    };
+    expect(matches(rule, makeSignals({ planMode: true, messageCount: 0 }))).toBe(true);
+    expect(matches(rule, makeSignals({ planMode: false, messageCount: 11 }))).toBe(true);
+    expect(matches(rule, makeSignals({ planMode: false, messageCount: 5 }))).toBe(false);
+  });
+
+  it('dsl_not_invertsTruthValue', () => {
+    const rule: Rule = {
+      id: 'r',
+      when: { not: { planMode: true } },
+      then: { choice: 'sonnet' },
+    };
+    expect(matches(rule, makeSignals({ planMode: false }))).toBe(true);
+    expect(matches(rule, makeSignals({ planMode: true }))).toBe(false);
+  });
+
+  it('dsl_notOfNullLeaf_returnsFalse', () => {
+    const rule: Rule = {
+      id: 'r',
+      when: { not: { planMode: true } },
+      then: { choice: 'sonnet' },
+    };
+    expect(matches(rule, makeSignals({ planMode: null }))).toBe(false);
+  });
+
+  it('dsl_deeplyNested_composition', () => {
+    const rule: Rule = {
+      id: 'r',
+      when: {
+        all: [
+          { any: [{ planMode: true }, { frustration: true }] },
+          { not: { retryCount: { gte: 5 } } },
+        ],
+      },
+      then: { choice: 'opus' },
+    };
+    expect(matches(rule, makeSignals({ planMode: true, retryCount: 2 }))).toBe(true);
+    expect(matches(rule, makeSignals({ frustration: true, retryCount: 2 }))).toBe(true);
+    expect(matches(rule, makeSignals({ planMode: false, retryCount: 6 }))).toBe(false);
+    expect(matches(rule, makeSignals({ planMode: false, frustration: false }))).toBe(false);
+  });
+
+  it('dsl_emptyAll_matchesEverything', () => {
+    const rule: Rule = { id: 'r', when: { all: [] }, then: { choice: 'opus' } };
+    expect(matches(rule, makeSignals({}))).toBe(true);
+  });
+
+  it('dsl_emptyAny_matchesNothing', () => {
+    const rule: Rule = { id: 'r', when: { any: [] }, then: { choice: 'opus' } };
+    expect(matches(rule, makeSignals({}))).toBe(false);
+  });
+});
diff --git a/tests/policy/evaluate.test.ts b/tests/policy/evaluate.test.ts
new file mode 100644
index 0000000..9259598
--- /dev/null
+++ b/tests/policy/evaluate.test.ts
@@ -0,0 +1,100 @@
+import { describe, it, expect } from 'vitest';
+import { evaluate } from '../../src/policy/evaluate.js';
+import type { Rule } from '../../src/policy/dsl.js';
+import { makeSignals } from './helpers.js';
+
+describe('evaluate — first-match-wins', () => {
+  it('evaluate_twoTruthyRules_onlyFirstWins', () => {
+    const rules: readonly Rule[] = [
+      { id: 'first', when: { planMode: true }, then: { choice: 'opus' } },
+      { id: 'second', when: { planMode: true }, then: { choice: 'haiku' } },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: true }));
+    expect(r.kind).toBe('matched');
+    if (r.kind === 'matched') {
+      expect(r.ruleId).toBe('first');
+      expect(r.result).toEqual({ choice: 'opus' });
+    }
+  });
+});
+
+describe('evaluate — abstain fall-through', () => {
+  it('evaluate_abstainRule_fallsThroughToNextMatch', () => {
+    const rules: readonly Rule[] = [
+      { id: 'a', when: { planMode: true }, then: { abstain: true } },
+      { id: 'b', when: { planMode: true }, then: { choice: 'haiku' } },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: true }));
+    expect(r.kind).toBe('matched');
+    if (r.kind === 'matched') expect(r.ruleId).toBe('b');
+  });
+
+  it('evaluate_onlyAbstainRules_resultIsAbstain', () => {
+    const rules: readonly Rule[] = [
+      { id: 'a', when: { planMode: true }, then: { abstain: true } },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: true }));
+    expect(r.kind).toBe('abstain');
+  });
+});
+
+describe('evaluate — no match', () => {
+  it('evaluate_noRuleMatches_abstain', () => {
+    const rules: readonly Rule[] = [
+      { id: 'a', when: { planMode: true }, then: { choice: 'opus' } },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: false }));
+    expect(r.kind).toBe('abstain');
+  });
+
+  it('evaluate_emptyRuleList_abstain', () => {
+    const r = evaluate([], makeSignals({}));
+    expect(r.kind).toBe('abstain');
+  });
+});
+
+describe('evaluate — escalate passthrough', () => {
+  it('evaluate_escalateRule_returnsEscalateRaw', () => {
+    const rules: readonly Rule[] = [
+      { id: 'bump', when: { frustration: true }, then: { escalate: 1 } },
+    ];
+    const r = evaluate(rules, makeSignals({ frustration: true }));
+    expect(r.kind).toBe('matched');
+    if (r.kind === 'matched') {
+      expect(r.result).toEqual({ escalate: 1 });
+      expect(r.ruleId).toBe('bump');
+    }
+  });
+});
+
+describe('evaluate — null signals do not fire', () => {
+  it('evaluate_nullSignal_ruleReferencingItDoesNotFire', () => {
+    const rules: readonly Rule[] = [
+      { id: 'plan', when: { planMode: true }, then: { choice: 'opus' } },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: null }));
+    expect(r.kind).toBe('abstain');
+  });
+
+  it('evaluate_nullPoisonInAll_treatedAsFalse', () => {
+    const rules: readonly Rule[] = [
+      {
+        id: 'combo',
+        when: { all: [{ planMode: true }, { messageCount: { lt: 5 } }] },
+        then: { choice: 'haiku' },
+      },
+    ];
+    const r = evaluate(rules, makeSignals({ planMode: null, messageCount: 2 }));
+    expect(r.kind).toBe('abstain');
+  });
+});
+
+describe('evaluate — result immutability', () => {
+  it('evaluate_result_isFrozen', () => {
+    const rules: readonly Rule[] = [
+      { id: 'r', when: { all: [] }, then: { choice: 'opus' } },
+    ];
+    const r = evaluate(rules, makeSignals({}));
+    expect(Object.isFrozen(r)).toBe(true);
+  });
+});
diff --git a/tests/policy/fixtures/mixed.json b/tests/policy/fixtures/mixed.json
new file mode 100644
index 0000000..5d3e2a8
--- /dev/null
+++ b/tests/policy/fixtures/mixed.json
@@ -0,0 +1,22 @@
+[
+  { "name": "plan-tiny",         "planMode": true,  "messageCount": 1,  "toolUseCount": 0, "estInputTokens": 200,   "frustration": false, "retryCount": 0 },
+  { "name": "plan-medium",       "planMode": true,  "messageCount": 4,  "toolUseCount": 2, "estInputTokens": 3000,  "frustration": false, "retryCount": 0 },
+  { "name": "plan-long",         "planMode": true,  "messageCount": 12, "toolUseCount": 3, "estInputTokens": 8000,  "frustration": false, "retryCount": 1 },
+  { "name": "tiny-1",            "planMode": false, "messageCount": 1,  "toolUseCount": 0, "estInputTokens": 300,   "frustration": false, "retryCount": 0 },
+  { "name": "tiny-2",            "planMode": false, "messageCount": 2,  "toolUseCount": 0, "estInputTokens": 450,   "frustration": false, "retryCount": 0 },
+  { "name": "small-no-tools",    "planMode": false, "messageCount": 3,  "toolUseCount": 0, "estInputTokens": 1500,  "frustration": false, "retryCount": 0 },
+  { "name": "small-no-tools-2",  "planMode": false, "messageCount": 4,  "toolUseCount": 0, "estInputTokens": 1800,  "frustration": false, "retryCount": 0 },
+  { "name": "tool-heavy-1",      "planMode": false, "messageCount": 6,  "toolUseCount": 8, "estInputTokens": 4000,  "frustration": false, "retryCount": 0 },
+  { "name": "tool-heavy-2",      "planMode": false, "messageCount": 10, "toolUseCount": 15,"estInputTokens": 12000, "frustration": false, "retryCount": 0 },
+  { "name": "frustrated-1",      "planMode": false, "messageCount": 7,  "toolUseCount": 2, "estInputTokens": 5000,  "frustration": true,  "retryCount": 0 },
+  { "name": "frustrated-2",      "planMode": false, "messageCount": 3,  "toolUseCount": 0, "estInputTokens": 900,   "frustration": true,  "retryCount": 0 },
+  { "name": "long-context-1",    "planMode": false, "messageCount": 15, "toolUseCount": 4, "estInputTokens": 20000, "frustration": false, "retryCount": 0 },
+  { "name": "long-context-2",    "planMode": false, "messageCount": 25, "toolUseCount": 6, "estInputTokens": 50000, "frustration": false, "retryCount": 0 },
+  { "name": "retry-1",           "planMode": false, "messageCount": 5,  "toolUseCount": 1, "estInputTokens": 2500,  "frustration": false, "retryCount": 2 },
+  { "name": "retry-2",           "planMode": false, "messageCount": 8,  "toolUseCount": 3, "estInputTokens": 4500,  "frustration": false, "retryCount": 3 },
+  { "name": "mid-1",             "planMode": false, "messageCount": 5,  "toolUseCount": 2, "estInputTokens": 3500,  "frustration": false, "retryCount": 0 },
+  { "name": "mid-2",             "planMode": false, "messageCount": 7,  "toolUseCount": 4, "estInputTokens": 4500,  "frustration": false, "retryCount": 1 },
+  { "name": "mid-3",             "planMode": false, "messageCount": 9,  "toolUseCount": 5, "estInputTokens": 6000,  "frustration": false, "retryCount": 0 },
+  { "name": "tiny-3",            "planMode": false, "messageCount": 1,  "toolUseCount": 0, "estInputTokens": 100,   "frustration": false, "retryCount": 0 },
+  { "name": "tiny-with-tool",    "planMode": false, "messageCount": 2,  "toolUseCount": 1, "estInputTokens": 600,   "frustration": false, "retryCount": 0 }
+]
diff --git a/tests/policy/helpers.ts b/tests/policy/helpers.ts
new file mode 100644
index 0000000..2391180
--- /dev/null
+++ b/tests/policy/helpers.ts
@@ -0,0 +1,22 @@
+import type { Signals } from '../../src/signals/types.js';
+
+const DEFAULT_SIGNALS: Signals = {
+  planMode: false,
+  messageCount: 1,
+  tools: [],
+  toolUseCount: 0,
+  estInputTokens: 100,
+  fileRefCount: 0,
+  retryCount: 0,
+  frustration: false,
+  explicitModel: null,
+  projectPath: null,
+  sessionDurationMs: 0,
+  betaFlags: [],
+  sessionId: 'session-test',
+  requestHash: 'hash-test',
+};
+
+export function makeSignals(overrides: Partial<Signals>): Signals {
+  return Object.freeze({ ...DEFAULT_SIGNALS, ...overrides });
+}
diff --git a/tests/policy/load.test.ts b/tests/policy/load.test.ts
new file mode 100644
index 0000000..9533832
--- /dev/null
+++ b/tests/policy/load.test.ts
@@ -0,0 +1,187 @@
+import { describe, it, expect } from 'vitest';
+import { loadRules } from '../../src/policy/load.js';
+
+const EMPTY_TIERS = Object.freeze({});
+const OPTS = { modelTiers: EMPTY_TIERS };
+
+describe('loadRules — valid shapes', () => {
+  it('loadRules_minimalChoice_returnsOk', () => {
+    const r = loadRules(
+      [{ id: 'r1', when: { planMode: true }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(true);
+    if (r.ok) {
+      expect(r.value).toHaveLength(1);
+      expect(r.value[0]?.id).toBe('r1');
+    }
+  });
+
+  it('loadRules_escalateRule_returnsOk', () => {
+    const r = loadRules(
+      [{ id: 'e', when: { frustration: true }, then: { escalate: 1 } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(true);
+    if (r.ok) expect(r.value[0]?.then).toEqual({ escalate: 1 });
+  });
+
+  it('loadRules_abstainRule_returnsOk', () => {
+    const r = loadRules(
+      [{ id: 'a', when: { planMode: true }, then: { abstain: true } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(true);
+    if (r.ok) expect(r.value[0]?.then).toEqual({ abstain: true });
+  });
+
+  it('loadRules_allAnyNotComposition_returnsOk', () => {
+    const r = loadRules(
+      [
+        {
+          id: 'c',
+          when: { all: [{ any: [{ planMode: true }] }, { not: { frustration: true } }] },
+          then: { choice: 'sonnet' },
+        },
+      ],
+      OPTS,
+    );
+    expect(r.ok).toBe(true);
+  });
+
+  it('loadRules_undefinedInput_returnsEmpty', () => {
+    const r = loadRules(undefined, OPTS);
+    expect(r.ok).toBe(true);
+    if (r.ok) expect(r.value).toEqual([]);
+  });
+});
+
+describe('loadRules — validation errors', () => {
+  it('loadRules_duplicateId_errorsAtSecondOccurrence', () => {
+    const r = loadRules(
+      [
+        { id: 'same', when: { planMode: true }, then: { choice: 'opus' } },
+        { id: 'same', when: { planMode: false }, then: { choice: 'haiku' } },
+      ],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+    if (!r.ok) {
+      const dup = r.error.find((e) => e.path === '/rules/1/id');
+      expect(dup).toBeDefined();
+      expect(dup?.message).toMatch(/duplicate/);
+    }
+  });
+
+  it('loadRules_unknownSignalName_errors', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { notARealSignal: true }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+    if (!r.ok) {
+      const err = r.error.find((e) => e.path.includes('notARealSignal'));
+      expect(err).toBeDefined();
+    }
+  });
+
+  it('loadRules_wrongLeafValueType_errors', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { messageCount: { lt: 'not-a-number' } }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+  });
+
+  it('loadRules_unparseableMatchesRegex_errors', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { explicitModel: { matches: '(((' } }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+  });
+
+  it('loadRules_modelIdWithNoTier_errors', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { planMode: true }, then: { choice: { modelId: 'custom-x' } } }],
+      { modelTiers: {} },
+    );
+    expect(r.ok).toBe(false);
+    if (!r.ok) {
+      const err = r.error.find((e) => e.message.toLowerCase().includes('modeltiers'));
+      expect(err).toBeDefined();
+    }
+  });
+
+  it('loadRules_modelIdPresentInTiers_returnsOk', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { planMode: true }, then: { choice: { modelId: 'custom-x' } } }],
+      { modelTiers: { 'custom-x': 'opus' } },
+    );
+    expect(r.ok).toBe(true);
+  });
+
+  it('loadRules_unknownKeyInsideRule_errors', () => {
+    const r = loadRules(
+      [
+        {
+          id: 'x',
+          when: { planMode: true },
+          then: { choice: 'opus' },
+          somethingElse: 42,
+        },
+      ],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+    if (!r.ok) {
+      const err = r.error.find((e) => e.path.includes('somethingElse'));
+      expect(err).toBeDefined();
+    }
+  });
+
+  it('loadRules_escalateNonPositive_errors', () => {
+    const r = loadRules(
+      [{ id: 'e', when: { planMode: true }, then: { escalate: 0 } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+    const r2 = loadRules(
+      [{ id: 'e', when: { planMode: true }, then: { escalate: 1.5 } }],
+      OPTS,
+    );
+    expect(r2.ok).toBe(false);
+  });
+
+  it('loadRules_unknownConditionKey_errors', () => {
+    const r = loadRules(
+      [{ id: 'x', when: { weird: { lt: 1 }, planMode: true }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+  });
+
+  it('loadRules_missingId_errors', () => {
+    const r = loadRules(
+      [{ when: { planMode: true }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(false);
+  });
+});
+
+describe('loadRules — matches regex compilation', () => {
+  it('loadRules_matchesRegex_compiledOnceAtLoad', () => {
+    const r = loadRules(
+      [{ id: 'r', when: { explicitModel: { matches: '^claude-' } }, then: { choice: 'opus' } }],
+      OPTS,
+    );
+    expect(r.ok).toBe(true);
+    if (r.ok) {
+      const when = r.value[0]?.when as Record<string, unknown>;
+      const leaf = when['explicitModel'] as { matches: RegExp };
+      expect(leaf.matches).toBeInstanceOf(RegExp);
+      expect(leaf.matches.source).toBe('^claude-');
+    }
+  });
+});
diff --git a/tests/policy/predicates.test.ts b/tests/policy/predicates.test.ts
new file mode 100644
index 0000000..fb37db7
--- /dev/null
+++ b/tests/policy/predicates.test.ts
@@ -0,0 +1,100 @@
+import { describe, it, expect } from 'vitest';
+import { matchLeaf } from '../../src/policy/predicates.js';
+import type { Leaf } from '../../src/policy/dsl.js';
+
+describe('predicates — numeric comparisons', () => {
+  it('matchLeaf_lt_numericTrueAndFalse', () => {
+    expect(matchLeaf({ lt: 5 } as Leaf, 3)).toBe(true);
+    expect(matchLeaf({ lt: 5 } as Leaf, 5)).toBe(false);
+    expect(matchLeaf({ lt: 5 } as Leaf, 6)).toBe(false);
+  });
+
+  it('matchLeaf_lte_numericBoundary', () => {
+    expect(matchLeaf({ lte: 5 } as Leaf, 5)).toBe(true);
+    expect(matchLeaf({ lte: 5 } as Leaf, 6)).toBe(false);
+  });
+
+  it('matchLeaf_gt_numericBoundary', () => {
+    expect(matchLeaf({ gt: 5 } as Leaf, 6)).toBe(true);
+    expect(matchLeaf({ gt: 5 } as Leaf, 5)).toBe(false);
+  });
+
+  it('matchLeaf_gte_numericBoundary', () => {
+    expect(matchLeaf({ gte: 5 } as Leaf, 5)).toBe(true);
+    expect(matchLeaf({ gte: 5 } as Leaf, 4)).toBe(false);
+  });
+
+  it('matchLeaf_numericOpsAgainstNonNumber_returnFalse', () => {
+    expect(matchLeaf({ lt: 5 } as Leaf, 'three')).toBe(false);
+    expect(matchLeaf({ gte: 0 } as Leaf, true)).toBe(false);
+  });
+});
+
+describe('predicates — equality', () => {
+  it('matchLeaf_eq_primitiveMatch', () => {
+    expect(matchLeaf({ eq: 'opus' } as Leaf, 'opus')).toBe(true);
+    expect(matchLeaf({ eq: 'opus' } as Leaf, 'sonnet')).toBe(false);
+    expect(matchLeaf({ eq: 42 } as Leaf, 42)).toBe(true);
+  });
+
+  it('matchLeaf_ne_primitiveMismatch', () => {
+    expect(matchLeaf({ ne: 'opus' } as Leaf, 'haiku')).toBe(true);
+    expect(matchLeaf({ ne: 'opus' } as Leaf, 'opus')).toBe(false);
+  });
+});
+
+describe('predicates — in', () => {
+  it('matchLeaf_in_primitiveArray', () => {
+    expect(matchLeaf({ in: ['haiku', 'sonnet'] } as Leaf, 'haiku')).toBe(true);
+    expect(matchLeaf({ in: ['haiku', 'sonnet'] } as Leaf, 'opus')).toBe(false);
+  });
+});
+
+describe('predicates — matches', () => {
+  it('matchLeaf_matches_stringSignal', () => {
+    const leaf: Leaf = { matches: /foo.+bar/ };
+    expect(matchLeaf(leaf, 'foo-and-bar')).toBe(true);
+    expect(matchLeaf(leaf, 'no match here')).toBe(false);
+  });
+
+  it('matchLeaf_matches_nonStringSignal_returnsFalse', () => {
+    const leaf: Leaf = { matches: /./ };
+    expect(matchLeaf(leaf, 123)).toBe(false);
+    expect(matchLeaf(leaf, ['a'])).toBe(false);
+  });
+});
+
+describe('predicates — boolean shorthand', () => {
+  it('matchLeaf_booleanTrue_matchesOnlyTrue', () => {
+    expect(matchLeaf(true as Leaf, true)).toBe(true);
+    expect(matchLeaf(true as Leaf, false)).toBe(false);
+    expect(matchLeaf(true as Leaf, 1)).toBe(false);
+  });
+
+  it('matchLeaf_booleanFalse_matchesOnlyFalse', () => {
+    expect(matchLeaf(false as Leaf, false)).toBe(true);
+    expect(matchLeaf(false as Leaf, true)).toBe(false);
+    expect(matchLeaf(false as Leaf, 0)).toBe(false);
+  });
+});
+
+describe('predicates — null signal', () => {
+  it('matchLeaf_nullSignal_allOpsReturnFalse', () => {
+    const ops: Leaf[] = [
+      true,
+      false,
+      { lt: 5 },
+      { lte: 5 },
+      { gt: 5 },
+      { gte: 5 },
+      { eq: 'x' },
+      { ne: 'x' },
+      { in: ['x'] },
+      { matches: /./ },
+    ];
+    for (const op of ops) {
+      expect(matchLeaf(op, null)).toBe(false);
+      expect(matchLeaf(op, undefined)).toBe(false);
+    }
+  });
+});
diff --git a/tests/policy/recipes.test.ts b/tests/policy/recipes.test.ts
new file mode 100644
index 0000000..7a86d04
--- /dev/null
+++ b/tests/policy/recipes.test.ts
@@ -0,0 +1,109 @@
+import { describe, it, expect } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { fileURLToPath } from 'node:url';
+import { dirname, join } from 'node:path';
+import { load as yamlLoad, CORE_SCHEMA } from 'js-yaml';
+import { loadConfig } from '../../src/config/loader.js';
+import { loadRules } from '../../src/policy/load.js';
+import { evaluate } from '../../src/policy/evaluate.js';
+import type { Signals } from '../../src/signals/types.js';
+import { makeSignals } from './helpers.js';
+import mixedFixtures from './fixtures/mixed.json' assert { type: 'json' };
+
+const here = dirname(fileURLToPath(import.meta.url));
+const RECIPE_DIR = join(here, '..', '..', 'src', 'policy', 'recipes');
+
+function recipePath(name: string): string {
+  return join(RECIPE_DIR, `${name}.yaml`);
+}
+
+function signalsFromFixture(f: (typeof mixedFixtures)[number]): Signals {
+  return makeSignals({
+    planMode: f.planMode,
+    messageCount: f.messageCount,
+    toolUseCount: f.toolUseCount,
+    estInputTokens: f.estInputTokens,
+    frustration: f.frustration,
+    retryCount: f.retryCount,
+  });
+}
+
+async function loadRecipeRules(name: string): Promise<ReturnType<typeof loadRules>> {
+  const yamlText = readFileSync(recipePath(name), 'utf8');
+  const parsed = yamlLoad(yamlText, { schema: CORE_SCHEMA }) as { rules?: unknown };
+  return loadRules(parsed.rules, { modelTiers: {} });
+}
+
+describe('recipes — load cleanly via section-03 loader', () => {
+  it.each(['frugal', 'balanced', 'opus-forward'] as const)(
+    'recipes_%sYaml_loadsWithoutErrors',
+    async (name) => {
+      const r = await loadConfig(recipePath(name));
+      expect(r.ok).toBe(true);
+      if (r.ok) {
+        expect(r.value.config.rules.length).toBeGreaterThan(0);
+      }
+    },
+  );
+});
+
+describe('recipes — strict DSL validation', () => {
+  it.each(['frugal', 'balanced', 'opus-forward'] as const)(
+    'recipes_%s_passesStrictLoad',
+    async (name) => {
+      const r = await loadRecipeRules(name);
+      expect(r.ok).toBe(true);
+    },
+  );
+});
+
+describe('recipes — balanced routing ratio', () => {
+  it('recipes_balanced_routesAtLeast30PercentToHaikuDirectly', async () => {
+    const r = await loadRecipeRules('balanced');
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const rules = r.value;
+    const haikuMatches = mixedFixtures
+      .map(signalsFromFixture)
+      .map((s) => evaluate(rules, s))
+      .filter((v) => v.kind === 'matched' && 'choice' in v.result && v.result.choice === 'haiku');
+    const ratio = haikuMatches.length / mixedFixtures.length;
+    expect(ratio).toBeGreaterThanOrEqual(0.3);
+  });
+});
+
+describe('recipes — opus-forward routing ratio', () => {
+  it('recipes_opusForward_routesMostNonTrivialToOpus', async () => {
+    const r = await loadRecipeRules('opus-forward');
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const rules = r.value;
+    const decisions = mixedFixtures.map(signalsFromFixture).map((s) => evaluate(rules, s));
+    const nonHaiku = decisions.filter(
+      (d) => !(d.kind === 'matched' && 'choice' in d.result && d.result.choice === 'haiku'),
+    );
+    const opusCount = nonHaiku.filter(
+      (d) => d.kind === 'matched' && 'choice' in d.result && d.result.choice === 'opus',
+    ).length;
+    const ratio = opusCount / nonHaiku.length;
+    expect(ratio).toBeGreaterThanOrEqual(0.6);
+  });
+});
+
+describe('recipes — frugal routing for tiny requests', () => {
+  it('recipes_frugal_emitsHaikuForEveryTinyRequest', async () => {
+    const r = await loadRecipeRules('frugal');
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const rules = r.value;
+    for (const f of mixedFixtures) {
+      if (f.messageCount < 6 && f.toolUseCount === 0 && !f.planMode && !f.frustration) {
+        const result = evaluate(rules, signalsFromFixture(f));
+        expect(result.kind, `fixture ${f.name}`).toBe('matched');
+        if (result.kind === 'matched' && 'choice' in result.result) {
+          expect(result.result.choice, `fixture ${f.name}`).toBe('haiku');
+        }
+      }
+    }
+  });
+});
