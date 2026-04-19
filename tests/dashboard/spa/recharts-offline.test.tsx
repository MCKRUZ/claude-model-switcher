// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { SummaryResponse } from '../../../src/dashboard/frontend/src/api/types.js';

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

const SUMMARY_DATA: SummaryResponse = {
  routingDistribution: { 'claude-opus-4': 10, 'claude-sonnet-4': 12, 'claude-haiku-4': 8 },
  cacheHitRate: 0.35,
  latency: { p50: 100, p95: 400, p99: 800 },
  totalCost: 2.5,
  classifierCost: 0.1,
};

describe('Recharts offline rendering', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ buckets: [] }), { status: 200 });
    });
  });

  it('SummaryPanel renders stat cards without network', async () => {
    const { default: SummaryPanel } = await import(
      '../../../src/dashboard/frontend/src/components/SummaryPanel.js'
    );
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(
        React.createElement(SummaryPanel, { data: SUMMARY_DATA }),
      );
    });

    expect(container.querySelector('.summary-panel')).not.toBeNull();
    expect(container.querySelector('.stat-value')).not.toBeNull();
    expect(container.textContent).toContain('35.0%');

    document.body.removeChild(container);
  });

  it('CostChart renders without network', async () => {
    const { default: CostChart } = await import(
      '../../../src/dashboard/frontend/src/components/CostChart.js'
    );
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(React.createElement(CostChart));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('.cost-chart')).not.toBeNull();

    document.body.removeChild(container);
  });
});
