// Top-level config validator. Forward-compat: unknown keys warn, type mismatches on known keys error.

import { defaultConfig } from './defaults.js';
import type {
  CcmuxConfig,
  ClassifierConfig,
  ClassifierThresholds,
  ConfigError,
  ConfigMode,
  ContentMode,
  DashboardConfig,
  LoggingConfig,
  LoggingRotation,
  PricingEntry,
  RotationStrategy,
  SecurityConfig,
  StickyModelConfig,
  Tier,
  ValidateResult,
} from './schema.js';
import { validateRules } from './validate-rules.js';

type Obj = Record<string, unknown>;

const KNOWN_TOP: readonly string[] = [
  'port',
  'mode',
  'security',
  'rules',
  'classifier',
  'stickyModel',
  'modelTiers',
  'logging',
  'dashboard',
  'pricing',
];
const CONTENT_MODES: readonly ContentMode[] = ['hashed', 'full', 'none'];
const ROTATION_STRATEGIES: readonly RotationStrategy[] = ['daily', 'size', 'none'];
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus'];
const MODES: readonly ConfigMode[] = ['live', 'shadow'];

class Issues {
  readonly errors: ConfigError[] = [];
  readonly warnings: ConfigError[] = [];
  err(path: string, message: string): void {
    this.errors.push({ path, message, severity: 'error' });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message, severity: 'warning' });
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function warnUnknown(
  obj: Obj,
  known: readonly string[],
  base: string,
  issues: Issues,
): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      issues.warn(`${base}/${k}`, 'unknown key (forward-compat)');
    }
  }
}

function readBool(v: Obj, key: string, base: string, issues: Issues, def: boolean): boolean {
  const val = v[key];
  if (val === undefined) return def;
  if (typeof val !== 'boolean') {
    issues.err(`${base}/${key}`, 'must be boolean');
    return def;
  }
  return val;
}

function readNonEmptyString(
  v: Obj, key: string, base: string, issues: Issues, def: string,
): string {
  const val = v[key];
  if (val === undefined) return def;
  if (typeof val !== 'string' || val.length === 0) {
    issues.err(`${base}/${key}`, 'must be a non-empty string');
    return def;
  }
  return val;
}

function readNonNegInt(
  v: Obj, key: string, base: string, issues: Issues, def: number,
): number {
  const val = v[key];
  if (val === undefined) return def;
  if (!isInt(val) || val < 0) {
    issues.err(`${base}/${key}`, 'must be a non-negative integer');
    return def;
  }
  return val;
}

function readNonNegNum(
  v: Obj, key: string, base: string, issues: Issues, def: number,
): number {
  const val = v[key];
  if (val === undefined) return def;
  if (!isFiniteNum(val) || val < 0) {
    issues.err(`${base}/${key}`, 'must be a non-negative number');
    return def;
  }
  return val;
}

function readEnum<T extends string>(
  v: Obj, key: string, base: string, issues: Issues, choices: readonly T[], def: T,
): T {
  const val = v[key];
  if (val === undefined) return def;
  if (typeof val !== 'string' || !(choices as readonly string[]).includes(val)) {
    issues.err(`${base}/${key}`, `must be one of ${choices.join(', ')}`);
    return def;
  }
  return val as T;
}

function readNumInRange(
  v: Obj, key: string, base: string, issues: Issues,
  min: number, max: number, def: number,
): number {
  const val = v[key];
  if (val === undefined) return def;
  if (!isFiniteNum(val) || val < min || val > max) {
    issues.err(`${base}/${key}`, `must be a number in [${min}, ${max}]`);
    return def;
  }
  return val;
}

function readPort(
  v: Obj, key: string, base: string, issues: Issues, def: number,
): number {
  const val = v[key];
  if (val === undefined) return def;
  if (!isInt(val) || val < 1 || val > 65535) {
    issues.err(`${base}/${key}`, 'must be an integer in [1, 65535]');
    return def;
  }
  return val;
}

function validateSecurity(v: unknown, path: string, issues: Issues, def: SecurityConfig): SecurityConfig {
  if (v === undefined) return def;
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['requireProxyToken'], path, issues);
  return { requireProxyToken: readBool(v, 'requireProxyToken', path, issues, def.requireProxyToken) };
}

function validateThresholds(
  v: unknown, path: string, issues: Issues, def: ClassifierThresholds,
): ClassifierThresholds {
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['haiku', 'heuristic'], path, issues);
  return {
    haiku: readNumInRange(v, 'haiku', path, issues, 0, 1, def.haiku),
    heuristic: readNumInRange(v, 'heuristic', path, issues, 0, 1, def.heuristic),
  };
}

function validateClassifier(
  v: unknown, path: string, issues: Issues, def: ClassifierConfig,
): ClassifierConfig {
  if (v === undefined) return def;
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['enabled', 'model', 'timeoutMs', 'confidenceThresholds'], path, issues);
  const thresholds = v['confidenceThresholds'] === undefined
    ? def.confidenceThresholds
    : validateThresholds(v['confidenceThresholds'], `${path}/confidenceThresholds`, issues, def.confidenceThresholds);
  return {
    enabled: readBool(v, 'enabled', path, issues, def.enabled),
    model: readNonEmptyString(v, 'model', path, issues, def.model),
    timeoutMs: readNonNegInt(v, 'timeoutMs', path, issues, def.timeoutMs),
    confidenceThresholds: thresholds,
  };
}

