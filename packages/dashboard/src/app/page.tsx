'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ── Types ────────────────────────────────────────────────────────

interface TestDefinition {
  id: string;
  name: string;
  url: string;
  tags?: string[];
  category?: 'smoke' | 'sanity' | 'regression' | 'e2e';
  timeout: number;
  requires_auth?: boolean;
}

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
  turn_count: number;
  screenshot_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_verdict: string | null;
  error: string | null;
}

interface TestAccount {
  email: string;
  password: string;
  passwordMasked: string;
}

type TabId = 'overview' | 'results' | 'failures' | 'logs' | 'config';

function statusBadge(status: string) {
  switch (status) {
    case 'passed': return 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/30';
    case 'failed': return 'bg-red-50 text-red-600 border-red-200 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30';
    case 'running': return 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30';
    case 'error': return 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-500/30';
    case 'timeout': return 'bg-yellow-50 text-yellow-600 border-yellow-200 dark:bg-yellow-500/20 dark:text-yellow-400 dark:border-yellow-500/30';
    default: return 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-500/20 dark:text-gray-400 dark:border-gray-500/30';
  }
}

// ── Main Page ────────────────────────────────────────────────────

export default function DashboardPage() {
  const [tests, setTests] = useState<TestDefinition[]>([]);
  const [latestSuite, setLatestSuite] = useState<SuiteRun | null>(null);
  const [testRuns, setTestRuns] = useState<TestRun[]>([]);
  const [running, setRunning] = useState(false);
  const [activeSuiteId, setActiveSuiteId] = useState<string | null>(null);
  const activeSuiteIdRef = useRef<string | null>(null);
  useEffect(() => { activeSuiteIdRef.current = activeSuiteId; }, [activeSuiteId]);



  // UI state
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [headless, setHeadless] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Config / account state
  const [account, setAccount] = useState<TestAccount | null>(null);
  const [editingAccount, setEditingAccount] = useState(false);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);

  // Logs state
  const [logEvents, setLogEvents] = useState<Array<{ type: string; message: string; timestamp: string }>>([]);

  // Modal state
  const [showResetModal, setShowResetModal] = useState(false);

  // ── Data loading ─────────────────────────────────────────────

  // Load initial data + detect active suites
  const loadData = useCallback(async () => {
    try {
      const [testsRes, accountRes] = await Promise.all([
        fetch(`${API}/api/tests`),
        fetch(`${API}/api/config/account`),
      ]);
      setTests(await testsRes.json());
      setAccount(await accountRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Single unified poll — runs every 2s, handles everything
  useEffect(() => {
    let isMounted = true;

    const poll = async () => {
      if (!isMounted) return;
      try {
        // Always fetch latest runs + latest suite
        const [latestRunsRes, suitesRes] = await Promise.all([
          fetch(`${API}/api/runs/latest`),
          fetch(`${API}/api/suites?limit=1`),
        ]);
        const latestRuns = await latestRunsRes.json();
        const suitesData = await suitesRes.json();
        const baseRuns: TestRun[] = Array.isArray(latestRuns) ? latestRuns : [];

        if (!isMounted) return;
        if (suitesData.length > 0) {
          setLatestSuite(suitesData[0]);
          // Auto-detect active suite on page load
          if (!suitesData[0].completed_at) {
            setActiveSuiteId(prev => prev ?? suitesData[0].id);
            setRunning(true);
          }
        }

        // Merge new data with existing — never lose data
        setTestRuns(prev => {
          const merged = new Map<string, TestRun>();
          // Keep existing runs as base
          prev.forEach(r => merged.set(r.test_id, r));
          // Overwrite with latest from DB
          baseRuns.forEach(r => merged.set(r.test_id, r));
          return Array.from(merged.values());
        });

        // If there's an active suite, also merge its runs for immediate updates
        const currentSuiteId = activeSuiteIdRef.current;
        if (currentSuiteId) {
          const suiteRes = await fetch(`${API}/api/suites/${currentSuiteId}`);
          const suiteData = await suiteRes.json();
          if (!isMounted) return;
          setLatestSuite(suiteData);

          const suiteRuns: TestRun[] = suiteData.testRuns ?? [];
          setTestRuns(prev => {
            const merged = new Map<string, TestRun>();
            prev.forEach(r => merged.set(r.test_id, r));
            suiteRuns.forEach(r => merged.set(r.test_id, r));
            return Array.from(merged.values());
          });

          // Check completion
          if (suiteData.completed_at) {
            setRunning(false);
            setActiveSuiteId(null);
          }

          // Poll log events for the running test
          const activeRun = suiteRuns.find((r: TestRun) => r.status === 'running');
          if (activeRun) {
            const runRes = await fetch(`${API}/api/runs/${activeRun.id}`);
            const runData = await runRes.json();
            if (isMounted) setLogEvents(runData.events ?? []);
          }
        }
      } catch { /* ignore */ }
    };

    // Run immediately, then every 2s
    poll();
    const interval = setInterval(poll, 2000);
    return () => { isMounted = false; clearInterval(interval); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────────────

  const getFilteredTestIds = () => {
    let filtered = tests;

    // Apply category filter
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(t => t.category === categoryFilter);
    }

    // Apply search filter
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      filtered = filtered.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.tags?.some(tag => tag.toLowerCase().includes(q)) ||
        t.category?.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q)
      );
    }

    // Return undefined only if no filters are active (run all)
    if (categoryFilter === 'all' && !searchFilter) return undefined;
    return filtered.map(t => t.id);
  };

  const runAllTests = async () => {
    setRunning(true);
    const filteredIds = getFilteredTestIds();
    const res = await fetch(`${API}/api/suites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless, testIds: filteredIds }),
    });
    const data = await res.json();
    setActiveSuiteId(data.suiteRunId);
    setTimeout(loadData, 500);
  };

  const runSingleTest = async (testId: string) => {
    setRunning(true);
    const res = await fetch(`${API}/api/tests/${testId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless }),
    });
    const data = await res.json();
    setActiveSuiteId(data.suiteRunId);
    setTimeout(loadData, 500);
  };

  const stopTests = async () => {
    if (!activeSuiteId) return;
    try {
      await fetch(`${API}/api/suites/${activeSuiteId}/abort`, { method: 'POST' });
      setRunning(false);
      setActiveSuiteId(null);
      setTimeout(loadData, 1000);
    } catch (err) {
      console.error('Failed to abort:', err);
    }
  };

  const saveAccount = async () => {
    setAccountSaving(true);
    try {
      const res = await fetch(`${API}/api/config/account`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: editEmail, password: editPassword }),
      });
      const data = await res.json();
      setAccount(data);
      setEditingAccount(false);
    } catch (err) {
      console.error('Failed to save account:', err);
    } finally {
      setAccountSaving(false);
    }
  };

  // ── Computed values ──────────────────────────────────────────

  const getTestRunForTest = (testId: string) => testRuns.find(r => r.test_id === testId);
  const authTestCount = tests.filter(t => t.requires_auth).length;
  const failedRuns = testRuns.filter(r => r.status === 'failed' || r.status === 'error');

  // Compute stats from aggregated test runs (across all suites)
  const aggregatedStats = useMemo(() => {
    const total = testRuns.length;
    const passed = testRuns.filter(r => r.status === 'passed').length;
    const failed = testRuns.filter(r => r.status === 'failed').length;
    const errors = testRuns.filter(r => r.status === 'error').length;
    const timeouts = testRuns.filter(r => r.status === 'timeout').length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    return { total, passed, failed, errors, timeouts, passRate };
  }, [testRuns]);
  const passRate = aggregatedStats.passRate;

  // Unique tags for filter dropdown
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    tests.forEach(t => t.tags?.forEach(tag => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [tests]);

  // Filtered test runs for Results tab
  const filteredTestRuns = useMemo(() => {
    return testRuns.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (searchFilter && !r.test_name.toLowerCase().includes(searchFilter.toLowerCase())) return false;
      return true;
    });
  }, [testRuns, statusFilter, searchFilter]);

  const runStatus = running ? 'Running' : latestSuite?.completed_at ? 'Completed' : 'Idle';

  // ── Tabs ─────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'results', label: 'Test Results' },
    { id: 'failures', label: 'Failures' },
    { id: 'logs', label: 'Logs' },
    { id: 'config', label: 'Config' },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header Bar ──────────────────────────────────────────── */}
      <div className="space-y-4">
        {/* Top row: Title + Actions */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-gray-50">QA Dashboard</h2>
            {running && <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Headless toggle */}
            <label className="flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 cursor-pointer hover:bg-gray-700 transition-colors">
              <input
                type="checkbox"
                checked={headless}
                onChange={e => setHeadless(e.target.checked)}
                disabled={running}
                className="accent-indigo-500"
              />
              Headless
            </label>

            {/* Run Tests */}
            <button
              onClick={runAllTests}
              disabled={running}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors"
            >
              {running ? 'Running...' : 'Run Tests'}
            </button>

            {/* Stop Test */}
            {running && (
              <button
                onClick={stopTests}
                className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                Stop Test
              </button>
            )}

            {/* Export Report */}
            {testRuns.length > 0 && !running && (
              <a
                href={`${API}/api/report/latest`}
                download
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
              >
                Export Report
              </a>
            )}

            {/* Reset */}
            <button
              onClick={() => setShowResetModal(true)}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Search bar + Category chips */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Global search */}
          <div className="relative flex-1 min-w-[250px] max-w-md">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search tests, categories, tags..."
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
              className="w-full pl-10 pr-8 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            {searchFilter && (
              <button
                onClick={() => setSearchFilter('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Category chip filters */}
          <div className="flex items-center gap-2">
            {(['all', 'smoke', 'sanity', 'regression', 'e2e'] as const).map(cat => {
              const count = cat === 'all' ? tests.length : tests.filter(t => t.category === cat).length;
              const isActive = categoryFilter === cat;
              const chipColors = {
                all: isActive ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-gray-800 text-gray-400 border-gray-700',
                smoke: isActive ? 'bg-cyan-600 text-white border-cyan-500' : 'bg-gray-800 text-cyan-400 border-gray-700',
                sanity: isActive ? 'bg-violet-600 text-white border-violet-500' : 'bg-gray-800 text-violet-400 border-gray-700',
                regression: isActive ? 'bg-orange-600 text-white border-orange-500' : 'bg-gray-800 text-orange-400 border-gray-700',
                e2e: isActive ? 'bg-pink-600 text-white border-pink-500' : 'bg-gray-800 text-pink-400 border-gray-700',
              };
              return (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors hover:opacity-90 ${chipColors[cat]}`}
                >
                  {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                  <span className="ml-1.5 opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Stats Cards (4-column) ──────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Passed */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Passed</div>
          <div className="text-3xl font-bold text-emerald-400">{aggregatedStats.passed}</div>
          <div className="text-xs text-gray-500 mt-1">{passRate}% of {aggregatedStats.total}</div>
        </div>

        {/* Failed */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Failed</div>
          <div className="text-3xl font-bold text-red-400">{aggregatedStats.failed}</div>
          <div className="text-xs text-gray-500 mt-1 truncate">
            {failedRuns.slice(0, 2).map(r => r.test_name.split(' ')[0]).join(', ') || '--'}
          </div>
        </div>

        {/* Errors + Timeouts */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Errors / Timeouts</div>
          <div className="text-3xl font-bold text-orange-400">
            {aggregatedStats.errors + aggregatedStats.timeouts}
          </div>
          <div className="text-xs text-gray-500 mt-1">{aggregatedStats.total} total</div>
        </div>

        {/* Run Status */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Run Status</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`w-2 h-2 rounded-full ${
              running ? 'bg-blue-400 animate-pulse' : latestSuite?.completed_at ? 'bg-emerald-400' : 'bg-gray-500'
            }`} />
            <span className="text-sm font-medium text-gray-50">{runStatus}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {latestSuite?.completed_at
              ? new Date(latestSuite.completed_at).toLocaleTimeString()
              : '--'}
          </div>
        </div>
      </div>

      {/* ── Tab Bar ─────────────────────────────────────────────── */}
      <div className="border-b border-gray-800">
        <div className="flex gap-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
              {tab.id === 'failures' && failedRuns.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 text-xs bg-red-500/20 text-red-400 rounded-full">
                  {failedRuns.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab Content ─────────────────────────────────────────── */}

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Test Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {tests.map(test => {
              const run = getTestRunForTest(test.id);
              if (categoryFilter !== 'all' && test.category !== categoryFilter) return null;
              if (searchFilter) {
                const q = searchFilter.toLowerCase();
                const matches = test.name.toLowerCase().includes(q) ||
                  test.tags?.some(tag => tag.toLowerCase().includes(q)) ||
                  test.category?.toLowerCase().includes(q) ||
                  test.url.toLowerCase().includes(q);
                if (!matches) return null;
              }
              return (
                <div key={test.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="font-semibold text-gray-50 text-sm truncate">{test.name}</h3>
                      {test.category && (
                        <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded border font-medium ${
                          test.category === 'smoke' ? 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/30' :
                          test.category === 'sanity' ? 'bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-500/15 dark:text-violet-400 dark:border-violet-500/30' :
                          test.category === 'regression' ? 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-500/15 dark:text-orange-400 dark:border-orange-500/30' :
                          'bg-pink-50 text-pink-600 border-pink-200 dark:bg-pink-500/15 dark:text-pink-400 dark:border-pink-500/30'
                        }`}>
                          {test.category.toUpperCase()}
                        </span>
                      )}
                      {test.requires_auth && (
                        <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30 rounded font-medium">
                          AUTH
                        </span>
                      )}
                    </div>
                    {run && (
                      <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full border ${statusBadge(run.status)}`}>
                        {run.status}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mb-3 truncate">{test.url}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1.5 overflow-hidden">
                      {test.tags?.slice(0, 3).map(tag => (
                        <span key={tag} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded whitespace-nowrap">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {run?.duration_ms != null && (
                        <span className="text-xs text-gray-500">{(run.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {run?.id && (
                        <a href={`/runs/${run.id}`} className="text-xs text-indigo-400 hover:text-indigo-300">
                          Details &rarr;
                        </a>
                      )}
                      <button
                        onClick={() => runSingleTest(test.id)}
                        disabled={running}
                        className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 rounded-md transition-colors"
                      >
                        Run
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TEST RESULTS TAB */}
      {activeTab === 'results' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Search test name..."
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 w-64 focus:outline-none focus:border-indigo-500"
            />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="all">All Statuses</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="error">Error</option>
              <option value="timeout">Timeout</option>
              <option value="running">Running</option>
            </select>
          </div>

          {/* Results Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="text-left py-3 px-4 font-medium">Test Name</th>
                  <th className="text-left py-3 px-4 font-medium">Status</th>
                  <th className="text-left py-3 px-4 font-medium">Duration</th>
                  <th className="text-left py-3 px-4 font-medium">Turns</th>
                  <th className="text-left py-3 px-4 font-medium">Tokens</th>
                  <th className="text-left py-3 px-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTestRuns.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-8 text-gray-600">No test results yet</td></tr>
                ) : (
                  filteredTestRuns.map(run => (
                    <tr key={run.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                      <td className="py-3 px-4 text-gray-50">{run.test_name}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${statusBadge(run.status)}`}>
                          {run.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-400">
                        {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '--'}
                      </td>
                      <td className="py-3 px-4 text-gray-400">{run.turn_count}</td>
                      <td className="py-3 px-4 text-gray-400 text-xs">
                        {run.input_tokens > 0 ? `${(run.input_tokens / 1000).toFixed(1)}k in / ${(run.output_tokens / 1000).toFixed(1)}k out` : '--'}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <a href={`/runs/${run.id}`} className="text-xs text-indigo-400 hover:text-indigo-300">
                            Details &rarr;
                          </a>
                          {run.status !== 'running' && run.status !== 'queued' && (
                            <a href={`${API}/api/runs/${run.id}/report`} download className="text-xs text-gray-500 hover:text-gray-300">
                              Export
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* FAILURES TAB */}
      {activeTab === 'failures' && (
        <div className="space-y-4">
          {failedRuns.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <div className="text-emerald-400 text-lg font-medium">No failures</div>
              <div className="text-gray-500 text-sm mt-1">All tests passed in the latest run</div>
            </div>
          ) : (
            failedRuns.map(run => (
              <div key={run.id} className="bg-gray-900 border border-red-200 dark:border-red-900/30 rounded-xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-gray-50 font-semibold text-sm">{run.test_name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full border mt-1 inline-block ${statusBadge(run.status)}`}>
                      {run.status}
                    </span>
                  </div>
                  <div className="text-right text-xs text-gray-500">
                    <div>{run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '--'}</div>
                    <div>{run.turn_count} turns</div>
                  </div>
                </div>

                {/* Error message */}
                {run.error && (
                  <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/20 rounded-lg p-3 mb-3">
                    <div className="text-xs text-red-600 dark:text-red-400 font-medium mb-1">Error</div>
                    <pre className="text-xs text-red-500 dark:text-red-300 font-mono whitespace-pre-wrap">{run.error}</pre>
                  </div>
                )}

                {/* Model verdict */}
                {run.model_verdict && (
                  <div className="bg-gray-800/50 rounded-lg p-3 mb-3">
                    <div className="text-xs text-gray-500 font-medium mb-1">Model Verdict</div>
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
                      {run.model_verdict}
                    </pre>
                  </div>
                )}

                <div className="flex gap-2">
                  <a
                    href={`/runs/${run.id}`}
                    className="text-xs px-3 py-1.5 bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 rounded-md hover:bg-indigo-600/30 transition-colors"
                  >
                    View Screenshots &rarr;
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* LOGS TAB */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-400">Live Event Log</h3>
              {running && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
            </div>
            <button
              onClick={() => setLogEvents([])}
              className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 max-h-[600px] overflow-y-auto font-mono text-xs">
            {logEvents.length === 0 ? (
              <div className="text-gray-600 text-center py-8">
                {running ? 'Waiting for events...' : 'No log events. Run a test to see live output.'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {logEvents.map((event, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="text-gray-600 flex-shrink-0 w-20">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={
                      event.type === 'run_failed' ? 'text-red-400' :
                      event.type === 'run_completed' ? 'text-emerald-400' :
                      event.type === 'actions_executed' ? 'text-blue-400' :
                      'text-gray-300'
                    }>
                      {event.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* CONFIG TAB */}
      {activeTab === 'config' && (
        <div className="space-y-6">
          {/* Test Account */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${account ? 'bg-emerald-400' : 'bg-yellow-400'}`} />
                <h3 className="font-semibold text-gray-50 text-sm">Test Account</h3>
                <span className="text-xs text-gray-500">
                  Used by {authTestCount} test{authTestCount !== 1 ? 's' : ''} requiring authentication
                </span>
              </div>
              {!editingAccount && (
                <button
                  onClick={() => { if (account) { setEditEmail(account.email); setEditPassword(account.password); } setEditingAccount(true); }}
                  className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
                >
                  Edit
                </button>
              )}
            </div>

            {editingAccount ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Email</label>
                    <input
                      type="email"
                      value={editEmail}
                      onChange={e => setEditEmail(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Password</label>
                    <input
                      type="text"
                      value={editPassword}
                      onChange={e => setEditPassword(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={saveAccount}
                    disabled={accountSaving || !editEmail || !editPassword}
                    className="text-xs px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md"
                  >
                    {accountSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingAccount(false)} className="text-xs px-4 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md">
                    Cancel
                  </button>
                </div>
              </div>
            ) : account ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-gray-500">Email</span>
                  <p className="text-sm text-gray-200 font-mono mt-0.5">{account.email}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-500">Password</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-gray-200 font-mono">
                      {showPassword ? account.password : account.passwordMasked}
                    </p>
                    <button onClick={() => setShowPassword(!showPassword)} className="text-xs text-gray-500 hover:text-gray-300">
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Loading...</p>
            )}
          </div>

          {/* Test Suite Info */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="font-semibold text-gray-50 text-sm mb-4">Test Suite Configuration</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-xs text-gray-500">Total Tests</span>
                <p className="text-gray-200 font-mono mt-0.5">{tests.length}</p>
              </div>
              <div>
                <span className="text-xs text-gray-500">Auth Required</span>
                <p className="text-gray-200 font-mono mt-0.5">{authTestCount}</p>
              </div>
              <div>
                <span className="text-xs text-gray-500">Target</span>
                <p className="text-gray-200 font-mono mt-0.5">appypieautomate.ai</p>
              </div>
            </div>
          </div>

          {/* Available Tags */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="font-semibold text-gray-50 text-sm mb-3">Available Tags</h3>
            <div className="flex flex-wrap gap-2">
              {allTags.map(tag => (
                <span key={tag} className="text-xs px-2.5 py-1 bg-gray-800 text-gray-400 rounded-md">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* ── Reset Confirmation Modal ──────────────────────────── */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowResetModal(false)}
          />
          {/* Modal */}
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            {/* Icon */}
            <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-full">
              <svg className="w-6 h-6 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            {/* Title */}
            <h3 className="text-lg font-semibold text-gray-50 text-center mb-2">Reset All Data</h3>
            {/* Description */}
            <p className="text-sm text-gray-400 text-center mb-6">
              This will permanently delete all test results, screenshots, and replay videos. This action cannot be undone.
            </p>
            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => setShowResetModal(false)}
                className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setShowResetModal(false);
                  try {
                    await fetch(`${API}/api/reset`, { method: 'POST' });
                  } catch (e) {
                    // API may be down, still clear UI
                  }
                  setLogEvents([]);
                  setLatestSuite(null);
                  setTestRuns([]);
                  setRunning(false);
                  setActiveSuiteId(null);
                  setCategoryFilter('all');
                  setSearchFilter('');
                }}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                Reset Everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
