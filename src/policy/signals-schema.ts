// Allow-list of signal names referenced by rules. Must stay in sync with src/signals/types.ts.

export const KNOWN_SIGNALS = Object.freeze([
  'planMode',
  'messageCount',
  'tools',
  'toolUseCount',
  'estInputTokens',
  'fileRefCount',
  'retryCount',
  'frustration',
  'explicitModel',
  'projectPath',
  'sessionDurationMs',
  'betaFlags',
  'sessionId',
  'requestHash',
] as const);

export type KnownSignal = (typeof KNOWN_SIGNALS)[number];

export function isKnownSignal(name: string): name is KnownSignal {
  return (KNOWN_SIGNALS as readonly string[]).includes(name);
}
