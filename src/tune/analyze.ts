// Stream the decision log + outcomes sidecar and aggregate per-rule stats
// used by suggest.ts. Abstain and shadow records are skipped — they did not
// drive user-visible live routing and belong to a different analysis.

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { OutcomeTag } from '../decisions/outcome.js';
import type { DecisionRecord } from '../decisions/types.js';
import { readDecisions } from '../decisions/reader.js';

export type OutcomeKey = OutcomeTag | 'unknown';

export interface RuleStats {
  ruleId: string;
  fires: number;
  outcomeCounts: Record<OutcomeKey, number>;
  costSum: number;
  costCount: number;
  latencySum: number;
  latencyCount: number;
  chosenModels: Map<string, number>;
}

export interface AnalyzeOptions {
  readonly logDir: string;
  readonly since?: string;
}

export interface AnalyzeResult {
  readonly rules: ReadonlyMap<string, RuleStats>;
  readonly totalLive: number;
}

const ALL_TAGS: readonly OutcomeKey[] = [
  'continued',
  'retried',
  'frustration_next_turn',
  'abandoned',
  'unknown',
];

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const outcomes = await loadOutcomes(opts.logDir, opts.since);
  const rules = new Map<string, RuleStats>();
  let totalLive = 0;
  const decisionOpts = opts.since !== undefined ? { since: opts.since } : {};
  for await (const rec of readDecisions(opts.logDir, decisionOpts)) {
    const ruleId = rec.policy_result.rule_id;
    if (!isLivePolicyHit(rec) || ruleId === undefined) continue;
    totalLive += 1;
    const stats = getOrInit(rules, ruleId);
    absorbRecord(stats, rec, outcomes.get(rec.request_hash));
  }
  return { rules, totalLive };
}

function isLivePolicyHit(rec: DecisionRecord): boolean {
  if (rec.mode === 'shadow') return false;
  if (rec.policy_result.abstain === true) return false;
  return rec.policy_result.rule_id !== undefined;
}

function absorbRecord(
  stats: RuleStats,
  rec: DecisionRecord,
  tag: OutcomeTag | undefined,
): void {
  stats.fires += 1;
  const key: OutcomeKey = tag ?? 'unknown';
  stats.outcomeCounts[key] += 1;
  if (rec.cost_estimate_usd !== null) {
    stats.costSum += rec.cost_estimate_usd;
    stats.costCount += 1;
  }
  if (Number.isFinite(rec.upstream_latency_ms) && rec.upstream_latency_ms >= 0) {
    stats.latencySum += rec.upstream_latency_ms;
    stats.latencyCount += 1;
  }
  const model = rec.forwarded_model;
  stats.chosenModels.set(model, (stats.chosenModels.get(model) ?? 0) + 1);
}

function getOrInit(map: Map<string, RuleStats>, ruleId: string): RuleStats {
  const existing = map.get(ruleId);
  if (existing !== undefined) return existing;
  const fresh: RuleStats = {
    ruleId,
    fires: 0,
    outcomeCounts: emptyCounts(),
    costSum: 0,
    costCount: 0,
    latencySum: 0,
    latencyCount: 0,
    chosenModels: new Map(),
  };
  map.set(ruleId, fresh);
  return fresh;
}

function emptyCounts(): Record<OutcomeKey, number> {
  const o = {} as Record<OutcomeKey, number>;
  for (const k of ALL_TAGS) o[k] = 0;
  return o;
}

interface RawOutcome {
  readonly requestHash?: unknown;
  readonly tag?: unknown;
  readonly ts?: unknown;
}

async function loadOutcomes(
  logDir: string,
  since: string | undefined,
): Promise<ReadonlyMap<string, OutcomeTag>> {
  const map = new Map<string, OutcomeTag>();
  let entries: readonly string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return map;
  }
  if (!entries.includes('outcomes.jsonl')) return map;
  const path = join(logDir, 'outcomes.jsonl');
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    const parsed = safeParse(line);
    if (parsed === null) continue;
    if (since !== undefined && typeof parsed.ts === 'string' && parsed.ts < since) continue;
    if (typeof parsed.requestHash !== 'string' || typeof parsed.tag !== 'string') continue;
    if (!isOutcomeTag(parsed.tag)) continue;
    if (!map.has(parsed.requestHash)) map.set(parsed.requestHash, parsed.tag);
  }
  return map;
}

function safeParse(line: string): RawOutcome | null {
  try {
    return JSON.parse(line) as RawOutcome;
  } catch {
    return null;
  }
}

function isOutcomeTag(v: string): v is OutcomeTag {
  return (
    v === 'continued' ||
    v === 'retried' ||
    v === 'frustration_next_turn' ||
    v === 'abandoned'
  );
}
