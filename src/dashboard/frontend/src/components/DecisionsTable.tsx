import { useState, useEffect } from 'react';
import type { DecisionRow } from '../api/types';
import { getDecisions } from '../api/client';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const LIMIT = Math.min(DEFAULT_LIMIT, MAX_LIMIT);

export default function DecisionsTable() {
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [totalScanned, setTotalScanned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getDecisions({ limit: LIMIT, offset })
      .then((res) => {
        setRows([...res.items]);
        setTotalScanned(res.total_scanned);
      })
      .catch((e: Error) => {
        setRows([]);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [offset]);

  if (loading) return <div className="loading">Loading decisions...</div>;
  if (error) return <div className="error">Failed to load decisions: {error}</div>;

  return (
    <div className="decisions-table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Requested</th>
            <th>Forwarded</th>
            <th>Chosen By</th>
            <th>Latency (ms)</th>
            <th>Cost ($)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.decision_id}>
              <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
              <td>{row.requested_model}</td>
              <td>{row.forwarded_model}</td>
              <td>{row.chosen_by}</td>
              <td>{row.upstream_latency_ms}</td>
              <td>{row.cost_estimate_usd?.toFixed(6) ?? '\u2014'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - LIMIT))}
        >
          Previous
        </button>
        <span>
          Showing {offset + 1}\u2013{offset + rows.length} (scanned{' '}
          {totalScanned})
        </span>
        <button
          disabled={rows.length < LIMIT}
          onClick={() => setOffset(offset + LIMIT)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
