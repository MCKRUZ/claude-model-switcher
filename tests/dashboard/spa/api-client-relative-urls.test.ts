import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('api client: relative URLs only', () => {
  let capturedUrls: string[];

  beforeEach(() => {
    capturedUrls = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      capturedUrls.push(url);
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  it('getSummary uses relative /api/summary path', async () => {
    const { getSummary } = await import('../../../src/dashboard/frontend/src/api/client.js');
    await getSummary();
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe('/api/summary');
    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
  });

  it('getDecisions uses relative /api/decisions path', async () => {
    const { getDecisions } = await import('../../../src/dashboard/frontend/src/api/client.js');
    await getDecisions({ limit: 50 });
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe('/api/decisions?limit=50');
    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
  });

  it('getCosts uses relative /api/costs path', async () => {
    const { getCosts } = await import('../../../src/dashboard/frontend/src/api/client.js');
    await getCosts({ bucket: 'day' });
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe('/api/costs?bucket=day');
    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
  });

  it('getDecisions with no params uses bare /api/decisions', async () => {
    const { getDecisions } = await import('../../../src/dashboard/frontend/src/api/client.js');
    await getDecisions();
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe('/api/decisions');
  });
});
