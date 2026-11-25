// The cache_buster field on the decision record: optional, identical across
// content modes, and free of prompt text.
import { describe, expect, it } from 'vitest';
import { buildDecisionRecord } from '../../src/decisions/record.js';
import { KNOWN_SIGNALS } from '../../src/policy/signals-schema.js';
import type { ContentMode } from '../../src/decisions/types.js';
import type { Signals } from '../../src/signals/types.js';

const BASE: Signals = {
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

const FLAGGED: Signals = {
  ...BASE,
  cacheBuster: { kinds: ['date', 'uuid'], prefix_fingerprint: 'ab12cd34ef56ab12cd34ef56ab12cd34' },
};

function build(signals: Signals, contentMode: ContentMode) {
  return buildDecisionRecord({
    now: new Date('2026-11-25T14:00:00.000Z'),
    sessionId: 's',
    requestHash: 'h',
    extractedSignals: signals,
    policyResult: { kind: 'abstain' },
    classifierResult: null,
    stickyHit: false,
    chosenModel: 'm',
    chosenBy: 'classifier',
    forwardedModel: 'm',
    upstreamModel: null,
    mode: 'live',
    shadowChoice: null,
    upstreamLatencyMs: 0,
    usage: null,
    costEstimateUsd: null,
    classifierCostUsd: null,
    contentMode,
  });
}

const MODES: readonly ContentMode[] = ['hashed', 'full', 'none'];

describe('decision record cache_buster field', () => {
  it.each(MODES)('is absent when the request was not flagged (%s)', (mode) => {
    const record = build(BASE, mode);
    expect('cache_buster' in record).toBe(false);
    expect(JSON.stringify(record)).not.toContain('cache_buster');
  });

  it.each(MODES)('carries kinds and fingerprint when flagged (%s)', (mode) => {
    expect(build(FLAGGED, mode).cache_buster).toEqual({
      kinds: ['date', 'uuid'],
      prefix_fingerprint: 'ab12cd34ef56ab12cd34ef56ab12cd34',
    });
  });

  it('is identical in hashed, full and none modes', () => {
    const [hashed, full, none] = MODES.map((m) => build(FLAGGED, m).cache_buster);
    expect(full).toEqual(hashed);
    expect(none).toEqual(hashed);
  });

  it.each(MODES)('never contains the raw value or prompt text in the record (%s)', (mode) => {
    // The detector only ever hands over hashes and kind labels, so a record
    // built from a real finding cannot mention the date or the system text.
    const serialized = JSON.stringify(build(FLAGGED, mode));
    expect(serialized).not.toContain('2026-11-26');
    expect(serialized).not.toContain('Secret system prompt');
  });
});

describe('policy signal allow-list', () => {
  it('does not let rules reference the cache-buster finding', () => {
    expect(KNOWN_SIGNALS as readonly string[]).not.toContain('cacheBuster');
    expect(KNOWN_SIGNALS as readonly string[]).not.toContain('cache_buster');
  });
});
