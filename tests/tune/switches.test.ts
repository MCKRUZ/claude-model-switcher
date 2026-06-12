import { describe, it, expect } from 'vitest';
import { summarizeSwitches } from '../../src/tune/switches.js';
import type { DecisionRecord, UsageFields } from '../../src/decisions/types.js';

function usage(cacheCreate: number): UsageFields {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: cacheCreate,
  };
}

function rec(over: Partial<DecisionRecord> & { session_id: string; forwarded_model: string }): DecisionRecord {
  return {
    timestamp: '2026-04-18T00:00:00.000Z',
    request_hash: 'h',
    extracted_signals: {},
    policy_result: { rule_id: 'r' },
    classifier_result: null,
    sticky_hit: false,
    chosen_model: over.forwarded_model,
    chosen_by: 'policy',
    upstream_model: null,
    upstream_latency_ms: 0,
    usage: null,
    cost_estimate_usd: null,
    classifier_cost_usd: null,
    mode: 'live',
    shadow_choice: null,
    ...over,
  };
}

describe('summarizeSwitches', () => {
  it('reports no switches when a session stays on one model', () => {
    const out = summarizeSwitches([
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
    ]);
    expect(out.totalSwitches).toBe(0);
    expect(out.sessionsWithSwitches).toBe(0);
    expect(out.cacheRebuildTokens).toBe(0);
  });

  it('counts a switch and attributes the post-switch cache-rebuild tokens', () => {
    const out = summarizeSwitches([
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
      rec({ session_id: 's1', forwarded_model: 'opus', usage: usage(4000) }),
    ]);
    expect(out.totalSwitches).toBe(1);
    expect(out.sessionsWithSwitches).toBe(1);
    expect(out.cacheRebuildTokens).toBe(4000);
  });

  it('tracks sessions independently and counts each switch', () => {
    const out = summarizeSwitches([
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
      rec({ session_id: 's2', forwarded_model: 'sonnet' }),
      rec({ session_id: 's1', forwarded_model: 'sonnet', usage: usage(1000) }),
      rec({ session_id: 's2', forwarded_model: 'sonnet' }),
      rec({ session_id: 's1', forwarded_model: 'opus', usage: usage(2000) }),
    ]);
    expect(out.totalSwitches).toBe(2); // s1: haiku→sonnet→opus
    expect(out.sessionsWithSwitches).toBe(1);
    expect(out.cacheRebuildTokens).toBe(3000);
  });

  it('ignores shadow records (they never change the served model)', () => {
    const out = summarizeSwitches([
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
      rec({ session_id: 's1', forwarded_model: 'haiku', mode: 'shadow', shadow_choice: 'opus' }),
      rec({ session_id: 's1', forwarded_model: 'haiku' }),
    ]);
    expect(out.totalSwitches).toBe(0);
  });
});
