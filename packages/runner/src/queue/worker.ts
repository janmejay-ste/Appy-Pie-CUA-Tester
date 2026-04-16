import { Worker, Job } from 'bullmq';
import { execFile } from 'child_process';
import OpenAI from 'openai';
import path from 'path';
import { v4 as uuid } from 'uuid';
import IORedis from 'ioredis';
import { connectDb } from '../db/turso.js';
import { deadLetterQueue, testExecutionQueue, type TestJobData } from './queue.js';
import { runCUALoop } from '../cua-loop.js';
import { launchBrowser } from '../browser.js';
import { getTestAccount } from '../config.js';
import * as testService from '../services/test.service.js';
import * as sessionService from '../services/session.service.js';
import * as repo from '../db/repo.js';
import { getSettings, findStuckRuns, updateTestRun, findPreviousTimeoutRun } from '../db/repo.js';
import { logger } from '../logger.js';
import type { ScreenshotRecord, StepActionMeta } from '../types.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const openai = new OpenAI();

// Track abort controllers per running job
const activeAbortControllers = new Map<string, AbortController>();

// Redis publisher for SSE events
let publisher: IORedis;

function getPublisher(): IORedis {
  if (!publisher) {
    publisher = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return publisher;
}

// FFmpeg video generation (reused from old test-runner)
function generateReplayVideo(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const outputPath = path.join(dir, 'replay.mp4');
    const inputPattern = path.join(dir, '%03d-turn.png');
    const args = [
      '-y', '-framerate', '1', '-i', inputPattern,
      '-vf', 'scale=1280:-2', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-preset', 'fast', outputPath,
    ];
    execFile('ffmpeg', args, { timeout: 60000 }, (err) => {
      if (err) {
        logger.warn({ err: err.message }, '[video] FFmpeg failed');
        resolve(null);
      } else {
        logger.info({ outputPath }, '[video] Generated replay video');
        resolve(outputPath);
      }
    });
  });
}

// Copy old run's screenshots into new run's folder (renumbered) then generate one combined video
async function mergeScreenshotsAndGenerateVideo(
  oldScreenshotDir: string,
  newScreenshotDir: string,
): Promise<string | null> {
  const fsSync = require('fs') as typeof import('fs');
  const fsPromises = require('fs/promises') as typeof import('fs/promises');

  if (!fsSync.existsSync(oldScreenshotDir) || !fsSync.existsSync(newScreenshotDir)) {
    logger.warn('[video] Cannot merge — one or both screenshot dirs missing');
    return generateReplayVideo(newScreenshotDir);
  }

  try {
    // Get old screenshots sorted
    const oldFiles = fsSync.readdirSync(oldScreenshotDir)
      .filter((f: string) => f.endsWith('-turn.png'))
      .sort();

    // Get new screenshots sorted
    const newFiles = fsSync.readdirSync(newScreenshotDir)
      .filter((f: string) => f.endsWith('-turn.png'))
      .sort();

    // Create a temp merged directory inside the new run's folder
    const mergedDir = path.join(newScreenshotDir, '_merged');
    fsSync.mkdirSync(mergedDir, { recursive: true });

    // Copy old screenshots with sequential numbering
    let seq = 0;
    for (const f of oldFiles) {
      const dest = path.join(mergedDir, `${String(seq).padStart(3, '0')}-turn.png`);
      await fsPromises.copyFile(path.join(oldScreenshotDir, f), dest);
      seq++;
    }

    // Copy new screenshots continuing the sequence
    for (const f of newFiles) {
      const dest = path.join(mergedDir, `${String(seq).padStart(3, '0')}-turn.png`);
      await fsPromises.copyFile(path.join(newScreenshotDir, f), dest);
      seq++;
    }

    logger.info({ oldCount: oldFiles.length, newCount: newFiles.length, total: seq }, '[video] Merged screenshots');

    // Generate video from merged screenshots
    const videoPath = await generateReplayVideo(mergedDir);

    // Move the generated video to the new run's folder
    if (videoPath) {
      const finalPath = path.join(newScreenshotDir, 'replay.mp4');
      await fsPromises.copyFile(videoPath, finalPath);
      // Cleanup merged dir
      fsSync.rmSync(mergedDir, { recursive: true, force: true });
      return finalPath;
    }

    // Cleanup on failure
    fsSync.rmSync(mergedDir, { recursive: true, force: true });
    return null;
  } catch (err: any) {
    logger.warn({ err: err.message }, '[video] Screenshot merge failed');
    return generateReplayVideo(newScreenshotDir);
  }
}

