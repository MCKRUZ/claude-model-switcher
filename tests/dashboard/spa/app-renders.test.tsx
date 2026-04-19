// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('recharts', () => {
  const Stub = (props: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'recharts-stub' }, props.children);
  return {
    PieChart: Stub,
    Pie: Stub,
    Cell: Stub,
    BarChart: Stub,
    Bar: Stub,
    XAxis: Stub,
    YAxis: Stub,
    Tooltip: Stub,
    Legend: Stub,
    ResponsiveContainer: Stub,
  };
});

const SUMMARY_FIXTURE = {
  routingDistribution: { 'claude-opus-4': 10, 'claude-sonnet-4': 15 },
  cacheHitRate: 0.45,
  latency: { p50: 120, p95: 450, p99: 900 },
  totalCost: 1.234,
  classifierCost: 0.056,
};

const DECISIONS_FIXTURE = {
  items: [],
  limit: 100,
  offset: 0,
  total_scanned: 0,
};

const COSTS_FIXTURE = {
  buckets: [],
};

describe('App smoke render', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (url: string) => {
      let body = {};
      if (url.includes('/api/summary')) body = SUMMARY_FIXTURE;
      else if (url.includes('/api/decisions')) body = DECISIONS_FIXTURE;
      else if (url.includes('/api/costs')) body = COSTS_FIXTURE;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });

  it('mounts <App /> without throwing', async () => {
    const { default: App } = await import(
      '../../../src/dashboard/frontend/src/App.js'
    );
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(React.createElement(App));
    });

    expect(container.querySelector('header')).not.toBeNull();
    expect(container.textContent).toContain('ccmux Dashboard');

    document.body.removeChild(container);
  });
});
