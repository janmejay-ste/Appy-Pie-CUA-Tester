import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import * as repo from '../db/repo.js';
import { getDb } from '../db/turso.js';

export async function createSession(total: number) {
  const id = uuid();
  await repo.createSession(id, total);
  return repo.getSession(id);
}

export async function getSession(sessionId: string) {
  const session = await repo.getSession(sessionId);
  if (!session) return null;
  const testRuns = await repo.getTestRunsBySession(sessionId, 'asc');
  return { ...session, testRuns };
}

export async function listSessions(limit = 20) {
  return repo.listSessions(limit);
}

export async function updateSessionStats(sessionId: string) {
  const runs = await repo.getTestRunsBySession(sessionId);
  const passed = runs.filter(r => r.status === 'passed').length;
  const failed = runs.filter(r => r.status === 'failed').length;
  const errors = runs.filter(r => r.status === 'error').length;
  const timeouts = runs.filter(r => r.status === 'timeout').length;

  const allDone = runs.every(r => !['queued', 'running'].includes(r.status));

  await repo.updateSession(sessionId, {
    passed,
    failed,
    errors,
    timeouts,
    ...(allDone ? { completed_at: new Date().toISOString() } : {}),
  });
}

export async function resetAll() {
  const db = getDb();
  await Promise.all([
    db.execute('DELETE FROM events'),
    db.execute('DELETE FROM steps'),
    db.execute('DELETE FROM test_runs'),
    db.execute('DELETE FROM sessions'),
  ]);

  // Delete screenshots
  const screenshotsDir = path.resolve(process.cwd(), 'data', 'screenshots');
  if (fs.existsSync(screenshotsDir)) {
    fs.rmSync(screenshotsDir, { recursive: true, force: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
}
