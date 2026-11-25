// End to end: two requests that differ only by a date go through the real proxy.
// The second decision-log line must carry the cache_buster finding next to the
// usage the upstream billed, and Anthropic must receive the exact bytes sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionLogWriter } from '../../src/decisions/log.js';
import type { DecisionRecord } from '../../src/decisions/types.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { CcmuxConfig } from '../../src/config/schema.js';
import { __resetCacheBusterForTests } from '../../src/signals/cache-buster.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';

const USAGE_BY_CALL = [
  { input_tokens: 12, output_tokens: 40, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 0 },
  { input_tokens: 12, output_tokens: 38, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 7 },
];

function requestBody(date: string): string {
  return JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    system: `You are a coding assistant. Today's date is ${date}. Be concise.`,
    tools: [
      {
        name: 'Read',
        description: 'Reads a file.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  });
}

function capturingWriter(records: DecisionRecord[]): DecisionLogWriter {
  return {
    append: (record) => {
      records.push(record);
      return true;
    },
    flush: async () => undefined,
    close: async () => undefined,
    currentPath: () => '',
    currentBytes: () => 0,
    droppedPostAccept: () => 0,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for decision records');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function post(proxy: BuiltProxy, body: string): Promise<void> {
  const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body,
  });
  await res.text();
}

describe('cache-buster detection through the proxy', () => {
  let upstream: UpstreamMock;
  let proxy: BuiltProxy;
  const records: DecisionRecord[] = [];
  let calls = 0;

  beforeEach(async () => {
    __resetCacheBusterForTests();
    records.length = 0;
    calls = 0;
    upstream = await startUpstreamMock(({ res }) => {
      const usage = USAGE_BY_CALL[Math.min(calls, USAGE_BY_CALL.length - 1)];
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          usage,
        }),
      );
    });
    // Shadow mode forwards the client's model untouched, and the classifier is
    // off so it sends no requests of its own to the upstream mock.
    const base = defaultConfig();
    const config: CcmuxConfig = {
      ...base,
      mode: 'shadow',
      classifier: { ...base.classifier, enabled: false },
    };
    proxy = await buildProxy({
      upstreamOrigin: upstream.origin,
      configOverrides: config,
      configStore: { getCurrent: () => config },
      decisionWriter: capturingWriter(records),
    });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  it('logs the finding with high cache_creation and near-zero cache_read, and forwards bytes unchanged', async () => {
    const first = requestBody('2025-03-14');
    const second = requestBody('2025-03-15');

    await post(proxy, first);
    await post(proxy, second);
    await waitFor(() => records.length === 2);

    const [firstRecord, secondRecord] = records;
    expect(firstRecord?.cache_buster).toBeUndefined();
    expect(secondRecord?.cache_buster?.kinds).toEqual(['date']);
    expect(secondRecord?.cache_buster?.prefix_fingerprint).toMatch(/^[0-9a-f]{32}$/);

    const usage = secondRecord?.usage;
    expect(usage?.cache_creation_input_tokens).toBeGreaterThanOrEqual(20_000);
    expect(usage?.cache_read_input_tokens).toBeLessThanOrEqual(10);

    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0]?.body.equals(Buffer.from(first))).toBe(true);
    expect(upstream.requests[1]?.body.equals(Buffer.from(second))).toBe(true);

    const serialized = JSON.stringify(secondRecord);
    expect(serialized).not.toContain('2025-03-1');
    expect(serialized).not.toContain('coding assistant');
  });

  it('does not flag a repeat of the identical request', async () => {
    const body = requestBody('2025-03-14');
    await post(proxy, body);
    await post(proxy, body);
    await waitFor(() => records.length === 2);
    expect(records.every((r) => r.cache_buster === undefined)).toBe(true);
  });
});
