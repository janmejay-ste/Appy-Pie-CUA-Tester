import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import * as repo from '../db/repo.js';
import { testExecutionQueue, createSubscriber } from '../queue/queue.js';
import { abortTestRun } from '../queue/worker.js';
import * as testService from '../services/test.service.js';
import { escapeHtml } from '../middleware/utils.js';

const router = Router();

// ── Get latest run per test (aggregated across all suites) ────
// IMPORTANT: must be before /:runId to avoid :runId matching "latest"
router.get('/latest', async (_req, res) => {
  const runs = await testService.getLatestRuns();
  res.json(runs);
});

// ── Get test run detail ───────────────────────────────────────
router.get('/:runId', async (req, res) => {
  const detail = await testService.getTestRunDetail(req.params.runId);
  if (!detail) return res.status(404).json({ error: 'Run not found' });
  res.json(detail);
});

// ── Serve screenshot files (path traversal protected) ────────
router.get('/:runId/screenshots/:filename', async (req, res) => {
  const run = await repo.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  // Reject path traversal attempts
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.png')) return res.status(400).json({ error: 'Invalid file type' });

  const baseDir = path.resolve('data', 'screenshots');
  let filePath = path.resolve(baseDir, run.test_id, req.params.runId, filename);
  if (!filePath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });

  if (!fs.existsSync(filePath)) {
    filePath = path.resolve(baseDir, req.params.runId, filename);
    if (!filePath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// ── Serve test run video (path traversal protected) ───────────
router.get('/:runId/video', async (req, res) => {
  const run = await repo.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const baseDir = path.resolve('data', 'screenshots');
  const videoPath = path.resolve(baseDir, run.test_id, req.params.runId, 'replay.mp4');
  if (!videoPath.startsWith(baseDir)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
  res.sendFile(videoPath);
});

// ── SSE: live events for a running test (via Redis pub/sub) ───
// Supports Last-Event-ID for reconnection replay
router.get('/:runId/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Support reconnection — only send events after lastEventId
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  const lastSeq = lastEventId && /^\d+$/.test(lastEventId) ? parseInt(lastEventId, 10) : 0;

  // Send existing events (all or only after lastSeq for reconnection)
  const existingEvents = await repo.getEventsByRun(req.params.runId, lastSeq > 0 ? lastSeq : undefined);
  for (const event of existingEvents) {
    res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // Check if run is still active
  const run = await repo.getTestRun(req.params.runId);
  if (!run || run.completed_at) {
    res.write(`data: ${JSON.stringify({ type: 'stream_end', message: 'Run is not active' })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to Redis pub/sub for live events
  const subscriber = createSubscriber();
  const channel = `events:${req.params.runId}`;
  await subscriber.subscribe(channel);

  subscriber.on('message', (_ch: string, message: string) => {
    res.write(`data: ${message}\n\n`);
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'run_completed' || parsed.type === 'run_failed') {
        res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
      }
    } catch { /* ignore parse errors */ }
  });

  req.on('close', () => {
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.disconnect();
  });
});

// ── Abort a running test ─────────────────────────────────────
router.post('/:runId/abort', async (_req, res) => {
  const runId = _req.params.runId;
  console.log(`[api] Abort requested for run: ${runId}`);
  abortTestRun(runId);

  // Remove from queue if still queued or active — prevents BullMQ retry
  try {
    const allJobs = await testExecutionQueue.getJobs(['waiting', 'delayed', 'active']);
    for (const job of allJobs) {
      if (job.data?.testRunId === runId) {
        try {
          await job.moveToFailed(new Error('Aborted by user'), '0', true);
        } catch {
          try { await job.remove(); } catch {}
        }
        console.log(`[api] Removed/failed job ${job.id} for run ${runId}`);
      }
    }
  } catch (err) {
    console.log(`[api] Could not clean up queue jobs: ${(err as Error).message}`);
  }

  // Immediately mark as aborted in DB so dashboard reflects it
  // The worker will also update status, but this ensures instant UI feedback
  const run = await repo.getTestRun(runId);
  if (run && (run.status === 'running' || run.status === 'queued')) {
    await repo.updateTestRun(runId, {
      status: 'aborted',
      completed_at: new Date().toISOString(),
      error: 'Aborted by user',
    });
    console.log(`[api] Marked run ${runId} as aborted in DB`);
  }

  res.json({ success: true, message: 'Run aborted' });
});

// ── Get run log (markdown) ─────────────────────────────────────
router.get('/:runId/log', async (req, res) => {
  const run = await repo.getTestRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const logPath = path.resolve('data', 'logs', run.test_id, `${req.params.runId}.md`);
  if (!fs.existsSync(logPath)) {
    // Generate on demand if not already created
    try {
      const { generateRunLog } = await import('../services/runlog.service.js');
      const generated = await generateRunLog(req.params.runId, run.test_id);
      if (!generated) return res.status(404).json({ error: 'Log not available' });
    } catch {
      return res.status(404).json({ error: 'Log generation failed' });
    }
  }
  res.type('text/markdown').sendFile(logPath);
});

// ── Generate HTML report for a single test run ─────────────────
router.get('/:runId/report', async (req, res) => {
  const detail = await testService.getTestRunDetail(req.params.runId);
  if (!detail) return res.status(404).json({ error: 'Run not found' });

  const run = detail as any;
  const screenshots = detail.screenshots as Array<Record<string, any>>;

  // Embed screenshots as base64
  const screenshotImages = screenshots.map((ss: Record<string, any>) => {
    const fname = ss.file_path?.replace(/\\/g, '/').split('/').pop();
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

export default router;
