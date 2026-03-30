import { v4 as uuid } from 'uuid';
import { TestRun } from '../db/models/TestRun.js';
import { Step, stepToScreenshot, stepToTurnToken } from '../db/models/Step.js';
import { Event } from '../db/models/Event.js';

export async function createTestRun(sessionId: string, testId: string, testName: string) {
  return TestRun.create({
    _id: uuid(),
    sessionId,
    testId,
    testName,
    status: 'queued',
  });
}

export async function getTestRun(testRunId: string) {
  return TestRun.findById(testRunId);
}

export async function getTestRunDetail(testRunId: string) {
  const run = await TestRun.findById(testRunId);
  if (!run) return null;

  const steps = await Step.find({ testRunId }).sort({ turnNumber: 1 }).lean();
  const events = await Event.find({ testRunId }).sort({ sequence: 1 });

  // Split steps into screenshots + turnTokens for backward compatibility
  const screenshots = steps.map(s => stepToScreenshot(s as any));
  const turnTokens = steps
    .filter(s => s.inputTokens > 0 || s.outputTokens > 0)
    .map(s => stepToTurnToken(s as any));

  return {
    ...run.toJSON(),
    screenshots,
    events: events.map(e => e.toJSON()),
    turnTokens,
  };
}

export async function getLatestRuns() {
  const runs = await TestRun.aggregate([
    { $sort: { startedAt: -1 as const } },
    { $group: { _id: '$testId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { startedAt: -1 as const } },
  ]);

  // Apply the same toJSON transform manually for aggregation results
  return runs.map(r => ({
    id: r._id,
    suite_run_id: r.sessionId,
    test_id: r.testId,
    test_name: r.testName,
    status: r.status,
    started_at: r.startedAt?.toISOString?.() ?? r.startedAt ?? null,
    completed_at: r.completedAt?.toISOString?.() ?? r.completedAt ?? null,
    duration_ms: r.durationMs,
    turn_count: r.turnCount,
    screenshot_count: r.screenshotCount,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    reasoning_tokens: r.reasoningTokens,
    model_verdict: r.modelVerdict,
    error: r.error,
  }));
}

export async function updateTestRunStatus(testRunId: string, updates: Record<string, any>) {
  await TestRun.updateOne({ _id: testRunId }, { $set: updates });
}

export async function persistStep(data: {
  _id: string;
  testRunId: string;
  turnNumber: number;
  filePath: string;
  capturedAt: Date;
  pageUrl: string | null;
  pageTitle: string | null;
}) {
  await Step.create({
    ...data,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    apiLatencyMs: 0,
    cumulativeInput: 0,
    cumulativeOutput: 0,
    cumulativeReasoning: 0,
  });
}

export async function updateStepTokens(testRunId: string, turnNumber: number, tokenData: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  apiLatencyMs: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeReasoning: number;
  mode?: string;
}) {
  await Step.updateOne(
    { testRunId, turnNumber },
    { $set: tokenData },
  );
}

export async function persistEvent(data: {
  _id: string;
  testRunId: string;
  sequence: number;
  type: string;
  message: string;
  detail: string | null;
  timestamp: Date;
}) {
  return Event.create(data);
}
