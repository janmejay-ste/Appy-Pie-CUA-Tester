import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { executeModelAction } from './actions.js';
import { extractPageState, formatPageStateForModel, buildElementMap, getDOMFingerprint } from './dom-extractor.js';
import type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState, ModelAction, StructuredMemory, ScreenshotRecord, TestAccountConfig } from './types.js';

// Re-export for backward compatibility
export type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState };

// ── Config ──────────────────────────────────────────────────────
const MODEL = 'gpt-5.4';
const DEFAULT_MAX_TURNS = 40;
const MAX_RETRIES_PER_TURN = 2;

// ── System prompt (compact, strict) ─────────────────────────────
const DOM_SYSTEM_PROMPT = `You are a UI testing agent. You interact with web pages through structured DOM element IDs.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "action": "click|type|scroll|select|wait|navigate|keypress|done",
  "target": "e1",
  "value": "",
  "reason": "short reason",
  "confidence": 0.9,
  "stepsCompleted": ["step1", "step2"]
}

Rules:
- ONLY use element IDs from the provided list (e1, e2...)
- Fill ALL required form fields before clicking submit
- If an action fails, try a DIFFERENT approach — never repeat the same failed action
- Prioritize visible, interactable elements over guessing
- If you see "Advanced Mode" or "Advanced Mapping" button, click it first to reveal hidden fields
- When filling forms, scroll down to check for more fields before submitting
- If you cannot find the right element, set confidence below 0.4
- When the test is complete, use action "done" with verdict, summary, and issuesFound

For "done" action:
{
  "action": "done",
  "reason": "test completed",
  "confidence": 1.0,
  "verdict": "PASS or FAIL",
  "summary": "what was tested and results",
  "stepsCompleted": ["step1", "step2"],
  "issuesFound": ["issue1"] or []
}`;

// ── Helpers ─────────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshotToDisk(
  page: Page, dir: string, turn: number, runId: string,
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

async function captureJPEGBase64(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

function parseModelJSON(text: string): ModelAction | null {
  // Try to extract JSON from response (model may add markdown fences)
  let clean = text.trim();
  // Strip markdown code fences
  const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) clean = jsonMatch[1].trim();
  // Strip leading/trailing non-JSON chars
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.action === 'string') return parsed as ModelAction;
    return null;
  } catch {
    return null;
  }
}

