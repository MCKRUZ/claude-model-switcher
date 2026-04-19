import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { analyze } from '../../src/tune/analyze.js';
import { mkDecision, mkLogDir } from './helpers.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('analyze', () => {
  it('joins decisions with outcomes by request_hash', async () => {
    const dir = mkLogDir(
      [
        mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
        mkDecision({ request_hash: 'h2', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
      ],
      [{ requestHash: 'h1', tag: 'frustration_next_turn' }],
    );
    cleanup.push(dir);
    const res = await analyze({ logDir: dir });
    const stats = res.rules.get('R')!;
    expect(stats.fires).toBe(2);
    expect(stats.outcomeCounts.frustration_next_turn).toBe(1);
    expect(stats.outcomeCounts.unknown).toBe(1);
  });

  it('skips abstain and shadow records', async () => {
    const dir = mkLogDir([
      mkDecision({ request_hash: 'a', policy_result: { abstain: true }, forwarded_model: 'claude-haiku-4-5-20251001' }),
      mkDecision({ request_hash: 'b', mode: 'shadow', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
      mkDecision({ request_hash: 'c', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
    ]);
    cleanup.push(dir);
    const res = await analyze({ logDir: dir });
    expect(res.totalLive).toBe(1);
    expect(res.rules.get('R')!.fires).toBe(1);
  });

  it('treats missing outcomes as unknown without inflating frustration ratio', async () => {
    const dir = mkLogDir([
      mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
    ]);
    cleanup.push(dir);
    const res = await analyze({ logDir: dir });
    const s = res.rules.get('R')!;
    expect(s.outcomeCounts.unknown).toBe(1);
    expect(s.outcomeCounts.frustration_next_turn).toBe(0);
  });

  it('tracks chosenModels counts', async () => {
    const dir = mkLogDir([
      mkDecision({ request_hash: 'h1', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
      mkDecision({ request_hash: 'h2', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-haiku-4-5-20251001' }),
      mkDecision({ request_hash: 'h3', policy_result: { rule_id: 'R' }, forwarded_model: 'claude-sonnet-4-6' }),
    ]);
    cleanup.push(dir);
    const res = await analyze({ logDir: dir });
    const s = res.rules.get('R')!;
    expect(s.chosenModels.get('claude-haiku-4-5-20251001')).toBe(2);
    expect(s.chosenModels.get('claude-sonnet-4-6')).toBe(1);
  });
});
