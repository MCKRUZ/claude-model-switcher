import type { CcmuxConfig } from './schema.js';

export function defaultConfig(): CcmuxConfig {
  return {
    port: 8787,
    mode: 'live',
    security: { requireProxyToken: false },
    rules: [],
    classifier: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 800,
      confidenceThresholds: { haiku: 0.6, heuristic: 0.4 },
    },
    stickyModel: { enabled: true, sessionTtlMs: 7_200_000 },
    modelTiers: {},
    logging: {
      content: 'hashed',
      fsync: false,
      rotation: { strategy: 'daily', keep: 30, maxMb: 10 },
    },
    dashboard: { port: 8788 },
    pricing: {},
  };
}
