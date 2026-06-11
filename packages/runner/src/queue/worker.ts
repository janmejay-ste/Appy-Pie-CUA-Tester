import { Worker, Job } from 'bullmq';
import { execFile } from 'child_process';
import OpenAI from 'openai';
import path from 'path';
import { v4 as uuid } from 'uuid';
import IORedis from 'ioredis';
import { connectSQLite } from '../db/sqlite.js';
import { deadLetterQueue, testExecutionQueue, type TestJobData } from './queue.js';
import { runCUALoop } from '../cua-loop.js';
import { launchBrowser } from '../browser.js';
import { getTestAccount } from '../config.js';
import * as testService from '../services/test.service.js';
import * as sessionService from '../services/session.service.js';

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
        console.warn('[video] FFmpeg failed:', err.message);
        resolve(null);
      } else {
        console.log('[video] Generated replay video:', outputPath);
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
    console.warn('[video] Cannot merge — one or both screenshot dirs missing');
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

    console.log(`[video] Merged ${oldFiles.length} old + ${newFiles.length} new screenshots (${seq} total)`);

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
    console.warn('[video] Screenshot merge failed:', err.message);
    return generateReplayVideo(newScreenshotDir);
  }
}

async function processTestJob(job: Job<TestJobData>) {
  const {
    sessionId, testRunId, testId, testName, headless,
    testInstructions, expectedOutcome, testUrl,
    requiresAuth, maxTurns, viewport,
    resumeFromUrl, resumeContext, resumeStorageStatePath,
  } = job.data;

  const pub = getPublisher();

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
  abortSub.on('message', () => {
    abortController.abort();
    abortSub.unsubscribe().then(() => abortSub.disconnect());
  });

  let seq = 0;
  const emitEvent = async (type: string, message: string, detail?: string) => {
    const event = await testService.persistEvent({
      _id: uuid(),
      testRunId,
      sequence: ++seq,
      type,
      message,
      detail: detail ?? null,
      timestamp: new Date(),
    });
    // Publish to Redis for SSE relay
    await pub.publish(`events:${testRunId}`, JSON.stringify(event.toJSON()));
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
      console.log(`[worker] Credentials loaded for run ${testRunId}: email=${testAccount.email}, password=${'*'.repeat(testAccount.password.length - 2) + testAccount.password.slice(-2)}`);
      await emitEvent('auth_info', `Test requires auth — using account: ${testAccount.email}`);
    } else {
      console.log(`[worker] No credentials for run ${testRunId} (requiresAuth=${requiresAuth})`);
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

            // Token budget enforcement with early warning
            const totalUsed = tokensSoFar.input + tokensSoFar.output;
            const { getSettings: getSettingsNow } = await import('../db/models/Settings.js');
            const currentSettings = await getSettingsNow();
            const budget = currentSettings.maxTokensPerSession;
            const usagePercent = Math.round((totalUsed / budget) * 100);

            if (totalUsed > budget) {
              console.warn(`[worker] Token budget exceeded: ${totalUsed} > ${budget}. Aborting.`);
              emitEvent('run_failed', `Token budget exceeded (${totalUsed.toLocaleString()} / ${budget.toLocaleString()}). Aborting to save costs.`);
              abortController.abort();
            } else if (usagePercent >= 80 && usagePercent < 100) {
              emitEvent('turn_completed', `WARNING: Token usage at ${usagePercent}% (${totalUsed.toLocaleString()} / ${budget.toLocaleString()}). Approaching limit.`);
            }
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
          testService.persistStep({
            _id: screenshot.id,
            testRunId,
            turnNumber: turn,
            filePath: screenshot.file_path,
            capturedAt: new Date(screenshot.captured_at),
            pageUrl: screenshot.page_url,
            pageTitle: screenshot.page_title,
            // Action metadata from CUA loop
            ...(actionMeta ? {
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
            } : {}),
          });
          emitEvent('screenshot_captured', `Screenshot captured (turn ${turn})`);
        },
      },
      testAccount,
      abortController.signal,
      maxTurns,
      (await (await import('../db/models/Settings.js')).getSettings()).maxTokensPerSession,
      testUrl,
      (job.data as any).cuaMode || (await (await import('../db/models/Settings.js')).getSettings()).cuaMode || 'dom',
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

    // Generate replay video in background
    (async () => {
      try {
        // If resume run, merge old + new screenshots into one video
        if (isResume) {
          const { TestRun: TestRunModel } = await import('../db/models/TestRun.js');
          const prevRuns = await TestRunModel.find({
            testId,
            status: 'timeout',
            _id: { $ne: testRunId },
          }).sort({ completedAt: -1 }).limit(1).lean();

          if (prevRuns.length > 0) {
            const prevRunId = prevRuns[0]._id;
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
        console.warn('[video] Video generation error:', err.message);
      }
    })();

  } catch (err: any) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const errorMsg = err.message ?? String(err);

    // ── Handle abort separately — NEVER retry aborted runs ──
    if (abortController.signal.aborted) {
      console.log(`[worker] Run ${testRunId} was aborted by user`);
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
  const { TestRun } = await import('../db/models/TestRun.js');
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  // Find runs that are 'running' AND either have no heartbeat or stale heartbeat
  const stuckRuns = await TestRun.find({
    status: 'running',
    $or: [
      { lastHeartbeat: null },
      { lastHeartbeat: { $lt: fiveMinAgo } },
    ],
  });

  if (stuckRuns.length === 0) return;

  console.log(`[worker] Recovering ${stuckRuns.length} stuck run(s) (no heartbeat for 5+ min)`);
  for (const run of stuckRuns) {
    await TestRun.updateOne({ _id: run._id }, {
      $set: {
        status: 'error',
        completedAt: new Date(),
        error: 'Process crashed or stalled during execution (no heartbeat). Recovered on restart.',
      },
    });
    await sessionService.updateSessionStats(run.sessionId);
  }
  console.log(`[worker] Recovered ${stuckRuns.length} stuck run(s)`);
}

export async function startWorker() {
  await connectSQLite();

  // Recover any runs stuck in 'running' from a previous crash
  await recoverStuckRuns();

  // Clean stale failed jobs from queue on startup
  try {
    const failedJobs = await testExecutionQueue.getJobs(['failed']);
    if (failedJobs.length > 0) {
      for (const job of failedJobs) await job.remove();
      console.log(`[worker] Cleaned ${failedJobs.length} stale failed job(s) from queue`);
    }
  } catch {}

  const worker = new Worker('test-execution', processTestJob, {
    connection: { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null },
    concurrency: 2,
  });

  // On final failure (all retries exhausted) → send to DLQ
  worker.on('failed', async (job, err) => {
    console.error(`[worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}):`, err.message);

    // If all retries exhausted, move to Dead Letter Queue
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
      console.warn(`[worker] Moving job ${job.id} to DLQ after ${job.attemptsMade} attempts`);
      await deadLetterQueue.add('failed-test', {
        ...job.data,
        failedAt: new Date().toISOString(),
        error: err.message,
        attempts: job.attemptsMade,
      });
    }
  });

  worker.on('completed', (job) => {
    console.log(`[worker] Job ${job.id} completed`);
  });

  worker.on('error', (err) => {
    console.error('[worker] Worker error:', err.message);
  });

  console.log('[worker] Test execution worker started (concurrency: 2, retries: 2, DLQ: enabled)');
  return worker;
}

// Export for abort handling from API
export function abortTestRun(testRunId: string) {
  const controller = activeAbortControllers.get(testRunId);
  if (controller) {
    console.log(`[worker] Aborting run ${testRunId} (local controller found)`);
    controller.abort();
    return true;
  }
  // If not in this process, publish abort via Redis
  console.log(`[worker] Aborting run ${testRunId} (publishing via Redis)`);
  getPublisher().publish(`abort:${testRunId}`, '1');
  return true;
}
