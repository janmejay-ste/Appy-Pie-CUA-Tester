import { v4 as uuid } from 'uuid';
import * as repo from '../db/repo.js';

/** Map camelCase field names (used by callers) to snake_case column names. */
const camelToSnake: Record<string, string> = {
  sessionId: 'session_id',
  testId: 'test_id',
  testName: 'test_name',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  durationMs: 'duration_ms',
  turnCount: 'turn_count',
  screenshotCount: 'screenshot_count',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  reasoningTokens: 'reasoning_tokens',
  modelVerdict: 'model_verdict',
  pageState: 'page_state',
  lastHeartbeat: 'last_heartbeat',
};

function mapToSnake(updates: Record<string, any>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    const col = camelToSnake[k] ?? k;
    mapped[col] = v;
  }
  return mapped;
}

export async function createTestRun(sessionId: string, testId: string, testName: string) {
  const id = uuid();
  await repo.createTestRun(id, sessionId, testId, testName);
  return repo.getTestRun(id);
}

export async function getTestRun(testRunId: string) {
  return repo.getTestRun(testRunId);
}

export async function getTestRunDetail(testRunId: string) {
  const run = await repo.getTestRun(testRunId);
  if (!run) return null;

  const [screenshots, events, turnTokens] = await Promise.all([
    repo.getStepScreenshotsByRun(testRunId),
    repo.getEventsByRun(testRunId),
    repo.getStepTurnTokensByRun(testRunId),
  ]);

  return {
    ...run,
    screenshots,
    events,
    turnTokens,
  };
}

export async function getLatestRuns() {
  return repo.getLatestRunPerTest();
}

export async function updateTestRunStatus(testRunId: string, updates: Record<string, any>) {
  await repo.updateTestRun(testRunId, mapToSnake(updates));
}

export async function persistStep(data: {
  _id: string;
  testRunId: string;
  turnNumber: number;
  filePath: string;
  capturedAt: Date;
  pageUrl: string | null;
  pageTitle: string | null;
  action?: unknown;
  result?: unknown;
  validation?: unknown;
  effective?: boolean | null;
  retryStrategy?: string | null;
  memory?: string | null;
  nextGoal?: string | null;
  domFingerprint?: string | null;
  confidence?: number | null;
  visionUsed?: boolean;
  mode?: string;
}) {
  await repo.createStep({
    id: data._id,
    test_run_id: data.testRunId,
    turn_number: data.turnNumber,
    file_path: data.filePath,
    captured_at: data.capturedAt,
    page_url: data.pageUrl,
    page_title: data.pageTitle,
    action: data.action,
    result: data.result,
    validation: data.validation,
    effective: data.effective,
    retry_strategy: data.retryStrategy ?? null,
    memory: data.memory ?? null,
    next_goal: data.nextGoal ?? null,
    dom_fingerprint: data.domFingerprint ?? null,
    confidence: data.confidence ?? null,
    vision_used: data.visionUsed ?? false,
    mode: data.mode ?? 'dom',
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    api_latency_ms: 0,
    cumulative_input: 0,
    cumulative_output: 0,
    cumulative_reasoning: 0,
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
  await repo.updateStepTokens(testRunId, turnNumber, {
    input_tokens: tokenData.inputTokens,
    output_tokens: tokenData.outputTokens,
    reasoning_tokens: tokenData.reasoningTokens,
    api_latency_ms: tokenData.apiLatencyMs,
    cumulative_input: tokenData.cumulativeInput,
    cumulative_output: tokenData.cumulativeOutput,
    cumulative_reasoning: tokenData.cumulativeReasoning,
    ...(tokenData.mode != null ? { mode: tokenData.mode } : {}),
  });
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
  await repo.createEvent({
    id: data._id,
    test_run_id: data.testRunId,
    sequence: data.sequence,
    type: data.type,
    message: data.message,
    detail: data.detail,
    timestamp: data.timestamp,
  });
}