// ── Helper: check token budget and abort if exceeded ────────────
async function checkTokenBudget(
  testRunId: string,
  tokensSoFar: { input: number; output: number; reasoning: number },
  abortController: AbortController,
  emitEvent: (type: string, message: string, detail?: string) => Promise<void>,
) {
  const totalUsed = tokensSoFar.input + tokensSoFar.output;
  const currentSettings = await getSettings();
  const budget = currentSettings.maxTokensPerSession;
  const usagePercent = Math.round((totalUsed / budget) * 100);

  if (totalUsed > budget) {
    logger.warn({ totalUsed, budget, testRunId }, '[worker] Token budget exceeded, aborting');
    emitEvent('run_failed', `Token budget exceeded (${totalUsed.toLocaleString()} / ${budget.toLocaleString()}). Aborting to save costs.`);
    abortController.abort();
  } else if (usagePercent >= 80 && usagePercent < 100) {
    emitEvent('turn_completed', `WARNING: Token usage at ${usagePercent}% (${totalUsed.toLocaleString()} / ${budget.toLocaleString()}). Approaching limit.`);
  }
}

// ── Helper: build step data from screenshot + action meta ───────
function buildStepData(
  testRunId: string,
  turn: number,
  screenshot: ScreenshotRecord,
  actionMeta?: StepActionMeta,
) {
  const base = {
    _id: screenshot.id,
    testRunId,
    turnNumber: turn,
    filePath: screenshot.file_path,
    capturedAt: new Date(screenshot.captured_at),
    pageUrl: screenshot.page_url,
    pageTitle: screenshot.page_title,
  };

  if (!actionMeta) return base;

  return {
    ...base,
    action: actionMeta.action,
    result: actionMeta.result,
    validation: actionMeta.validation,
    effective: actionMeta.effective,
    retryStrategy: actionMeta.retryStrategy,
    memory: actionMeta.memory,
    nextGoal: actionMeta.nextGoal,
    domFingerprint: actionMeta.domFingerprint,
    confidence: actionMeta.confidence,
    visionUsed: actionMeta.visionUsed,
  };
}

