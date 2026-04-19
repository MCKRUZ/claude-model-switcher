// Cost accounting for decision-log records.
//
// Parses the four token fields from an Anthropic response.usage object and
// multiplies by the per-model pricing table from config.yaml. Per the
// section-13 contract:
//
//   - The chargeable model is the actual upstream model (response.model or
//     message_start.model for streaming) — NOT the client-requested model.
//   - Unknown model in the pricing table → cost is null. A single warning
//     is emitted per model per process via the supplied logger.
//   - If any of the four usage fields is absent, that component is null;
//     if all are absent, total cost is null. We never silently
//     under-report by treating missing fields as zero.

import type { Logger } from 'pino';
import type { PricingEntry } from '../config/schema.js';
import type { UsageFields } from './types.js';

export function parseUsage(raw: unknown): UsageFields | null {
  if (raw === null || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const input = numOrNull(u.input_tokens);
  const output = numOrNull(u.output_tokens);
  const cacheRead = numOrNull(u.cache_read_input_tokens);
  const cacheCreate = numOrNull(u.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheCreate === null) {
    return null;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface CostContext {
  readonly pricing: Readonly<Record<string, PricingEntry>>;
  readonly logger: Pick<Logger, 'warn'>;
  /** Mutable set so the warning fires only once per model per process. */
  readonly warnedModels: Set<string>;
}

export function createCostContext(
  pricing: Readonly<Record<string, PricingEntry>>,
  logger: Pick<Logger, 'warn'>,
): CostContext {
  return { pricing, logger, warnedModels: new Set() };
}

export function computeCostUsd(
  model: string,
  usage: UsageFields | null,
  ctx: CostContext,
): number | null {
  if (usage === null) return null;
  const rate = ctx.pricing[model];
  if (rate === undefined) {
    if (!ctx.warnedModels.has(model)) {
      ctx.warnedModels.add(model);
      ctx.logger.warn({ event: 'cost_unavailable_unknown_model', model }, 'no pricing entry for model');
    }
    return null;
  }
  let total = 0;
  let any = false;
  if (usage.input_tokens !== null) {
    total += (usage.input_tokens / 1_000_000) * rate.input;
    any = true;
  }
  if (usage.output_tokens !== null) {
    total += (usage.output_tokens / 1_000_000) * rate.output;
    any = true;
  }
  if (usage.cache_read_input_tokens !== null) {
    total += (usage.cache_read_input_tokens / 1_000_000) * rate.cacheRead;
    any = true;
  }
  if (usage.cache_creation_input_tokens !== null) {
    total += (usage.cache_creation_input_tokens / 1_000_000) * rate.cacheCreate;
    any = true;
  }
  return any ? total : null;
}

/**
 * Extracts the upstream model from a parsed `message_start` SSE event payload.
 * Returns null if the shape is not recognized.
 */
export function modelFromMessageStart(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null;
  const obj = event as Record<string, unknown>;
  const msg = obj.message;
  if (msg === null || typeof msg !== 'object') return null;
  const m = (msg as Record<string, unknown>).model;
  return typeof m === 'string' ? m : null;
}
