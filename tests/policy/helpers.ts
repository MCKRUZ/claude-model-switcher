import type { Signals } from '../../src/signals/types.js';

const DEFAULT_SIGNALS: Signals = {
  planMode: false,
  messageCount: 1,
  tools: [],
  toolUseCount: 0,
  estInputTokens: 100,
  fileRefCount: 0,
  retryCount: 0,
  frustration: false,
  explicitModel: null,
  projectPath: null,
  sessionDurationMs: 0,
  betaFlags: [],
  sessionId: 'session-test',
  requestHash: 'hash-test',
};

export function makeSignals(overrides: Partial<Signals>): Signals {
  return Object.freeze({ ...DEFAULT_SIGNALS, ...overrides });
}