async function processTestJob(job: Job<TestJobData>) {
  const {
    sessionId, testRunId, testId, testName, headless,
    testInstructions, expectedOutcome, testUrl,
    requiresAuth, maxTurns, viewport,
    resumeFromUrl, resumeContext, resumeStorageStatePath,
    validation: validationRules,
  } = job.data;

  const pub = getPublisher();

  // Check if run was already aborted (e.g., by user while job was queued or stalled)
  const existingRun = await repo.getTestRun(testRunId);
  if (existingRun && (existingRun.status === 'aborted' || existingRun.status === 'passed' || existingRun.status === 'failed')) {
    logger.info({ testRunId, status: existingRun.status }, '[worker] Skipping job — run already completed/aborted');
    return; // Don't process — job is stale
  }

  // Mark running
  const startedAt = new Date();
  await testService.updateTestRunStatus(testRunId, {
    status: 'running',
    startedAt,
  });

  const abortController = new AbortController();
  activeAbortControllers.set(testRunId, abortController);

  // Listen for abort signals via Redis
  const abortSub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  await abortSub.subscribe(`abort:${testRunId}`);
  abortSub.once('message', () => {
    abortController.abort();
    abortSub.unsubscribe().then(() => abortSub.disconnect()).catch(() => {});
  });

  let seq = 0;
  const emitEvent = async (type: string, message: string, detail?: string) => {
    const eventId = uuid();
    const timestamp = new Date();
    await testService.persistEvent({
      _id: eventId,
      testRunId,
      sequence: ++seq,
      type,
      message,
      detail: detail ?? null,
      timestamp,
    });
    // Publish to Redis for SSE relay
    const eventPayload = {
      id: eventId,
      test_run_id: testRunId,
      sequence: seq,
      type,
      message,
      detail: detail ?? null,
      timestamp: timestamp.toISOString(),
    };
    await pub.publish(`events:${testRunId}`, JSON.stringify(eventPayload));
  };

  const screenshotDir = path.resolve(process.cwd(), 'data', 'screenshots', testId, testRunId);
  let session;

  try {
    const isResume = !!resumeContext;

    await emitEvent('run_started', isResume
      ? `Resuming test: ${testName} (continuing from previous timed-out run)`
      : `Starting test: ${testName}`);

    // Always start from the test URL — resumeFromUrl may require auth redirect
    const vp = viewport ?? { width: 1440, height: 900 };
    session = await launchBrowser(testUrl, vp, headless, isResume ? resumeStorageStatePath : undefined);
    await emitEvent('turn_completed', `Browser launched, navigated to ${testUrl}${isResume && resumeStorageStatePath ? ' (with restored auth state)' : ''}`);

    // Resume state validation — verify restored state actually worked
    if (isResume && resumeStorageStatePath) {
      const currentUrl = session.page.url();
      const currentTitle = await session.page.title().catch(() => '');
      const isLoginPage = currentUrl.includes('login') || currentUrl.includes('signin') ||
        currentTitle.toLowerCase().includes('log in') || currentTitle.toLowerCase().includes('sign in');

      if (isLoginPage) {
        await emitEvent('turn_completed', 'WARNING: Storage state restored but landed on login page — session may have expired. Will login with credentials.');
      } else {
        await emitEvent('turn_completed', `Resume validation OK: landed on "${currentTitle}" (${currentUrl})`);
      }
    }

    const testAccount = requiresAuth ? getTestAccount() : undefined;
    if (testAccount) {
      logger.info({ testRunId, email: testAccount.email }, '[worker] Credentials loaded for run');
      await emitEvent('auth_info', `Test requires auth — using account: ${testAccount.email}`);
    } else {
      logger.info({ testRunId, requiresAuth }, '[worker] No credentials for run');
    }

    // Build instructions — for resume, tell model to continue from where it stopped
    let finalInstructions = testInstructions;
    if (isResume && resumeContext) {
      finalInstructions = `CRITICAL RESUME INSTRUCTIONS:
This is a CONTINUATION of a previously timed-out test run. The previous run completed these steps before timing out:

${resumeContext}

YOUR TASK:
1. Look at the current page carefully:
   - If you see the page where the previous run stopped (e.g. a connect editor, form, or configuration page), do NOT navigate away — just continue from the exact step that was not completed
   - If you see a login page, log in quickly with the provided credentials and then navigate to where the previous run left off${resumeFromUrl ? ` (the page was: ${resumeFromUrl})` : ''}
   - If the previous work is already visible (e.g. trigger already configured, some fields already filled), do NOT redo it — skip to the incomplete part
2. Skip ALL steps that were already completed in the previous run
3. Start executing from the FIRST UNCOMPLETED step only
4. Do NOT repeat any work — do NOT re-create connects, re-select apps, or re-fill fields that are already configured
5. If you see an error message from the previous run (e.g. "Items is a required parameter"), fix that specific error by filling the missing field and retry

--- FULL TEST INSTRUCTIONS (for reference — skip completed steps) ---
${testInstructions}`;
    }

    // Pre-load settings once for token budget + CUA mode
    const settings = await getSettings();
    const tokenBudget = settings.maxTokensPerSession;
    const cuaMode = (job.data as any).cuaMode || settings.cuaMode || 'dom';

    const result = await runCUALoop(
      openai,
      session.page,
      finalInstructions,
      expectedOutcome,
      screenshotDir,
      testRunId,
      {
        onTurnStart: (turn) => {
          emitEvent('turn_completed', `Turn ${turn} started — calling CUA model`);
        },
        onTurnComplete: async (turn, apiLatencyMs, tokensSoFar) => {
          emitEvent('turn_completed', `Turn ${turn} complete (API: ${apiLatencyMs}ms)`);
          if (tokensSoFar) {
            testService.updateTestRunStatus(testRunId, {
              turnCount: turn,
              inputTokens: tokensSoFar.input,
              outputTokens: tokensSoFar.output,
              reasoningTokens: tokensSoFar.reasoning,
              lastHeartbeat: new Date(),
            });
            await checkTokenBudget(testRunId, tokensSoFar, abortController, emitEvent);
          }
        },
        onTurnTokens: (turnTokens) => {
          testService.updateStepTokens(testRunId, turnTokens.turn, {
            inputTokens: turnTokens.input,
            outputTokens: turnTokens.output,
            reasoningTokens: turnTokens.reasoning,
            apiLatencyMs: turnTokens.apiLatencyMs,
            cumulativeInput: turnTokens.cumulativeInput,
            cumulativeOutput: turnTokens.cumulativeOutput,
            cumulativeReasoning: turnTokens.cumulativeReasoning,
            mode: turnTokens.mode || 'dom',
          });
        },
        onActionsExecuted: (turn, actions) => {
          const summary = actions.map(a => a.type).join(', ');
          emitEvent('actions_executed', `Turn ${turn}: executed [${summary}]`);
        },
        onScreenshot: (turn, screenshot, actionMeta) => {
          testService.persistStep(buildStepData(testRunId, turn, screenshot, actionMeta));
          emitEvent('screenshot_captured', `Screenshot captured (turn ${turn})`);
        },
      },
      testAccount,
      abortController.signal,
      maxTurns,
      tokenBudget,
      testUrl,
      cuaMode,
      validationRules as any,
    );

    // Determine final status
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const wasAborted = abortController.signal.aborted;
    const status = wasAborted ? 'aborted'
      : result.verdict === 'PASS' ? 'passed'
      : result.verdict === 'FAIL' ? 'failed'
      : result.verdict === 'TIMEOUT' ? 'timeout'
      : 'error';

    await testService.updateTestRunStatus(testRunId, {
      status,
      completedAt,
      durationMs,
      turnCount: result.turns,
      screenshotCount: result.turns + 1,
      inputTokens: result.totalTokens.input,
      outputTokens: result.totalTokens.output,
      reasoningTokens: result.totalTokens.reasoning,
      modelVerdict: result.modelMessage,
      ...(result.pageState ? { pageState: result.pageState } : {}),
    });

    await emitEvent('run_completed', `Test ${status}: ${result.verdict}`, result.modelMessage);

    // Generate run log in background
    void (async () => {
      try {
        const { generateRunLog } = await import('../services/runlog.service.js');
        const logPath = await generateRunLog(testRunId, testId);
        if (logPath) await emitEvent('log_generated', `Run log generated: ${logPath}`);
      } catch (err: any) {
        logger.warn({ err: err.message }, '[worker] Log generation failed');
      }
    })();

    // Generate replay video in background
    void (async () => {
      try {
        // If resume run, merge old + new screenshots into one video
        if (isResume) {
          const prevRun = await findPreviousTimeoutRun(testId, testRunId);

          if (prevRun) {
            const prevRunId = prevRun.id;
            const oldScreenshotDir = path.resolve(process.cwd(), 'data', 'screenshots', testId, prevRunId);
            const merged = await mergeScreenshotsAndGenerateVideo(oldScreenshotDir, screenshotDir);
            if (merged) {
              await emitEvent('video_ready', 'Merged replay video generated (old + new screenshots)');
              return;
            }
          }
        }
        // Normal video generation (no resume)
        const videoPath = await generateReplayVideo(screenshotDir);
        if (videoPath) await emitEvent('video_ready', 'Replay video generated');
      } catch (err: any) {
        logger.warn({ err: err.message }, '[video] Video generation error');
      }
    })();

  } catch (err: any) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const errorMsg = err.message ?? String(err);

    // ── Handle abort separately — NEVER retry aborted runs ──
    if (abortController.signal.aborted) {
      logger.info({ testRunId }, '[worker] Run was aborted by user');
      await testService.updateTestRunStatus(testRunId, {
        status: 'aborted',
        completedAt,
        durationMs,
        error: 'Aborted by user',
      });
      await emitEvent('run_failed', 'Test aborted by user');
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError('Aborted by user');
    }

    // Classify the error — comprehensive infra detection
    const INFRA_PATTERNS = [
      'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',  // network
      'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',                // DNS/routing
      'net::', 'ERR_CONNECTION', 'ERR_NAME_NOT_RESOLVED',         // Chromium network
      'SSL', 'TLS', 'certificate',                                 // TLS errors
      'Target closed', 'Target crashed', 'Session closed',        // browser crash
      'Browser closed', 'browser has been closed',                 // Playwright crash
      'Navigation timeout', 'Timeout exceeded',                    // Playwright timeout
      'page.goto: net::', 'frame was detached',                    // page-level crashes
      'Protocol error', 'WebSocket',                               // CDP protocol errors
      'ENOMEM', 'spawn', 'ENOENT',                                // system resource errors
    ];
    const isInfraError = INFRA_PATTERNS.some(p => errorMsg.includes(p));

    const isTestFail = errorMsg.includes('CUA API error') ||
      errorMsg.includes('Safety check') ||
      errorMsg.includes('aborted') ||
      errorMsg.includes('Token budget exceeded');

    await testService.updateTestRunStatus(testRunId, {
      status: 'error',
      completedAt,
      durationMs,
      error: errorMsg,
    });

    await emitEvent('run_failed', `Test error (${isInfraError ? 'infra' : isTestFail ? 'test' : 'unknown'}): ${errorMsg}`);

    // Generate run log for failed runs too
    void (async () => {
      try {
        const { generateRunLog } = await import('../services/runlog.service.js');
        await generateRunLog(testRunId, testId);
      } catch {}
    })();

    // Only allow BullMQ retry for infra errors — skip retry for test failures
    if (!isInfraError) {
      // Throw UnrecoverableError to prevent BullMQ from retrying
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError(`Test failure (no retry): ${errorMsg}`);
    }

    // Re-throw for infra errors so BullMQ retries
    throw err;
  } finally {
    if (session) await session.close();
    activeAbortControllers.delete(testRunId);
    abortSub.unsubscribe().catch(() => {});
    abortSub.disconnect();

    // Update session stats
    await sessionService.updateSessionStats(sessionId);
  }
}

