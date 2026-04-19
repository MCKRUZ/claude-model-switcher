import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import type { CostBucket } from '../api/types';
import { getCosts } from '../api/client';

export default function CostChart() {
  const [buckets, setBuckets] = useState<CostBucket[]>([]);
  const [showClassifier, setShowClassifier] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCosts({ bucket: 'hour' })
      .then((res) => setBuckets([...res.buckets]))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading costs...</div>;
  if (error) return <div className="error">Failed to load costs: {error}</div>;

  const chartData = buckets.map((b) => ({
    time: new Date(b.ts_bucket).toLocaleTimeString(),
    cost: b.cost_usd,
    classifier: b.classifier_cost_usd,
    requests: b.requests,
  }));

  return (
    <div className="cost-chart">
      <div className="controls">
        <label>
          <input
            type="checkbox"
            checked={showClassifier}
            onChange={(e) => setShowClassifier(e.target.checked)}
          />
          Show classifier overhead
        </label>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart data={chartData}>
          <XAxis dataKey="time" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="cost" name="Forwarding Cost" fill="#8884d8" />
          {showClassifier && (
            <Bar dataKey="classifier" name="Classifier Cost" fill="#ff7300" />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
