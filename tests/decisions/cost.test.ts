import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { computeCostUsd, createCostContext, modelFromMessageStart, parseUsage } from '../../src/decisions/cost.js';
import type { PricingEntry } from '../../src/config/schema.js';

const PRICING: Record<string, PricingEntry> = {
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
  'claude-opus-4-7':           { input: 15,  output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
};

function mkLogger(): Pick<Logger, 'warn'> & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('cost accounting', () => {
  it('parses the four documented usage fields', () => {
    const u = parseUsage({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    });
    expect(u).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    });
  });

  it('returns null when usage is absent or all four fields are missing', () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ unrelated: 1 })).toBeNull();
  });

  it('records a per-component null when a single field is absent', () => {
    const u = parseUsage({ input_tokens: 100 });
    expect(u).toEqual({
      input_tokens: 100,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });
  });

  it('uses the pricing table to compute USD cost per million tokens', () => {
    const u = parseUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    const ctx = createCostContext(PRICING, mkLogger());
    const cost = computeCostUsd('claude-haiku-4-5-20251001', u, ctx);
    expect(cost).toBeCloseTo(0.8 + 4, 6);
  });

  it('returns null and warns once per process for an unknown model', () => {
    const logger = mkLogger();
    const ctx = createCostContext(PRICING, logger);
    const u = parseUsage({ input_tokens: 100 });
    expect(computeCostUsd('claude-mystery', u, ctx)).toBeNull();
    expect(computeCostUsd('claude-mystery', u, ctx)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null cost when usage is null (e.g., stream errored)', () => {
    const ctx = createCostContext(PRICING, mkLogger());
    expect(computeCostUsd('claude-opus-4-7', null, ctx)).toBeNull();
  });

  it('extracts the actual upstream model from a streaming message_start event', () => {
    const event = { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001' } };
    expect(modelFromMessageStart(event)).toBe('claude-haiku-4-5-20251001');
  });

  it('returns null when message_start does not carry a string model', () => {
    expect(modelFromMessageStart({})).toBeNull();
    expect(modelFromMessageStart({ message: {} })).toBeNull();
    expect(modelFromMessageStart({ message: { model: 42 } })).toBeNull();
  });
});
