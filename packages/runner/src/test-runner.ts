import OpenAI from 'openai';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { getDb } from './db.js';
import { getTestAccount } from './config.js';
import { launchBrowser } from './browser.js';
import { runCUALoop } from './cua-loop.js';
import { loadAllTests, loadTestById } from './test-loader.js';
import type { TestDefinition, TestRun, SuiteRun, RunEvent, ScreenshotRecord } from './types.js';

const openai = new OpenAI();

// ── FFmpeg video generation ──────────────────────────────────────
function generateReplayVideo(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const outputPath = path.join(dir, 'replay.mp4');
    const inputPattern = path.join(dir, '%03d-turn.png');
    const args = [
      '-y',
      '-framerate', '1',
      '-i', inputPattern,
      '-vf', 'scale=1280:-2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      outputPath,
    ];
    execFile('ffmpeg', args, { timeout: 60000 }, (err) => {
      if (err) {
        console.warn('[video] FFmpeg failed:', err.message);
        resolve(null);
      } else {
        console.log('[video] Generated replay video:', outputPath);
        resolve(outputPath);
      }
    });
  });
}

// ── In-memory event emitters for SSE ────────────────────────────
const activeRunEmitters = new Map<string, EventEmitter>();
const activeAbortControllers = new Map<string, AbortController>();

export function getActiveRunEmitter(runId: string): EventEmitter | undefined {
  return activeRunEmitters.get(runId);
}

