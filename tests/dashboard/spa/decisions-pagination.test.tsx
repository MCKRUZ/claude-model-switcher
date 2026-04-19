// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('recharts', () => {
  const Stub = (props: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'recharts-stub' }, props.children);
  return {
    PieChart: Stub, Pie: Stub, Cell: Stub, BarChart: Stub, Bar: Stub,
    XAxis: Stub, YAxis: Stub, Tooltip: Stub, Legend: Stub, ResponsiveContainer: Stub,
  };
});

function makeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    decision_id: `d-${i}`,
    timestamp: new Date().toISOString(),
    session_id: 'sess-1',
    request_hash: `hash-${i}`,
    requested_model: 'claude-sonnet-4',
    forwarded_model: 'claude-sonnet-4',
    chosen_by: 'passthrough',
    upstream_latency_ms: 100 + i,
    cost_estimate_usd: 0.001,
    classifier_cost_usd: null,
    policy_result: { rule_id: null, action: 'forward', target_model: 'claude-sonnet-4' },
    classifier_result: null,
    usage: null,
  }));
}

describe('decisions pagination', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api/decisions')) {
        return new Response(
          JSON.stringify({
            items: makeRows(100),
            limit: 100,
            offset: 0,
            total_scanned: 100,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  it('renders decision rows from server response', async () => {
    const { default: DecisionsTable } = await import(
      '../../../src/dashboard/frontend/src/components/DecisionsTable.js'
    );
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(React.createElement(DecisionsTable));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(100);
    expect(rows.length).toBeLessThanOrEqual(1000);

    document.body.removeChild(container);
  });

  it('client clamps limit to 1000 when server returns clamped response', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrl = url;
      if (url.includes('/api/decisions')) {
        return new Response(
          JSON.stringify({
            items: makeRows(1000),
            limit: 1000,
            offset: 0,
            total_scanned: 2000,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { default: DecisionsTable } = await import(
      '../../../src/dashboard/frontend/src/components/DecisionsTable.js'
    );
    const container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      createRoot(container).render(React.createElement(DecisionsTable));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeLessThanOrEqual(1000);
    expect(capturedUrl).toContain('/api/decisions');

    document.body.removeChild(container);
  });
});
