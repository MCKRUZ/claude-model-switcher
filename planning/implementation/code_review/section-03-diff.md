diff --git a/src/config/defaults.ts b/src/config/defaults.ts
index ccc606b..ae646b3 100644
--- a/src/config/defaults.ts
+++ b/src/config/defaults.ts
@@ -1,2 +1,25 @@
-// Populated in section-03. Do not import.
-export {};
+import type { CcmuxConfig } from './schema.js';
+
+export function defaultConfig(): CcmuxConfig {
+  return {
+    port: 8787,
+    mode: 'live',
+    security: { requireProxyToken: false },
+    rules: [],
+    classifier: {
+      enabled: true,
+      model: 'claude-haiku-4-5-20251001',
+      timeoutMs: 800,
+      confidenceThresholds: { haiku: 0.6, heuristic: 0.4 },
+    },
+    stickyModel: { enabled: true, sessionTtlMs: 7_200_000 },
+    modelTiers: {},
+    logging: {
+      content: 'hashed',
+      fsync: false,
+      rotation: { strategy: 'daily', keep: 30, maxMb: 10 },
+    },
+    dashboard: { port: 8788 },
+    pricing: {},
+  };
+}
diff --git a/src/config/index.ts b/src/config/index.ts
new file mode 100644
index 0000000..90be01b
--- /dev/null
+++ b/src/config/index.ts
@@ -0,0 +1,22 @@
+export type {
+  CcmuxConfig,
+  CcmuxRule,
+  ClassifierConfig,
+  ClassifierThresholds,
+  ConfigError,
+  ConfigMode,
+  ContentMode,
+  DashboardConfig,
+  LoggingConfig,
+  LoggingRotation,
+  PricingEntry,
+  RotationStrategy,
+  SecurityConfig,
+  StickyModelConfig,
+  Tier,
+  ValidateResult,
+} from './schema.js';
+export { defaultConfig } from './defaults.js';
+export { validateConfig } from './validate.js';
+export { loadConfig, type LoadedConfig } from './loader.js';
+export { resolvePaths, ensureDirs, type CcmuxPaths } from './paths.js';
diff --git a/src/config/load.ts b/src/config/load.ts
deleted file mode 100644
index ccc606b..0000000
--- a/src/config/load.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-// Populated in section-03. Do not import.
-export {};
diff --git a/src/config/loader.ts b/src/config/loader.ts
new file mode 100644
index 0000000..9599649
--- /dev/null
+++ b/src/config/loader.ts
@@ -0,0 +1,48 @@
+// ccmux YAML config loader. Pure-async; no IO at import time.
+
+import { readFile } from 'node:fs/promises';
+import yaml from 'js-yaml';
+import { defaultConfig } from './defaults.js';
+import { resolvePaths } from './paths.js';
+import type { CcmuxConfig, ConfigError } from './schema.js';
+import { validateConfig } from './validate.js';
+import { fail, ok, type Result } from '../types/result.js';
+
+export interface LoadedConfig {
+  readonly config: CcmuxConfig;
+  readonly warnings: readonly ConfigError[];
+}
+
+async function readFileIfExists(p: string): Promise<string | null> {
+  try {
+    return await readFile(p, 'utf8');
+  } catch (err) {
+    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
+    throw err;
+  }
+}
+
+export async function loadConfig(
+  path?: string,
+): Promise<Result<LoadedConfig, ConfigError[]>> {
+  const resolved = path ?? resolvePaths().configFile;
+  const contents = await readFileIfExists(resolved);
+  if (contents === null) {
+    return ok({ config: defaultConfig(), warnings: [] });
+  }
+  // anthropic-forward-compat: yaml returns unknown
+  let parsed: unknown;
+  try {
+    parsed = yaml.load(contents);
+  } catch (err) {
+    const msg = err instanceof Error ? err.message : String(err);
+    return fail<ConfigError[]>([
+      { path: '/', message: `invalid YAML: ${msg}`, severity: 'error' },
+    ]);
+  }
+  const result = validateConfig(parsed);
+  if (result.errors.length > 0) {
+    return fail<ConfigError[]>([...result.errors]);
+  }
+  return ok({ config: result.config, warnings: result.warnings });
+}
diff --git a/src/config/schema.ts b/src/config/schema.ts
index ccc606b..b613d77 100644
--- a/src/config/schema.ts
+++ b/src/config/schema.ts
@@ -1,2 +1,83 @@
-// Populated in section-03. Do not import.
-export {};
+// TypeScript types for the ccmux configuration file.
+// Validator lives in ./validate.ts; loader lives in ./loader.ts.
+
+export interface ConfigError {
+  readonly path: string;
+  readonly message: string;
+  readonly severity: 'error' | 'warning';
+}
+
+export type ConfigMode = 'live' | 'shadow';
+export type ContentMode = 'hashed' | 'full' | 'none';
+export type RotationStrategy = 'daily' | 'size' | 'none';
+export type Tier = 'haiku' | 'sonnet' | 'opus';
+
+export interface CcmuxRule {
+  readonly id: string;
+  readonly when: Readonly<Record<string, unknown>>;
+  readonly then: { readonly choice: string; readonly [key: string]: unknown };
+  readonly allowDowngrade?: boolean;
+}
+
+export interface ClassifierThresholds {
+  readonly haiku: number;
+  readonly heuristic: number;
+}
+
+export interface ClassifierConfig {
+  readonly enabled: boolean;
+  readonly model: string;
+  readonly timeoutMs: number;
+  readonly confidenceThresholds: ClassifierThresholds;
+}
+
+export interface StickyModelConfig {
+  readonly enabled: boolean;
+  readonly sessionTtlMs: number;
+}
+
+export interface LoggingRotation {
+  readonly strategy: RotationStrategy;
+  readonly keep: number;
+  readonly maxMb: number;
+}
+
+export interface LoggingConfig {
+  readonly content: ContentMode;
+  readonly fsync: boolean;
+  readonly rotation: LoggingRotation;
+}
+
+export interface DashboardConfig {
+  readonly port: number;
+}
+
+export interface PricingEntry {
+  readonly input: number;
+  readonly output: number;
+  readonly cacheRead: number;
+  readonly cacheCreate: number;
+}
+
+export interface SecurityConfig {
+  readonly requireProxyToken: boolean;
+}
+
+export interface CcmuxConfig {
+  readonly port: number;
+  readonly mode: ConfigMode;
+  readonly security: SecurityConfig;
+  readonly rules: readonly CcmuxRule[];
+  readonly classifier: ClassifierConfig;
+  readonly stickyModel: StickyModelConfig;
+  readonly modelTiers: Readonly<Record<string, Tier>>;
+  readonly logging: LoggingConfig;
+  readonly dashboard: DashboardConfig;
+  readonly pricing: Readonly<Record<string, PricingEntry>>;
+}
+
+export interface ValidateResult {
+  readonly config: CcmuxConfig;
+  readonly errors: readonly ConfigError[];
+  readonly warnings: readonly ConfigError[];
+}
diff --git a/src/config/validate-rules.ts b/src/config/validate-rules.ts
new file mode 100644
index 0000000..247edcf
--- /dev/null
+++ b/src/config/validate-rules.ts
@@ -0,0 +1,120 @@
+// Rule-shape validation at load time. Full rule-DSL semantics live in section-08-policy.
+
+import type { CcmuxRule, ConfigError } from './schema.js';
+
+type Obj = Record<string, unknown>;
+
+interface ErrorSink {
+  err(path: string, message: string): void;
+  warn(path: string, message: string): void;
+}
+
+function isObj(v: unknown): v is Obj {
+  return typeof v === 'object' && v !== null && !Array.isArray(v);
+}
+
+function warnUnknownKeys(
+  v: Obj,
+  known: readonly string[],
+  base: string,
+  sink: ErrorSink,
+): void {
+  for (const k of Object.keys(v)) {
+    if (!known.includes(k)) {
+      sink.warn(`${base}/${k}`, 'unknown key (forward-compat)');
+    }
+  }
+}
+
+function readRuleThen(
+  v: Obj,
+  path: string,
+  sink: ErrorSink,
+): { choice: string; rest: Obj } {
+  const raw = v['then'];
+  if (raw === undefined) {
+    sink.err(`${path}/then`, 'required object');
+    return { choice: '', rest: {} };
+  }
+  if (!isObj(raw)) {
+    sink.err(`${path}/then`, 'must be an object');
+    return { choice: '', rest: {} };
+  }
+  const choice = raw['choice'];
+  if (typeof choice !== 'string' || choice.length === 0) {
+    sink.err(`${path}/then/choice`, 'required non-empty string');
+    return { choice: '', rest: raw };
+  }
+  return { choice, rest: raw };
+}
+
+function readRuleWhen(v: Obj, path: string, sink: ErrorSink): Obj {
+  const raw = v['when'];
+  if (raw === undefined) {
+    sink.err(`${path}/when`, 'required object');
+    return {};
+  }
+  if (!isObj(raw)) {
+    sink.err(`${path}/when`, 'must be an object');
+    return {};
+  }
+  return raw;
+}
+
+function readRuleId(v: Obj, path: string, sink: ErrorSink): string {
+  const raw = v['id'];
+  if (typeof raw !== 'string' || raw.length === 0) {
+    sink.err(`${path}/id`, 'required non-empty string');
+    return '';
+  }
+  return raw;
+}
+
+export function validateRule(
+  v: unknown,
+  path: string,
+  sink: ErrorSink,
+): CcmuxRule | null {
+  if (!isObj(v)) {
+    sink.err(path, 'rule must be an object');
+    return null;
+  }
+  warnUnknownKeys(v, ['id', 'when', 'then', 'allowDowngrade'], path, sink);
+  const id = readRuleId(v, path, sink);
+  const when = readRuleWhen(v, path, sink);
+  const { choice, rest } = readRuleThen(v, path, sink);
+  const base: CcmuxRule = { id, when, then: { ...rest, choice } };
+  if (typeof v['allowDowngrade'] === 'boolean') {
+    return { ...base, allowDowngrade: v['allowDowngrade'] };
+  }
+  return base;
+}
+
+export function validateRules(
+  v: unknown,
+  path: string,
+  sink: ErrorSink,
+): readonly CcmuxRule[] {
+  if (v === undefined) return [];
+  if (!Array.isArray(v)) {
+    sink.err(path, 'must be an array');
+    return [];
+  }
+  const seen = new Set<string>();
+  const out: CcmuxRule[] = [];
+  v.forEach((item, i) => {
+    const rule = validateRule(item, `${path}/${i}`, sink);
+    if (!rule) return;
+    if (rule.id.length > 0) {
+      if (seen.has(rule.id)) {
+        sink.err(`${path}/${i}/id`, `duplicate rule id "${rule.id}"`);
+      } else {
+        seen.add(rule.id);
+      }
+    }
+    out.push(rule);
+  });
+  return out;
+}
+
+export type { ConfigError };
diff --git a/src/config/validate.ts b/src/config/validate.ts
new file mode 100644
index 0000000..3b26683
--- /dev/null
+++ b/src/config/validate.ts
@@ -0,0 +1,311 @@
+// Top-level config validator. Forward-compat: unknown keys warn, type mismatches on known keys error.
+
+import { defaultConfig } from './defaults.js';
+import type {
+  CcmuxConfig,
+  ClassifierConfig,
+  ClassifierThresholds,
+  ConfigError,
+  ConfigMode,
+  ContentMode,
+  DashboardConfig,
+  LoggingConfig,
+  LoggingRotation,
+  PricingEntry,
+  RotationStrategy,
+  SecurityConfig,
+  StickyModelConfig,
+  Tier,
+  ValidateResult,
+} from './schema.js';
+import { validateRules } from './validate-rules.js';
+
+type Obj = Record<string, unknown>;
+
+const KNOWN_TOP: readonly string[] = [
+  'port',
+  'mode',
+  'security',
+  'rules',
+  'classifier',
+  'stickyModel',
+  'modelTiers',
+  'logging',
+  'dashboard',
+  'pricing',
+];
+const CONTENT_MODES: readonly ContentMode[] = ['hashed', 'full', 'none'];
+const ROTATION_STRATEGIES: readonly RotationStrategy[] = ['daily', 'size', 'none'];
+const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
+const MODES: readonly ConfigMode[] = ['live', 'shadow'];
+
+class Issues {
+  readonly errors: ConfigError[] = [];
+  readonly warnings: ConfigError[] = [];
+  err(path: string, message: string): void {
+    this.errors.push({ path, message, severity: 'error' });
+  }
+  warn(path: string, message: string): void {
+    this.warnings.push({ path, message, severity: 'warning' });
+  }
+}
+
+function isObj(v: unknown): v is Obj {
+  return typeof v === 'object' && v !== null && !Array.isArray(v);
+}
+function isInt(v: unknown): v is number {
+  return typeof v === 'number' && Number.isInteger(v);
+}
+function isFiniteNum(v: unknown): v is number {
+  return typeof v === 'number' && Number.isFinite(v);
+}
+
+function warnUnknown(
+  obj: Obj,
+  known: readonly string[],
+  base: string,
+  issues: Issues,
+): void {
+  for (const k of Object.keys(obj)) {
+    if (!known.includes(k)) {
+      issues.warn(`${base}/${k}`, 'unknown key (forward-compat)');
+    }
+  }
+}
+
+function readBool(v: Obj, key: string, base: string, issues: Issues, def: boolean): boolean {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (typeof val !== 'boolean') {
+    issues.err(`${base}/${key}`, 'must be boolean');
+    return def;
+  }
+  return val;
+}
+
+function readNonEmptyString(
+  v: Obj, key: string, base: string, issues: Issues, def: string,
+): string {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (typeof val !== 'string' || val.length === 0) {
+    issues.err(`${base}/${key}`, 'must be a non-empty string');
+    return def;
+  }
+  return val;
+}
+
+function readNonNegInt(
+  v: Obj, key: string, base: string, issues: Issues, def: number,
+): number {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (!isInt(val) || val < 0) {
+    issues.err(`${base}/${key}`, 'must be a non-negative integer');
+    return def;
+  }
+  return val;
+}
+
+function readNonNegNum(
+  v: Obj, key: string, base: string, issues: Issues, def: number,
+): number {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (!isFiniteNum(val) || val < 0) {
+    issues.err(`${base}/${key}`, 'must be a non-negative number');
+    return def;
+  }
+  return val;
+}
+
+function readEnum<T extends string>(
+  v: Obj, key: string, base: string, issues: Issues, choices: readonly T[], def: T,
+): T {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (typeof val !== 'string' || !(choices as readonly string[]).includes(val)) {
+    issues.err(`${base}/${key}`, `must be one of ${choices.join(', ')}`);
+    return def;
+  }
+  return val as T;
+}
+
+function readNumInRange(
+  v: Obj, key: string, base: string, issues: Issues,
+  min: number, max: number, def: number,
+): number {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (!isFiniteNum(val) || val < min || val > max) {
+    issues.err(`${base}/${key}`, `must be a number in [${min}, ${max}]`);
+    return def;
+  }
+  return val;
+}
+
+function readPort(
+  v: Obj, key: string, base: string, issues: Issues, def: number,
+): number {
+  const val = v[key];
+  if (val === undefined) return def;
+  if (!isInt(val) || val < 1 || val > 65535) {
+    issues.err(`${base}/${key}`, 'must be an integer in [1, 65535]');
+    return def;
+  }
+  return val;
+}
+
+function validateSecurity(v: unknown, path: string, issues: Issues, def: SecurityConfig): SecurityConfig {
+  if (v === undefined) return def;
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['requireProxyToken'], path, issues);
+  return { requireProxyToken: readBool(v, 'requireProxyToken', path, issues, def.requireProxyToken) };
+}
+
+function validateThresholds(
+  v: unknown, path: string, issues: Issues, def: ClassifierThresholds,
+): ClassifierThresholds {
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['haiku', 'heuristic'], path, issues);
+  return {
+    haiku: readNumInRange(v, 'haiku', path, issues, 0, 1, def.haiku),
+    heuristic: readNumInRange(v, 'heuristic', path, issues, 0, 1, def.heuristic),
+  };
+}
+
+function validateClassifier(
+  v: unknown, path: string, issues: Issues, def: ClassifierConfig,
+): ClassifierConfig {
+  if (v === undefined) return def;
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['enabled', 'model', 'timeoutMs', 'confidenceThresholds'], path, issues);
+  const thresholds = v['confidenceThresholds'] === undefined
+    ? def.confidenceThresholds
+    : validateThresholds(v['confidenceThresholds'], `${path}/confidenceThresholds`, issues, def.confidenceThresholds);
+  return {
+    enabled: readBool(v, 'enabled', path, issues, def.enabled),
+    model: readNonEmptyString(v, 'model', path, issues, def.model),
+    timeoutMs: readNonNegInt(v, 'timeoutMs', path, issues, def.timeoutMs),
+    confidenceThresholds: thresholds,
+  };
+}
+
+function validateStickyModel(
+  v: unknown, path: string, issues: Issues, def: StickyModelConfig,
+): StickyModelConfig {
+  if (v === undefined) return def;
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['enabled', 'sessionTtlMs'], path, issues);
+  return {
+    enabled: readBool(v, 'enabled', path, issues, def.enabled),
+    sessionTtlMs: readNonNegInt(v, 'sessionTtlMs', path, issues, def.sessionTtlMs),
+  };
+}
+
+function validateModelTiers(
+  v: unknown, path: string, issues: Issues,
+): Readonly<Record<string, Tier>> {
+  if (v === undefined) return {};
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return {}; }
+  const out: Record<string, Tier> = {};
+  for (const [k, val] of Object.entries(v)) {
+    if (typeof val !== 'string' || !(TIERS as readonly string[]).includes(val)) {
+      issues.err(`${path}/${k}`, `must be one of ${TIERS.join(', ')}`);
+    } else {
+      out[k] = val as Tier;
+    }
+  }
+  return out;
+}
+
+function validateRotation(
+  v: unknown, path: string, issues: Issues, def: LoggingRotation,
+): LoggingRotation {
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['strategy', 'keep', 'maxMb'], path, issues);
+  return {
+    strategy: readEnum(v, 'strategy', path, issues, ROTATION_STRATEGIES, def.strategy),
+    keep: readNonNegInt(v, 'keep', path, issues, def.keep),
+    maxMb: readNonNegNum(v, 'maxMb', path, issues, def.maxMb),
+  };
+}
+
+function validateLogging(
+  v: unknown, path: string, issues: Issues, def: LoggingConfig,
+): LoggingConfig {
+  if (v === undefined) return def;
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['content', 'fsync', 'rotation'], path, issues);
+  const rotation = v['rotation'] === undefined
+    ? def.rotation
+    : validateRotation(v['rotation'], `${path}/rotation`, issues, def.rotation);
+  return {
+    content: readEnum(v, 'content', path, issues, CONTENT_MODES, def.content),
+    fsync: readBool(v, 'fsync', path, issues, def.fsync),
+    rotation,
+  };
+}
+
+function validateDashboard(
+  v: unknown, path: string, issues: Issues, def: DashboardConfig,
+): DashboardConfig {
+  if (v === undefined) return def;
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
+  warnUnknown(v, ['port'], path, issues);
+  return { port: readPort(v, 'port', path, issues, def.port) };
+}
+
+function validatePricingEntry(v: unknown, path: string, issues: Issues): PricingEntry | null {
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return null; }
+  warnUnknown(v, ['input', 'output', 'cacheRead', 'cacheCreate'], path, issues);
+  const fields = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;
+  const out: Record<(typeof fields)[number], number> = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
+  let valid = true;
+  for (const f of fields) {
+    const val = v[f];
+    if (val === undefined) { issues.err(`${path}/${f}`, 'missing required number'); valid = false; continue; }
+    if (!isFiniteNum(val) || val < 0) { issues.err(`${path}/${f}`, 'must be a non-negative number'); valid = false; continue; }
+    out[f] = val;
+  }
+  return valid ? out : null;
+}
+
+function validatePricing(
+  v: unknown, path: string, issues: Issues,
+): Readonly<Record<string, PricingEntry>> {
+  if (v === undefined) return {};
+  if (!isObj(v)) { issues.err(path, 'must be an object'); return {}; }
+  const out: Record<string, PricingEntry> = {};
+  for (const [model, entry] of Object.entries(v)) {
+    const parsed = validatePricingEntry(entry, `${path}/${model}`, issues);
+    if (parsed) out[model] = parsed;
+  }
+  return out;
+}
+
+export function validateConfig(raw: unknown): ValidateResult {
+  const issues = new Issues();
+  const def = defaultConfig();
+  if (raw === undefined || raw === null) {
+    return { config: def, errors: [], warnings: [] };
+  }
+  if (!isObj(raw)) {
+    issues.err('/', 'root must be a mapping');
+    return { config: def, errors: issues.errors, warnings: issues.warnings };
+  }
+  warnUnknown(raw, KNOWN_TOP, '', issues);
+  const config: CcmuxConfig = {
+    port: readPort(raw, 'port', '', issues, def.port),
+    mode: readEnum(raw, 'mode', '', issues, MODES, def.mode),
+    security: validateSecurity(raw['security'], '/security', issues, def.security),
+    rules: validateRules(raw['rules'], '/rules', issues),
+    classifier: validateClassifier(raw['classifier'], '/classifier', issues, def.classifier),
+    stickyModel: validateStickyModel(raw['stickyModel'], '/stickyModel', issues, def.stickyModel),
+    modelTiers: validateModelTiers(raw['modelTiers'], '/modelTiers', issues),
+    logging: validateLogging(raw['logging'], '/logging', issues, def.logging),
+    dashboard: validateDashboard(raw['dashboard'], '/dashboard', issues, def.dashboard),
+    pricing: validatePricing(raw['pricing'], '/pricing', issues),
+  };
+  return { config, errors: issues.errors, warnings: issues.warnings };
+}
diff --git a/src/types/result.ts b/src/types/result.ts
new file mode 100644
index 0000000..904f354
--- /dev/null
+++ b/src/types/result.ts
@@ -0,0 +1,11 @@
+export type Result<T, E> =
+  | { readonly ok: true; readonly value: T }
+  | { readonly ok: false; readonly error: E };
+
+export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
+  return { ok: true, value };
+}
+
+export function fail<E>(error: E): { readonly ok: false; readonly error: E } {
+  return { ok: false, error };
+}
diff --git a/tests/config/loader.test.ts b/tests/config/loader.test.ts
new file mode 100644
index 0000000..e6585b4
--- /dev/null
+++ b/tests/config/loader.test.ts
@@ -0,0 +1,130 @@
+import { describe, it, expect } from 'vitest';
+import { join } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { dirname } from 'node:path';
+import { loadConfig } from '../../src/config/loader.js';
+import { resolvePaths } from '../../src/config/paths.js';
+
+const here = dirname(fileURLToPath(import.meta.url));
+const fixtures = join(here, '..', 'fixtures', 'config');
+
+function fx(name: string): string {
+  return join(fixtures, name);
+}
+
+describe('loadConfig — missing file', () => {
+  it('loadConfig_missingFile_returnsDefaults', async () => {
+    const r = await loadConfig(join(fixtures, 'does-not-exist.yaml'));
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    expect(r.value.warnings).toEqual([]);
+    expect(r.value.config.port).toBe(8787);
+    expect(r.value.config.mode).toBe('live');
+    expect(r.value.config.classifier.enabled).toBe(true);
+  });
+});
+
+describe('loadConfig — minimal fixture', () => {
+  it('loadConfig_minimalValid_returnsDefaultsMerged', async () => {
+    const r = await loadConfig(fx('minimal.yaml'));
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    expect(r.value.config.port).toBe(9000);
+    expect(r.value.config.classifier.timeoutMs).toBe(800);
+    expect(r.value.config.logging.rotation.strategy).toBe('daily');
+    expect(r.value.warnings).toEqual([]);
+  });
+});
+
+describe('loadConfig — full canonical fixture', () => {
+  it('loadConfig_fullExample_acceptsEveryDocumentedKey', async () => {
+    const r = await loadConfig(fx('full.yaml'));
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    expect(r.value.warnings).toEqual([]);
+    expect(r.value.config.rules).toHaveLength(1);
+    expect(r.value.config.rules[0]?.id).toBe('plan-mode-opus');
+    expect(r.value.config.rules[0]?.then.choice).toBe('opus');
+    expect(r.value.config.modelTiers['claude-opus-4-7']).toBe('opus');
+    const opusPricing = r.value.config.pricing['claude-opus-4-7'];
+    expect(opusPricing?.input).toBe(15);
+    expect(opusPricing?.cacheCreate).toBe(18.75);
+  });
+});
+
+describe('loadConfig — forward compatibility', () => {
+  it('loadConfig_unknownTopLevelKey_warnsButSucceeds', async () => {
+    const r = await loadConfig(fx('unknown-top.yaml'));
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const warn = r.value.warnings.find((w) => w.path === '/telemetry');
+    expect(warn).toBeDefined();
+    expect(warn?.severity).toBe('warning');
+  });
+
+  it('loadConfig_unknownNestedKey_warnsButSucceeds', async () => {
+    const r = await loadConfig(fx('unknown-nested.yaml'));
+    expect(r.ok).toBe(true);
+    if (!r.ok) return;
+    const warn = r.value.warnings.find(
+      (w) => w.path === '/classifier/futureFlag',
+    );
+    expect(warn).toBeDefined();
+    expect(warn?.severity).toBe('warning');
+  });
+});
+
+describe('loadConfig — error paths', () => {
+  it('loadConfig_invalidYaml_returnsError', async () => {
+    const r = await loadConfig(fx('invalid-yaml.yaml'));
+    expect(r.ok).toBe(false);
+    if (r.ok) return;
+    expect(r.error).toHaveLength(1);
+    expect(r.error[0]?.path).toBe('/');
+    expect(r.error[0]?.severity).toBe('error');
+  });
+
+  it('loadConfig_invalidRuleShape_pointsToBadPath', async () => {
+    const r = await loadConfig(fx('invalid-rule.yaml'));
+    expect(r.ok).toBe(false);
+    if (r.ok) return;
+    const missing = r.error.find((e) => e.path === '/rules/0/then/choice');
+    expect(missing).toBeDefined();
+  });
+
+  it('loadConfig_invalidEnum_pointsToBadPath', async () => {
+    const r = await loadConfig(fx('invalid-enum.yaml'));
+    expect(r.ok).toBe(false);
+    if (r.ok) return;
+    const err = r.error.find((e) => e.path === '/mode');
+    expect(err).toBeDefined();
+  });
+
+  it('loadConfig_badPricing_pointsToModel', async () => {
+    const r = await loadConfig(fx('bad-pricing.yaml'));
+    expect(r.ok).toBe(false);
+    if (r.ok) return;
+    const err = r.error.find(
+      (e) => e.path === '/pricing/claude-opus-4-7/input',
+    );
+    expect(err).toBeDefined();
+  });
+});
+
+describe('loadConfig — cross-platform paths', () => {
+  it('loadConfig_crossPlatformPath_resolves', () => {
+    const posix = resolvePaths(
+      { XDG_CONFIG_HOME: '/home/u/.config' },
+      'linux',
+    );
+    expect(posix.configFile).toBe(join('/home/u/.config', 'ccmux', 'config.yaml'));
+
+    const win = resolvePaths(
+      { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
+      'win32',
+    );
+    expect(win.configFile).toBe(
+      join('C:\\Users\\u\\AppData\\Roaming', 'ccmux', 'config.yaml'),
+    );
+  });
+});
diff --git a/tests/config/schema.test.ts b/tests/config/schema.test.ts
new file mode 100644
index 0000000..3ec64fb
--- /dev/null
+++ b/tests/config/schema.test.ts
@@ -0,0 +1,57 @@
+import { describe, it, expect } from 'vitest';
+import { validateConfig } from '../../src/config/validate.js';
+
+describe('schema — port range', () => {
+  it('schema_portOutOfRange_fails', () => {
+    const low = validateConfig({ port: 0 });
+    expect(low.errors.some((e) => e.path === '/port')).toBe(true);
+
+    const high = validateConfig({ port: 70000 });
+    expect(high.errors.some((e) => e.path === '/port')).toBe(true);
+  });
+});
+
+describe('schema — logging enums', () => {
+  it('schema_loggingContent_enumEnforced', () => {
+    const r = validateConfig({ logging: { content: 'verbose' } });
+    expect(r.errors.some((e) => e.path === '/logging/content')).toBe(true);
+  });
+
+  it('schema_rotationStrategy_enumEnforced', () => {
+    const r = validateConfig({
+      logging: { rotation: { strategy: 'hourly' } },
+    });
+    expect(r.errors.some((e) => e.path === '/logging/rotation/strategy')).toBe(
+      true,
+    );
+  });
+});
+
+describe('schema — model tiers', () => {
+  it('schema_modelTiers_valueEnumEnforced', () => {
+    const r = validateConfig({ modelTiers: { 'some-model': 'ultra' } });
+    expect(r.errors.some((e) => e.path === '/modelTiers/some-model')).toBe(
+      true,
+    );
+  });
+});
+
+describe('schema — sticky model', () => {
+  it('schema_stickyModel_ttlNonNegative', () => {
+    const r = validateConfig({ stickyModel: { sessionTtlMs: -1 } });
+    expect(
+      r.errors.some((e) => e.path === '/stickyModel/sessionTtlMs'),
+    ).toBe(true);
+  });
+});
+
+describe('schema — rule shape at load time', () => {
+  it('schema_rule_withOnlyIdAndThen_isValid', () => {
+    const r = validateConfig({
+      rules: [{ id: 'r1', when: {}, then: { choice: 'opus' } }],
+    });
+    expect(r.errors).toEqual([]);
+    expect(r.config.rules).toHaveLength(1);
+    expect(r.config.rules[0]?.id).toBe('r1');
+  });
+});
diff --git a/tests/fixtures/config/bad-pricing.yaml b/tests/fixtures/config/bad-pricing.yaml
new file mode 100644
index 0000000..bdb6812
--- /dev/null
+++ b/tests/fixtures/config/bad-pricing.yaml
@@ -0,0 +1,6 @@
+pricing:
+  claude-opus-4-7:
+    input: "oops"
+    output: 75
+    cacheRead: 1.5
+    cacheCreate: 18.75
diff --git a/tests/fixtures/config/full.yaml b/tests/fixtures/config/full.yaml
new file mode 100644
index 0000000..ea27ccf
--- /dev/null
+++ b/tests/fixtures/config/full.yaml
@@ -0,0 +1,45 @@
+port: 8787
+mode: live
+
+security:
+  requireProxyToken: false
+
+rules:
+  - id: plan-mode-opus
+    when: { planMode: true }
+    then: { choice: opus }
+
+classifier:
+  enabled: true
+  model: claude-haiku-4-5-20251001
+  timeoutMs: 800
+  confidenceThresholds:
+    haiku: 0.6
+    heuristic: 0.4
+
+stickyModel:
+  enabled: true
+  sessionTtlMs: 7200000
+
+modelTiers:
+  claude-opus-4-7: opus
+  claude-sonnet-4-6: sonnet
+  claude-haiku-4-5-20251001: haiku
+
+logging:
+  content: hashed
+  fsync: false
+  rotation:
+    strategy: daily
+    keep: 30
+    maxMb: 10
+
+dashboard:
+  port: 8788
+
+pricing:
+  claude-opus-4-7:
+    input: 15
+    output: 75
+    cacheRead: 1.5
+    cacheCreate: 18.75
diff --git a/tests/fixtures/config/invalid-enum.yaml b/tests/fixtures/config/invalid-enum.yaml
new file mode 100644
index 0000000..8aca8b6
--- /dev/null
+++ b/tests/fixtures/config/invalid-enum.yaml
@@ -0,0 +1 @@
+mode: weird
diff --git a/tests/fixtures/config/invalid-rule.yaml b/tests/fixtures/config/invalid-rule.yaml
new file mode 100644
index 0000000..8917358
--- /dev/null
+++ b/tests/fixtures/config/invalid-rule.yaml
@@ -0,0 +1,4 @@
+rules:
+  - id: broken
+    when: {}
+    then: {}
diff --git a/tests/fixtures/config/invalid-yaml.yaml b/tests/fixtures/config/invalid-yaml.yaml
new file mode 100644
index 0000000..6b326e2
--- /dev/null
+++ b/tests/fixtures/config/invalid-yaml.yaml
@@ -0,0 +1,4 @@
+port: 8787
+rules:
+  - id: broken
+    when: { unclosed
diff --git a/tests/fixtures/config/minimal.yaml b/tests/fixtures/config/minimal.yaml
new file mode 100644
index 0000000..0d27615
--- /dev/null
+++ b/tests/fixtures/config/minimal.yaml
@@ -0,0 +1 @@
+port: 9000
diff --git a/tests/fixtures/config/unknown-nested.yaml b/tests/fixtures/config/unknown-nested.yaml
new file mode 100644
index 0000000..bfb71a3
--- /dev/null
+++ b/tests/fixtures/config/unknown-nested.yaml
@@ -0,0 +1,3 @@
+classifier:
+  enabled: true
+  futureFlag: true
diff --git a/tests/fixtures/config/unknown-top.yaml b/tests/fixtures/config/unknown-top.yaml
new file mode 100644
index 0000000..26427e8
--- /dev/null
+++ b/tests/fixtures/config/unknown-top.yaml
@@ -0,0 +1,4 @@
+port: 8787
+telemetry:
+  enabled: true
+  endpoint: https://example.invalid/metrics