function extractResponseText(response: any): string {
  // Handle both chat completions and responses API formats
  if (response.output) {
    return (response.output ?? [])
      .filter((item: any) => item.type === 'message')
      .flatMap((item: any) => (item.content ?? []))
      .filter((part: any) => part.type === 'output_text')
      .map((part: any) => part.text?.trim())
      .filter(Boolean)
      .join('\n');
  }
  if (response.choices?.[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  return '';
}

// ── Vision mode import (lazy) ───────────────────────────────────
let visionLoop: typeof runCUALoopDOM | null = null;
async function getVisionLoop() {
  if (!visionLoop) {
    const mod = await import('./cua-loop-vision.js');
    visionLoop = mod.runCUALoop as any;
  }
  return visionLoop!;
}

// ── Main export: mode dispatch ──────────────────────────────────
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
  maxTurns: number = DEFAULT_MAX_TURNS,
  tokenBudget: number = 200000,
  testUrl?: string,
  mode: 'dom' | 'vision' = 'dom',
): Promise<CUALoopResult> {
  if (mode === 'vision') {
    const visionFn = await getVisionLoop();
    return visionFn(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl);
  }
  return runCUALoopDOM(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl);
}

// ── DOM-First CUA Loop ──────────────────────────────────────────
async function runCUALoopDOM(
  openai: OpenAI,
  page: Page,
  testInstructions: string,
  expectedOutcome: string,
  screenshotDir: string,
  runId: string,
  callbacks: CUALoopCallbacks,
  testAccount?: TestAccountConfig,
  abortSignal?: AbortSignal,
  maxTurns: number = DEFAULT_MAX_TURNS,
  tokenBudget: number = 200000,
  testUrl?: string,
): Promise<CUALoopResult> {
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // Adaptive vision budget
  const VISION_BUDGET = Math.min(3, Math.ceil(maxTurns * 0.2));
  const LOW_CONFIDENCE = 0.4;
  const STUCK_DOM_THRESHOLD = 2;

  let visionTurnsUsed = 0;
  let useVisionNextTurn = false;
  let lastDOMFingerprint = '';
  let consecutiveSameDOM = 0;
  let lastActionSig = '';
  let consecutiveSameAction = 0;
  let consecutiveFailures = 0;

  // State (overwritten each turn, NOT accumulated)
  let structuredMemory: StructuredMemory = { page: '', filled: [], pending: [], errors: [] };
  let stepsCompleted: string[] = [];
  let lastActionResult = 'none';

  // URL watchdog
  const allowedDomains: string[] = ['appypie.com', 'appypieautomate.ai', 'connectcloud.appypie.com'];
  if (testUrl) {
    try { allowedDomains.push(new URL(testUrl).hostname); } catch { /* ignore */ }
  }
  const isUrlAllowed = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname;
      return allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    } catch { return true; }
  };

  const EXTERNAL_TRAPS = ['login.live.com', 'accounts.google.com', 'github.com', 'facebook.com'];
  const isExternalTrap = (url: string): boolean => {
    try { return EXTERNAL_TRAPS.some(d => new URL(url).hostname.includes(d)); } catch { return false; }
  };

  // Credential security
  const credentialDomains = new Set(allowedDomains);

  // Multi-tab handling
  let activePage = page;
  const context = page.context();
  context.on('page', (newPage) => {
    console.log(`[cua-dom] New tab opened: ${newPage.url()}`);
    activePage = newPage;
    newPage.on('close', () => { activePage = page; });
  });

  // Network error tracking
  const networkErrors: string[] = [];
  activePage.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      networkErrors.push(`${res.status()} ${res.url().slice(0, 60)}`);
      if (networkErrors.length > 10) networkErrors.shift();
    }
  });

  // ── Save initial screenshot (replay only) ─────────────────────
  const initialSaved = await saveScreenshotToDisk(activePage, screenshotDir, 0, runId);
  callbacks.onScreenshot(0, initialSaved);

  // ── Extract initial DOM ───────────────────────────────────────
  let domState = await extractPageState(activePage);
  let elementMap = buildElementMap(domState);

  // Check if DOM has too few elements → start with vision
  if (domState.elements.length < 5) {
    console.log(`[cua-dom] Few DOM elements (${domState.elements.length}), starting with vision fallback`);
    useVisionNextTurn = true;
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (abortSignal?.aborted) {
      return { verdict: 'FAIL', modelMessage: 'Test was aborted (token budget exceeded or manual stop).', turns: turn - 1, totalTokens };
    }

    callbacks.onTurnStart(turn);

    // ── Build prompt (self-contained, no history) ───────────────
    const promptParts: string[] = [];

    // Credentials
    if (testAccount) {
      const currentHost = (() => { try { return new URL(activePage.url()).hostname; } catch { return ''; } })();
      if (credentialDomains.has(currentHost) || allowedDomains.some(d => currentHost.endsWith(d))) {
        promptParts.push(`CREDENTIALS: email=${testAccount.email} password=${testAccount.password}`);
      }
    }

    promptParts.push(`GOAL: ${testInstructions}`);
    promptParts.push(`EXPECTED OUTCOME: ${expectedOutcome}`);
    promptParts.push('');
    promptParts.push('CURRENT PAGE STATE:');
    promptParts.push(formatPageStateForModel(domState));
    promptParts.push('');
    promptParts.push(`LAST ACTION: ${lastActionResult}`);
    promptParts.push(`PROGRESS: ${stepsCompleted.length > 0 ? stepsCompleted.join(', ') : 'None yet'}`);
    promptParts.push(`STATE: page="${structuredMemory.page}" filled=[${structuredMemory.filled.join(',')}] pending=[${structuredMemory.pending.join(',')}] errors=[${structuredMemory.errors.join(',')}]`);
    promptParts.push(`TURN: ${turn}/${maxTurns}`);

    if (networkErrors.length > 0) {
      promptParts.push(`NETWORK ERRORS: ${networkErrors.slice(-3).join(' | ')}`);
    }

    // Build input content
    const content: any[] = [{ type: 'input_text', text: promptParts.join('\n') }];

    // Vision fallback: attach JPEG screenshot
    if (useVisionNextTurn && visionTurnsUsed < VISION_BUDGET) {
      try {
        const jpegData = await captureJPEGBase64(activePage);
        content.push({ type: 'input_image', image_url: jpegData });
        content.push({ type: 'input_text', text: '\nScreenshot attached because previous actions had no effect. Use BOTH the DOM listing AND the visual screenshot.' });
        visionTurnsUsed++;
        console.log(`[cua-dom] Vision fallback turn (${visionTurnsUsed}/${VISION_BUDGET})`);
      } catch { /* screenshot failed, continue DOM only */ }
      useVisionNextTurn = false;
    }

    // ── Call the model ──────────────────────────────────────────
    const apiStart = Date.now();
    let responseText = '';
    let turnInput = 0;
    let turnOutput = 0;
    let turnReasoning = 0;

    try {
      const response = await openai.responses.create({
        model: MODEL,
        instructions: DOM_SYSTEM_PROMPT,
        input: [{ role: 'user', content }],
        reasoning: { effort: 'low' as any },
      } as any) as any;

      turnInput = response.usage?.input_tokens ?? 0;
      turnOutput = response.usage?.output_tokens ?? 0;
      turnReasoning = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;

      totalTokens.input += turnInput;
      totalTokens.output += turnOutput;
      totalTokens.reasoning += turnReasoning;

      responseText = extractResponseText(response);
    } catch (err: any) {
      if (abortSignal?.aborted) {
        return { verdict: 'FAIL', modelMessage: 'Test was manually aborted.', turns: turn, totalTokens };
      }
      throw err;
    }
    const apiLatency = Date.now() - apiStart;

    callbacks.onTurnComplete(turn, apiLatency, { ...totalTokens });
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

    // ── Parse model response ────────────────────────────────────
    let action: ModelAction | null = parseModelJSON(responseText);

    // Retry on invalid JSON
    if (!action) {
      for (let retry = 0; retry < MAX_RETRIES_PER_TURN; retry++) {
        console.warn(`[cua-dom] Invalid JSON (retry ${retry + 1}), asking model to fix`);
        try {
          const retryResponse = await openai.responses.create({
            model: MODEL,
            instructions: DOM_SYSTEM_PROMPT,
            input: [{
              role: 'user',
              content: [{ type: 'input_text', text: `Your last response was not valid JSON. Here it was:\n${responseText.slice(0, 500)}\n\nRespond with ONLY valid JSON matching the required format. No markdown, no explanation.` }],
            }],
            reasoning: { effort: 'low' as any },
          } as any) as any;

          const retryInput = retryResponse.usage?.input_tokens ?? 0;
          const retryOutput = retryResponse.usage?.output_tokens ?? 0;
          totalTokens.input += retryInput;
          totalTokens.output += retryOutput;

          const retryText = extractResponseText(retryResponse);
          action = parseModelJSON(retryText);
          if (action) break;
        } catch { /* retry failed */ }
      }

      if (!action) {
        // Give up on this turn — treat as wait
        console.error('[cua-dom] Could not parse model response after retries');
        lastActionResult = 'parse_error: model returned invalid JSON';
        consecutiveFailures++;
        // Save screenshot and continue
        const saved = await saveScreenshotToDisk(activePage, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: 'wait' }]);
        continue;
      }
    }

    // Validate action
    const validActions = ['click', 'type', 'scroll', 'select', 'wait', 'navigate', 'keypress', 'done'];
    if (!validActions.includes(action.action)) {
      console.warn(`[cua-dom] Invalid action type: ${action.action}`);
      lastActionResult = `invalid_action: "${action.action}" not recognized`;
      consecutiveFailures++;
      const saved = await saveScreenshotToDisk(activePage, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: action.action }]);
      continue;
    }

    // ── Handle "done" action ────────────────────────────────────
    if (action.action === 'done') {
      // Save final screenshot
      const saved = await saveScreenshotToDisk(activePage, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: 'done' }]);

      const verdict = action.verdict === 'PASS' ? 'PASS' : 'FAIL';
      // Goal validation: if PASS but issues found, override to FAIL
      const finalVerdict = (verdict === 'PASS' && action.issuesFound && action.issuesFound.length > 0) ? 'FAIL' : verdict;

      const message = [
        `VERDICT: ${finalVerdict}`,
        `SUMMARY: ${action.summary || action.reason}`,
        `STEPS_COMPLETED: ${(action.stepsCompleted || stepsCompleted).join(', ')}`,
        `ISSUES: ${action.issuesFound?.join(', ') || 'None'}`,
      ].join('\n');

      return { verdict: finalVerdict as any, modelMessage: message, turns: turn, totalTokens };
    }

    // ── Credential security ─────────────────────────────────────
    if (action.action === 'type' && testAccount) {
      const currentHost = (() => { try { return new URL(activePage.url()).hostname; } catch { return ''; } })();
      const isKnown = allowedDomains.some(d => currentHost === d || currentHost.endsWith('.' + d));
      if (!isKnown && (action.value === testAccount.password || action.value === testAccount.email)) {
        console.warn(`[cua-dom] BLOCKED: credential typing on unknown domain ${currentHost}`);
        lastActionResult = `BLOCKED: credential input on unknown domain ${currentHost}`;
        const saved = await saveScreenshotToDisk(activePage, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: 'type' }]);
        continue;
      }
    }

    // ── Action repeat detection ─────────────────────────────────
    const actionSig = `${action.action}:${action.target}:${action.value?.slice(0, 20) ?? ''}`;
    if (actionSig === lastActionSig) {
      consecutiveSameAction++;
      if (consecutiveSameAction >= 5) {
        console.warn(`[cua-dom] Action loop detected (${consecutiveSameAction} repeats). Aborting.`);
        return {
          verdict: 'FAIL',
          modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — repeated same action ${consecutiveSameAction} times.\nISSUES: Infinite loop on: ${action.action} ${action.target} at ${activePage.url()}`,
          turns: turn,
          totalTokens,
        };
      }
    } else {
      lastActionSig = actionSig;
      consecutiveSameAction = 0;
    }

    // ── Execute action ──────────────────────────────────────────
    const result = await executeModelAction(activePage, action, elementMap);
    callbacks.onActionsExecuted(turn, [{ type: action.action, ...action }]);

    if (result.success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      console.warn(`[cua-dom] Action failed: ${result.error}`);
    }

    lastActionResult = result.description;
    await delay(150); // small delay for page to settle

    // ── URL watchdog ────────────────────────────────────────────
    const currentUrl = activePage.url();
    if (isExternalTrap(currentUrl)) {
      console.warn(`[cua-dom] External trap: ${currentUrl}. Navigating back.`);
      try { await activePage.goto(testUrl || 'about:blank', { waitUntil: 'load', timeout: 10000 }); } catch { /* ignore */ }
    } else if (!isUrlAllowed(currentUrl) && testUrl) {
      console.warn(`[cua-dom] Off-domain: ${currentUrl}. Navigating back.`);
      try { await activePage.goto(testUrl, { waitUntil: 'load', timeout: 10000 }); } catch { /* ignore */ }
    }

    // ── Save screenshot to disk (replay video only, NOT sent to model) ──
    const saved = await saveScreenshotToDisk(activePage, screenshotDir, turn, runId);
    callbacks.onScreenshot(turn, saved);

    // ── Re-extract DOM ──────────────────────────────────────────
    try {
      domState = await extractPageState(activePage);
      elementMap = buildElementMap(domState);
    } catch (err) {
      console.error('[cua-dom] DOM extraction failed:', (err as Error).message);
      // Page may have crashed
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — page became unresponsive.\nISSUES: DOM extraction failed: ${(err as Error).message}`,
        turns: turn,
        totalTokens,
      };
    }

    // ── Stuck detection (comprehensive) ─────────────────────────
    const domFingerprint = getDOMFingerprint(domState);
    if (domFingerprint === lastDOMFingerprint) {
      consecutiveSameDOM++;
    } else {
      lastDOMFingerprint = domFingerprint;
      consecutiveSameDOM = 0;
    }

    const isStuck =
      consecutiveSameDOM >= STUCK_DOM_THRESHOLD ||
      consecutiveSameAction >= 2 ||
      consecutiveFailures >= 2 ||
      (action.confidence !== undefined && action.confidence < LOW_CONFIDENCE);

    // Auto-vision if too few elements (overlay/modal/canvas)
    const fewElements = domState.elements.length < 5;

    if ((isStuck || fewElements) && visionTurnsUsed < VISION_BUDGET) {
      useVisionNextTurn = true;
      if (isStuck) console.log(`[cua-dom] Stuck detected (sameDom=${consecutiveSameDOM}, sameAction=${consecutiveSameAction}, failures=${consecutiveFailures}). Switching to vision.`);
      if (fewElements) console.log(`[cua-dom] Few elements (${domState.elements.length}). Using vision.`);
    }

    // Hard stuck abort (even after vision budget exhausted)
    if (consecutiveSameDOM >= STUCK_DOM_THRESHOLD + VISION_BUDGET + 2) {
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — stuck on same page for ${consecutiveSameDOM} turns.\nISSUES: No progress at ${activePage.url()}`,
        turns: turn,
        totalTokens,
      };
    }

    // ── Update structured memory (overwrite) ────────────────────
    structuredMemory = {
      page: domState.title || activePage.url().split('/').pop() || '',
      filled: Object.entries(domState.formState || {}).map(([k, v]) => `${k}=${v.slice(0, 20)}`),
      pending: action.stepsCompleted ? [] : ['continue test'],
      errors: domState.errors || [],
    };

    if (action.stepsCompleted?.length) {
      stepsCompleted = action.stepsCompleted;
    }

    // ── Token budget check ──────────────────────────────────────
    const totalUsed = totalTokens.input + totalTokens.output;
    if (totalUsed > tokenBudget * 0.8) {
      console.warn(`[cua-dom] Token usage at ${Math.round(totalUsed / tokenBudget * 100)}% (${totalUsed.toLocaleString()} / ${tokenBudget.toLocaleString()})`);
    }

    // Structured logging
    console.log(`[cua-dom] Turn ${turn}: ${action.action} ${action.target || ''} → ${result.success ? 'ok' : 'FAIL'} | tokens: ${turnInput}+${turnOutput} | confidence: ${action.confidence}`);
  }

  // ── Turn budget exhausted ─────────────────────────────────────
  let storageStatePath: string | undefined;
  try {
    const storageFile = path.join(screenshotDir, 'storage-state.json');
    await activePage.context().storageState({ path: storageFile });
    storageStatePath = storageFile;
  } catch { /* ignore */ }

  return {
    verdict: 'TIMEOUT',
    modelMessage: `Reached maximum turn limit (${maxTurns}) without completing the test.`,
    turns: maxTurns,
    totalTokens,
    pageState: {
      url: activePage.url(),
      title: await activePage.title().catch(() => ''),
      lastActions: [],
      storageStatePath,
    },
  };
}
