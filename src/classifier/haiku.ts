// Haiku-backed classifier (§12).
//
// Races the heuristic classifier; resolves to `null` on any failure so the
// upstream user request is never affected. Outbound endpoint is hard-pinned
// to api.anthropic.com/v1/messages — there is no config knob to relax this.

import { fetch as undiciFetch } from 'undici';
import type {
  Classifier,
  ClassifierInput,
  ClassifierResult,
  Tier,
} from './types.js';
import type { ClassifierConfig, PricingEntry } from '../config/schema.js';
import { CLASSIFIER_PROMPT } from './prompt.js';

export const HAIKU_ENDPOINT = 'https://api.anthropic.com/v1/messages';

const MAX_USER_SUMMARY_CHARS = 2000;
const MAX_HAIKU_OUTPUT_TOKENS = 256;

type FetchImpl = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HaikuClassifierDeps {
  readonly config: ClassifierConfig;
  /** Pricing table keyed by model id; see `PricingEntry` in config schema. */
  readonly pricing: Readonly<Record<string, PricingEntry>>;
  /**
   * Optional override URL — must be exactly {@link HAIKU_ENDPOINT} or
   * construction throws. Intentionally retained even though no caller
   * passes it today: if `ClassifierConfig` ever grows an `endpoint` field
   * the allowlist check is already wired up. See §12 spec line 7.
   */
  readonly endpoint?: string;
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => number;
}

/**
 * Throws synchronously if `url` is not the single allowed Haiku endpoint.
 * Exposed so tests and `init` can share the check.
 */
export function assertAllowedEndpoint(url: string): void {
  if (url !== HAIKU_ENDPOINT) {
    throw new Error(
      `HaikuClassifier: outbound endpoint must be exactly "${HAIKU_ENDPOINT}", got "${url}"`,
    );
  }
}

interface HaikuJson {
  readonly complexity: number;
  readonly suggestedModel: Tier;
  readonly confidence: number;
  readonly rationale?: string;
}

function isValidHaikuJson(x: unknown): x is HaikuJson {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o['complexity'] !== 'number' || !Number.isFinite(o['complexity'])) return false;
  if (o['complexity'] < 0 || o['complexity'] > 10) return false;
  if (typeof o['confidence'] !== 'number' || !Number.isFinite(o['confidence'])) return false;
  if (o['confidence'] < 0 || o['confidence'] > 1) return false;
  const sm = o['suggestedModel'];
  if (sm !== 'opus' && sm !== 'sonnet' && sm !== 'haiku') return false;
  if (o['rationale'] !== undefined && typeof o['rationale'] !== 'string') return false;
  return true;
}

interface AuthHeaders {
  readonly headers: Record<string, string>;
}

function selectAuthHeaders(
  incoming: Readonly<Record<string, string>> | undefined,
): AuthHeaders | null {
  if (!incoming) return null;
  const out: Record<string, string> = {};
  const xKey = incoming['x-api-key'];
  const auth = incoming['authorization'];
  // Never both; never substituted.
  if (typeof xKey === 'string' && xKey.length > 0) {
    out['x-api-key'] = xKey;
  } else if (typeof auth === 'string' && auth.length > 0) {
    out['authorization'] = auth;
  } else {
    return null;
  }
  const ver = incoming['anthropic-version'];
  if (typeof ver === 'string' && ver.length > 0) out['anthropic-version'] = ver;
  const beta = incoming['anthropic-beta'];
  if (typeof beta === 'string' && beta.length > 0) out['anthropic-beta'] = beta;
  out['content-type'] = 'application/json';
  return { headers: out };
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function summarizeRequest(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    const text = flattenText(m.content);
    return text.length > MAX_USER_SUMMARY_CHARS
      ? text.slice(0, MAX_USER_SUMMARY_CHARS)
      : text;
  }
  return '';
}

interface HaikuUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

function toFiniteNonNegative(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

function computeClassifierCost(
  usage: HaikuUsage | undefined,
  pricing: PricingEntry | undefined,
): number {
  if (!pricing) return 0;
  const input = toFiniteNonNegative(usage?.input_tokens);
  const output = toFiniteNonNegative(usage?.output_tokens);
  const cacheRead = toFiniteNonNegative(usage?.cache_read_input_tokens);
  const cacheCreate = toFiniteNonNegative(usage?.cache_creation_input_tokens);
  return (
    input * pricing.input +
    cacheCreate * pricing.cacheCreate +
    cacheRead * pricing.cacheRead +
    output * pricing.output
  );
}

function extractAssistantText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return '';
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface InternalDeps {
  readonly config: ClassifierConfig;
  readonly pricing: Readonly<Record<string, PricingEntry>>;
  readonly fetchImpl: FetchImpl;
  readonly now: () => number;
}

function buildClassifierResult(
  data: { content?: unknown; usage?: HaikuUsage },
  deps: InternalDeps,
  start: number,
): ClassifierResult | null {
  const parsed = safeParseJson(extractAssistantText(data));
  if (!isValidHaikuJson(parsed)) return null;

  const pricingEntry = deps.pricing[deps.config.model];
  const classifierCostUsd = computeClassifierCost(data.usage, pricingEntry);

  const base: ClassifierResult = {
    score: parsed.complexity,
    suggestedModel: parsed.suggestedModel,
    confidence: parsed.confidence,
    source: 'haiku',
    latencyMs: deps.now() - start,
    classifierCostUsd,
  };
  return parsed.rationale !== undefined
    ? { ...base, rationale: parsed.rationale }
    : base;
}

class HaikuClassifier implements Classifier {
  constructor(private readonly deps: InternalDeps) {}

  async classify(
    input: ClassifierInput,
    deadline: AbortSignal,
  ): Promise<ClassifierResult | null> {
    const start = this.deps.now();
    // Short-circuit if the race deadline already fired — avoids constructing
    // an AbortController/timer that would leak if `AbortSignal.any` rejected.
    if (deadline.aborted) return null;

    const auth = selectAuthHeaders(input.incomingHeaders);
    if (!auth) return null;

    const localCtl = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(
      () => localCtl.abort(),
      this.deps.config.timeoutMs,
    );
    // `unref` so a hung fetch never blocks process exit.
    timer.unref?.();
    try {
      const signal = AbortSignal.any([deadline, localCtl.signal]);

      const outbound = {
        model: this.deps.config.model,
        max_tokens: MAX_HAIKU_OUTPUT_TOKENS,
        system: [
          {
            type: 'text',
            text: CLASSIFIER_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: summarizeRequest(input.body) },
        ],
      };

      const response = await this.deps.fetchImpl(HAIKU_ENDPOINT, {
        method: 'POST',
        headers: auth.headers,
        body: JSON.stringify(outbound),
        signal,
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { content?: unknown; usage?: HaikuUsage };
      return buildClassifierResult(data, this.deps, start);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createHaikuClassifier(deps: HaikuClassifierDeps): Classifier {
  // Synchronous startup assertion — failure here is a configuration error,
  // not a per-request fallback.
  assertAllowedEndpoint(deps.endpoint ?? HAIKU_ENDPOINT);
  return new HaikuClassifier({
    config: deps.config,
    pricing: deps.pricing,
    fetchImpl: (deps.fetchImpl ?? (undiciFetch as unknown as FetchImpl)),
    now: deps.now ?? (() => performance.now()),
  });
}