// Recover stuck runs on startup (runs left in 'running' state from a crash)
// Uses heartbeat: if lastHeartbeat is older than 5 minutes, it's dead
async function recoverStuckRuns() {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  // Find runs that are 'running' AND either have no heartbeat or stale heartbeat
  const stuckRuns = await findStuckRuns(fiveMinAgo);

  if (stuckRuns.length === 0) return;

  logger.info({ count: stuckRuns.length }, '[worker] Recovering stuck run(s) (no heartbeat for 5+ min)');
  for (const run of stuckRuns) {
    await updateTestRun(run.id, {
      status: 'error',
      completed_at: new Date().toISOString(),
      error: 'Process crashed or stalled during execution (no heartbeat). Recovered on restart.',
    });
    await sessionService.updateSessionStats(run.suite_run_id);
  }
  logger.info({ count: stuckRuns.length }, '[worker] Recovered stuck run(s)');
}

export async function startWorker() {
  await connectDb();

  // Recover any runs stuck in 'running' from a previous crash
  await recoverStuckRuns();

  // Clean stale failed jobs from queue on startup
  try {
    const failedJobs = await testExecutionQueue.getJobs(['failed']);
    if (failedJobs.length > 0) {
      for (const job of failedJobs) await job.remove();
      logger.info({ count: failedJobs.length }, '[worker] Cleaned stale failed job(s) from queue');
    }
  } catch {}

  const redisUrl = new URL(REDIS_URL);
  const worker = new Worker('test-execution', processTestJob, {
    connection: { host: redisUrl.hostname, port: parseInt(redisUrl.port || '6379', 10), maxRetriesPerRequest: null },
    concurrency: 2,
  });

  // On final failure (all retries exhausted) → send to DLQ
  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, attempt: job?.attemptsMade, maxAttempts: job?.opts?.attempts, err: err.message }, '[worker] Job failed');

    // If all retries exhausted, move to Dead Letter Queue
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
      logger.warn({ jobId: job.id, attempts: job.attemptsMade }, '[worker] Moving job to DLQ');
      await deadLetterQueue.add('failed-test', {
        ...job.data,
        failedAt: new Date().toISOString(),
        error: err.message,
        attempts: job.attemptsMade,
      });
    }
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, '[worker] Job completed');
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, '[worker] Worker error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, '[worker] Job stalled — will be retried by BullMQ');
  });

  logger.info('[worker] Test execution worker started (concurrency: 2, retries: 2, DLQ: enabled)');
  return worker;
}

// Export for abort handling from API
export function abortTestRun(testRunId: string) {
  const controller = activeAbortControllers.get(testRunId);
  if (controller) {
    logger.info({ testRunId }, '[worker] Aborting run (local controller found)');
    controller.abort();
    return true;
  }
  // If not in this process, publish abort via Redis
  logger.info({ testRunId }, '[worker] Aborting run (publishing via Redis)');
  getPublisher().publish(`abort:${testRunId}`, '1');
  return true;
}
