import { useState, useEffect } from 'react';
import type { SummaryResponse } from './api/types';
import { getSummary } from './api/client';
import SummaryPanel from './components/SummaryPanel';
import DecisionsTable from './components/DecisionsTable';
import CostChart from './components/CostChart';

type Tab = 'summary' | 'decisions' | 'costs';

export default function App() {
  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSummary()
      .then(setSummary)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <header>
        <h1>ccmux Dashboard</h1>
        <nav>
          {(['summary', 'decisions', 'costs'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {error && <div className="error">{error}</div>}
        {tab === 'summary' && <SummaryPanel data={summary} />}
        {tab === 'decisions' && <DecisionsTable />}
        {tab === 'costs' && <CostChart />}
      </main>
    </div>
  );
}
