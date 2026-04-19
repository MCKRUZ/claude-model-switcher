import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HAIKU_ENDPOINT,
  assertAllowedEndpoint,
  createHaikuClassifier,
  type HaikuClassifierDeps,
} from '../../src/classifier/haiku.js';
import type { ClassifierInput } from '../../src/classifier/types.js';
import type { ClassifierConfig, PricingEntry } from '../../src/config/schema.js';

const FIX_DIR = join(__dirname, 'fixtures', 'haiku');

function loadFixture(name: string): ClassifierInput {
  return JSON.parse(readFileSync(join(FIX_DIR, name), 'utf8')) as ClassifierInput;
}

function noDeadline(): AbortSignal {
  return new AbortController().signal;
}

const TEST_MODEL = 'claude-haiku-4-5-20251001';

const TEST_CONFIG: ClassifierConfig = {
  enabled: true,
  model: TEST_MODEL,
  timeoutMs: 800,
  confidenceThresholds: { haiku: 0.6, heuristic: 0.4 },
};

const TEST_PRICING: Readonly<Record<string, PricingEntry>> = {
  [TEST_MODEL]: {
    input: 0.000001,
    output: 0.000005,
    cacheCreate: 0.00000125,
    cacheRead: 0.0000001,
  },
};

interface MockFetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  };
}

interface MockFetchOptions {
  status?: number;
  ok?: boolean;
  json?: unknown;
  /** If provided, fetch never resolves until aborted. */
  hang?: boolean;
  /** Throw a synthetic error on call (e.g., simulate network 5xx after 'fetch' rejects). */
  reject?: Error;
}

function makeMockFetch(opts: MockFetchOptions = {}) {
  const calls: MockFetchCall[] = [];
  const fn = vi.fn((url: string, init: MockFetchCall['init']) => {
    calls.push({ url, init });
    if (opts.reject) return Promise.reject(opts.reject);
    if (opts.hang) {
      return new Promise<never>((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: () => Promise.resolve(opts.json ?? {}),
    });
  });
  return { fn, calls };
}

function defaultHaikuResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          complexity: 4.2,
          suggestedModel: 'sonnet',
          confidence: 0.7,
          rationale: 'mid-complexity task',
          ...overrides,
        }),
      },
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 30,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100,
    },
  };
}

describe('assertAllowedEndpoint', () => {
  it('accepts https://api.anthropic.com/v1/messages', () => {
    expect(() => assertAllowedEndpoint(HAIKU_ENDPOINT)).not.toThrow();
  });

  it.each([
    'https://api.anthropic.com/v1/messages/',
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com/v1/complete',
    'https://evil.example.com/v1/messages',
    'https://api.anthropic.com:8443/v1/messages',
    '',
  ])('throws on %s', (url) => {
    expect(() => assertAllowedEndpoint(url)).toThrow(/outbound endpoint must be exactly/);
  });
});

describe('createHaikuClassifier', () => {
  it('throws at construction when configured endpoint is not api.anthropic.com/v1/messages', () => {
    expect(() =>
      createHaikuClassifier({
        config: TEST_CONFIG,
        pricing: TEST_PRICING,
        endpoint: 'https://evil.example.com/v1/messages',
      }),
    ).toThrow(/outbound endpoint must be exactly/);
  });

  it('does not throw when endpoint is omitted', () => {
    expect(() =>
      createHaikuClassifier({ config: TEST_CONFIG, pricing: TEST_PRICING }),
    ).not.toThrow();
  });
});

