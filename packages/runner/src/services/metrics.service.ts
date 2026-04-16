import { v4 as uuid } from 'uuid';
import * as repo from '../db/repo.js';
import { getQueueMetrics } from '../queue/queue.js';

// Alert thresholds (configurable via env)
const ALERT_FAILURE_RATE = parseInt(process.env.ALERT_FAILURE_RATE || '30', 10);
const ALERT_QUEUE_SIZE = parseInt(process.env.ALERT_QUEUE_SIZE || '20', 10);
const ALERT_AVG_LATENCY_MS = parseInt(process.env.ALERT_AVG_LATENCY_MS || '300000', 10); // 5 min

export async function captureMetricSnapshot() {
  const queue = await getQueueMetrics();

  // Compute stats from last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentRuns = await repo.getRecentCompletedRuns(since);

  const totalRuns = recentRuns.length;
  const failedRuns = recentRuns.filter(r => r.status === 'failed' || r.status === 'error').length;
  const failureRate = totalRuns > 0 ? Math.round((failedRuns / totalRuns) * 100) : 0;

  const durations = recentRuns.filter(r => r.duration_ms).map(r => r.duration_ms!);
  const avgLatencyMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const totalTokensUsed = recentRuns.reduce((sum, r) => sum + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

  // Generate alerts — only when there are recent runs (skip on cold start)
  const alerts: string[] = [];
  if (totalRuns >= 3) {
    if (failureRate > ALERT_FAILURE_RATE) {
      alerts.push(`HIGH_FAILURE_RATE: ${failureRate}% failure rate in last 24h (${failedRuns}/${totalRuns} runs)`);
    }
    if (avgLatencyMs > ALERT_AVG_LATENCY_MS) {
      alerts.push(`HIGH_LATENCY: avg ${Math.round(avgLatencyMs / 1000)}s per test (threshold: ${Math.round(ALERT_AVG_LATENCY_MS / 1000)}s)`);
    }
  }
  if (queue.waiting > ALERT_QUEUE_SIZE) {
    alerts.push(`QUEUE_BACKLOG: ${queue.waiting} jobs waiting (threshold: ${ALERT_QUEUE_SIZE})`);
  }
  if (queue.failed > 10) {
    alerts.push(`QUEUE_FAILURES: ${queue.failed} failed jobs in queue`);
  }

  // Log alerts
  if (alerts.length > 0) {
    console.warn(`[metrics] ALERTS:\n  ${alerts.join('\n  ')}`);
  }

  // Save snapshot
  const id = uuid();
  await repo.createMetricSnapshot({
    id,
    timestamp: new Date(),
    queue_waiting: queue.waiting,
    queue_active: queue.active,
    queue_failed: queue.failed,
    total_runs: totalRuns,
    failure_rate: failureRate,
    avg_latency_ms: avgLatencyMs,
    total_tokens_used: totalTokensUsed,
    alerts,
  });

  // Clean up old metrics (replace MongoDB TTL index)
  const ttlCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
  await repo.deleteOldMetrics(ttlCutoff);

  return repo.getMetricsSince(new Date(Date.now() - 1000)); // return the just-created snapshot
}

// Get time-series data for the last N hours
export async function getMetricsTimeSeries(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return repo.getMetricsSince(since);
}

// Schedule metrics capture every 5 minutes
let metricsInterval: ReturnType<typeof setInterval> | null = null;

export function startMetricsScheduler() {
  // Capture first snapshot after 30s (let system stabilize)
  setTimeout(() => {
    captureMetricSnapshot().catch(err =>
      console.error('[metrics] Snapshot failed:', err.message)
    );
  }, 30000);

  metricsInterval = setInterval(() => {
    captureMetricSnapshot().catch(err =>
      console.error('[metrics] Snapshot failed:', err.message)
    );
  }, 5 * 60 * 1000); // every 5 minutes

  console.log('[metrics] Metrics scheduler started (every 5 min)');
}

export function stopMetricsScheduler() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}
