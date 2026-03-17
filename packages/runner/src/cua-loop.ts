import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { executeAction } from './actions.js';
import type { CUAResponse, ComputerAction, ScreenshotRecord, TestAccountConfig } from './types.js';

// ── Performance config ──────────────────────────────────────────
const INTER_ACTION_DELAY_MS = 120;
const DEFAULT_maxTurns = 40;
const ACTION_TIMEOUT_MS = 20_000;
const MODEL = 'gpt-5.4';

// ── System instructions ─────────────────────────────────────────
const SYSTEM_INSTRUCTIONS = `You are a UI usability testing agent. You are testing a live website by interacting with it through a browser.

Your job:
1. Follow the test instructions precisely
2. Interact with the page naturally (click, type, scroll, navigate)
3. Observe what happens after each action
4. When you are done, respond with a summary that includes:
   - What you tested
   - What worked correctly
   - Any issues found (broken links, missing elements, slow loads, confusing UX)
   - Your verdict: PASS or FAIL

Format your final message EXACTLY like this:
VERDICT: PASS or FAIL
SUMMARY: <brief summary of what was tested>
ISSUES: <list any issues found, or "None">`;

// ── Callbacks for live events ───────────────────────────────────
export interface TurnTokenUsage {
  turn: number;
  input: number;
  output: number;
  reasoning: number;
  apiLatencyMs: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeReasoning: number;
}

export interface CUALoopCallbacks {
  onTurnStart: (turn: number) => void;
  onTurnComplete: (turn: number, apiLatencyMs: number, tokensSoFar?: { input: number; output: number; reasoning: number }) => void;
  onTurnTokens: (turnTokens: TurnTokenUsage) => void;
  onActionsExecuted: (turn: number, actions: ComputerAction[]) => void;
  onScreenshot: (turn: number, screenshot: ScreenshotRecord) => void;
}

export interface CUALoopResult {
  verdict: 'PASS' | 'FAIL' | 'TIMEOUT' | 'UNKNOWN';
  modelMessage: string;
  turns: number;
  totalTokens: { input: number; output: number; reasoning: number };
}

// ── Small helpers ───────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function captureScreenshotBase64(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'png' });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function saveScreenshotToDisk(
  page: Page,
  dir: string,
  turn: number,
  runId: string,
): Promise<ScreenshotRecord> {
  await fs.mkdir(dir, { recursive: true });
  const filename = `${String(turn).padStart(3, '0')}-turn.png`;
  const filePath = path.join(dir, filename);
  await page.screenshot({ path: filePath });
  const pageTitle = await page.title().catch(() => undefined);

  return {
    id: uuid(),
    test_run_id: runId,
    turn_number: turn,
    file_path: filename,
    captured_at: new Date().toISOString(),
    page_url: page.url(),
    page_title: pageTitle ?? null,
  };
}

