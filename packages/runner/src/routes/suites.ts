import { Router } from 'express';
import * as repo from '../db/repo.js';
import { loadAllTests } from '../test-loader.js';
import { testExecutionQueue } from '../queue/queue.js';
import { abortTestRun } from '../queue/worker.js';
import * as sessionService from '../services/session.service.js';
import * as testService from '../services/test.service.js';
import { escapeHtml } from '../middleware/utils.js';

const router = Router();

// ── Run full suite ────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    // Backpressure — reject if queue is overloaded
    const MAX_QUEUE_SIZE = 50;
    const { getQueueMetrics } = await import('../queue/queue.js');
    const metrics = await getQueueMetrics();
    if (metrics.waiting + metrics.active > MAX_QUEUE_SIZE) {
      return res.status(429).json({
        error: `Queue is full (${metrics.waiting} waiting, ${metrics.active} active). Try again later.`,
      });
    }

    const { testIds, headless = true, skipDupeCheck = false } = req.body ?? {};

    // Deduplication — reject if any test already has an active run
    if (!skipDupeCheck) {
      const activeRuns = await repo.findRunningTestRuns(['queued', 'running']);
      const activeTestIds = new Set(activeRuns.map(r => r.test_id));
      const requestedIds = testIds ?? (await repo.listActiveTestDefs()).map(t => t.id);
      const dupes = requestedIds.filter((id: string) => activeTestIds.has(id));
      if (dupes.length > 0) {
        return res.status(409).json({
          error: `${dupes.length} test(s) already running/queued: ${dupes.slice(0, 5).join(', ')}`,
          duplicates: dupes,
        });
      }
    }

    // Load tests from DB first, fallback to YAML
    let allTests: any[];
    const dbTests = await repo.listActiveTestDefs();
    if (dbTests.length > 0) {
      allTests = dbTests;
    } else {
      allTests = loadAllTests();
    }

    const tests = testIds
      ? allTests.filter((t: any) => testIds.includes(t.id))
      : allTests;

    if (tests.length === 0) return res.status(400).json({ error: 'No tests to run' });

    // Load system settings for defaults
    const sysSettings = await repo.getSettings();

    // Create session
    const session = await sessionService.createSession(tests.length);
    if (!session) throw new Error('Failed to create session');

    // Create test runs and queue jobs
    for (const testDef of tests) {
      const testRun = await testService.createTestRun(session.id, testDef.id, testDef.name);
      if (!testRun) throw new Error('Failed to create test run');

      const jobData: any = {
        sessionId: session.id,
        testRunId: testRun.id,
        testId: testDef.id,
        testName: testDef.name,
        testUrl: testDef.url,
        testInstructions: testDef.instructions,
        expectedOutcome: testDef.expected_outcome,
        headless,
        requiresAuth: testDef.requires_auth ?? false,
        maxTurns: testDef.max_turns || sysSettings.maxTurnsDefault,
        timeout: testDef.timeout || sysSettings.defaultTimeout,
        viewport: testDef.viewport,
        cuaMode: testDef.cuaMode || undefined,
        // Forward declarative validation rules so the CUA loop can run them
        // post-verdict. Tests without rules trust the model verdict (current behavior).
        validation: Array.isArray(testDef.validation) ? testDef.validation : undefined,
      };
      // Priority: smoke=1 (highest), e2e=2, regression=3, sanity=4 (lowest)
      const priorityMap: Record<string, number> = { smoke: 1, e2e: 2, regression: 3, sanity: 4 };
      const priority = priorityMap[testDef.category ?? 'sanity'] ?? 4;
      await testExecutionQueue.add(`test-${testDef.id}`, jobData, { priority });
    }

    res.status(202).json({ suiteRunId: session.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Abort all running tests in a suite/session ──────────────
router.post('/:suiteId/abort', async (req, res) => {
  const runs = await repo.getTestRunsBySessionAndStatus(req.params.suiteId, ['running', 'queued']);

  let aborted = 0;
  for (const run of runs) {
    abortTestRun(run.id);
    aborted++;
  }
  res.json({ success: true, abortedCount: aborted });
});

// ── List suite runs (history) ─────────────────────────────────
router.get('/', async (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const sessions = await repo.listSessions(limit);
  res.json(sessions);
});

// ── Get suite/session detail ──────────────────────────────────
router.get('/:suiteId', async (req, res) => {
  const session = await repo.getSession(req.params.suiteId);
  if (!session) return res.status(404).json({ error: 'Suite not found' });
  const testRuns = await repo.getTestRunsBySession(req.params.suiteId);
  res.json({ ...session, testRuns });
});

// ── Get all test runs for a suite (polling alternative) ───────
router.get('/:suiteId/runs', async (req, res) => {
  const runs = await repo.getTestRunsBySession(req.params.suiteId);
  res.json(runs);
});

// ── Generate HTML report for a suite run ──────────────────────
router.get('/:suiteId/report', async (req, res) => {
  const session = await repo.getSession(req.params.suiteId);
  if (!session) return res.status(404).json({ error: 'Suite not found' });

  const testRuns = await repo.getTestRunsBySession(req.params.suiteId);

  const suite = session as Record<string, any>;

  const passRate = suite.total > 0 ? Math.round((suite.passed / suite.total) * 100) : 0;
  const startedAt = suite.started_at ? new Date(suite.started_at).toLocaleString() : 'N/A';
  const completedAt = suite.completed_at ? new Date(suite.completed_at).toLocaleString() : 'N/A';

  const statusColors: Record<string, string> = {
    passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308',
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Suite Report - ${escapeHtml(suite.id.slice(0, 8))}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; padding: 40px; }
  .container { max-width: 1000px; margin: 0 auto; }
  .header { background: #0f172a; color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { font-size: 14px; color: #94a3b8; display: flex; gap: 24px; flex-wrap: wrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 28px; font-weight: 700; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .section { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
  .run-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .run-table th { text-align: left; padding: 10px 12px; background: #f8fafc; color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; }
  .run-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
  .run-table tr:hover { background: #f8fafc; }
  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; color: white; text-transform: uppercase; }
  .verdict-preview { font-family: monospace; font-size: 12px; color: #64748b; max-height: 60px; overflow: hidden; margin-top: 8px; white-space: pre-wrap; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Test Suite Report</h1>
    <div class="meta">
      <span>Suite ID: ${escapeHtml(suite.id.slice(0, 8))}</span>
      <span>Started: ${startedAt}</span>
      <span>Completed: ${completedAt}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value" style="color:#0f172a">${suite.total}</div><div class="label">Total Tests</div></div>
    <div class="stat-card"><div class="value" style="color:#10b981">${suite.passed}</div><div class="label">Passed</div></div>
    <div class="stat-card"><div class="value" style="color:#ef4444">${suite.failed}</div><div class="label">Failed</div></div>
    <div class="stat-card"><div class="value" style="color:#f97316">${suite.errors}</div><div class="label">Errors</div></div>
    <div class="stat-card"><div class="value" style="color:#eab308">${suite.timeouts}</div><div class="label">Timeouts</div></div>
    <div class="stat-card"><div class="value" style="color:${passRate >= 80 ? '#10b981' : passRate >= 50 ? '#eab308' : '#ef4444'}">${passRate}%</div><div class="label">Pass Rate</div></div>
  </div>

  <div class="section">
    <h2>Test Results</h2>
    <table class="run-table">
      <thead><tr><th>Test Name</th><th>Status</th><th>Duration</th><th>Turns</th><th>Tokens</th></tr></thead>
      <tbody>
        ${testRuns.map(r => `<tr>
          <td style="font-weight:500;">${escapeHtml(r.test_name)}</td>
          <td><span class="status-badge" style="background:${statusColors[r.status] || '#6b7280'}">${escapeHtml(r.status)}</span></td>
          <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '--'}</td>
          <td>${r.turn_count}</td>
          <td style="font-size:12px;color:#64748b;">${r.input_tokens > 0 ? (r.input_tokens / 1000).toFixed(1) + 'k / ' + (r.output_tokens / 1000).toFixed(1) + 'k' : '--'}</td>
        </tr>
        ${r.model_verdict ? `<tr><td colspan="5"><div class="verdict-preview">${escapeHtml(r.model_verdict.slice(0, 300))}${r.model_verdict.length > 300 ? '...' : ''}</div></td></tr>` : ''}
        ${r.error ? `<tr><td colspan="5"><div style="color:#dc2626;font-size:12px;font-family:monospace;padding:4px 0;">${escapeHtml(r.error.slice(0, 200))}</div></td></tr>` : ''}`).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner Suite Report
  </div>
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="suite-report-${req.params.suiteId.slice(0, 8)}.html"`);
  res.send(html);
});

export default router;