export function abortRun(runId: string): boolean {
  const controller = activeAbortControllers.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

export function abortSuite(suiteRunId: string): number {
  const db = getDb();
  const runs = db.prepare(
    'SELECT id FROM test_runs WHERE suite_run_id = ? AND status IN (?, ?)',
  ).all(suiteRunId, 'running', 'queued') as { id: string }[];
  let aborted = 0;
  for (const run of runs) {
    if (abortRun(run.id)) aborted++;
  }
  return aborted;
}

// ── Helpers ─────────────────────────────────────────────────────
function emitAndPersistEvent(
  runId: string,
  seq: number,
  type: string,
  message: string,
  detail?: string,
): RunEvent {
  const event: RunEvent = {
    id: uuid(),
    test_run_id: runId,
    sequence: seq,
    type,
    message,
    detail: detail ?? null,
    timestamp: new Date().toISOString(),
  };

  const db = getDb();
  db.prepare(
    `INSERT INTO run_events (id, test_run_id, sequence, type, message, detail, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.id, event.test_run_id, event.sequence, event.type, event.message, event.detail, event.timestamp);

  const emitter = activeRunEmitters.get(runId);
  if (emitter) emitter.emit('event', event);

  return event;
}

function persistScreenshot(screenshot: ScreenshotRecord) {
  const db = getDb();
  db.prepare(
    `INSERT INTO screenshots (id, test_run_id, turn_number, file_path, captured_at, page_url, page_title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    screenshot.id, screenshot.test_run_id, screenshot.turn_number,
    screenshot.file_path, screenshot.captured_at, screenshot.page_url, screenshot.page_title,
  );
}

// ── Run a single test ───────────────────────────────────────────
async function executeTestRun(testDef: TestDefinition, suiteRunId: string, headless = true): Promise<TestRun> {
  const runId = uuid();
  const db = getDb();
  const now = new Date().toISOString();

  // Create test_run record
  db.prepare(
    `INSERT INTO test_runs (id, suite_run_id, test_id, test_name, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`,
  ).run(runId, suiteRunId, testDef.id, testDef.name, now);

  // Set up SSE emitter and abort controller
  const emitter = new EventEmitter();
  activeRunEmitters.set(runId, emitter);
  const abortController = new AbortController();
  activeAbortControllers.set(runId, abortController);

  let seq = 0;
  emitAndPersistEvent(runId, ++seq, 'run_started', `Starting test: ${testDef.name}`);

  const screenshotDir = path.resolve(process.cwd(), 'data', 'screenshots', testDef.id, runId);
  let session;

  try {
    // Launch browser
    const viewport = testDef.viewport ?? { width: 1440, height: 900 };
    session = await launchBrowser(testDef.url, viewport, headless);

    emitAndPersistEvent(runId, ++seq, 'turn_completed', `Browser launched, navigated to ${testDef.url}`);

    // Load test account if this test requires authentication
    const testAccount = testDef.requires_auth ? getTestAccount() : undefined;
    if (testAccount) {
      emitAndPersistEvent(runId, ++seq, 'auth_info', `Test requires auth — using account: ${testAccount.email}`);
    }

    // Run the CUA loop
    const result = await runCUALoop(
      openai,
      session.page,
      testDef.instructions,
      testDef.expected_outcome,
      screenshotDir,
      runId,
      {
        onTurnStart: (turn) => {
          emitAndPersistEvent(runId, ++seq, 'turn_completed', `Turn ${turn} started — calling CUA model`);
        },
        onTurnComplete: (turn, apiLatencyMs, tokensSoFar) => {
          emitAndPersistEvent(runId, ++seq, 'turn_completed', `Turn ${turn} complete (API: ${apiLatencyMs}ms)`);
          // Update tokens and turn count live so the dashboard can poll them
          if (tokensSoFar) {
            db.prepare(
              `UPDATE test_runs SET turn_count = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ? WHERE id = ?`,
            ).run(turn, tokensSoFar.input, tokensSoFar.output, tokensSoFar.reasoning, runId);
          }
        },
        onActionsExecuted: (turn, actions) => {
          const summary = actions.map(a => a.type).join(', ');
          emitAndPersistEvent(runId, ++seq, 'actions_executed', `Turn ${turn}: executed [${summary}]`);
        },
        onTurnTokens: (turnTokens) => {
          db.prepare(
            `INSERT INTO turn_tokens (id, test_run_id, turn_number, input_tokens, output_tokens, reasoning_tokens, api_latency_ms, cumulative_input, cumulative_output, cumulative_reasoning, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            uuid(), runId, turnTokens.turn,
            turnTokens.input, turnTokens.output, turnTokens.reasoning,
            turnTokens.apiLatencyMs,
            turnTokens.cumulativeInput, turnTokens.cumulativeOutput, turnTokens.cumulativeReasoning,
            new Date().toISOString(),
          );
        },
        onScreenshot: (turn, screenshot) => {
          persistScreenshot(screenshot);
          emitAndPersistEvent(runId, ++seq, 'screenshot_captured', `Screenshot captured (turn ${turn})`);
        },
      },
      testAccount,
      abortController.signal,
      testDef.max_turns,
    );

    // Determine status
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(now).getTime();
    const status = result.verdict === 'PASS' ? 'passed'
      : result.verdict === 'FAIL' ? 'failed'
      : result.verdict === 'TIMEOUT' ? 'timeout'
      : 'error';

    // Update DB
    db.prepare(
      `UPDATE test_runs SET
        status = ?, completed_at = ?, duration_ms = ?,
        turn_count = ?, screenshot_count = ?,
        input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
        model_verdict = ?
      WHERE id = ?`,
    ).run(
      status, completedAt, durationMs,
      result.turns, result.turns + 1, // +1 for initial screenshot
      result.totalTokens.input, result.totalTokens.output, result.totalTokens.reasoning,
      result.modelMessage,
      runId,
    );

    emitAndPersistEvent(runId, ++seq, 'run_completed', `Test ${status}: ${result.verdict}`, result.modelMessage);

    // Generate replay video in background (non-blocking)
    generateReplayVideo(screenshotDir).then(videoPath => {
      if (videoPath) emitAndPersistEvent(runId, ++seq, 'video_ready', `Replay video generated`);
    });

    return db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId) as TestRun;
  } catch (err: any) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(now).getTime();

    db.prepare(
      `UPDATE test_runs SET status = 'error', completed_at = ?, duration_ms = ?, error = ? WHERE id = ?`,
    ).run(completedAt, durationMs, err.message ?? String(err), runId);

    emitAndPersistEvent(runId, ++seq, 'run_failed', `Test error: ${err.message}`);

    return db.prepare('SELECT * FROM test_runs WHERE id = ?').get(runId) as TestRun;
  } finally {
    if (session) await session.close();
    activeAbortControllers.delete(runId);
    // Clean up emitter after a delay to let SSE clients catch final events
    setTimeout(() => activeRunEmitters.delete(runId), 5000);
  }
}

// ── Public API ──────────────────────────────────────────────────
export async function runSingleTest(testId: string, headless = true): Promise<{ suiteRunId: string; testRunId: string }> {
  const testDef = loadTestById(testId);
  if (!testDef) throw new Error(`Test not found: ${testId}`);

  const db = getDb();
  const suiteRunId = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO suite_runs (id, started_at, total) VALUES (?, ?, 1)`,
  ).run(suiteRunId, now);

  // Run asynchronously (non-blocking)
  const runPromise = executeTestRun(testDef, suiteRunId, headless).then((run) => {
    const completedAt = new Date().toISOString();
    db.prepare(
      `UPDATE suite_runs SET completed_at = ?, passed = ?, failed = ?, errors = ?, timeouts = ?
       WHERE id = ?`,
    ).run(
      completedAt,
      run.status === 'passed' ? 1 : 0,
      run.status === 'failed' ? 1 : 0,
      run.status === 'error' ? 1 : 0,
      run.status === 'timeout' ? 1 : 0,
      suiteRunId,
    );
  });

  // Don't await — return immediately with IDs
  const testRunRow = db.prepare(
    `SELECT id FROM test_runs WHERE suite_run_id = ? AND test_id = ?`,
  ).get(suiteRunId, testId) as { id: string } | undefined;

  // If the row isn't created yet (race), wait a tiny bit
  if (!testRunRow) {
    await new Promise(r => setTimeout(r, 100));
  }

  const finalRow = db.prepare(
    `SELECT id FROM test_runs WHERE suite_run_id = ?`,
  ).get(suiteRunId) as { id: string } | undefined;

  return { suiteRunId, testRunId: finalRow?.id ?? 'pending' };
}

export async function runSuite(
  testIds?: string[],
  parallel = false,
  headless = true,
): Promise<{ suiteRunId: string }> {
  const allTests = loadAllTests();
  const tests = testIds
    ? allTests.filter(t => testIds.includes(t.id))
    : allTests;

  if (tests.length === 0) throw new Error('No tests to run');

  const db = getDb();
  const suiteRunId = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO suite_runs (id, started_at, total) VALUES (?, ?, ?)`,
  ).run(suiteRunId, now, tests.length);

  // Run tests (non-blocking)
  const executeAll = async () => {
    const results: TestRun[] = [];

    if (parallel) {
      const promises = tests.map(t => executeTestRun(t, suiteRunId, headless));
      results.push(...await Promise.all(promises));
    } else {
      for (const t of tests) {
        results.push(await executeTestRun(t, suiteRunId, headless));
      }
    }

    // Update suite summary
    const completedAt = new Date().toISOString();
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const errors = results.filter(r => r.status === 'error').length;
    const timeouts = results.filter(r => r.status === 'timeout').length;

    db.prepare(
      `UPDATE suite_runs SET completed_at = ?, passed = ?, failed = ?, errors = ?, timeouts = ?
       WHERE id = ?`,
    ).run(completedAt, passed, failed, errors, timeouts, suiteRunId);
  };

  // Fire and forget — don't block the API response
  executeAll().catch(err => console.error('[test-runner] Suite execution error:', err));

  return { suiteRunId };
}