function validateStickyModel(
  v: unknown, path: string, issues: Issues, def: StickyModelConfig,
): StickyModelConfig {
  if (v === undefined) return def;
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['enabled', 'sessionTtlMs'], path, issues);
  return {
    enabled: readBool(v, 'enabled', path, issues, def.enabled),
    sessionTtlMs: readNonNegInt(v, 'sessionTtlMs', path, issues, def.sessionTtlMs),
  };
}

function validateModelTiers(
  v: unknown, path: string, issues: Issues,
): Readonly<Record<string, Tier>> {
  if (v === undefined) return {};
  if (!isObj(v)) { issues.err(path, 'must be an object'); return {}; }
  const out: Record<string, Tier> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string' || !(TIERS as readonly string[]).includes(val)) {
      issues.err(`${path}/${k}`, `must be one of ${TIERS.join(', ')}`);
    } else {
      out[k] = val as Tier;
    }
  }
  return out;
}

function validateRotation(
  v: unknown, path: string, issues: Issues, def: LoggingRotation,
): LoggingRotation {
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['strategy', 'keep', 'maxMb'], path, issues);
  return {
    strategy: readEnum(v, 'strategy', path, issues, ROTATION_STRATEGIES, def.strategy),
    keep: readNonNegInt(v, 'keep', path, issues, def.keep),
    maxMb: readNonNegNum(v, 'maxMb', path, issues, def.maxMb),
  };
}

function validateLogging(
  v: unknown, path: string, issues: Issues, def: LoggingConfig,
): LoggingConfig {
  if (v === undefined) return def;
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['content', 'fsync', 'rotation'], path, issues);
  const rotation = v['rotation'] === undefined
    ? def.rotation
    : validateRotation(v['rotation'], `${path}/rotation`, issues, def.rotation);
  return {
    content: readEnum(v, 'content', path, issues, CONTENT_MODES, def.content),
    fsync: readBool(v, 'fsync', path, issues, def.fsync),
    rotation,
  };
}

function validateDashboard(
  v: unknown, path: string, issues: Issues, def: DashboardConfig,
): DashboardConfig {
  if (v === undefined) return def;
  if (!isObj(v)) { issues.err(path, 'must be an object'); return def; }
  warnUnknown(v, ['port'], path, issues);
  return { port: readPort(v, 'port', path, issues, def.port) };
}

function validatePricingEntry(v: unknown, path: string, issues: Issues): PricingEntry | null {
  if (!isObj(v)) { issues.err(path, 'must be an object'); return null; }
  warnUnknown(v, ['input', 'output', 'cacheRead', 'cacheCreate'], path, issues);
  const fields = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;
  const out: Record<(typeof fields)[number], number> = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let valid = true;
  for (const f of fields) {
    const val = v[f];
    if (val === undefined) { issues.err(`${path}/${f}`, 'missing required number'); valid = false; continue; }
    if (!isFiniteNum(val) || val < 0) { issues.err(`${path}/${f}`, 'must be a non-negative number'); valid = false; continue; }
    out[f] = val;
  }
  return valid ? out : null;
}

function validatePricing(
  v: unknown, path: string, issues: Issues,
): Readonly<Record<string, PricingEntry>> {
  if (v === undefined) return {};
  if (!isObj(v)) { issues.err(path, 'must be an object'); return {}; }
  const out: Record<string, PricingEntry> = {};
  for (const [model, entry] of Object.entries(v)) {
    const parsed = validatePricingEntry(entry, `${path}/${model}`, issues);
    if (parsed) out[model] = parsed;
  }
  return out;
}

export function validateConfig(raw: unknown): ValidateResult {
  const issues = new Issues();
  const def = defaultConfig();
  if (raw === undefined || raw === null) {
    return { config: def, errors: [], warnings: [] };
  }
  if (!isObj(raw)) {
    issues.err('/', 'root must be a mapping');
    return { config: def, errors: issues.errors, warnings: issues.warnings };
  }
  warnUnknown(raw, KNOWN_TOP, '', issues);
  const config: CcmuxConfig = {
    port: readPort(raw, 'port', '', issues, def.port),
    mode: readEnum(raw, 'mode', '', issues, MODES, def.mode),
    security: validateSecurity(raw['security'], '/security', issues, def.security),
    rules: validateRules(raw['rules'], '/rules', issues),
    classifier: validateClassifier(raw['classifier'], '/classifier', issues, def.classifier),
    stickyModel: validateStickyModel(raw['stickyModel'], '/stickyModel', issues, def.stickyModel),
    modelTiers: validateModelTiers(raw['modelTiers'], '/modelTiers', issues),
    logging: validateLogging(raw['logging'], '/logging', issues, def.logging),
    dashboard: validateDashboard(raw['dashboard'], '/dashboard', issues, def.dashboard),
    pricing: validatePricing(raw['pricing'], '/pricing', issues),
  };
  return { config, errors: issues.errors, warnings: issues.warnings };
}
