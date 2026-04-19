import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionRecord } from '../../src/decisions/types.js';
import type { OutcomeTag } from '../../src/decisions/outcome.js';

export interface DecisionPartial extends Partial<DecisionRecord> {
  readonly request_hash: string;
  readonly forwarded_model: string;
}

export function mkDecision(over: DecisionPartial): DecisionRecord {
  return {
    timestamp: '2026-04-18T00:00:00.000Z',
    session_id: 's1',
    request_hash: over.request_hash,
    extracted_signals: {},
    policy_result: { rule_id: 'default-rule' },
    classifier_result: null,
    sticky_hit: false,
    chosen_model: over.forwarded_model,
    chosen_by: 'policy',
    forwarded_model: over.forwarded_model,
    upstream_latency_ms: 100,
    usage: null,
    cost_estimate_usd: 0.01,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

export function mkLogDir(
  decisions: readonly DecisionRecord[],
  outcomes: ReadonlyArray<{ readonly requestHash: string; readonly tag: OutcomeTag }> = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-tune-'));
  mkdirSync(dir, { recursive: true });
  const dateStamp = decisions[0]?.timestamp.slice(0, 10) ?? '2026-04-18';
  const decisionsFile = join(dir, `decisions-${dateStamp}.jsonl`);
  writeFileSync(
    decisionsFile,
    decisions.map((d) => JSON.stringify(d)).join('\n') + (decisions.length > 0 ? '\n' : ''),
    'utf8',
  );
  if (outcomes.length > 0) {
    const outcomesFile = join(dir, 'outcomes.jsonl');
    writeFileSync(
      outcomesFile,
      outcomes
        .map((o) => JSON.stringify({ requestHash: o.requestHash, tag: o.tag, sessionId: 's1', ts: '2026-04-18T00:00:01.000Z' }))
        .join('\n') + '\n',
      'utf8',
    );
  }
  return dir;
}
