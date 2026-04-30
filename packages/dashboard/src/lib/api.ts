import type { TestDefinition, TestRun, SuiteRun, RunDetail, SystemSettings, TestAccount } from '@cua/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// ── Reads ────────────────────────────────────────────────────────

export function fetchTests(): Promise<TestDefinition[]> {
  return request(`${API_BASE}/api/tests`);
}

export function fetchSuites(limit = 20): Promise<SuiteRun[]> {
  return request(`${API_BASE}/api/suites?limit=${limit}`);
}

export function fetchSuiteDetail(suiteId: string): Promise<{ suite: SuiteRun; runs: TestRun[] }> {
  return request(`${API_BASE}/api/suites/${suiteId}`);
}

export function fetchRunDetail(runId: string): Promise<RunDetail> {
  return request(`${API_BASE}/api/runs/${runId}`);
}

export function fetchSettings(): Promise<SystemSettings> {
  return request(`${API_BASE}/api/settings`);
}

export function fetchAccount(): Promise<TestAccount> {
  return request(`${API_BASE}/api/config/account`);
}

// ── Writes ───────────────────────────────────────────────────────

export function startSuite(testIds?: string[], headless = true): Promise<{ suiteRunId: string }> {
  return request(`${API_BASE}/api/suites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testIds, headless }),
  });
}

export function startSingleTest(testId: string, headless = true): Promise<{ suiteRunId: string; testRunId: string }> {
  return request(`${API_BASE}/api/tests/${testId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headless }),
  });
}

export function abortSuite(suiteId: string): Promise<{ success: boolean }> {
  return request(`${API_BASE}/api/suites/${suiteId}/abort`, { method: 'POST' });
}

export function abortRun(runId: string): Promise<{ success: boolean }> {
  return request(`${API_BASE}/api/runs/${runId}/abort`, { method: 'POST' });
}

export function resetAllData(): Promise<{ success: boolean }> {
  return request(`${API_BASE}/api/reset`, { method: 'POST' });
}

export function updateSettings(settings: Partial<SystemSettings>): Promise<SystemSettings> {
  return request(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export function updateAccount(email: string, password: string): Promise<TestAccount> {
  return request(`${API_BASE}/api/config/account`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

// ── URL builders ─────────────────────────────────────────────────

export function getScreenshotUrl(runId: string, filename: string): string {
  return `${API_BASE}/api/runs/${runId}/screenshots/${filename}`;
}

export function getVideoUrl(runId: string): string {
  return `${API_BASE}/api/runs/${runId}/video`;
}

export function getSSEUrl(runId: string): string {
  return `${API_BASE}/api/runs/${runId}/events`;
}
