'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || '';

// ── Types ────────────────────────────────────────────────────────

interface TestDefinition {
  id: string;
  _id?: string;
  name: string;
  url: string;
  instructions?: string;
  expected_outcome?: string;
  expectedOutcome?: string;
  tags?: string[];
  category?: 'smoke' | 'sanity' | 'regression' | 'e2e';
  timeout: number;
  requires_auth?: boolean;
  requiresAuth?: boolean;
  max_turns?: number;
  maxTurns?: number;
  page?: string;
  version?: number;
  isActive?: boolean;
}

interface SystemSettings {
  _id: string;
  maxConcurrency: number;
  maxTurnsDefault: number;
  maxTokensPerSession: number;
  defaultTimeout: number;
  defaultHeadless: boolean;
  allowedDomains: string[];
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
  started_at: string | null;
  completed_at: string | null;
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

type TabId = 'overview' | 'results' | 'failures' | 'logs' | 'tests' | 'config';

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

function categoryBadgeClass(cat: string) {
  switch (cat) {
    case 'smoke': return 'bg-cyan-50 text-cyan-600 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/30';
    case 'sanity': return 'bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-500/15 dark:text-violet-400 dark:border-violet-500/30';
    case 'regression': return 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-500/15 dark:text-orange-400 dark:border-orange-500/30';
    case 'e2e': return 'bg-pink-50 text-pink-600 border-pink-200 dark:bg-pink-500/15 dark:text-pink-400 dark:border-pink-500/30';
    default: return 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-500/15 dark:text-gray-400 dark:border-gray-500/30';
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

  // Live elapsed timer
  const [elapsedMs, setElapsedMs] = useState(0);
  const runStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (running) {
      if (!runStartRef.current) {
        // Use suite start time if available, else now
        runStartRef.current = latestSuite?.started_at ? new Date(latestSuite.started_at).getTime() : Date.now();
      }
      const timer = setInterval(() => {
        setElapsedMs(Date.now() - (runStartRef.current || Date.now()));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      runStartRef.current = null;
    }
  }, [running, latestSuite?.started_at]);



  // UI state
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [headless, setHeadless] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // NEW UI state
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  const [runDropdownOpen, setRunDropdownOpen] = useState(false);
  const [testMenuOpen, setTestMenuOpen] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('all');
  const [activeFilter, setActiveFilter] = useState('all');
  const [parallelRuns, setParallelRuns] = useState(1);
  const [retryFailed, setRetryFailed] = useState(0);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [nameSortDir, setNameSortDir] = useState<'asc' | 'desc' | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Config / account state
  const [account, setAccount] = useState<TestAccount | null>(null);
  const [editingAccount, setEditingAccount] = useState(false);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);

  // Logs state
  const [logEvents, setLogEvents] = useState<Array<{ type: string; message: string; timestamp: string }>>([]);

  // Test Manager state
  const [editingTest, setEditingTest] = useState<TestDefinition | null>(null);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testForm, setTestForm] = useState({ name: '', url: '', instructions: '', expectedOutcome: '', category: 'sanity', tags: '', requiresAuth: false, maxTurns: 40, timeout: 120000, page: '' });
  const [testSaving, setTestSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  // Settings state
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Modal state
  const [showResetModal, setShowResetModal] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ testId: string; testName: string } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Close dropdowns on outside click
  const runDropdownRef = useRef<HTMLDivElement>(null);
  const testMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (runDropdownRef.current && !runDropdownRef.current.contains(e.target as Node)) {
        setRunDropdownOpen(false);
      }
      if (testMenuRef.current && !testMenuRef.current.contains(e.target as Node)) {
        setTestMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Data loading ─────────────────────────────────────────────

  // Load initial data + detect active suites
  const loadData = useCallback(async () => {
    try {
      const [testsRes, accountRes, settingsRes] = await Promise.all([
        fetch(`${API}/api/tests`),
        fetch(`${API}/api/config/account`),
        fetch(`${API}/api/settings`),
      ]);
      setTests(await testsRes.json());
      setAccount(await accountRes.json());
      setSettings(await settingsRes.json());
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

    // Apply tag filter
    if (tagFilter !== 'all') {
      filtered = filtered.filter(t => t.tags?.includes(tagFilter));
    }

    // Apply active filter
    if (activeFilter === 'active') {
      filtered = filtered.filter(t => t.isActive !== false);
    } else if (activeFilter === 'inactive') {
      filtered = filtered.filter(t => t.isActive === false);
    }

    // Return undefined only if no filters are active (run all)
    if (categoryFilter === 'all' && !searchFilter && tagFilter === 'all' && activeFilter === 'all') return undefined;
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
    // Auto-navigate to the run details page
    if (data.testRunId) {
      window.location.href = `/runs/${data.testRunId}`;
    }
  };

  const stopTests = async () => {
    try {
      if (activeSuiteId) {
        await fetch(`${API}/api/suites/${activeSuiteId}/abort`, { method: 'POST' });
      } else {
        // No suite ID — abort all running test runs individually
        const runningRuns = testRuns.filter(r => r.status === 'running');
        for (const run of runningRuns) {
          await fetch(`${API}/api/runs/${run.id}/abort`, { method: 'POST' });
        }
      }
      setRunning(false);
      setActiveSuiteId(null);
      showToast('Tests stopped', 'info');
      setTimeout(loadData, 1000);
    } catch (err) {
      console.error('Failed to abort:', err);
    }
  };

  // NEW: Run selected tests only
  const runSelectedTests = async () => {
    if (selectedTests.size === 0) return;
    setRunning(true);
    setRunDropdownOpen(false);
    const res = await fetch(`${API}/api/suites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless, testIds: Array.from(selectedTests) }),
    });
    const data = await res.json();
    setActiveSuiteId(data.suiteRunId);
    setTimeout(loadData, 500);
  };

  // NEW: Run filtered tests only
  const runFilteredTests = async () => {
    setRunning(true);
    setRunDropdownOpen(false);
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

  // NEW: Run tests by category
  const runCategoryTests = async (category: string) => {
    const categoryTestIds = tests.filter(t => t.category === category).map(t => t.id);
    if (categoryTestIds.length === 0) return;
    setRunning(true);
    setRunDropdownOpen(false);
    const res = await fetch(`${API}/api/suites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless, testIds: categoryTestIds }),
    });
    const data = await res.json();
    setActiveSuiteId(data.suiteRunId);
    setTimeout(loadData, 500);
  };

