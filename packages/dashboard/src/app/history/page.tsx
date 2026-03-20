'use client';

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || '';

interface SuiteRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
}

interface TestRun {
  id: string;
  test_id: string;
  test_name: string;
  status: string;
  duration_ms: number | null;
  model_verdict: string | null;
}

export default function HistoryPage() {
  const [suites, setSuites] = useState<SuiteRun[]>([]);
  const [expandedSuite, setExpandedSuite] = useState<string | null>(null);
  const [testRuns, setTestRuns] = useState<Record<string, TestRun[]>>({});

  useEffect(() => {
    fetch(`${API}/api/suites?limit=50`).then(r => r.json()).then(setSuites);
  }, []);

  const toggleSuite = async (suiteId: string) => {
    if (expandedSuite === suiteId) {
      setExpandedSuite(null);
      return;
    }
    setExpandedSuite(suiteId);
    if (!testRuns[suiteId]) {
      const res = await fetch(`${API}/api/suites/${suiteId}`);
      const data = await res.json();
      setTestRuns(prev => ({ ...prev, [suiteId]: data.testRuns ?? [] }));
    }
  };

  const passRate = (s: SuiteRun) => s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;

  const statusDot: Record<string, string> = {
    passed: 'bg-emerald-400',
    failed: 'bg-red-400',
    error: 'bg-orange-400',
    timeout: 'bg-yellow-400',
    running: 'bg-blue-400 animate-pulse',
    queued: 'bg-gray-400',
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-50">Run History</h2>

      {suites.length === 0 ? (
        <p className="text-gray-500 text-center py-20">No test runs yet. Run your first suite from the Dashboard.</p>
      ) : (
        <div className="space-y-3">
          {suites.map(suite => (
            <div key={suite.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button
                onClick={() => toggleSuite(suite.id)}
                className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <span className="text-sm text-gray-400 font-mono">
                    {new Date(suite.started_at).toLocaleString()}
                  </span>
                  <span className="text-sm text-gray-50 font-medium">
                    {suite.total} tests
                  </span>
                </div>
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-emerald-400">{suite.passed} passed</span>
                    <span className="text-red-400">{suite.failed} failed</span>
                    {suite.errors > 0 && <span className="text-orange-400">{suite.errors} errors</span>}
                    {suite.timeouts > 0 && <span className="text-yellow-400">{suite.timeouts} timeouts</span>}
                  </div>
                  <div className="w-16 text-right">
                    <span className={`text-sm font-bold ${passRate(suite) === 100 ? 'text-emerald-400' : passRate(suite) >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {passRate(suite)}%
                    </span>
                  </div>
                  <span className="text-gray-600 text-sm">{expandedSuite === suite.id ? '▲' : '▼'}</span>
                </div>
              </button>

              {expandedSuite === suite.id && testRuns[suite.id] && (
                <div className="border-t border-gray-800 px-5 py-3 space-y-2">
                  {testRuns[suite.id].map(run => (
                    <a
                      key={run.id}
                      href={`/runs/${run.id}`}
                      className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-800/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${statusDot[run.status] ?? 'bg-gray-500'}`} />
                        <span className="text-sm text-gray-300">{run.test_name}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        {run.duration_ms && <span>{(run.duration_ms / 1000).toFixed(1)}s</span>}
                        <span className="uppercase">{run.status}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
