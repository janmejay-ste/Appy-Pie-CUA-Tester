import fs from 'fs';
import path from 'path';
import { Session } from '../db/models/Session.js';
import { TestRun } from '../db/models/TestRun.js';
import { Step } from '../db/models/Step.js';
import { Event } from '../db/models/Event.js';

const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'data', 'screenshots');
const DEFAULT_RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7', 10);
const KEEP_FAILED_RUNS = parseInt(process.env.KEEP_FAILED_RUNS || '50', 10);

export async function cleanupOldRuns(retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  console.log(`[cleanup] Cleaning up runs older than ${retentionDays} days (before ${cutoff.toISOString()})`);

  // Find old COMPLETED sessions only (never touch active ones)
  const oldSessions = await Session.find({
    completedAt: { $ne: null, $lt: cutoff },
  }).lean();

  if (oldSessions.length === 0) {
    console.log('[cleanup] No old sessions to clean up');
    return { sessions: 0, runs: 0, steps: 0, events: 0, screenshotDirs: 0, keptFailed: 0 };
  }

  const sessionIds = oldSessions.map(s => s._id);

  // Find old test runs — but KEEP recent failed runs PER TEST for debugging diversity
  const KEEP_PER_TEST = 5;
  const failedRuns = await TestRun.find({ status: { $in: ['failed', 'error'] } })
    .sort({ completedAt: -1 }).lean();

  // Keep last N failed runs per testId (not global — ensures diversity)
  const failedCountPerTest: Record<string, number> = {};
  const recentFailedIds = new Set<string>();
  for (const r of failedRuns) {
    const count = failedCountPerTest[r.testId] || 0;
    if (count < KEEP_PER_TEST) {
      recentFailedIds.add(r._id);
      failedCountPerTest[r.testId] = count + 1;
    }
    // Also respect global cap
    if (recentFailedIds.size >= KEEP_FAILED_RUNS) break;
  }

  const oldRuns = await TestRun.find({
    sessionId: { $in: sessionIds },
    status: { $nin: ['running', 'queued'] },  // never delete active runs
  }).lean();

  // Filter out protected failed runs
  const runsToDelete = oldRuns.filter(r => !recentFailedIds.has(r._id));
  const keptFailed = oldRuns.length - runsToDelete.length;
  const runIds = runsToDelete.map(r => r._id);

  // Delete screenshot directories (only for runs being deleted)
  let screenshotDirsDeleted = 0;
  for (const run of runsToDelete) {
    const dir = path.join(SCREENSHOTS_DIR, run.testId, run._id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      screenshotDirsDeleted++;
    }
  }

  // Clean empty parent directories
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    try {
      const testDirs = fs.readdirSync(SCREENSHOTS_DIR);
      for (const testDir of testDirs) {
        const fullPath = path.join(SCREENSHOTS_DIR, testDir);
        try {
          const contents = fs.readdirSync(fullPath);
          if (contents.length === 0) fs.rmdirSync(fullPath);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Delete from MongoDB
  const [stepsResult, eventsResult, runsResult] = await Promise.all([
    Step.deleteMany({ testRunId: { $in: runIds } }),
    Event.deleteMany({ testRunId: { $in: runIds } }),
    TestRun.deleteMany({ _id: { $in: runIds } }),
  ]);

  // Only delete sessions where ALL runs have been deleted
  let sessionsDeleted = 0;
  for (const sessionId of sessionIds) {
    const remaining = await TestRun.countDocuments({ sessionId });
    if (remaining === 0) {
      await Session.deleteOne({ _id: sessionId });
      sessionsDeleted++;
    }
  }

  const result = {
    sessions: sessionsDeleted,
    runs: runsResult.deletedCount,
    steps: stepsResult.deletedCount,
    events: eventsResult.deletedCount,
    screenshotDirs: screenshotDirsDeleted,
    keptFailed,
  };

  console.log(`[cleanup] Deleted: ${result.sessions} sessions, ${result.runs} runs, ${result.steps} steps, ${result.events} events, ${result.screenshotDirs} dirs | Kept ${keptFailed} failed runs`);
  return result;
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupScheduler(retentionDays = DEFAULT_RETENTION_DAYS) {
  cleanupOldRuns(retentionDays).catch(err =>
    console.error('[cleanup] Startup cleanup failed:', err.message)
  );

  cleanupInterval = setInterval(() => {
    cleanupOldRuns(retentionDays).catch(err =>
      console.error('[cleanup] Scheduled cleanup failed:', err.message)
    );
  }, 24 * 60 * 60 * 1000);

  console.log(`[cleanup] Retention scheduler started (${retentionDays} day retention, keep last ${KEEP_FAILED_RUNS} failed runs)`);
}

export function stopCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
