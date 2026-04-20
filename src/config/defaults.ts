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
    pricing: {
      'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreate: 1.00 },
      'claude-sonnet-4-6':         { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 },
      'claude-opus-4-6':           { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
      'claude-opus-4-7':           { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
    },
  };
}
