const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function fetchTests() {
  const res = await fetch(`${API_BASE}/api/tests`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch tests');
  return res.json();
}

export async function fetchSuites(limit = 20) {
  const res = await fetch(`${API_BASE}/api/suites?limit=${limit}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch suites');
  return res.json();
}

export async function fetchSuiteDetail(suiteId: string) {
  const res = await fetch(`${API_BASE}/api/suites/${suiteId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch suite detail');
  return res.json();
}

export async function fetchRunDetail(runId: string) {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch run detail');
  return res.json();
}

export async function startSuite(testIds?: string[], headless = true) {
  const res = await fetch(`${API_BASE}/api/suites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testIds, headless }),
  });
  if (!res.ok) throw new Error('Failed to start suite');
  return res.json();
}

export async function startSingleTest(testId: string, headless = true) {
  const res = await fetch(`${API_BASE}/api/tests/${testId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headless }),
  });
  if (!res.ok) throw new Error('Failed to start test');
  return res.json();
}

export async function abortSuite(suiteId: string) {
  const res = await fetch(`${API_BASE}/api/suites/${suiteId}/abort`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to abort suite');
  return res.json();
}

export async function resetAllData() {
  const res = await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to reset data');
  return res.json();
}

export function getScreenshotUrl(runId: string, filename: string) {
  return `${API_BASE}/api/runs/${runId}/screenshots/${filename}`;
}

export function getVideoUrl(runId: string) {
  return `${API_BASE}/api/runs/${runId}/video`;
}

export function getSSEUrl(runId: string) {
  return `${API_BASE}/api/runs/${runId}/events`;
}