describe('haiku classifier — header forwarding', () => {
  it('forwards x-api-key, anthropic-version, anthropic-beta from the intercepted request', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const input = loadFixture('multi-tool.json');
    // augment with anthropic-beta to assert pass-through
    const withBeta: ClassifierInput = {
      ...input,
      incomingHeaders: { ...input.incomingHeaders!, 'anthropic-beta': 'b1,b2' },
    };
    await c.classify(withBeta, noDeadline());
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers;
    expect(headers['x-api-key']).toBe('sk-test-xkey');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('b1,b2');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  it('prefers x-api-key and drops authorization when both are present (never both)', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const input = loadFixture('multi-tool.json');
    const both: ClassifierInput = {
      ...input,
      incomingHeaders: {
        ...input.incomingHeaders!,
        authorization: 'Bearer should-be-dropped',
      },
    };
    await c.classify(both, noDeadline());
    const headers = calls[0]!.init.headers;
    expect(headers['x-api-key']).toBe('sk-test-xkey');
    expect(headers['authorization']).toBeUndefined();
  });

  it('forwards authorization when x-api-key is absent', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    await c.classify(loadFixture('large.json'), noDeadline());
    const headers = calls[0]!.init.headers;
    expect(headers['authorization']).toBe('Bearer sk-test-bearer');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31,tools-2024-05-16');
  });

  it('resolves to null when neither x-api-key nor authorization is present (no network call)', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const input = loadFixture('small.json');
    const stripped: ClassifierInput = {
      ...input,
      incomingHeaders: { 'anthropic-version': '2023-06-01' },
    };
    const result = await c.classify(stripped, noDeadline());
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('resolves to null when incomingHeaders is undefined (no network call)', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const input = loadFixture('small.json');
    const stripped = { ...input } as ClassifierInput & {
      incomingHeaders?: Readonly<Record<string, string>>;
    };
    delete stripped.incomingHeaders;
    const result = await c.classify(stripped, noDeadline());
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not synthesize anthropic-version when absent', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const input = loadFixture('small.json');
    const noVer: ClassifierInput = {
      ...input,
      incomingHeaders: { 'x-api-key': 'sk-test-xkey' },
    };
    await c.classify(noVer, noDeadline());
    expect(calls[0]!.init.headers['anthropic-version']).toBeUndefined();
  });
});

