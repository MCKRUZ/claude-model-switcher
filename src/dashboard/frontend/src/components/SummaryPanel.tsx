import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { SummaryResponse } from '../api/types';

const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#0088fe'];

interface Props {
  readonly data: SummaryResponse | null;
}

export default function SummaryPanel({ data }: Props) {
  if (!data) return <div className="loading">Loading summary...</div>;

  const pieData = Object.entries(data.routingDistribution).map(
    ([name, value]) => ({ name, value }),
  );
  const latencyData = [
    { name: 'p50', value: data.latency.p50 },
    { name: 'p95', value: data.latency.p95 },
    { name: 'p99', value: data.latency.p99 },
  ];

  return (
    <div className="summary-panel">
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Cache Hit Rate</h3>
          <span className="stat-value">
            {(data.cacheHitRate * 100).toFixed(1)}%
          </span>
        </div>
        <div className="stat-card">
          <h3>Total Cost</h3>
          <span className="stat-value">${data.totalCost.toFixed(4)}</span>
        </div>
        <div className="stat-card">
          <h3>Classifier Cost</h3>
          <span className="stat-value">${data.classifierCost.toFixed(4)}</span>
        </div>
      </div>

      <div className="charts-row">
        <div className="chart-container">
          <h3>Routing Distribution</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-container">
          <h3>Latency Percentiles (ms)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={latencyData}>
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="value" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
