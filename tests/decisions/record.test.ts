import { describe, expect, it } from 'vitest';
import { buildDecisionRecord } from '../../src/decisions/record.js';
import type { Signals } from '../../src/signals/types.js';
import type { PolicyResult } from '../../src/policy/dsl.js';
import type { ClassifierResult } from '../../src/classifier/types.js';

const SIGNALS: Signals = {
  planMode: false,
  messageCount: 1,
  tools: ['bash'],
  toolUseCount: 0,
  estInputTokens: 100,
  fileRefCount: 0,
  retryCount: 0,
  frustration: false,
  explicitModel: null,
  projectPath: '/p',
  sessionDurationMs: 0,
  betaFlags: [],
  sessionId: 'sess',
  requestHash: 'rh',
};

const NOW = new Date('2026-04-17T14:00:00.000Z');

describe('buildDecisionRecord', () => {
  it('serializes timestamp as ISO and projects PolicyResult.matched into rule_id', () => {
    const policy: PolicyResult = { kind: 'matched', ruleId: 'short-simple-haiku', result: { choice: 'haiku' } };
    const r = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: policy, classifierResult: null, stickyHit: false,
      chosenModel: 'm', chosenBy: 'policy', forwardedModel: 'm',
      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
    });
    expect(r.timestamp).toBe('2026-04-17T14:00:00.000Z');
    expect(r.policy_result).toEqual({ rule_id: 'short-simple-haiku' });
  });

  it('projects PolicyResult.abstain into { abstain: true }', () => {
    const r = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: { kind: 'abstain' },
      classifierResult: null, stickyHit: false,
      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
    });
    expect(r.policy_result).toEqual({ abstain: true });
  });

  it('projects ClassifierResult into the documented decision-log shape', () => {
    const cr: ClassifierResult = {
      score: 4.2, suggestedModel: 'sonnet', confidence: 0.81, source: 'haiku', latencyMs: 512,
    };
    const r = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: { kind: 'abstain' }, classifierResult: cr, stickyHit: false,
      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
    });
    expect(r.classifier_result).toEqual({
      score: 4.2, suggested: 'sonnet', confidence: 0.81, source: 'haiku', latencyMs: 512,
    });
  });

  it('shadow mode: forwarded_model is the requested one and shadow_choice holds the would-have-been override', () => {
    const r = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: { kind: 'matched', ruleId: 'opus-rule', result: { choice: 'opus' } },
      classifierResult: null, stickyHit: false,
      chosenModel: 'claude-sonnet-4-5',          // client-requested
      chosenBy: 'shadow',
      forwardedModel: 'claude-sonnet-4-5',       // what actually went upstream
      mode: 'shadow',
      shadowChoice: 'claude-opus-4-7',           // what we WOULD have done
      upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'hashed',
    });
    expect(r.mode).toBe('shadow');
    expect(r.forwarded_model).toBe('claude-sonnet-4-5');
    expect(r.shadow_choice).toBe('claude-opus-4-7');
  });

  it('applies the configured content-mode redaction to extracted_signals', () => {
    const full = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: { kind: 'abstain' }, classifierResult: null, stickyHit: false,
      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'full',
    });
    expect((full.extracted_signals as Record<string, unknown>).projectPath).toBe('/p');

    const none = buildDecisionRecord({
      now: NOW,
      sessionId: 's', requestHash: 'h', extractedSignals: SIGNALS,
      policyResult: { kind: 'abstain' }, classifierResult: null, stickyHit: false,
      chosenModel: 'm', chosenBy: 'classifier', forwardedModel: 'm',
      mode: 'live', shadowChoice: null, upstreamLatencyMs: 0,
      usage: null, costEstimateUsd: null, classifierCostUsd: null, contentMode: 'none',
    });
    expect('projectPath' in (none.extracted_signals as Record<string, unknown>)).toBe(false);
  });
});