describe('haiku classifier — outbound body', () => {
  it('contains cache_control marker on the system prompt prefix', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    await c.classify(loadFixture('multi-tool.json'), noDeadline());
    const body = JSON.parse(calls[0]!.init.body) as {
      model: string;
      system: Array<{ type: string; cache_control?: { type: string } }>;
    };
    expect(body.model).toBe(TEST_MODEL);
    expect(body.system).toHaveLength(1);
    expect(body.system[0]!.type).toBe('text');
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('targets exactly HAIKU_ENDPOINT', async () => {
    const { fn, calls } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    await c.classify(loadFixture('small.json'), noDeadline());
    expect(calls[0]!.url).toBe(HAIKU_ENDPOINT);
  });
});

describe('haiku classifier — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hard-timeout at 800ms resolves to null and aborts its own fetch only', async () => {
    const upstreamCtl = new AbortController();
    const upstreamAborted = vi.fn();
    upstreamCtl.signal.addEventListener('abort', upstreamAborted);

    const { fn } = makeMockFetch({ hang: true });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const promise = c.classify(loadFixture('multi-tool.json'), noDeadline());
    await vi.advanceTimersByTimeAsync(801);
    const result = await promise;
    expect(result).toBeNull();
    // Independent "upstream" controller untouched.
    expect(upstreamAborted).not.toHaveBeenCalled();
    expect(upstreamCtl.signal.aborted).toBe(false);
  });

  it('respects the race-level deadline signal', async () => {
    const deadlineCtl = new AbortController();
    const { fn } = makeMockFetch({ hang: true });
    const c = createHaikuClassifier({
      config: { ...TEST_CONFIG, timeoutMs: 60_000 },
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const promise = c.classify(loadFixture('multi-tool.json'), deadlineCtl.signal);
    deadlineCtl.abort();
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe('haiku classifier — response parsing', () => {
  it('parses valid JSON response into ClassifierResult with source: "haiku"', async () => {
    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('multi-tool.json'), noDeadline());
    expect(result).not.toBeNull();
    expect(result!.source).toBe('haiku');
    expect(result!.score).toBe(4.2);
    expect(result!.suggestedModel).toBe('sonnet');
    expect(result!.confidence).toBe(0.7);
    expect(result!.rationale).toBe('mid-complexity task');
    expect(typeof result!.latencyMs).toBe('number');
    expect(typeof result!.classifierCostUsd).toBe('number');
  });

  it('omits rationale when model omits it', async () => {
    const resp = defaultHaikuResponse();
    resp.content[0]!.text = JSON.stringify({
      complexity: 1, suggestedModel: 'haiku', confidence: 0.9,
    });
    const { fn } = makeMockFetch({ json: resp });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).not.toBeNull();
    expect(result!.rationale).toBeUndefined();
  });

  it('returns null on malformed JSON in model response', async () => {
    const { fn } = makeMockFetch({
      json: { content: [{ type: 'text', text: 'not json at all {' }] },
    });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).toBeNull();
  });

  it('returns null when JSON is structurally valid but fails schema check', async () => {
    const { fn } = makeMockFetch({
      json: {
        content: [{ type: 'text', text: JSON.stringify({ complexity: 5, suggestedModel: 'gpt-5', confidence: 0.8 }) }],
      },
    });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).toBeNull();
  });

  it('returns null when complexity is out of range', async () => {
    const { fn } = makeMockFetch({
      json: {
        content: [{ type: 'text', text: JSON.stringify({ complexity: 11, suggestedModel: 'opus', confidence: 0.9 }) }],
      },
    });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
  });

  it('returns null on upstream 4xx without reading the response body', async () => {
    const jsonSpy = vi.fn(() => Promise.resolve({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    const fn = vi.fn(() => Promise.resolve({ ok: false, status: 401, json: jsonSpy }));
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn as unknown as HaikuClassifierDeps['fetchImpl'],
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).toBeNull();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('does not throw on upstream 5xx — returns null', async () => {
    const { fn } = makeMockFetch({ ok: false, status: 503, json: { error: 'overloaded' } });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
  });

  it('does not throw when the fetch itself rejects — returns null', async () => {
    const { fn } = makeMockFetch({ reject: new Error('ECONNRESET') });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    expect(await c.classify(loadFixture('small.json'), noDeadline())).toBeNull();
  });
});

describe('haiku classifier — cost reporting', () => {
  it('computes classifierCostUsd from usage fields (including cache tokens) using pricing table', async () => {
    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('multi-tool.json'), noDeadline());
    expect(result).not.toBeNull();
    // 50*1e-6 + 100*1e-6*1.25 + 400*1e-6*0.1 + 30*5e-6
    // = 5e-5 + 1.25e-4 + 4e-5 + 1.5e-4 = 3.65e-4
    expect(result!.classifierCostUsd).toBeCloseTo(3.65e-4, 10);
  });

  it('classifierCostUsd is 0 when no pricing entry for the model', async () => {
    const { fn } = makeMockFetch({ json: defaultHaikuResponse() });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: {},
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).not.toBeNull();
    expect(result!.classifierCostUsd).toBe(0);
  });

  it('classifierCostUsd handles missing usage fields gracefully', async () => {
    const resp = {
      content: [{ type: 'text', text: JSON.stringify({ complexity: 2, suggestedModel: 'haiku', confidence: 0.8 }) }],
    };
    const { fn } = makeMockFetch({ json: resp });
    const c = createHaikuClassifier({
      config: TEST_CONFIG,
      pricing: TEST_PRICING,
      fetchImpl: fn,
    } as HaikuClassifierDeps);
    const result = await c.classify(loadFixture('small.json'), noDeadline());
    expect(result).not.toBeNull();
    expect(result!.classifierCostUsd).toBe(0);
  });
});
