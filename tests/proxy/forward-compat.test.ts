// Forward compatibility: unknown fields survive at every known nesting level.
import { describe, it, expect, afterEach } from 'vitest';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock.js';
import { buildProxy, type BuiltProxy } from './helpers/build-proxy.js';

describe('forward-compat', () => {
  let up: UpstreamMock | undefined;
  let proxy: BuiltProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (up) await up.close();
    up = undefined;
    proxy = undefined;
  });

  const variants: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'top-level',
      body: { model: 'm', messages: [], unknown_top_level: { flag: true, count: 7 } },
    },
    {
      label: 'inside messages[].content[]',
      body: {
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'future_block', data: { deep: [1, 2, 3] } }] },
        ],
      },
    },
    {
      label: 'inside tools[]',
      body: {
        model: 'm',
        messages: [],
        tools: [{ name: 't', description: 'd', input_schema: {}, future_param: { x: 1 } }],
      },
    },
    {
      label: 'inside metadata',
      body: { model: 'm', messages: [], metadata: { user_id: 'u', future_metadata: 'yes' } },
    },
  ];

  it.each(variants)('injects unknown fields at every known nesting level and verifies round-trip to upstream ($label)', async ({ body }) => {
    up = await startUpstreamMock(({ res }) => { res.writeHead(200); res.end('{}'); });
    proxy = await buildProxy({ upstreamOrigin: up.origin });
    await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sent = JSON.parse(up.requests[0]!.body.toString('utf8'));
    expect(sent).toEqual(body);
  });
});