function extractMessage(response: CUAResponse): string {
  return (response.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => (item.content as Array<{ text?: string; type?: string }>) ?? [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text?.trim())
    .filter(Boolean)
    .join('\n\n');
}

function parseVerdict(message: string): 'PASS' | 'FAIL' | 'UNKNOWN' {
  const upper = message.toUpperCase();
  if (upper.includes('VERDICT: PASS') || upper.includes('VERDICT:PASS')) return 'PASS';
  if (upper.includes('VERDICT: FAIL') || upper.includes('VERDICT:FAIL')) return 'FAIL';
  return 'UNKNOWN';
}

// ── THE CORE CUA LOOP ───────────────────────────────────────────
export async function runCUALoop(
  openai: OpenAI,
  page: Page,
  testInstructions: string,
  expectedOutcome: string,
  screenshotDir: string,
  runId: string,
  callbacks: CUALoopCallbacks,
  testAccount?: TestAccountConfig,
  abortSignal?: AbortSignal,
  maxTurns: number = DEFAULT_maxTurns,
): Promise<CUALoopResult> {
  let previousResponseId: string | undefined;
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // Capture initial screenshot
  const initialScreenshot = await captureScreenshotBase64(page);
  const initialSaved = await saveScreenshotToDisk(page, screenshotDir, 0, runId);
  callbacks.onScreenshot(0, initialSaved);

  // Build first turn input
  let prompt = '';
  if (testAccount) {
    prompt += `TEST ACCOUNT CREDENTIALS (use these to log in when the test instructions require authentication):\nEmail: ${testAccount.email}\nPassword: ${testAccount.password}\n\n`;
  }
  prompt += `TEST INSTRUCTIONS:\n${testInstructions}\n\nEXPECTED OUTCOME:\n${expectedOutcome}`;
  let nextInput: unknown = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: initialScreenshot, detail: 'original' },
      ],
    },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Check if the run has been aborted
    if (abortSignal?.aborted) {
      return {
        verdict: 'FAIL',
        modelMessage: 'Test was manually aborted by user to save tokens.',
        turns: turn - 1,
        totalTokens,
      };
    }

    callbacks.onTurnStart(turn);

    // ── Call the CUA model ──────────────────────────────────────
    const apiStart = Date.now();
    let response: CUAResponse;
    try {
      response = await openai.responses.create({
        model: MODEL,
        instructions: SYSTEM_INSTRUCTIONS,
        input: nextInput as any,
        tools: [{ type: 'computer' as any }],
        reasoning: { effort: 'low' as any },
        parallel_tool_calls: false,
        truncation: 'auto',
        previous_response_id: previousResponseId,
      } as any) as unknown as CUAResponse;
    } catch (err: any) {
      // If aborted during API call, return gracefully
      if (abortSignal?.aborted) {
        return {
          verdict: 'FAIL',
          modelMessage: 'Test was manually aborted by user.',
          turns: turn - 1,
          totalTokens,
        };
      }
      throw err;
    }
    const apiLatency = Date.now() - apiStart;

    // Check abort after API call returns
    if (abortSignal?.aborted) {
      return {
        verdict: 'FAIL',
        modelMessage: 'Test was manually aborted by user.',
        turns: turn,
        totalTokens,
      };
    }

    // Per-turn token usage
    const turnInput = response.usage?.input_tokens ?? 0;
    const turnOutput = response.usage?.output_tokens ?? 0;
    const turnReasoning = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;

    // Accumulate tokens
    totalTokens.input += turnInput;
    totalTokens.output += turnOutput;
    totalTokens.reasoning += turnReasoning;

    // Validate
    if (response.error?.message) throw new Error(`CUA API error: ${response.error.message}`);
    if (response.status === 'failed') throw new Error('CUA API request failed');

    previousResponseId = response.id;
    callbacks.onTurnComplete(turn, apiLatency, { ...totalTokens });

    // Emit per-turn token breakdown
    callbacks.onTurnTokens({
      turn,
      input: turnInput,
      output: turnOutput,
      reasoning: turnReasoning,
      apiLatencyMs: apiLatency,
      cumulativeInput: totalTokens.input,
      cumulativeOutput: totalTokens.output,
      cumulativeReasoning: totalTokens.reasoning,
    });

    // ── Check for computer_call items ───────────────────────────
    const computerCalls = (response.output ?? []).filter(item => item.type === 'computer_call');

    if (computerCalls.length === 0) {
      // Model finished — extract verdict
      const message = extractMessage(response);
      const verdict = parseVerdict(message);
      return { verdict, modelMessage: message, turns: turn, totalTokens };
    }

    // ── Execute actions from each computer_call ─────────────────
    const toolOutputs: unknown[] = [];

    for (const call of computerCalls) {
      const actions = (call.actions ?? []) as ComputerAction[];

      // Safety check
      if (call.pending_safety_checks?.length) {
        throw new Error(`Safety check required: ${call.pending_safety_checks.map(c => c.message).join(', ')}`);
      }

      // Execute action batch with timeout
      try {
        await withTimeout(
          (async () => {
            for (const action of actions) {
              await executeAction(page, action);
              if (action.type !== 'wait' && action.type !== 'screenshot') {
                await delay(INTER_ACTION_DELAY_MS);
              }
            }
          })(),
          ACTION_TIMEOUT_MS,
          'Action batch',
        );
      } catch (err) {
        console.error(`[cua-loop] Action execution error (turn ${turn}):`, err);
        // Continue to screenshot — model can recover
      }

      callbacks.onActionsExecuted(turn, actions);

      // Capture screenshot after actions
      const screenshotDataUrl = await captureScreenshotBase64(page);
      const savedScreenshot = await saveScreenshotToDisk(page, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, savedScreenshot);

      toolOutputs.push({
        type: 'computer_call_output',
        call_id: call.call_id,
        output: {
          type: 'computer_screenshot',
          image_url: screenshotDataUrl,
        },
      });
    }

    nextInput = toolOutputs;
  }

  // Turn budget exhausted
  return {
    verdict: 'TIMEOUT',
    modelMessage: `Reached maximum turn limit (${maxTurns}) without completing the test.`,
    turns: maxTurns,
    totalTokens,
  };
}
