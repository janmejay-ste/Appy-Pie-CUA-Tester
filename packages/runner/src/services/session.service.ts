import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Session, TestRun, Step, Event } from '../db/models/index.js';

export async function createSession(total: number) {
  const session = await Session.create({
    _id: uuid(),
    startedAt: new Date(),
    total,
  });
  return session;
}

export async function getSession(sessionId: string) {
  const session = await Session.findById(sessionId).lean();
  if (!session) return null;
  const testRuns = await TestRun.find({ sessionId }).sort({ startedAt: 1 });
  return { ...session, testRuns: testRuns.map(r => r.toJSON()) };
}

export async function listSessions(limit = 20) {
  return Session.find().sort({ startedAt: -1 }).limit(limit);
}

export async function updateSessionStats(sessionId: string) {
  const runs = await TestRun.find({ sessionId }).lean();
  const passed = runs.filter(r => r.status === 'passed').length;
  const failed = runs.filter(r => r.status === 'failed').length;
  const errors = runs.filter(r => r.status === 'error').length;
  const timeouts = runs.filter(r => r.status === 'timeout').length;

  const allDone = runs.every(r => !['queued', 'running'].includes(r.status));

  await Session.updateOne({ _id: sessionId }, {
    $set: {
      passed,
      failed,
      errors,
      timeouts,
      ...(allDone ? { completedAt: new Date() } : {}),
    },
  });
}

export async function resetAll() {
  await Promise.all([
    Event.deleteMany({}),
    Step.deleteMany({}),
    TestRun.deleteMany({}),
    Session.deleteMany({}),
  ]);

  // Delete screenshots
  const screenshotsDir = path.resolve(process.cwd(), 'data', 'screenshots');
  if (fs.existsSync(screenshotsDir)) {
    fs.rmSync(screenshotsDir, { recursive: true, force: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
}
