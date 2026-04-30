import { Router } from 'express';
import * as repo from '../db/repo.js';
import * as testService from '../services/test.service.js';
import * as sessionService from '../services/session.service.js';
import { escapeHtml } from '../middleware/utils.js';

const router = Router();

// ── Observability Metrics ────────────────────────────────────
router.get('/metrics', async (_req, res) => {
  try {
    const { getQueueMetrics } = await import('../queue/queue.js');
    const queueMetrics = await getQueueMetrics();

    // DB stats
    const totalSessions = await repo.countSessions();
    const totalRuns = await repo.countTestRuns();
    const runsByStatus = await repo.getTestRunMetrics();

    // Token totals
    const tokenTotals = await repo.getTokenMetrics();

    // Average latency (all time — use a very old date as "since")
    const longAgo = new Date('2000-01-01');
    const latencyResult = await repo.getLatencyMetrics(longAgo);

    // Failure rate
    const totalCompleted = Object.entries(runsByStatus)
      .filter(([status]) => status !== 'queued' && status !== 'running')
      .reduce((sum, [, count]) => sum + count, 0);
    const totalFailed = (runsByStatus['failed'] ?? 0) + (runsByStatus['error'] ?? 0);
    const failureRate = totalCompleted > 0 ? Math.round((totalFailed / totalCompleted) * 100) : 0;

    // Per-test metrics
    const perTestMetrics = await repo.getPerTestMetrics(longAgo);

    res.json({
      queue: queueMetrics,
      database: {
        sessions: totalSessions,
        totalRuns,
        runsByStatus,
      },
      tokens: {
        totalInput: tokenTotals.total_input,
        totalOutput: tokenTotals.total_output,
        totalReasoning: tokenTotals.total_reasoning,
      },
      latency: {
        avgMs: latencyResult.avg_duration,
        maxMs: 0,
        minMs: 0,
      },
      failureRate: `${failureRate}%`,
      perTest: perTestMetrics.map(m => ({
        _id: m.test_id,
        testName: m.test_name,
        totalRuns: m.total,
        passed: m.passed,
        failed: m.failures,
        timeouts: 0,
        avgDurationMs: m.avg_duration,
        totalTokens: m.avg_tokens * m.total,
        lastRun: null,
        failureRate: Math.round(m.failure_rate * 100 * 10) / 10,
      })),
      uptime: process.uptime(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Metrics time-series ──────────────────────────────────────
router.get('/metrics/history', async (req, res) => {
  try {
    const hours = Number(req.query.hours) || 24;
    const { getMetricsTimeSeries } = await import('../services/metrics.service.js');
    const data = await getMetricsTimeSeries(hours);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cleanup old data ──────────────────────────────────────────
router.post('/cleanup', async (req, res) => {
  try {
    const { retentionDays = 7 } = req.body ?? {};
    const { cleanupOldRuns } = await import('../services/cleanup.service.js');
    const result = await cleanupOldRuns(retentionDays);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DLQ: list failed jobs with grouping ────────────────────────
router.get('/dlq', async (_req, res) => {
  try {
    const { deadLetterQueue: dlq } = await import('../queue/queue.js');
    const jobs = await dlq.getWaiting(0, 100);
    const items = jobs.map(j => {
      const d = j.data as any;
      const error = d.error || '';
      const errorType = error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT') ? 'infra'
        : error.includes('CUA API') || error.includes('Safety check') ? 'api'
        : error.includes('aborted') ? 'aborted'
        : 'unknown';
      return {
        id: j.id,
        testId: d.testId,
        testName: d.testName,
        sessionId: d.sessionId,
        testRunId: d.testRunId,
        failedAt: d.failedAt,
        error,
        errorType,
        attempts: d.attempts,
      };
    });

    // Group by error type
    const grouped: Record<string, typeof items> = {};
    for (const item of items) {
      if (!grouped[item.errorType]) grouped[item.errorType] = [];
      grouped[item.errorType].push(item);
    }

    res.json({ total: items.length, grouped, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DLQ: requeue a failed job (max 3 total attempts) ────────────
router.post('/dlq/:jobId/requeue', async (req, res) => {
  try {
    const MAX_TOTAL_ATTEMPTS = 3;
    const { deadLetterQueue: dlq, testExecutionQueue: queue } = await import('../queue/queue.js');
    const job = await dlq.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found in DLQ' });

    const jobData = job.data as any;
    const totalAttempts = (jobData.totalAttempts ?? jobData.attempts ?? 1) + 1;

    if (totalAttempts > MAX_TOTAL_ATTEMPTS) {
      return res.status(400).json({
        error: `Max retry limit reached (${MAX_TOTAL_ATTEMPTS} total attempts). This job cannot be requeued.`,
        testName: jobData.testName,
        totalAttempts: totalAttempts - 1,
      });
    }

    // Clean DLQ metadata, track total attempts
    delete jobData.failedAt;
    delete jobData.error;
    delete jobData.attempts;
    jobData.totalAttempts = totalAttempts;

    await queue.add(`retry-${jobData.testId}`, jobData);
    await job.remove();

    res.json({ success: true, message: `Requeued job for test: ${jobData.testName} (attempt ${totalAttempts}/${MAX_TOTAL_ATTEMPTS})` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DLQ: clear all ──────────────────────────────────────────────
router.delete('/dlq', async (_req, res) => {
  try {
    const { deadLetterQueue: dlq } = await import('../queue/queue.js');
    await dlq.obliterate({ force: true });
    res.json({ success: true, message: 'DLQ cleared' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reset all data (clear MongoDB + delete screenshots) ──────
router.post('/reset', async (_req, res) => {
  try {
    await sessionService.resetAll();
    res.json({ success: true, message: 'All test data and screenshots have been reset' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate aggregated HTML report (matches dashboard view) ───
router.get('/report/latest', async (_req, res) => {
  const testRuns = await testService.getLatestRuns();

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
<title>Automate CUA Dashboard</title>
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
    <h1>Automate CUA Dashboard Report</h1>
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
    Generated on ${new Date().toLocaleString()} &bull; CUA Test Runner &mdash; Automate CUA Dashboard Report
  </div>
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="qa-dashboard-report-${new Date().toISOString().slice(0, 10)}.html"`);
  res.send(html);
});

export default router;
