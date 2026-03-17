import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getDb } from './db.js';
import { getTestAccount, updateTestAccount, maskPassword } from './config.js';
import { loadAllTests } from './test-loader.js';
import { runSuite, runSingleTest, getActiveRunEmitter, abortRun, abortSuite } from './test-runner.js';

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createServer(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Health ─────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Test Account Config ──────────────────────────────────────
  app.get('/api/config/account', (_req, res) => {
    const account = getTestAccount();
    res.json({
      email: account.email,
      passwordMasked: maskPassword(account.password),
      password: account.password,
    });
  });

  app.put('/api/config/account', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Both email and password are required' });
    }
    const updated = updateTestAccount(email, password);
    res.json({
      email: updated.email,
      passwordMasked: maskPassword(updated.password),
      password: updated.password,
    });
  });

  // ── Test Definitions ──────────────────────────────────────────
  app.get('/api/tests', (_req, res) => {
    const tests = loadAllTests();
    res.json(tests);
  });

  // ── Run full suite ────────────────────────────────────────────
  app.post('/api/suites', async (req, res) => {
    try {
      const { testIds, parallel, headless = true } = req.body ?? {};
      const result = await runSuite(testIds, parallel, headless);
      res.status(202).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Run single test ───────────────────────────────────────────
  app.post('/api/tests/:testId/run', async (req, res) => {
    try {
      const { headless = true } = req.body ?? {};
      const result = await runSingleTest(req.params.testId, headless);
      res.status(202).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Abort a running test ─────────────────────────────────────
  app.post('/api/runs/:runId/abort', (req, res) => {
    const aborted = abortRun(req.params.runId);
    if (aborted) {
      res.json({ success: true, message: 'Run abort signal sent' });
    } else {
      res.status(404).json({ success: false, message: 'No active run found with that ID' });
    }
  });

  // ── Abort all running tests in a suite ──────────────────────
  app.post('/api/suites/:suiteId/abort', (req, res) => {
    const count = abortSuite(req.params.suiteId);
    res.json({ success: true, abortedCount: count });
  });

  // ── List suite runs (history) ─────────────────────────────────
  app.get('/api/suites', (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const db = getDb();
    const suites = db.prepare(
      'SELECT * FROM suite_runs ORDER BY started_at DESC LIMIT ?',
    ).all(limit);
    res.json(suites);
  });

  // ── Get suite detail ──────────────────────────────────────────
  app.get('/api/suites/:suiteId', (req, res) => {
    const db = getDb();
    const suite = db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(req.params.suiteId);
    if (!suite) return res.status(404).json({ error: 'Suite not found' });
    const testRuns = db.prepare(
      'SELECT * FROM test_runs WHERE suite_run_id = ? ORDER BY started_at',
    ).all(req.params.suiteId);
    res.json({ ...(suite as object), testRuns });
  });

  // ── Get latest run per test (aggregated across all suites) ────
  // IMPORTANT: must be before /api/runs/:runId to avoid :runId matching "latest"
  app.get('/api/runs/latest', (_req, res) => {
    const db = getDb();
    const runs = db.prepare(`
      SELECT t1.* FROM test_runs t1
      INNER JOIN (
        SELECT test_id, MAX(started_at) as max_started
        FROM test_runs
        GROUP BY test_id
      ) t2 ON t1.test_id = t2.test_id AND t1.started_at = t2.max_started
      ORDER BY t1.started_at DESC
    `).all();
    res.json(runs);
  });

  // ── Get test run detail ───────────────────────────────────────
  app.get('/api/runs/:runId', (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const screenshots = db.prepare(
      'SELECT * FROM screenshots WHERE test_run_id = ? ORDER BY turn_number',
    ).all(req.params.runId);
    const events = db.prepare(
      'SELECT * FROM run_events WHERE test_run_id = ? ORDER BY sequence',
    ).all(req.params.runId);
    const turnTokens = db.prepare(
      'SELECT * FROM turn_tokens WHERE test_run_id = ? ORDER BY turn_number',
    ).all(req.params.runId);
    res.json({ ...(run as object), screenshots, events, turnTokens });
  });

  // ── Serve screenshot files ────────────────────────────────────
  app.get('/api/runs/:runId/screenshots/:filename', (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT test_id FROM test_runs WHERE id = ?').get(req.params.runId) as { test_id: string } | undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });

    // Try new path structure first (testId/runId), fallback to legacy (runId only)
    let filePath = path.resolve('data', 'screenshots', run.test_id, req.params.runId, req.params.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.resolve('data', 'screenshots', req.params.runId, req.params.filename);
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(filePath);
  });

  // ── Serve test run video ────────────────────────────────────────
  app.get('/api/runs/:runId/video', (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT test_id FROM test_runs WHERE id = ?').get(req.params.runId) as { test_id: string } | undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const videoPath = path.resolve('data', 'screenshots', run.test_id, req.params.runId, 'replay.mp4');
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    res.sendFile(videoPath);
  });

  // ── SSE: live events for a running test ───────────────────────
  app.get('/api/runs/:runId/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send existing events first
    const db = getDb();
    const existingEvents = db.prepare(
      'SELECT * FROM run_events WHERE test_run_id = ? ORDER BY sequence',
    ).all(req.params.runId);
    for (const event of existingEvents) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Subscribe to new events
    const emitter = getActiveRunEmitter(req.params.runId);
    if (emitter) {
      const handler = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emitter.on('event', handler);
      req.on('close', () => emitter.off('event', handler));
    } else {
      // Run is not active — send a done signal and close
      res.write(`data: ${JSON.stringify({ type: 'stream_end', message: 'Run is not active' })}\n\n`);
    }
  });

  // ── Reset all data (clear DB + delete screenshots) ──────────
  app.post('/api/reset', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('DELETE FROM turn_tokens').run();
      db.prepare('DELETE FROM run_events').run();
      db.prepare('DELETE FROM screenshots').run();
      db.prepare('DELETE FROM test_runs').run();
      db.prepare('DELETE FROM suite_runs').run();

      // Delete all screenshot files
      const screenshotsDir = path.resolve('data', 'screenshots');
      if (fs.existsSync(screenshotsDir)) {
        fs.rmSync(screenshotsDir, { recursive: true, force: true });
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      res.json({ success: true, message: 'All test data and screenshots have been reset' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Generate HTML report for a single test run ─────────────────
  app.get('/api/runs/:runId/report', (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(req.params.runId) as Record<string, any> | undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const screenshots = db.prepare(
      'SELECT * FROM screenshots WHERE test_run_id = ? ORDER BY turn_number',
    ).all(req.params.runId) as Array<Record<string, any>>;

    // Embed screenshots as base64
    const screenshotImages = screenshots.map((ss: Record<string, any>) => {
      const fname = ss.file_path.replace(/\\/g, '/').split('/').pop();
      let filePath = path.resolve('data', 'screenshots', run.test_id, req.params.runId, fname);
      if (!fs.existsSync(filePath)) {
        filePath = path.resolve('data', 'screenshots', req.params.runId, fname);
      }
      let dataUri = '';
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        dataUri = `data:image/png;base64,${buf.toString('base64')}`;
      }
      return { turn_number: ss.turn_number, page_title: ss.page_title, page_url: ss.page_url, dataUri };
    });

    const statusColors: Record<string, string> = {
      passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308', running: '#3b82f6',
    };
    const statusColor = statusColors[run.status] || '#6b7280';
    const duration = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : 'N/A';
    const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : 'N/A';
    const completedAt = run.completed_at ? new Date(run.completed_at).toLocaleString() : 'N/A';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report - ${escapeHtml(run.test_name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; padding: 40px; }
  .container { max-width: 1000px; margin: 0 auto; }
  .header { background: #0f172a; color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { display: flex; gap: 24px; flex-wrap: wrap; font-size: 14px; color: #94a3b8; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; background: ${statusColor}; text-transform: uppercase; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card .value { font-size: 24px; font-weight: 700; color: #0f172a; }
  .stat-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .section { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
  .verdict { background: #f1f5f9; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; line-height: 1.7; }
  .error-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #dc2626; white-space: pre-wrap; }
  .screenshot-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .screenshot-item { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .screenshot-item .info { padding: 8px 12px; background: #f8fafc; font-size: 12px; color: #64748b; display: flex; justify-content: space-between; }
  .screenshot-item img { width: 100%; display: block; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  @media print { body { padding: 20px; } .screenshot-item img { max-height: 400px; object-fit: contain; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <h1>${escapeHtml(run.test_name)}</h1>
      <span class="status-badge">${escapeHtml(run.status)}</span>
    </div>
    <div class="meta">
      <span>Run ID: ${escapeHtml(run.id)}</span>
      <span>Started: ${startedAt}</span>
      <span>Completed: ${completedAt}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value">${duration}</div><div class="label">Duration</div></div>
    <div class="stat-card"><div class="value">${run.turn_count}</div><div class="label">Turns</div></div>
    <div class="stat-card"><div class="value">${screenshots.length}</div><div class="label">Screenshots</div></div>
    <div class="stat-card"><div class="value">${run.input_tokens?.toLocaleString() ?? 0}</div><div class="label">Input Tokens</div></div>
    <div class="stat-card"><div class="value">${run.output_tokens?.toLocaleString() ?? 0}</div><div class="label">Output Tokens</div></div>
    <div class="stat-card"><div class="value">${run.reasoning_tokens?.toLocaleString() ?? 0}</div><div class="label">Reasoning Tokens</div></div>
  </div>

  ${run.model_verdict ? `
  <div class="section">
    <h2>Model Verdict</h2>
    <div class="verdict">${escapeHtml(run.model_verdict)}</div>
  </div>` : ''}

  ${run.error ? `
  <div class="section">
    <h2>Error</h2>
    <div class="error-box">${escapeHtml(run.error)}</div>
  </div>` : ''}

  ${screenshotImages.length > 0 ? `
  <div class="section">
    <h2>Screenshots (${screenshotImages.length})</h2>
    <div class="screenshot-grid">
      ${screenshotImages.map((ss, i) => `
      <div class="screenshot-item">
        <div class="info">
          <span>Turn ${ss.turn_number} ${i === 0 ? '(Initial)' : i === screenshotImages.length - 1 ? '(Final)' : ''}</span>
          <span>${ss.page_title ? escapeHtml(ss.page_title) : ''}${ss.page_url ? ' &mdash; ' + escapeHtml(ss.page_url) : ''}</span>
        </div>
        ${ss.dataUri ? `<img src="${ss.dataUri}" alt="Turn ${ss.turn_number}" />` : '<div style="padding:32px;text-align:center;color:#94a3b8;">Screenshot not available</div>'}
      </div>`).join('')}
    </div>
  </div>` : ''}

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner Report
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="report-${run.test_name.replace(/[^a-zA-Z0-9]/g, '-')}-${req.params.runId.slice(0, 8)}.html"`);
    res.send(html);
  });

  // ── Generate HTML report for a suite run ──────────────────────
  app.get('/api/suites/:suiteId/report', (req, res) => {
    const db = getDb();
    const suite = db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(req.params.suiteId) as Record<string, any> | undefined;
    if (!suite) return res.status(404).json({ error: 'Suite not found' });

    const testRuns = db.prepare(
      'SELECT * FROM test_runs WHERE suite_run_id = ? ORDER BY started_at',
    ).all(req.params.suiteId) as Array<Record<string, any>>;

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

  // ── Get all test runs for a suite (polling alternative) ───────
  app.get('/api/suites/:suiteId/runs', (req, res) => {
    const db = getDb();
    const runs = db.prepare(
      'SELECT * FROM test_runs WHERE suite_run_id = ? ORDER BY started_at',
    ).all(req.params.suiteId);
    res.json(runs);
  });

  // ── Generate aggregated HTML report (matches dashboard view) ───
  app.get('/api/report/latest', (_req, res) => {
    const db = getDb();
    const testRuns = db.prepare(`
      SELECT t1.* FROM test_runs t1
      INNER JOIN (
        SELECT test_id, MAX(started_at) as max_started
        FROM test_runs
        GROUP BY test_id
      ) t2 ON t1.test_id = t2.test_id AND t1.started_at = t2.max_started
      ORDER BY t1.test_name
    `).all() as Array<Record<string, any>>;

    if (testRuns.length === 0) return res.status(404).json({ error: 'No test data available' });

    const total = testRuns.length;
    const passed = testRuns.filter(r => r.status === 'passed').length;
    const failed = testRuns.filter(r => r.status === 'failed').length;
    const errors = testRuns.filter(r => r.status === 'error').length;
    const timeouts = testRuns.filter(r => r.status === 'timeout').length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    const statusColors: Record<string, string> = {
      passed: '#10b981', failed: '#ef4444', error: '#f97316', timeout: '#eab308',
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Dashboard Report</title>
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
  .verdict-preview { font-family: monospace; font-size: 12px; color: #64748b; max-height: 80px; overflow: hidden; margin-top: 8px; white-space: pre-wrap; }
  .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>QA Dashboard Report</h1>
    <div class="meta">
      <span>Latest results per test case (aggregated across all runs)</span>
      <span>Generated: ${new Date().toLocaleString()}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value" style="color:#0f172a">${total}</div><div class="label">Total Tests</div></div>
    <div class="stat-card"><div class="value" style="color:#10b981">${passed}</div><div class="label">Passed</div></div>
    <div class="stat-card"><div class="value" style="color:#ef4444">${failed}</div><div class="label">Failed</div></div>
    <div class="stat-card"><div class="value" style="color:#f97316">${errors}</div><div class="label">Errors</div></div>
    <div class="stat-card"><div class="value" style="color:#eab308">${timeouts}</div><div class="label">Timeouts</div></div>
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
        ${r.model_verdict ? `<tr><td colspan="5"><div class="verdict-preview">${escapeHtml(r.model_verdict.slice(0, 500))}${r.model_verdict.length > 500 ? '...' : ''}</div></td></tr>` : ''}
        ${r.error ? `<tr><td colspan="5"><div style="color:#dc2626;font-size:12px;font-family:monospace;padding:4px 0;">${escapeHtml(r.error.slice(0, 300))}</div></td></tr>` : ''}`).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner &mdash; QA Dashboard Report
  </div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="qa-dashboard-report-${new Date().toISOString().slice(0, 10)}.html"`);
    res.send(html);
  });

  return app;
}
