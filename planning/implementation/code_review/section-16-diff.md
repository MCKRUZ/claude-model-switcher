diff --git a/src/cli/main.ts b/src/cli/main.ts
index 347237a..170e7f2 100644
--- a/src/cli/main.ts
+++ b/src/cli/main.ts
@@ -74,6 +74,7 @@ function buildProgram(
       box.code = runVersion(stdout);
     });
   registerReport(program, box, stdout, stderr);
+  registerTune(program, box, stdout, stderr);
   return program;
 }
 
@@ -97,6 +98,24 @@ function registerReport(
     });
 }
 
+function registerTune(
+  program: Command,
+  box: ActionBox,
+  stdout: NodeJS.WritableStream,
+  stderr: NodeJS.WritableStream,
+): void {
+  // Flags intentionally not declared — same reason as report (see above).
+  program
+    .command('tune')
+    .description('Suggest policy-rule changes (flags: --since <dur>, --log-dir <path>, --config <path>)')
+    .allowUnknownOption(true)
+    .helpOption(false)
+    .action(async (_cmdOpts: unknown, cmd: Command) => {
+      const { runTune } = await import('./tune.js');
+      box.code = await runTune(cmd.args as readonly string[], { stdout, stderr });
+    });
+}
+
 function handleCommanderError(err: unknown, stderr: NodeJS.WritableStream): number {
   if (err instanceof CommanderError) {
     if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') return 0;
diff --git a/src/cli/tune.ts b/src/cli/tune.ts
index edb34ae..47efd74 100644
--- a/src/cli/tune.ts
+++ b/src/cli/tune.ts
@@ -1,2 +1,147 @@
-// Populated in section-16. Do not import.
-export {};
+// `ccmux tune`: offline analyzer. Never writes to config.yaml. Emits a
+// unified diff to stdout, status messages to stderr.
+// Exit codes: 0 on a successful run (no suggestions is still success).
+//             1 on IO failure (missing log dir, unreadable config).
+//             2 on invalid --since.
+
+import { readFileSync, statSync } from 'node:fs';
+import { resolvePaths } from '../config/paths.js';
+import { parseDuration } from '../report/duration.js';
+import { analyze } from '../tune/analyze.js';
+import { suggest } from '../tune/suggest.js';
+import { renderDiff } from '../tune/diff.js';
+import { fail, ok, type Result } from '../types/result.js';
+
+export interface RunTuneOpts {
+  readonly stdout?: NodeJS.WritableStream;
+  readonly stderr?: NodeJS.WritableStream;
+  readonly now?: number;
+}
+
+interface Flags {
+  since: string;
+  logDir: string | null;
+  configPath: string | null;
+}
+
+export async function runTune(
+  argv: readonly string[],
+  opts: RunTuneOpts = {},
+): Promise<number> {
+  const stdout = opts.stdout ?? process.stdout;
+  const stderr = opts.stderr ?? process.stderr;
+
+  const parsed = parseFlags(argv);
+  if (!parsed.ok) {
+    stderr.write(`ccmux tune: ${parsed.error}\n`);
+    return 2;
+  }
+  const flags = parsed.value;
+
+  const durationResult = parseDuration(flags.since);
+  if (!durationResult.ok) {
+    stderr.write(`ccmux tune: invalid --since duration: ${flags.since}\n`);
+    return 2;
+  }
+
+  const paths = resolvePaths();
+  const logDir = flags.logDir ?? paths.decisionLogDir;
+  const configPath = flags.configPath ?? paths.configFile;
+
+  if (!validateLogDir(logDir, stderr)) return 1;
+
+  let yaml: string;
+  try {
+    yaml = readFileSync(configPath, 'utf8');
+  } catch {
+    stderr.write(`ccmux tune: config.yaml not readable: ${configPath}\n`);
+    return 1;
+  }
+
+  const now = opts.now ?? Date.now();
+  const sinceIso = new Date(now - durationResult.value).toISOString();
+
+  const result = await analyze({ logDir, since: sinceIso });
+  const suggestions = suggest(result.rules);
+  if (suggestions.length === 0) {
+    stderr.write('ccmux tune: no suggestions\n');
+    return 0;
+  }
+
+  const diffText = renderDiff(configPath, yaml, suggestions);
+  if (diffText.length === 0) {
+    stderr.write('ccmux tune: no suggestions\n');
+    return 0;
+  }
+
+  stdout.write(diffText);
+  for (const s of suggestions) {
+    stderr.write(`ccmux tune: ${s.ruleId} — ${s.rationale}\n`);
+  }
+  return 0;
+}
+
+function validateLogDir(logDir: string, stderr: NodeJS.WritableStream): boolean {
+  try {
+    const s = statSync(logDir);
+    if (!s.isDirectory()) {
+      stderr.write(`ccmux tune: log path is not a directory: ${logDir}\n`);
+      return false;
+    }
+    return true;
+  } catch {
+    stderr.write(`ccmux tune: log directory not found: ${logDir}\n`);
+    return false;
+  }
+}
+
+function parseFlags(argv: readonly string[]): Result<Flags, string> {
+  const out: Flags = { since: '7d', logDir: null, configPath: null };
+  let i = 0;
+  while (i < argv.length) {
+    const a = argv[i];
+    if (a === undefined) break;
+    const pair = splitEq(a);
+    const inline = pair.value;
+    const next = argv[i + 1];
+    const value = inline ?? next;
+    if (pair.key === '--since') {
+      const r = setFlag(out, 'since', value);
+      if (!r.ok) return fail(r.error);
+    } else if (pair.key === '--log-dir') {
+      const r = setFlag(out, 'logDir', value);
+      if (!r.ok) return fail(r.error);
+    } else if (pair.key === '--config') {
+      const r = setFlag(out, 'configPath', value);
+      if (!r.ok) return fail(r.error);
+    } else {
+      return fail(`unknown argument: ${a}`);
+    }
+    i += inline !== undefined ? 1 : 2;
+  }
+  return ok(out);
+}
+
+function setFlag(
+  out: Flags,
+  key: 'since' | 'logDir' | 'configPath',
+  value: string | undefined,
+): Result<null, string> {
+  if (value === undefined || value.length === 0) {
+    return fail(`missing value for --${cliName(key)}`);
+  }
+  out[key] = value;
+  return ok(null);
+}
+
+function cliName(key: 'since' | 'logDir' | 'configPath'): string {
+  if (key === 'logDir') return 'log-dir';
+  if (key === 'configPath') return 'config';
+  return 'since';
+}
+
+function splitEq(a: string): { readonly key: string; readonly value: string | undefined } {
+  const eq = a.indexOf('=');
+  if (eq === -1) return { key: a, value: undefined };
+  return { key: a.slice(0, eq), value: a.slice(eq + 1) };
+}
diff --git a/src/tune/analyze.ts b/src/tune/analyze.ts
index edb34ae..02ef185 100644
--- a/src/tune/analyze.ts
+++ b/src/tune/analyze.ts
@@ -1,2 +1,155 @@
-// Populated in section-16. Do not import.
-export {};
+// Stream the decision log + outcomes sidecar and aggregate per-rule stats
+// used by suggest.ts. Abstain and shadow records are skipped — they did not
+// drive user-visible live routing and belong to a different analysis.
+
+import { createReadStream, readdirSync } from 'node:fs';
+import { createInterface } from 'node:readline';
+import { join } from 'node:path';
+import type { OutcomeTag } from '../decisions/outcome.js';
+import type { DecisionRecord } from '../decisions/types.js';
+import { readDecisions } from '../decisions/reader.js';
+
+export type OutcomeKey = OutcomeTag | 'unknown';
+
+export interface RuleStats {
+  ruleId: string;
+  fires: number;
+  outcomeCounts: Record<OutcomeKey, number>;
+  costSum: number;
+  costCount: number;
+  latencySum: number;
+  latencyCount: number;
+  chosenModels: Map<string, number>;
+}
+
+export interface AnalyzeOptions {
+  readonly logDir: string;
+  readonly since?: string;
+}
+
+export interface AnalyzeResult {
+  readonly rules: ReadonlyMap<string, RuleStats>;
+  readonly totalLive: number;
+}
+
+const ALL_TAGS: readonly OutcomeKey[] = [
+  'continued',
+  'retried',
+  'frustration_next_turn',
+  'abandoned',
+  'unknown',
+];
+
+export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
+  const outcomes = await loadOutcomes(opts.logDir, opts.since);
+  const rules = new Map<string, RuleStats>();
+  let totalLive = 0;
+  const decisionOpts = opts.since !== undefined ? { since: opts.since } : {};
+  for await (const rec of readDecisions(opts.logDir, decisionOpts)) {
+    const ruleId = rec.policy_result.rule_id;
+    if (!isLivePolicyHit(rec) || ruleId === undefined) continue;
+    totalLive += 1;
+    const stats = getOrInit(rules, ruleId);
+    absorbRecord(stats, rec, outcomes.get(rec.request_hash));
+  }
+  return { rules, totalLive };
+}
+
+function isLivePolicyHit(rec: DecisionRecord): boolean {
+  if (rec.mode === 'shadow') return false;
+  if (rec.policy_result.abstain === true) return false;
+  return rec.policy_result.rule_id !== undefined;
+}
+
+function absorbRecord(
+  stats: RuleStats,
+  rec: DecisionRecord,
+  tag: OutcomeTag | undefined,
+): void {
+  stats.fires += 1;
+  const key: OutcomeKey = tag ?? 'unknown';
+  stats.outcomeCounts[key] += 1;
+  if (rec.cost_estimate_usd !== null) {
+    stats.costSum += rec.cost_estimate_usd;
+    stats.costCount += 1;
+  }
+  if (Number.isFinite(rec.upstream_latency_ms) && rec.upstream_latency_ms >= 0) {
+    stats.latencySum += rec.upstream_latency_ms;
+    stats.latencyCount += 1;
+  }
+  const model = rec.forwarded_model;
+  stats.chosenModels.set(model, (stats.chosenModels.get(model) ?? 0) + 1);
+}
+
+function getOrInit(map: Map<string, RuleStats>, ruleId: string): RuleStats {
+  const existing = map.get(ruleId);
+  if (existing !== undefined) return existing;
+  const fresh: RuleStats = {
+    ruleId,
+    fires: 0,
+    outcomeCounts: emptyCounts(),
+    costSum: 0,
+    costCount: 0,
+    latencySum: 0,
+    latencyCount: 0,
+    chosenModels: new Map(),
+  };
+  map.set(ruleId, fresh);
+  return fresh;
+}
+
+function emptyCounts(): Record<OutcomeKey, number> {
+  const o = {} as Record<OutcomeKey, number>;
+  for (const k of ALL_TAGS) o[k] = 0;
+  return o;
+}
+
+interface RawOutcome {
+  readonly requestHash?: unknown;
+  readonly tag?: unknown;
+  readonly ts?: unknown;
+}
+
+async function loadOutcomes(
+  logDir: string,
+  since: string | undefined,
+): Promise<ReadonlyMap<string, OutcomeTag>> {
+  const map = new Map<string, OutcomeTag>();
+  let entries: readonly string[];
+  try {
+    entries = readdirSync(logDir);
+  } catch {
+    return map;
+  }
+  if (!entries.includes('outcomes.jsonl')) return map;
+  const path = join(logDir, 'outcomes.jsonl');
+  const stream = createReadStream(path, { encoding: 'utf8' });
+  const rl = createInterface({ input: stream, crlfDelay: Infinity });
+  for await (const line of rl) {
+    if (line.length === 0) continue;
+    const parsed = safeParse(line);
+    if (parsed === null) continue;
+    if (since !== undefined && typeof parsed.ts === 'string' && parsed.ts < since) continue;
+    if (typeof parsed.requestHash !== 'string' || typeof parsed.tag !== 'string') continue;
+    if (!isOutcomeTag(parsed.tag)) continue;
+    if (!map.has(parsed.requestHash)) map.set(parsed.requestHash, parsed.tag);
+  }
+  return map;
+}
+
+function safeParse(line: string): RawOutcome | null {
+  try {
+    return JSON.parse(line) as RawOutcome;
+  } catch {
+    return null;
+  }
+}
+
+function isOutcomeTag(v: string): v is OutcomeTag {
+  return (
+    v === 'continued' ||
+    v === 'retried' ||
+    v === 'frustration_next_turn' ||
+    v === 'abandoned'
+  );
+}
diff --git a/src/tune/diff.ts b/src/tune/diff.ts
index edb34ae..c765216 100644
--- a/src/tune/diff.ts
+++ b/src/tune/diff.ts
@@ -1,2 +1,74 @@
-// Populated in section-16. Do not import.
-export {};
+// Hand-rolled unified-diff renderer for tune proposals. We never write to the
+// config file — this builds a standard unified-diff string on top of the YAML
+// we read from disk. Only targets rules whose `then:` uses `choice: <tier>`;
+// `escalate: N` rules are skipped because the proposal is tier-expressed.
+
+import type { Suggestion } from './suggest.js';
+
+export function renderDiff(
+  path: string,
+  yaml: string,
+  suggestions: readonly Suggestion[],
+): string {
+  if (suggestions.length === 0) return '';
+  const lines = yaml.split('\n');
+  const hunks: string[] = [];
+  for (const sugg of suggestions) {
+    const hunk = hunkFor(lines, sugg);
+    if (hunk !== null) hunks.push(hunk);
+  }
+  if (hunks.length === 0) return '';
+  const header = `--- ${path}\n+++ ${path}\n`;
+  return header + hunks.join('');
+}
+
+function hunkFor(lines: readonly string[], sugg: Suggestion): string | null {
+  const idLine = findRuleIdLine(lines, sugg.ruleId);
+  if (idLine === -1) return null;
+  const choiceLine = findChoiceLine(lines, idLine);
+  if (choiceLine === -1) return null;
+  const original = lines[choiceLine];
+  if (original === undefined) return null;
+  const replaced = original.replace(
+    /choice:\s*(haiku|sonnet|opus)/,
+    `choice: ${sugg.proposedTier}`,
+  );
+  if (replaced === original) return null;
+  const contextBefore = Math.max(0, choiceLine - 2);
+  const contextAfter = Math.min(lines.length - 1, choiceLine + 2);
+  const parts: string[] = [];
+  const originalRange = contextAfter - contextBefore + 1;
+  parts.push(`@@ -${contextBefore + 1},${originalRange} +${contextBefore + 1},${originalRange} @@\n`);
+  for (let i = contextBefore; i < choiceLine; i += 1) {
+    parts.push(` ${lines[i] ?? ''}\n`);
+  }
+  parts.push(`-${original}\n`);
+  parts.push(`+${replaced}\n`);
+  for (let i = choiceLine + 1; i <= contextAfter; i += 1) {
+    parts.push(` ${lines[i] ?? ''}\n`);
+  }
+  return parts.join('');
+}
+
+function findRuleIdLine(lines: readonly string[], ruleId: string): number {
+  const re = new RegExp(`^\\s*-?\\s*id:\\s*${escapeRe(ruleId)}\\s*$`);
+  for (let i = 0; i < lines.length; i += 1) {
+    if (re.test(lines[i] ?? '')) return i;
+  }
+  return -1;
+}
+
+function findChoiceLine(lines: readonly string[], startLine: number): number {
+  // Search forward until the next rule-id line (indent-insensitive sentinel)
+  // or end of file. We stop early if we see another `- id:` entry.
+  for (let i = startLine + 1; i < lines.length; i += 1) {
+    const line = lines[i] ?? '';
+    if (/^\s*-\s*id:/.test(line) && i !== startLine) return -1;
+    if (/choice:\s*(haiku|sonnet|opus)/.test(line)) return i;
+  }
+  return -1;
+}
+
+function escapeRe(s: string): string {
+  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
+}
diff --git a/src/tune/suggest.ts b/src/tune/suggest.ts
index edb34ae..eaeb192 100644
--- a/src/tune/suggest.ts
+++ b/src/tune/suggest.ts
@@ -1,2 +1,68 @@
-// Populated in section-16. Do not import.
-export {};
+// Turn per-rule stats (from analyze.ts) into concrete escalation proposals.
+// Heuristic: a rule is "weak" if it fires enough and a majority of its
+// follow-ups show retries or frustration. The proposal is to move the rule's
+// target one tier up in the haiku < sonnet < opus ordering.
+
+import { nextTier, tierOf, compareTiers } from '../sticky/tiers.js';
+import type { Tier } from '../classifier/types.js';
+import type { RuleStats } from './analyze.js';
+
+export const MIN_FIRES = 20;
+export const WEAK_THRESHOLD = 0.5;
+
+export interface Suggestion {
+  readonly ruleId: string;
+  readonly kind: 'escalate-target';
+  readonly currentTier: Tier;
+  readonly proposedTier: Tier;
+  readonly rationale: string;
+}
+
+export function suggest(
+  rules: ReadonlyMap<string, RuleStats>,
+): readonly Suggestion[] {
+  const out: Suggestion[] = [];
+  for (const stats of rules.values()) {
+    const s = suggestOne(stats);
+    if (s !== null) out.push(s);
+  }
+  return out.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
+}
+
+function suggestOne(stats: RuleStats): Suggestion | null {
+  if (stats.fires < MIN_FIRES) return null;
+  const bad = stats.outcomeCounts.frustration_next_turn + stats.outcomeCounts.retried;
+  if (bad / stats.fires < WEAK_THRESHOLD) return null;
+  const currentModel = mostCommon(stats.chosenModels);
+  if (currentModel === null) return null;
+  let currentTier: Tier;
+  try {
+    currentTier = tierOf(currentModel, new Map());
+  } catch {
+    return null;
+  }
+  const proposedTier = nextTier(currentTier, 1);
+  if (compareTiers(proposedTier, currentTier) === 0) return null;
+  const frustPct = ((stats.outcomeCounts.frustration_next_turn / stats.fires) * 100).toFixed(1);
+  const avgCost = stats.costCount > 0 ? stats.costSum / stats.costCount : 0;
+  const rationale = `fires=${stats.fires} frustration=${frustPct}% avg_cost=$${avgCost.toFixed(4)}`;
+  return {
+    ruleId: stats.ruleId,
+    kind: 'escalate-target',
+    currentTier,
+    proposedTier,
+    rationale,
+  };
+}
+
+function mostCommon(counts: ReadonlyMap<string, number>): string | null {
+  let best: string | null = null;
+  let bestCount = -1;
+  for (const [key, n] of counts) {
+    if (n > bestCount || (n === bestCount && best !== null && key < best)) {
+      best = key;
+      bestCount = n;
+    }
+  }
+  return best;
+}
diff --git a/tests/tune/analyze.test.ts b/tests/tune/analyze.test.ts
new file mode 100644
index 0000000..b9a5707
--- /dev/null
+++ b/tests/tune/analyze.test.ts
@@ -0,0 +1,63 @@
+import { describe, it, expect, afterEach } from 'vitest';
+import { rmSync } from 'node:fs';
+import { analyze } from '../../src/tune/analyze.js';
+import { mkDecision, mkLogDir } from './helpers.js';
+
+const cleanup: string[] = [];
+afterEach(() => {
+  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
+});
+
+describe('analyze', () => {
+  it('joins decisions with outcomes by request_hash', async () => {
+    const dir = mkLogDir(
+      [
+        mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+        mkDecision({ request_hash: 'h2', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+      ],
+      [{ requestHash: 'h1', tag: 'frustration_next_turn' }],
+    );
+    cleanup.push(dir);
+    const res = await analyze({ logDir: dir });
+    const stats = res.rules.get('R')!;
+    expect(stats.fires).toBe(2);
+    expect(stats.outcomeCounts.frustration_next_turn).toBe(1);
+    expect(stats.outcomeCounts.unknown).toBe(1);
+  });
+
+  it('skips abstain and shadow records', async () => {
+    const dir = mkLogDir([
+      mkDecision({ request_hash: 'a', policy_result: { abstain: true }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+      mkDecision({ request_hash: 'b', mode: 'shadow', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+      mkDecision({ request_hash: 'c', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+    ]);
+    cleanup.push(dir);
+    const res = await analyze({ logDir: dir });
+    expect(res.totalLive).toBe(1);
+    expect(res.rules.get('R')!.fires).toBe(1);
+  });
+
+  it('treats missing outcomes as unknown without inflating frustration ratio', async () => {
+    const dir = mkLogDir([
+      mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+    ]);
+    cleanup.push(dir);
+    const res = await analyze({ logDir: dir });
+    const s = res.rules.get('R')!;
+    expect(s.outcomeCounts.unknown).toBe(1);
+    expect(s.outcomeCounts.frustration_next_turn).toBe(0);
+  });
+
+  it('tracks chosenModels counts', async () => {
+    const dir = mkLogDir([
+      mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+      mkDecision({ request_hash: 'h2', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
+      mkDecision({ request_hash: 'h3', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-sonnet-4-6' }),
+    ]);
+    cleanup.push(dir);
+    const res = await analyze({ logDir: dir });
+    const s = res.rules.get('R')!;
+    expect(s.chosenModels.get('claude-haiku-4-5-20251001')).toBe(2);
+    expect(s.chosenModels.get('claude-sonnet-4-6')).toBe(1);
+  });
+});
diff --git a/tests/tune/diff.test.ts b/tests/tune/diff.test.ts
new file mode 100644
index 0000000..54bbcbc
--- /dev/null
+++ b/tests/tune/diff.test.ts
@@ -0,0 +1,43 @@
+import { describe, it, expect } from 'vitest';
+import { readFileSync } from 'node:fs';
+import { join } from 'node:path';
+import { renderDiff } from '../../src/tune/diff.js';
+import type { Suggestion } from '../../src/tune/suggest.js';
+
+const FIXTURE = join(__dirname, 'fixtures', 'config.yaml');
+
+describe('renderDiff', () => {
+  it('produces a valid unified diff header', () => {
+    const yaml = readFileSync(FIXTURE, 'utf8');
+    const sugg: readonly Suggestion[] = [
+      { ruleId: 'trivial-to-haiku', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'fires=100 frustration=70%' },
+    ];
+    const diff = renderDiff(FIXTURE, yaml, sugg);
+    expect(diff).toMatch(/^--- /m);
+    expect(diff).toMatch(/^\+\+\+ /m);
+    expect(diff).toMatch(/^@@ /m);
+    expect(diff).toMatch(/-.*choice: haiku/);
+    expect(diff).toMatch(/\+.*choice: sonnet/);
+  });
+
+  it('returns empty string when suggestions are empty', () => {
+    const yaml = readFileSync(FIXTURE, 'utf8');
+    expect(renderDiff(FIXTURE, yaml, [])).toBe('');
+  });
+
+  it('returns empty string when rule id is not found', () => {
+    const yaml = readFileSync(FIXTURE, 'utf8');
+    const sugg: readonly Suggestion[] = [
+      { ruleId: 'nonexistent', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
+    ];
+    expect(renderDiff(FIXTURE, yaml, sugg)).toBe('');
+  });
+
+  it('skips rule blocks that use escalate: (not choice:)', () => {
+    const yaml = readFileSync(FIXTURE, 'utf8');
+    const sugg: readonly Suggestion[] = [
+      { ruleId: 'retry-escalate', kind: 'escalate-target', currentTier: 'haiku', proposedTier: 'sonnet', rationale: 'x' },
+    ];
+    expect(renderDiff(FIXTURE, yaml, sugg)).toBe('');
+  });
+});
diff --git a/tests/tune/fixtures/config.yaml b/tests/tune/fixtures/config.yaml
new file mode 100644
index 0000000..5c3739e
--- /dev/null
+++ b/tests/tune/fixtures/config.yaml
@@ -0,0 +1,17 @@
+port: 7879
+mode: live
+rules:
+  - id: plan-to-opus
+    when: { planMode: true }
+    then: { choice: opus }
+
+  - id: trivial-to-haiku
+    when:
+      all:
+        - { messageCount: { lt: 5 } }
+        - { toolUseCount: { eq: 0 } }
+    then: { choice: haiku }
+
+  - id: retry-escalate
+    when: { retryCount: { gte: 2 } }
+    then: { escalate: 1 }
diff --git a/tests/tune/helpers.ts b/tests/tune/helpers.ts
new file mode 100644
index 0000000..650a6aa
--- /dev/null
+++ b/tests/tune/helpers.ts
@@ -0,0 +1,58 @@
+import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import type { DecisionRecord } from '../../src/decisions/types.js';
+import type { OutcomeTag } from '../../src/decisions/outcome.js';
+
+export interface DecisionPartial extends Partial<DecisionRecord> {
+  readonly request_hash: string;
+  readonly forwarded_model: string;
+}
+
+export function mkDecision(over: DecisionPartial): DecisionRecord {
+  return {
+    timestamp: '2026-04-18T00:00:00.000Z',
+    session_id: 's1',
+    request_hash: over.request_hash,
+    extracted_signals: {},
+    policy_result: { rule_id: 'default-rule' },
+    classifier_result: null,
+    sticky_hit: false,
+    chosen_model: over.forwarded_model,
+    chosen_by: 'policy',
+    forwarded_model: over.forwarded_model,
+    upstream_latency_ms: 100,
+    usage: null,
+    cost_estimate_usd: 0.01,
+    classifier_cost_usd: null,
+    mode: 'live',
+    shadow_choice: null,
+    ...over,
+  };
+}
+
+export function mkLogDir(
+  decisions: readonly DecisionRecord[],
+  outcomes: ReadonlyArray<{ readonly requestHash: string; readonly tag: OutcomeTag }> = [],
+): string {
+  const dir = mkdtempSync(join(tmpdir(), 'ccmux-tune-'));
+  mkdirSync(dir, { recursive: true });
+  const dateStamp = decisions[0]?.timestamp.slice(0, 10) ?? '2026-04-18';
+  const decisionsFile = join(dir, `decisions-${dateStamp}.jsonl`);
+  writeFileSync(
+    decisionsFile,
+    decisions.map((d) => JSON.stringify(d)).join('\n') + (decisions.length > 0 ? '\n' : ''),
+    'utf8',
+  );
+  if (outcomes.length > 0) {
+    const outcomesFile = join(dir, 'outcomes.jsonl');
+    writeFileSync(
+      outcomesFile,
+      outcomes
+        .map((o) => JSON.stringify({ requestHash: o.requestHash, tag: o.tag, sessionId: 's1', ts: '2026-04-18T00:00:01.000Z' }))
+        .join('\n') + '\n',
+      'utf8',
+    );
+  }
+  return dir;
+}
diff --git a/tests/tune/suggest.test.ts b/tests/tune/suggest.test.ts
new file mode 100644
index 0000000..17ecf90
--- /dev/null
+++ b/tests/tune/suggest.test.ts
@@ -0,0 +1,83 @@
+import { describe, it, expect } from 'vitest';
+import { suggest, MIN_FIRES, WEAK_THRESHOLD } from '../../src/tune/suggest.js';
+import type { RuleStats } from '../../src/tune/analyze.js';
+
+function mkStats(over: Partial<RuleStats> & { ruleId: string }): RuleStats {
+  return {
+    ruleId: over.ruleId,
+    fires: 0,
+    outcomeCounts: {
+      continued: 0,
+      retried: 0,
+      frustration_next_turn: 0,
+      abandoned: 0,
+      unknown: 0,
+    },
+    costSum: 0,
+    costCount: 0,
+    latencySum: 0,
+    latencyCount: 0,
+    chosenModels: new Map(),
+    ...over,
+  };
+}
+
+describe('suggest', () => {
+  it('flags a weak rule with proposed tier one above current', () => {
+    const stats = mkStats({
+      ruleId: 'R',
+      fires: 100,
+      outcomeCounts: { continued: 20, retried: 10, frustration_next_turn: 70, abandoned: 0, unknown: 0 },
+      chosenModels: new Map([['claude-haiku-4-5-20251001', 100]]),
+    });
+    const out = suggest(new Map([['R', stats]]));
+    expect(out).toHaveLength(1);
+    const s = out[0]!;
+    expect(s.ruleId).toBe('R');
+    expect(s.kind).toBe('escalate-target');
+    expect(s.currentTier).toBe('haiku');
+    expect(s.proposedTier).toBe('sonnet');
+  });
+
+  it('does not flag rules below MIN_FIRES', () => {
+    const stats = mkStats({
+      ruleId: 'R',
+      fires: 5,
+      outcomeCounts: { continued: 0, retried: 0, frustration_next_turn: 5, abandoned: 0, unknown: 0 },
+      chosenModels: new Map([['claude-haiku-4-5-20251001', 5]]),
+    });
+    expect(MIN_FIRES).toBeGreaterThan(5);
+    const out = suggest(new Map([['R', stats]]));
+    expect(out).toHaveLength(0);
+  });
+
+  it('respects WEAK_THRESHOLD', () => {
+    expect(WEAK_THRESHOLD).toBeGreaterThan(0);
+    const stats = mkStats({
+      ruleId: 'R',
+      fires: MIN_FIRES + 10,
+      outcomeCounts: {
+        continued: MIN_FIRES + 10,
+        retried: 0,
+        frustration_next_turn: 0,
+        abandoned: 0,
+        unknown: 0,
+      },
+      chosenModels: new Map([['claude-haiku-4-5-20251001', MIN_FIRES + 10]]),
+    });
+    const out = suggest(new Map([['R', stats]]));
+    expect(out).toHaveLength(0);
+  });
+
+  it('does not propose beyond opus', () => {
+    const stats = mkStats({
+      ruleId: 'opus-rule',
+      fires: 100,
+      outcomeCounts: { continued: 10, retried: 10, frustration_next_turn: 80, abandoned: 0, unknown: 0 },
+      chosenModels: new Map([['claude-opus-4-7', 100]]),
+    });
+    const out = suggest(new Map([['opus-rule', stats]]));
+    // No escalation available above opus, so no suggestion.
+    expect(out).toHaveLength(0);
+  });
+});
diff --git a/tests/tune/tune-cli.test.ts b/tests/tune/tune-cli.test.ts
new file mode 100644
index 0000000..dbe10fe
--- /dev/null
+++ b/tests/tune/tune-cli.test.ts
@@ -0,0 +1,116 @@
+import { describe, it, expect, afterEach } from 'vitest';
+import { Writable } from 'node:stream';
+import { copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';
+import { join } from 'node:path';
+import { runTune } from '../../src/cli/tune.js';
+import { mkDecision, mkLogDir } from './helpers.js';
+
+const FIXTURE = join(__dirname, 'fixtures', 'config.yaml');
+
+function bufferStream(): { stream: Writable; read: () => string } {
+  const chunks: Buffer[] = [];
+  const stream = new Writable({
+    write(chunk: Buffer | string, _enc, cb) {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+      cb();
+    },
+  });
+  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
+}
+
+const cleanup: string[] = [];
+afterEach(() => {
+  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
+});
+
+describe('runTune', () => {
+  it('emits unified diff to stdout without modifying config.yaml', async () => {
+    const decisions = [];
+    for (let i = 0; i < 100; i += 1) {
+      decisions.push(mkDecision({
+        request_hash: `h${i}`,
+        session_id: `s${i}`,
+        policy_result: { rule_id: 'trivial-to-haiku' },
+        forwarded_model: 'claude-haiku-4-5-20251001',
+      }));
+    }
+    const outcomes = decisions.slice(0, 80).map((d) => ({ requestHash: d.request_hash, tag: 'frustration_next_turn' as const }));
+    const dir = mkLogDir(decisions, outcomes);
+    cleanup.push(dir);
+
+    const configCopy = join(dir, 'config.yaml');
+    copyFileSync(FIXTURE, configCopy);
+    const before = readFileSync(configCopy);
+    const beforeMtime = statSync(configCopy).mtimeMs;
+
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runTune(['--log-dir', dir, '--config', configCopy], {
+      stdout: out.stream,
+      stderr: err.stream,
+    });
+
+    expect(code).toBe(0);
+    expect(out.read()).toMatch(/^@@ /m);
+    const after = readFileSync(configCopy);
+    expect(after.equals(before)).toBe(true);
+    expect(statSync(configCopy).mtimeMs).toBe(beforeMtime);
+  });
+
+  it('exits 0 with no stdout and stderr message when no suggestions', async () => {
+    const dir = mkLogDir([
+      mkDecision({
+        request_hash: 'h1',
+        policy_result: { rule_id: 'trivial-to-haiku' },
+        forwarded_model: 'claude-haiku-4-5-20251001',
+      }),
+    ]);
+    cleanup.push(dir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runTune(['--log-dir', dir, '--config', FIXTURE], {
+      stdout: out.stream,
+      stderr: err.stream,
+    });
+    expect(code).toBe(0);
+    expect(out.read()).toBe('');
+    expect(err.read()).toMatch(/no suggestions/);
+  });
+
+  it('exits 1 when log directory is missing', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runTune(['--log-dir', '/tmp/ccmux-nonexistent-xyz', '--config', FIXTURE], {
+      stdout: out.stream,
+      stderr: err.stream,
+    });
+    expect(code).toBe(1);
+    expect(err.read()).toMatch(/log/i);
+  });
+
+  it('exits 2 on invalid --since', async () => {
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runTune(['--since', 'bogus'], { stdout: out.stream, stderr: err.stream });
+    expect(code).toBe(2);
+    expect(err.read()).toMatch(/since/i);
+  });
+
+  it('exits 1 when config.yaml is unreadable', async () => {
+    const dir = mkLogDir([
+      mkDecision({
+        request_hash: 'h1',
+        policy_result: { rule_id: 'trivial-to-haiku' },
+        forwarded_model: 'claude-haiku-4-5-20251001',
+      }),
+    ]);
+    cleanup.push(dir);
+    const out = bufferStream();
+    const err = bufferStream();
+    const code = await runTune(['--log-dir', dir, '--config', '/tmp/ccmux-missing-config.yaml'], {
+      stdout: out.stream,
+      stderr: err.stream,
+    });
+    expect(code).toBe(1);
+  });
+});
