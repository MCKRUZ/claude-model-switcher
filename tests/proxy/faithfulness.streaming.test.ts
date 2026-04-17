// SSE streaming faithfulness: chunks byte-for-byte, ping events, content_block_delta counts, message_stop termination, unknown events.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { loadSseFixture, replaySse, startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';
import { buildRequest, parseRawResponse, streamRawRequest } from './helpers/http-client.js';

const SSE_DIR = join(process.cwd(), 'tests', 'fixtures', 'sse');

function sseExpectedBytes(lines: ReturnType<typeof loadSseFixture>): string {
  return lines.map((l) => `event: ${l.event}\ndata: ${l.data}\n\n`).join('');
}

describe('faithfulness.streaming', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  async function runFixture(name: string): Promise<string> {
    const lines = loadSseFixture(join(SSE_DIR, name));
    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json'], ['accept', 'text/event-stream']],
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [], stream: true }),
    });
    const { done } = streamRawRequest(proxy.port, req);
    const raw = await done;
    return parseRawResponse(raw).body.toString('utf8');
  }

  it('writes upstream SSE chunks to client socket in exact order and bytes captured in fixture', async () => {
    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
    const body = await runFixture('basic.jsonl');
    expect(body).toBe(sseExpectedBytes(lines));
  });

  it('forwards ping SSE events verbatim', async () => {
    const body = await runFixture('basic.jsonl');
    expect(body).toContain('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it('forwards content_block_delta events in the same order and quantity as the fixture', async () => {
    const lines = loadSseFixture(join(SSE_DIR, 'with-tool-use.jsonl'));
    up = await startUpstreamMock(async ({ res }) => replaySse(res, lines));
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    const req = buildRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const { done } = streamRawRequest(proxy.port, req);
    const body = parseRawResponse(await done).body.toString('utf8');
    const deltaCount = (body.match(/event: content_block_delta\n/g) ?? []).length;
    const fixtureDeltas = lines.filter((l) => l.event === 'content_block_delta').length;
    expect(deltaCount).toBe(fixtureDeltas);
    expect(body).toContain('partial_json');
  });

  it('terminates client stream on message_stop with no trailing bytes', async () => {
    const lines = loadSseFixture(join(SSE_DIR, 'basic.jsonl'));
    const body = await runFixture('basic.jsonl');
    expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
    expect(body).toBe(sseExpectedBytes(lines));
  });

  it('forwards unknown SSE event types (event: weird-new-type) byte-equal', async () => {
    const lines = loadSseFixture(join(SSE_DIR, 'unknown-event-type.jsonl'));
    const body = await runFixture('unknown-event-type.jsonl');
    expect(body).toContain('event: weird-new-type\n');
    expect(body).toBe(sseExpectedBytes(lines));
  });
});