  // NEW: Duplicate test
  const duplicateTest = async (testId: string) => {
    setTestMenuOpen(null);
    const test = tests.find(t => t.id === testId);
    if (!test) return;
    try {
      const body = {
        name: `${test.name} (copy)`,
        url: test.url,
        instructions: test.instructions || test.expectedOutcome || '',
        expectedOutcome: test.expected_outcome || test.expectedOutcome || '',
        category: test.category || 'sanity',
        tags: test.tags || [],
        requiresAuth: test.requires_auth || test.requiresAuth || false,
        maxTurns: test.max_turns || test.maxTurns || 40,
        timeout: test.timeout || 120000,
        page: test.page || '',
      };
      await fetch(`${API}/api/tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showToast('Test duplicated', 'success');
      loadData();
    } catch (err) {
      console.error('Failed to duplicate test:', err);
      showToast('Failed to duplicate test', 'error');
    }
  };

  // NEW: Export test as YAML
  const exportTest = (testId: string) => {
    setTestMenuOpen(null);
    const test = tests.find(t => t.id === testId);
    if (!test) return;
    const yamlContent = [
      `name: "${test.name}"`,
      `url: "${test.url}"`,
      test.instructions ? `instructions: "${test.instructions}"` : null,
      test.expected_outcome || test.expectedOutcome ? `expected_outcome: "${test.expected_outcome || test.expectedOutcome}"` : null,
      `category: ${test.category || 'sanity'}`,
      test.tags && test.tags.length > 0 ? `tags:\n${test.tags.map(t => `  - ${t}`).join('\n')}` : null,
      `timeout: ${test.timeout}`,
      `requires_auth: ${test.requires_auth || test.requiresAuth || false}`,
      test.max_turns || test.maxTurns ? `max_turns: ${test.max_turns || test.maxTurns}` : null,
      test.page ? `page: "${test.page}"` : null,
    ].filter(Boolean).join('\n');
    const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${test.name.replace(/\s+/g, '_').toLowerCase()}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // NEW: Toggle test active status
  const toggleTestActive = async (testId: string) => {
    const test = tests.find(t => t.id === testId);
    if (!test) return;
    try {
      await fetch(`${API}/api/tests/${testId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !(test.isActive !== false) }),
      });
      loadData();
    } catch (err) {
      console.error('Failed to toggle test active:', err);
    }
  };

  // NEW: Export selected tests
  const exportSelectedTests = () => {
    selectedTests.forEach(id => exportTest(id));
  };

  // NEW: Delete selected tests
  const deleteSelectedTests = async () => {
    for (const id of selectedTests) {
      await fetch(`${API}/api/tests/${id}`, { method: 'DELETE' });
    }
    setSelectedTests(new Set());
    loadData();
    showToast(`Deleted ${selectedTests.size} tests`, 'success');
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

  // Live token consumption
  const totalTokens = useMemo(() => {
    const input = testRuns.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
    const output = testRuns.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
    const reasoning = testRuns.reduce((sum, r) => sum + (r.reasoning_tokens || 0), 0);
    const total = input + output;
    return { input, output, reasoning, total };
  }, [testRuns]);

  const formatTokens = (n: number) => {
    if (n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1000000).toFixed(2)}M`;
  };

  // Total duration — live elapsed when running, completed duration when done
  const totalDuration = useMemo(() => {
    const ms = running ? elapsedMs : testRuns.reduce((sum, r) => sum + (r.duration_ms || 0), 0);
    if (ms === 0) return '0s';
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }, [testRuns, running, elapsedMs]);

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

  // Tests filtered for Test Manager table
  const filteredTests = useMemo(() => {
    let result = [...tests];

    if (categoryFilter !== 'all') {
      result = result.filter(t => t.category === categoryFilter);
    }
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.tags?.some(tag => tag.toLowerCase().includes(q)) ||
        t.category?.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q)
      );
    }
    if (tagFilter !== 'all') {
      result = result.filter(t => t.tags?.includes(tagFilter));
    }
    if (activeFilter === 'active') {
      result = result.filter(t => t.isActive !== false);
    } else if (activeFilter === 'inactive') {
      result = result.filter(t => t.isActive === false);
    }
    if (nameSortDir) {
      result.sort((a, b) => nameSortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
    }
    return result;
  }, [tests, categoryFilter, searchFilter, tagFilter, activeFilter, nameSortDir]);

  // Running progress — completed tests / total tests
  const completedTestCount = testRuns.filter(r => r.status !== 'running' && r.status !== 'queued').length;
  const totalTestCount = latestSuite?.total || tests.length;
  const runProgress = running && totalTestCount > 0 ? Math.round((completedTestCount / totalTestCount) * 100) : 0;
  const runStatus = running ? `Running` : latestSuite?.completed_at ? 'Completed' : 'Idle';

  // Selection helpers
  const allVisibleSelected = filteredTests.length > 0 && filteredTests.every(t => selectedTests.has(t.id));
  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedTests(new Set());
    } else {
      setSelectedTests(new Set(filteredTests.map(t => t.id)));
    }
  };
  const toggleSelectTest = (id: string) => {
    setSelectedTests(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Tabs ─────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'results', label: 'Results' },
    { id: 'failures', label: 'Failures' },
    { id: 'logs', label: 'Logs' },
    { id: 'tests', label: 'Test Manager' },
    { id: 'config', label: 'Settings' },
  ];

  // ── Test CRUD helpers ───────────────────────────────────────
  const openCreateTest = () => {
    setEditingTest(null);
    setTestForm({ name: '', url: '', instructions: '', expectedOutcome: '', category: 'sanity', tags: '', requiresAuth: false, maxTurns: 40, timeout: 120000, page: '' });
    setShowTestModal(true);
  };

  const openEditTest = (test: TestDefinition) => {
    setEditingTest(test);
    setTestForm({
      name: test.name,
      url: test.url,
      instructions: test.instructions || test.expectedOutcome || '',
      expectedOutcome: test.expected_outcome || test.expectedOutcome || '',
      category: test.category || 'sanity',
      tags: (test.tags || []).join(', '),
      requiresAuth: test.requires_auth || test.requiresAuth || false,
      maxTurns: test.max_turns || test.maxTurns || 40,
      timeout: test.timeout || 120000,
      page: test.page || '',
    });
    setShowTestModal(true);
  };

  const saveTest = async () => {
    setTestSaving(true);
    try {
      const body = {
        ...testForm,
        tags: testForm.tags.split(',').map(t => t.trim()).filter(Boolean),
      };
      if (editingTest) {
        await fetch(`${API}/api/tests/${editingTest.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        await fetch(`${API}/api/tests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      setShowTestModal(false);
      loadData();
    } catch (err) {
      console.error('Failed to save test:', err);
    } finally {
      setTestSaving(false);
    }
  };

  const deleteTest = async (testId: string) => {
    await fetch(`${API}/api/tests/${testId}`, { method: 'DELETE' });
    loadData();
  };

  const importYaml = async () => {
    setImporting(true);
    try {
      const res = await fetch(`${API}/api/tests/import-yaml`, { method: 'POST' });
      const data = await res.json();
      showToast(`Imported ${data.imported} tests, skipped ${data.skipped}`, 'success');
      loadData();
    } catch (err) {
      console.error('Import failed:', err);
    } finally {
      setImporting(false);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSettings(await res.json());
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSettingsSaving(false);
    }
  };

  const selectClasses = "px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none focus:border-indigo-500 cursor-pointer appearance-none";

  return (
    <div className="space-y-4">
      {/* ── Header Bar ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-gray-50">QA Dashboard</h2>
          {running && <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Headless checkbox */}
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

          {/* Run Tests button with dropdown */}
          <div className="relative" ref={runDropdownRef}>
            <div className="flex">
              <button
                onClick={runAllTests}
                disabled={running}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-l-lg text-sm transition-colors"
              >
                {running ? 'Running...' : 'Run Tests'}
              </button>
              <button
                onClick={() => setRunDropdownOpen(!runDropdownOpen)}
                disabled={running}
                className="px-2 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-r-lg text-sm transition-colors border-l border-indigo-500"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
            {runDropdownOpen && (
              <div className="absolute right-0 mt-1 w-64 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden">
                <button
                  onClick={() => { runAllTests(); setRunDropdownOpen(false); }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                >
                  Run All Tests
                </button>
                <button
                  onClick={() => { if (categoryFilter !== 'all') runCategoryTests(categoryFilter); }}
                  disabled={categoryFilter === 'all'}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                >
                  Run by Category{categoryFilter !== 'all' && ` (${categoryFilter})`}
                </button>
                <button
                  onClick={() => { runSelectedTests(); }}
                  disabled={selectedTests.size === 0}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                >
                  Run Selected Tests{selectedTests.size > 0 && ` (${selectedTests.size})`}
                </button>
                <div className="border-t border-gray-700 my-1" />
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">Headless</span>
                  <button
                    onClick={() => setHeadless(!headless)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${headless ? 'bg-indigo-600' : 'bg-gray-600'}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${headless ? 'translate-x-4' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">Parallel Runs</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setParallelRuns(Math.max(1, parallelRuns - 1))}
                      className="w-5 h-5 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                    >-</button>
                    <span className="text-xs text-gray-300 w-6 text-center">{parallelRuns}/3</span>
                    <button
                      onClick={() => setParallelRuns(Math.min(3, parallelRuns + 1))}
                      className="w-5 h-5 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                    >+</button>
                  </div>
                </div>
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">Retry Failed: {retryFailed}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={retryFailed}
                      onChange={e => setRetryFailed(Number(e.target.value))}
                      className="w-10 h-5 bg-gray-700 border border-gray-600 rounded text-xs text-gray-300 text-center focus:outline-none"
                    />
                    <button
                      onClick={() => setRetryEnabled(!retryEnabled)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${retryEnabled ? 'bg-indigo-600' : 'bg-gray-600'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${retryEnabled ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

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

      {/* ── Filter Bar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Global search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search tests..."
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

        {/* Category dropdown */}
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className={selectClasses}
        >
          <option value="all">All Categories</option>
          <option value="smoke">Smoke</option>
          <option value="sanity">Sanity</option>
          <option value="regression">Regression</option>
          <option value="e2e">E2E</option>
        </select>

        {/* Status dropdown */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className={selectClasses}
        >
          <option value="all">All Statuses</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="error">Error</option>
          <option value="running">Running</option>
          <option value="not_run">Not Run</option>
        </select>
      </div>

      {/* ── Summary Bar (inline) ──────────────────────────────── */}
      <div className="flex items-center gap-6 px-4 py-2.5 bg-gray-900 border border-gray-800 rounded-lg">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-sm text-gray-400">Passed:</span>
          <span className="text-sm font-semibold text-emerald-400">{aggregatedStats.passed}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span className="text-sm text-gray-400">Failed:</span>
          <span className="text-sm font-semibold text-red-400">{aggregatedStats.failed}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-orange-400" />
          <span className="text-sm text-gray-400">Errors:</span>
          <span className="text-sm font-semibold text-orange-400">{aggregatedStats.errors + aggregatedStats.timeouts}</span>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-gray-400">Duration:</span>
          <span className="text-sm font-semibold text-gray-200">{totalDuration}</span>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span className="text-sm text-gray-400">Tokens:</span>
          <span className="text-sm font-semibold text-gray-200">{formatTokens(totalTokens.total)}</span>
          {totalTokens.total > 0 && (
            <span className="text-xs text-gray-500">({formatTokens(totalTokens.input)} in / {formatTokens(totalTokens.output)} out)</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-blue-400 animate-pulse' : latestSuite?.completed_at ? 'bg-emerald-400' : 'bg-gray-500'}`} />
          <span className="text-sm text-gray-400">{runStatus}</span>
          <span className="text-xs text-gray-600">
            {running
              ? `(${runProgress}% — ${completedTestCount}/${totalTestCount})`
              : `(${passRate}% pass rate)`
            }
          </span>
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
      {activeTab === 'overview' && (() => {
        // Filter tests for overview
        const overviewTests = tests.filter(test => {
          if (categoryFilter !== 'all' && test.category !== categoryFilter) return false;
          if (searchFilter) {
            const q = searchFilter.toLowerCase();
            const matches = test.name.toLowerCase().includes(q) ||
              test.category?.toLowerCase().includes(q) ||
              test.url.toLowerCase().includes(q);
            if (!matches) return false;
          }
          // Status filter based on latest run
          if (statusFilter !== 'all') {
            const run = getTestRunForTest(test.id);
            if (statusFilter === 'not_run') {
              if (run) return false;
            } else {
              if (!run || run.status !== statusFilter) return false;
            }
          }
          return true;
        });

        // Group by category
        const categories = ['smoke', 'sanity', 'regression', 'e2e'] as const;
        const grouped = categories
          .map(cat => ({
            category: cat,
            tests: overviewTests.filter(t => (t.category || 'sanity') === cat),
          }))
          .filter(g => g.tests.length > 0);

        const toggleCategory = (cat: string) => {
          setCollapsedCategories(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
          });
        };

        const statusDot = (status: string) => {
          switch (status) {
            case 'passed': return 'bg-emerald-400';
            case 'failed': return 'bg-red-400';
            case 'error': return 'bg-orange-400';
            case 'running': return 'bg-blue-400 animate-pulse';
            case 'queued': return 'bg-amber-400 animate-pulse';
            case 'timeout': return 'bg-yellow-400';
            default: return 'bg-gray-400';
          }
        };

        const statusText = (status: string) => {
          switch (status) {
            case 'passed': return 'text-emerald-400';
            case 'failed': return 'text-red-400';
            case 'error': return 'text-orange-400';
            case 'running': return 'text-blue-400';
            case 'queued': return 'text-amber-400';
            case 'timeout': return 'text-yellow-400';
            default: return 'text-gray-500';
          }
        };

        const cardBorderClass = (status: string) => {
          switch (status) {
            case 'passed': return 'border-l-[3px] border-l-emerald-500';
            case 'failed': return 'border-l-[3px] border-l-red-500';
            case 'error': return 'border-l-[3px] border-l-orange-500';
            case 'running': return 'border-l-[3px] border-l-blue-500';
            case 'queued': return 'border-l-[3px] border-l-amber-500';
            case 'timeout': return 'border-l-[3px] border-l-yellow-500';
            case 'aborted': return 'border-l-[3px] border-l-gray-500';
            default: return 'border-l-[3px] border-l-gray-700';
          }
        };

        return (
          <div className="space-y-4">
            {grouped.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
                <div className="text-gray-500 text-sm">No tests match the current filters</div>
              </div>
            ) : (
              grouped.map(group => {
                const isCollapsed = collapsedCategories.has(group.category);
                return (
                  <div key={group.category} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    {/* Category header */}
                    <div
                      className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-gray-800/50 transition-colors"
                      onClick={() => toggleCategory(group.category)}
                    >
                      <div className="flex items-center gap-3">
                        <svg className="w-5 h-5 text-gray-400 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {isCollapsed
                            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                          }
                        </svg>
                        <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${categoryBadgeClass(group.category)}`}>
                          {group.category.toUpperCase()}
                        </span>
                        <span className="text-sm text-gray-400">
                          {group.tests.length} test{group.tests.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); runCategoryTests(group.category); }}
                        disabled={running}
                        className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 rounded-md transition-colors border border-gray-700"
                      >
                        Run Category
                      </button>
                    </div>

                    {/* Cards grid */}
                    {!isCollapsed && (
                      <div className="px-5 grid grid-cols-1 md:grid-cols-2 gap-4" style={{ paddingBottom: '2rem', marginBottom: '0.5rem' }}>
                        {group.tests.map(test => {
                          const run = getTestRunForTest(test.id);
                          const runStatus = run?.status || 'not_run';
                          const isRunning = runStatus === 'running';
                          const isQueued = runStatus === 'queued';
                          const isCompleted = ['passed', 'failed', 'error', 'timeout', 'aborted'].includes(runStatus);
                          const isFailed = runStatus === 'failed' || runStatus === 'error';

                          const durationMs = run?.duration_ms;
                          const durationStr = durationMs ? (durationMs >= 60000 ? `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s` : `${Math.round(durationMs / 1000)}s`) : null;
                          const lastRunStr = run?.completed_at ? (() => {
                            const secs = Math.round((Date.now() - new Date(run.completed_at).getTime()) / 1000);
                            if (secs < 60) return `${secs}s ago`;
                            if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
                            if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
                            return `${Math.floor(secs / 86400)}d ago`;
                          })() : run?.started_at ? 'just now' : 'never';

                          return (
                            <div
                              key={test.id}
                              className={`bg-gray-900 border border-gray-800 rounded-xl hover:bg-gray-800/80 hover:border-gray-700 transition-all duration-200 py-5 px-6 ${cardBorderClass(runStatus)} ${isCompleted || isRunning ? 'cursor-pointer' : ''}`}
                              onClick={() => { if ((isCompleted || isRunning) && run?.id) window.location.href = `/runs/${run.id}`; }}
                            >
                              {/* Row 1: badge + name + status pill */}
                              <div className="flex items-center gap-3 mb-2">
                                <div className="flex items-center gap-4 min-w-0 flex-1">
                                  <span className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded border font-bold ${categoryBadgeClass(test.category || 'sanity')}`}>
                                    {(test.category || 'sanity').toUpperCase()}
                                  </span>
                                  <h3 className="font-semibold text-gray-50 text-sm leading-snug truncate">{test.name}</h3>
                                </div>
                                {/* Status pill — solid colors visible on any background */}
                                {isRunning ? (
                                  <span className="flex-shrink-0 flex items-center gap-1.5 text-[11px] font-bold px-3 py-1 rounded-md bg-blue-500 text-white whitespace-nowrap">
                                    Running...
                                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                  </span>
                                ) : isQueued ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-amber-500 text-white whitespace-nowrap">Queued</span>
                                ) : runStatus === 'passed' ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-emerald-500 text-white whitespace-nowrap">Passed</span>
                                ) : runStatus === 'failed' ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-red-500 text-white whitespace-nowrap">Failed</span>
                                ) : runStatus === 'error' ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-orange-500 text-white whitespace-nowrap">Error</span>
                                ) : runStatus === 'timeout' ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-yellow-500 text-gray-900 whitespace-nowrap">Timeout</span>
                                ) : runStatus === 'aborted' ? (
                                  <span className="flex-shrink-0 text-[10px] font-bold px-3 py-1 rounded-md bg-gray-500 text-white whitespace-nowrap">Aborted</span>
                                ) : (
                                  <span className="flex-shrink-0 text-[10px] font-medium text-gray-400 whitespace-nowrap">Not Run</span>
                                )}
                              </div>
                              {/* Row 2: meta + buttons */}
                              <div className="flex items-center justify-between mt-1">
                                <span className="text-xs text-gray-500">
                                  {(test.category || 'sanity').toUpperCase()}
                                  {' '}&middot; Last run: {lastRunStr}
                                  {durationStr && <> &middot; Duration: {durationStr}</>}
                                </span>
                                <div className="flex items-center gap-2">
                                  {isFailed && run?.id && (
                                    <a
                                      href={`/runs/${run.id}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-xs px-3 py-1 rounded-md border border-gray-600 text-gray-300 hover:bg-gray-700/50 transition-colors whitespace-nowrap"
                                    >
                                      View Error
                                    </a>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); runSingleTest(test.id); }}
                                    disabled={running || isRunning || isQueued}
                                    className="text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                                  >
                                    Run
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        );
      })()}

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
              className={selectClasses}
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
              <div key={run.id} className="bg-white dark:bg-gray-900 rounded-xl p-5 shadow-sm" style={{ border: '1px solid #e5e7eb', borderLeft: '4px solid #ef4444' }}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-gray-900 dark:text-gray-50 font-semibold text-sm">{run.test_name}</h3>
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
                  <div className="rounded-r-lg p-3 mb-3" style={{ backgroundColor: '#fef2f2', borderLeft: '3px solid #f87171' }}>
                    <div className="text-xs text-red-600 dark:text-red-400 font-semibold mb-1">Error</div>
                    <pre className="text-xs text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap leading-relaxed">{run.error}</pre>
                  </div>
                )}

                {/* Model verdict */}
                {run.model_verdict && (
                  <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-3">
                    <div className="text-xs text-gray-600 dark:text-gray-400 font-medium mb-1">Model Verdict</div>
                    <pre className="text-xs text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
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

      {/* TEST MANAGER TAB */}
      {activeTab === 'tests' && (
        <div className="space-y-4">
          {/* Top bar: selected count + bulk actions + create/import */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              {selectedTests.size > 0 && (
                <span className="text-sm text-indigo-400 font-medium">{selectedTests.size} selected</span>
              )}
              {selectedTests.size > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={runSelectedTests}
                    disabled={running}
                    className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-colors"
                  >
                    Run Selected
                  </button>
                  <button
                    onClick={deleteSelectedTests}
                    className="text-xs px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-md transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    onClick={exportSelectedTests}
                    className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
                  >
                    Export
                  </button>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setImporting(true);
                  try {
                    const res = await fetch(`${API}/api/tests/sync-yaml`, { method: 'POST' });
                    const data = await res.json();
                    showToast(`Synced: ${data.created} new, ${data.updated} updated, ${data.unchanged} unchanged`, 'success');
                    loadData();
                  } catch (err) { console.error('Sync failed:', err); }
                  finally { setImporting(false); }
                }}
                disabled={importing}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
              >
                {importing ? 'Syncing...' : 'Sync from YAML'}
              </button>
              <label className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors cursor-pointer">
                Import YAML
                <input
                  type="file"
                  accept=".yaml,.yml"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setImporting(true);
                    try {
                      const text = await file.text();
                      const res = await fetch(`${API}/api/tests/import-file`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename: file.name, content: text }),
                      });
                      const data = await res.json();
                      if (data.error) { showToast(`Import failed: ${data.error}`, 'error'); }
                      else { showToast(`Imported: ${data.name}`, 'success'); loadData(); }
                    } catch (err) { console.error('Import failed:', err); }
                    finally { setImporting(false); e.target.value = ''; }
                  }}
                />
              </label>
              <button
                onClick={openCreateTest}
                className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
              >
                + Create Test
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="py-3 px-4 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      className="accent-indigo-500"
                    />
                  </th>
                  <th className="text-left py-3 px-4 font-medium">
                    <button
                      onClick={() => setNameSortDir(d => d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc')}
                      className="flex items-center gap-1 hover:text-gray-300 transition-colors"
                    >
                      Name
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {nameSortDir === 'asc' ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        ) : nameSortDir === 'desc' ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                        )}
                      </svg>
                    </button>
                  </th>
                  <th className="text-left py-3 px-4 font-medium">Category</th>
                  <th className="text-left py-3 px-4 font-medium">Page</th>
                  <th className="text-left py-3 px-4 font-medium">Version</th>
                  <th className="text-left py-3 px-4 font-medium">Active</th>
                  <th className="text-left py-3 px-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTests.map(test => {
                  const run = getTestRunForTest(test.id);
                  return (
                    <tr key={test.id} className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${selectedTests.has(test.id) ? 'bg-indigo-500/5' : ''}`}>
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          checked={selectedTests.has(test.id)}
                          onChange={() => toggleSelectTest(test.id)}
                          className="accent-indigo-500"
                        />
                      </td>
                      <td className="py-3 px-4">
                        <button onClick={() => openEditTest(test)} className="text-gray-50 font-medium hover:text-indigo-400 transition-colors text-left">
                          {test.name}
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${categoryBadgeClass(test.category || 'sanity')}`}>
                          {(test.category || 'sanity').toUpperCase()}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-400 text-xs">{test.page || '-'}</td>
                      <td className="py-3 px-4 text-gray-400 text-xs">{test.version ?? '-'}</td>
                      <td className="py-3 px-4">
                        <button
                          onClick={() => toggleTestActive(test.id)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${test.isActive !== false ? 'bg-indigo-600' : 'bg-gray-600'}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${test.isActive !== false ? 'translate-x-4' : 'translate-x-1'}`} />
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => runSingleTest(test.id)}
                            disabled={running}
                            className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-colors"
                          >
                            Run
                          </button>
                          {run?.id && (
                            <a
                              href={`/runs/${run.id}`}
                              className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
                            >
                              Logs
                            </a>
                          )}
                          {/* ... menu */}
                          <div className="relative" ref={testMenuOpen === test.id ? testMenuRef : undefined}>
                            <button
                              onClick={() => setTestMenuOpen(testMenuOpen === test.id ? null : test.id)}
                              className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-md transition-colors"
                              title="More actions"
                            >
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                              </svg>
                            </button>
                            {testMenuOpen === test.id && (
                              <div className="absolute right-0 mt-1 w-36 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 py-1">
                                <button
                                  onClick={() => { openEditTest(test); setTestMenuOpen(null); }}
                                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => duplicateTest(test.id)}
                                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                                >
                                  Duplicate
                                </button>
                                <button
                                  onClick={() => { setDeleteConfirm({ testId: test.id, testName: test.name }); setTestMenuOpen(null); }}
                                  className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-gray-700 transition-colors"
                                >
                                  Delete
                                </button>
                                <button
                                  onClick={() => exportTest(test.id)}
                                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
                                >
                                  Export
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Bottom status bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-500">
            <div>Tests: {filteredTests.length}</div>
            {selectedTests.size > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-indigo-400">{selectedTests.size} selected</span>
                <button onClick={runSelectedTests} disabled={running} className="text-indigo-400 hover:text-indigo-300 disabled:text-gray-600">Run Selected</button>
                <button onClick={deleteSelectedTests} className="text-red-400 hover:text-red-300">Delete</button>
                <button onClick={exportSelectedTests} className="text-gray-400 hover:text-gray-300">Export</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TEST CREATE/EDIT MODAL */}
      {showTestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowTestModal(false)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-2xl mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-50 mb-4">{editingTest ? 'Edit Test' : 'Create Test'}</h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Name *</label>
                  <input value={testForm.name} onChange={e => setTestForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">URL *</label>
                  <input value={testForm.url} onChange={e => setTestForm(f => ({ ...f, url: e.target.value }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Instructions *</label>
                <textarea value={testForm.instructions} onChange={e => setTestForm(f => ({ ...f, instructions: e.target.value }))} rows={6} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500 font-mono" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Expected Outcome *</label>
                <textarea value={testForm.expectedOutcome} onChange={e => setTestForm(f => ({ ...f, expectedOutcome: e.target.value }))} rows={2} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Category</label>
                  <select value={testForm.category} onChange={e => setTestForm(f => ({ ...f, category: e.target.value }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none focus:border-indigo-500">
                    <option value="smoke">Smoke</option>
                    <option value="sanity">Sanity</option>
                    <option value="regression">Regression</option>
                    <option value="e2e">E2E</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Turns</label>
                  <input type="number" value={testForm.maxTurns} onChange={e => setTestForm(f => ({ ...f, maxTurns: Number(e.target.value) }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Timeout (ms)</label>
                  <input type="number" value={testForm.timeout} onChange={e => setTestForm(f => ({ ...f, timeout: Number(e.target.value) }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Tags (comma-separated)</label>
                  <input value={testForm.tags} onChange={e => setTestForm(f => ({ ...f, tags: e.target.value }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" placeholder="homepage, navigation" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Page Group</label>
                  <input value={testForm.page} onChange={e => setTestForm(f => ({ ...f, page: e.target.value }))} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" placeholder="homepage" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input type="checkbox" checked={testForm.requiresAuth} onChange={e => setTestForm(f => ({ ...f, requiresAuth: e.target.checked }))} className="accent-indigo-500" />
                Requires Authentication
              </label>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowTestModal(false)} className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg text-sm transition-colors">Cancel</button>
                <button onClick={saveTest} disabled={testSaving || !testForm.name || !testForm.url || !testForm.instructions} className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-sm transition-colors">
                  {testSaving ? 'Saving...' : editingTest ? 'Update Test' : 'Create Test'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CONFIG/SETTINGS TAB */}
      {activeTab === 'config' && (
        <div className="space-y-6">
          {/* System Settings */}
          {settings && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="font-semibold text-gray-50 text-sm mb-4">System Settings</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Concurrency</label>
                  <input type="number" value={settings.maxConcurrency ?? 2} onChange={e => setSettings(s => s ? { ...s, maxConcurrency: Number(e.target.value) } : s)} min={1} max={10} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Default Max Turns</label>
                  <input type="number" value={settings.maxTurnsDefault ?? 500} onChange={e => setSettings(s => s ? { ...s, maxTurnsDefault: Number(e.target.value) } : s)} min={1} max={500} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Tokens/Session</label>
                  <input type="number" value={settings.maxTokensPerSession ?? 200000} onChange={e => setSettings(s => s ? { ...s, maxTokensPerSession: Number(e.target.value) } : s)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Default Timeout (ms)</label>
                  <input type="number" value={settings.defaultTimeout ?? 120000} onChange={e => setSettings(s => s ? { ...s, defaultTimeout: Number(e.target.value) } : s)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Default Headless</label>
                  <select value={settings.defaultHeadless ? 'true' : 'false'} onChange={e => setSettings(s => s ? { ...s, defaultHeadless: e.target.value === 'true' } : s)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 focus:outline-none focus:border-indigo-500">
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Allowed Domains</label>
                  <input value={(settings.allowedDomains || []).join(', ')} onChange={e => setSettings(s => s ? { ...s, allowedDomains: e.target.value.split(',').map(d => d.trim()).filter(Boolean) } : s)} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-50 focus:outline-none focus:border-indigo-500" />
                </div>
              </div>
              <div className="mt-4">
                <button onClick={saveSettings} disabled={settingsSaving} className="text-xs px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md">
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          )}

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
                  onClick={() => { if (account) { setEditEmail(account.email); setEditPassword(''); } setEditingAccount(true); }}
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
                      {account.passwordMasked}
                    </p>
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
              All test run data, screenshots, replay videos, and event logs will be permanently deleted. Test definitions and system settings will be preserved. This action cannot be undone.
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

      {/* ── Delete Confirmation Modal ──────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-full">
              <svg className="w-6 h-6 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-50 text-center mb-2">Delete Test</h3>
            <p className="text-sm text-gray-400 text-center mb-6">
              Are you sure you want to delete <strong className="text-gray-300">{deleteConfirm.testName}</strong>? This will deactivate the test definition.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg text-sm transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { deleteTest(deleteConfirm.testId); setDeleteConfirm(null); }}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg text-sm transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notification ──────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4">
          <div className={`flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl border ${
            toast.type === 'success' ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' :
            toast.type === 'error' ? 'bg-red-900/90 border-red-700 text-red-100' :
            'bg-gray-900/90 border-gray-700 text-gray-100'
          }`}>
            {toast.type === 'success' && (
              <svg className="w-5 h-5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {toast.type === 'error' && (
              <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {toast.type === 'info' && (
              <svg className="w-5 h-5 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className="text-sm font-medium">{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 text-gray-400 hover:text-gray-200">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
