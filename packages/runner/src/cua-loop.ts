import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { PlaywrightAdapter, executeValidatedAction } from './adapter/index.js';
import type { ActionStep, BrowserState } from './adapter/types.js';
import type { ValidatedResult } from './adapter/action-engine.js';
import type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState, ScreenshotRecord, TestAccountConfig } from './types.js';

// Re-export for backward compatibility
export type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState };

// ── Config ──────────────────────────────────────────────────────
const MODEL = 'gpt-5.4';
const DEFAULT_MAX_TURNS = 40;
const MAX_RETRIES_PER_TURN = 2;

// ── System prompt (compact, strict) ─────────────────────────────
const SYSTEM_PROMPT = `You are a QA test executor. Follow the TEST STEPS exactly in order. One action per response.

Respond ONLY with JSON:
{"action":"click|type|scroll|select|wait|navigate|keypress|done","target":"elementId","value":"","reason":"why","confidence":0.9,"memory":"1-line state","next_goal":"next step","stepsCompleted":["done steps"]}

CRITICAL:
1. Follow TEST STEPS in EXACT ORDER — do one step, then the next
2. Use element IDs from the Elements list (8-char hashes like "a1b2c3d4")
3. If element not found, use "value" field with the TEXT you want to click (system will search page)
4. For dropdowns: use action "select" with target=elementId and value=option text
5. If action had no effect, try a DIFFERENT element — NEVER repeat the same action+target that already failed
6. CHECK ACTION HISTORY before choosing your next action — if a target appears in FAILED TARGETS, do NOT try it again. Use a different element, scroll to find new elements, or try a completely different approach
7. LOGIN: click email field → type email → click field again → type password → click LOGIN
8. Never click "Forgot password" or "Sign in with Google" — use email+password only
9. NEVER click expand/fullscreen/maximize buttons (diagonal arrows icon) on side panels — they break the layout
10. If the page shows a loading spinner or is mostly empty, use action "wait" with value "3000" — do NOT navigate away or go back. The page is loading.
11. NEVER use "navigate" to go back to a previous page or restart the flow. Always move FORWARD through the steps.
12. When done: {"action":"done","verdict":"PASS/FAIL","summary":"...","stepsCompleted":[...],"issuesFound":[]}`;

// ── Helpers ─────────────────────────────────────────────────────
async function saveScreenshotToDisk(
  adapter: PlaywrightAdapter, dir: string, turn: number, runId: string,
): Promise<ScreenshotRecord> {
  await fs.mkdir(dir, { recursive: true });
  const filename = `${String(turn).padStart(3, '0')}-turn.png`;
  const filePath = path.join(dir, filename);
  await adapter.screenshot(filePath);
  const title = await adapter.getTitle();
  const url = await adapter.getUrl();
  return {
    id: uuid(),
    test_run_id: runId,
    turn_number: turn,
    file_path: filename,
    captured_at: new Date().toISOString(),
    page_url: url,
    page_title: title ?? null,
  };
}

function parseModelJSON(text: string): ActionStep | null {
  let clean = text.trim();
  const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) clean = jsonMatch[1].trim();
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.action === 'string') return parsed as ActionStep;
    return null;
  } catch {
    return null;
  }
}

function extractResponseText(response: any): string {
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

function formatStateForModel(state: BrowserState): string {
  const lines: string[] = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Title: ${state.title || '(none)'}`);
  if (state.hasOverlay) lines.push('NOTE: Modal/overlay detected');
  lines.push('');
  lines.push('Elements:');
  for (const el of state.elements) {
    // Use stable elementId as target identifier
    let desc = `${el.elementId}: <${el.tag}`;
    if (el.type) desc += ` type="${el.type}"`;
    desc += `>`;
    if (el.text) desc += ` "${el.text}"`;
    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
    if (el.value) desc += ` value="${el.value}"`;
    if (el.attributes['href']) desc += ` href="${el.attributes['href'].slice(0, 50)}"`;
    if (!el.isInteractable) desc += ' [disabled]';
    desc += ` [${el.boundingBox.x},${el.boundingBox.y}]`;
    lines.push(desc);
  }
  if (state.keyText.length > 0) {
    lines.push('');
    lines.push(`Key text: ${state.keyText.join(' | ')}`);
  }
  if (Object.keys(state.formValues).length > 0) {
    lines.push(`Form: ${Object.entries(state.formValues).map(([k, v]) => `${k}="${v.slice(0, 25)}"`).join(' ')}`);
  }
  if (state.errorMessages.length > 0) {
    lines.push(`ERRORS: ${state.errorMessages.join(' | ')}`);
  }
  return lines.join('\n');
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
  maxTurns: number,
  tokenBudget: number,
  
  testUrl?: string,
  mode: 'dom' | 'vision' = 'dom',
): Promise<CUALoopResult> {
  if (mode === 'vision') {
    const visionFn = await getVisionLoop();
    return visionFn(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl);
  }
  return runCUALoopDOM(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl);
}

// ── DOM-First CUA Loop (Adapter-based) ──────────────────────────
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
  maxTurns: number,
  tokenBudget: number,
  testUrl?: string,
): Promise<CUALoopResult> {
  // ── Create adapter (CUA never touches Playwright directly) ─────
  const adapter = new PlaywrightAdapter(page);
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // Vision budget — higher cap to allow vision bursts when DOM is stuck
  const VISION_BUDGET = Math.min(20, Math.ceil(maxTurns * 0.4));
  let visionTurnsUsed = 0;
  let useVisionNextTurn = false;

  // Stuck detection
  let lastDOMFingerprint = '';
  let consecutiveSameDOM = 0;
  let lastActionSig = '';
  let consecutiveSameAction = 0;
  let consecutiveFailures = 0;
  const STUCK_THRESHOLD = 4;  // triggers vision fallback after 4 same-state turns
  const LOW_CONFIDENCE = 0.4;

  // Agent memory (overwritten each turn, NOT accumulated)
  let agentMemory = 'Starting test';
  let nextGoal = 'Begin test instructions';
  let stepsCompleted: string[] = [];
  let lastResult: ValidatedResult | null = null;

  // ── Rolling action history (prevents loops) ─────────────────
  // Keeps last N actions so model knows what it already tried
  const ACTION_HISTORY_SIZE = 15;
  const actionHistory: Array<{
    turn: number;
    action: string;
    target: string;
    value?: string;
    effective: boolean;
    description: string;
  }> = [];

  // URL watchdog
  const allowedDomains = ['appypie.com', 'appypieautomate.ai', 'connectcloud.appypie.com'];
  if (testUrl) {
    try { allowedDomains.push(new URL(testUrl).hostname); } catch {}
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

  // Network error tracking
  const networkErrors: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('favicon')) {
      networkErrors.push(`${res.status()} ${res.url().slice(0, 60)}`);
      if (networkErrors.length > 10) networkErrors.shift();
    }
  });

  // ── Save initial screenshot ────────────────────────────────────
  const initialSaved = await saveScreenshotToDisk(adapter, screenshotDir, 0, runId);
  callbacks.onScreenshot(0, initialSaved);

  // ── Get initial DOM state ──────────────────────────────────────
  let state = await adapter.getState();

  if (state.elements.length < 3) {
    console.log(`[cua] Few DOM elements (${state.elements.length}), starting with vision`);
    useVisionNextTurn = true;
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (abortSignal?.aborted) {
      return { verdict: 'FAIL', modelMessage: 'Test was aborted.', turns: turn - 1, totalTokens };
    }

    callbacks.onTurnStart(turn);

    // ── Auto-wait for loading spinners ──────────────────────────
    // If page has very few elements (loading spinner), wait up to 10s for content to load
    if (state.elements.length < 5) {
      let waited = 0;
      const LOAD_WAIT_INTERVAL = 2000;
      const LOAD_WAIT_MAX = 10000;
      while (waited < LOAD_WAIT_MAX) {
        console.log(`[cua] Page loading (${state.elements.length} elements) — waiting ${LOAD_WAIT_INTERVAL / 1000}s...`);
        await new Promise(r => setTimeout(r, LOAD_WAIT_INTERVAL));
        waited += LOAD_WAIT_INTERVAL;
        try { state = await adapter.getState(); } catch { break; }
        if (state.elements.length >= 5) {
          console.log(`[cua] Page loaded (${state.elements.length} elements after ${waited / 1000}s)`);
          break;
        }
      }
    }

    // ── Build prompt (self-contained, with rolling action history) ─
    const promptParts: string[] = [];

    // Credentials — only on allowed domains
    if (testAccount) {
      const host = await adapter.getUrl().then(u => { try { return new URL(u).hostname; } catch { return ''; } });
      const domainAllowed = allowedDomains.some(d => host === d || host.endsWith('.' + d));
      if (domainAllowed) {
        promptParts.push(`CREDENTIALS: email=${testAccount.email} password=${testAccount.password}`);
        if (turn === 1) console.log(`[cua] Credentials INCLUDED for domain: ${host} (email: ${testAccount.email})`);
      } else {
        console.warn(`[cua] T${turn}: Credentials BLOCKED — domain "${host}" not in allowed list: [${allowedDomains.join(', ')}]`);
      }
    } else if (turn === 1) {
      console.log(`[cua] No credentials — test does not require auth`);
    }

    // TEST STEPS go FIRST — they are the primary instruction
    promptParts.push(`=== TEST STEPS (follow in order) ===`);
    promptParts.push(testInstructions);
    promptParts.push(`=== EXPECTED OUTCOME ===`);
    promptParts.push(expectedOutcome);
    promptParts.push(`=== PROGRESS ===`);
    promptParts.push(`Completed: ${stepsCompleted.length > 0 ? stepsCompleted.join(', ') : 'None yet'}`);
    promptParts.push(`Turn: ${turn}/${maxTurns}`);
    promptParts.push('');
    promptParts.push('CURRENT PAGE STATE:');
    promptParts.push(formatStateForModel(state));
    promptParts.push('');

    // ── Action history — gives model full awareness of what it tried ──
    if (actionHistory.length > 0) {
      promptParts.push(`=== ACTION HISTORY (last ${actionHistory.length} actions) ===`);
      // Show all history entries with clear effective/ineffective markers
      for (const h of actionHistory) {
        const marker = h.effective ? 'OK' : 'NO-EFFECT';
        const valStr = h.value ? ` value="${h.value}"` : '';
        promptParts.push(`  T${h.turn}: ${h.action} ${h.target}${valStr} → [${marker}] ${h.description}`);
      }

      // Compile list of failed targets so model avoids them
      const failedTargets = actionHistory
        .filter(h => !h.effective)
        .map(h => `${h.action}:${h.target}`)
        .filter((v, i, a) => a.indexOf(v) === i); // dedupe
      if (failedTargets.length > 0) {
        promptParts.push(`\nFAILED TARGETS (DO NOT retry these — they already failed):`);
        promptParts.push(`  ${failedTargets.join(', ')}`);
      }

      promptParts.push('');
    }

    // Last action result with effective flag + retry hint
    if (lastResult) {
      promptParts.push(`LAST ACTION: ${lastResult.description}`);
      promptParts.push(`LAST RESULT: success=${lastResult.success} effective=${lastResult.effective} urlChanged=${lastResult.validation.urlChanged} domChanged=${lastResult.validation.domChanged} valueChanged=${lastResult.validation.valueChanged} intentMatch=${lastResult.validation.intentMatch}`);
      if (!lastResult.effective && lastResult.success) {
        promptParts.push(`WARNING: Action succeeded but had NO visible effect. You MUST try a different element or approach. Check ACTION HISTORY above — do NOT repeat any failed target.`);
      }
      if (lastResult.validation.errorAppeared) {
        promptParts.push(`ERROR AFTER ACTION: ${lastResult.validation.errorMessage}`);
      }
      if (lastResult.retryStrategy && lastResult.retryStrategy !== 'none') {
        promptParts.push(`MANDATORY RETRY: ${lastResult.retryStrategy} — you MUST follow this hint unless clearly invalid.`);
      }
    } else {
      promptParts.push('LAST ACTION: none (first turn)');
    }

    if (networkErrors.length > 0) {
      promptParts.push(`NETWORK ERRORS: ${networkErrors.slice(-3).join(' | ')}`);
    }

    // Build input
    const content: any[] = [{ type: 'input_text', text: promptParts.join('\n') }];

    // Vision fallback — predictive triggers (not just reactive)
    if (!useVisionNextTurn && visionTurnsUsed < VISION_BUDGET) {
      if (state.hasCanvas) {
        useVisionNextTurn = true;
        console.log('[cua] Canvas detected — predictive vision trigger');
      } else if (state.duplicateTextCount > 3) {
        useVisionNextTurn = true;
        console.log(`[cua] ${state.duplicateTextCount} duplicate text elements — predictive vision trigger`);
      }
    }

    // Vision fallback
    if (useVisionNextTurn && visionTurnsUsed < VISION_BUDGET) {
      try {
        const jpegData = await adapter.screenshotJPEG();
        content.push({ type: 'input_image', image_url: jpegData });
        content.push({ type: 'input_text', text: '\nScreenshot attached — previous actions had no effect. Use BOTH DOM listing AND screenshot.' });
        visionTurnsUsed++;
        console.log(`[cua] Vision fallback (${visionTurnsUsed}/${VISION_BUDGET})`);
      } catch {}
      useVisionNextTurn = false;
    }

    // ── Call model ──────────────────────────────────────────────
    const turnMode: 'dom' | 'vision' = content.some((c: any) => c.type === 'input_image') ? 'vision' : 'dom';
    const apiStart = Date.now();
    let responseText = '';
    let turnInput = 0, turnOutput = 0, turnReasoning = 0;

    // Debug: log what we're sending to the model
    const textParts = content.filter((c: any) => c.type === 'input_text').map((c: any) => c.text);
    const hasImage = content.some((c: any) => c.type === 'input_image');
    console.log(`[cua-debug] T${turn} → model | texts: ${textParts.length} | image: ${hasImage} | model: ${MODEL}`);
    for (const part of textParts) {
      // Truncate long prompts to keep logs readable
      const preview = part.length > 500 ? part.slice(0, 500) + `... (${part.length} chars)` : part;
      console.log(`[cua-debug] PROMPT:\n${preview}`);
    }

    try {
      const response = await openai.responses.create({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content }],
        reasoning: { effort: 'high' as any },
      } as any, { signal: abortSignal } as any) as any;

      turnInput = response.usage?.input_tokens ?? 0;
      turnOutput = response.usage?.output_tokens ?? 0;
      turnReasoning = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
      totalTokens.input += turnInput;
      totalTokens.output += turnOutput;
      totalTokens.reasoning += turnReasoning;
      responseText = extractResponseText(response);
    } catch (err: any) {
      if (abortSignal?.aborted) {
        return { verdict: 'FAIL', modelMessage: 'Test was aborted.', turns: turn, totalTokens };
      }
      console.error(`[cua-debug] T${turn} API ERROR:`, err.message || err);
      throw err;
    }
    const apiLatency = Date.now() - apiStart;

    // Debug: log model response
    const respPreview = responseText.length > 500 ? responseText.slice(0, 500) + `... (${responseText.length} chars)` : responseText;
    console.log(`[cua-debug] T${turn} ← model | ${apiLatency}ms | in=${turnInput} out=${turnOutput} reason=${turnReasoning}`);
    console.log(`[cua-debug] RESPONSE: ${respPreview}`);

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
      mode: turnMode,
    });

    // ── Parse model response ────────────────────────────────────
    let action = parseModelJSON(responseText);

    // Retry on invalid JSON
    if (!action) {
      for (let retry = 0; retry < MAX_RETRIES_PER_TURN; retry++) {
        console.warn(`[cua] Invalid JSON (retry ${retry + 1})`);
        try {
          const retryResp = await openai.responses.create({
            model: MODEL,
            instructions: SYSTEM_PROMPT,
            input: [{
              role: 'user',
              content: [{ type: 'input_text', text: `Your last response was not valid JSON:\n${responseText.slice(0, 400)}\n\nRespond with ONLY valid JSON.` }],
            }],
            reasoning: { effort: 'low' as any },
          } as any) as any;

          totalTokens.input += retryResp.usage?.input_tokens ?? 0;
          totalTokens.output += retryResp.usage?.output_tokens ?? 0;
          action = parseModelJSON(extractResponseText(retryResp));
          if (action) break;
        } catch {}
      }

      if (!action) {
        console.error('[cua] Could not parse model response');
        lastResult = null;
        agentMemory = 'Model returned invalid JSON';
        nextGoal = 'Retry with valid response';
        consecutiveFailures++;
        const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: 'wait' }]);
        continue;
      }
    }

    // Validate action type
    const validActions = ['click', 'type', 'scroll', 'select', 'wait', 'navigate', 'keypress', 'done'];
    if (!validActions.includes(action.action)) {
      console.warn(`[cua] Invalid action: ${action.action}`);
      lastResult = null;
      consecutiveFailures++;
      const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: action.action }]);
      continue;
    }

    // ── Handle "done" ───────────────────────────────────────────
    if (action.action === 'done') {
      const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: 'done' }]);

      const verdict = action.verdict === 'PASS' ? 'PASS' : 'FAIL';
      const finalVerdict = (verdict === 'PASS' && action.issuesFound?.length) ? 'FAIL' : verdict;

      return {
        verdict: finalVerdict as any,
        modelMessage: [
          `VERDICT: ${finalVerdict}`,
          `SUMMARY: ${action.summary || action.reason}`,
          `STEPS_COMPLETED: ${(action.stepsCompleted || stepsCompleted).join(', ')}`,
          `ISSUES: ${action.issuesFound?.join(', ') || 'None'}`,
        ].join('\n'),
        turns: turn,
        totalTokens,
      };
    }

    // ── Memory enforcement — block redundant actions ────────────
    if (action.action === 'type' && action.target && action.value) {
      // If form already has this value filled, skip
      const existingVal = state.formValues[action.target] || '';
      if (existingVal && existingVal.includes(action.value.slice(0, 15))) {
        console.log(`[cua] Memory enforcement: field ${action.target} already contains "${action.value.slice(0, 15)}". Skipping.`);
        const skipResult: ValidatedResult = { success: true, effective: false, action: 'type', description: `skipped: field ${action.target} already contains "${action.value.slice(0, 15)}"`, retryStrategy: 'change_target' as any, validation: { urlChanged: false, domChanged: false, valueChanged: false, errorAppeared: false, elementStillExists: true, intentMatch: true }, durationMs: 0 };
        lastResult = skipResult;
        // Record in history so model knows and stops retrying
        actionHistory.push({
          turn, action: 'type', target: action.target,
          value: action.value, effective: false,
          description: `SKIPPED: field already filled with "${existingVal.slice(0, 20)}"`,
        });
        if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
        const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: 'type' }]);
        continue;
      }
    }

    // ── Credential security ─────────────────────────────────────
    if (action.action === 'type' && testAccount) {
      const host = await adapter.getUrl().then(u => { try { return new URL(u).hostname; } catch { return ''; } });
      const isKnown = allowedDomains.some(d => host === d || host.endsWith('.' + d));
      if (!isKnown && (action.value === testAccount.password || action.value === testAccount.email)) {
        console.warn(`[cua] BLOCKED: credential on unknown domain ${host}`);
        agentMemory = `Credential blocked on ${host}`;
        const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: 'type' }]);
        continue;
      }
    }

    // ── Action repeat detection ─────────────────────────────────
    const actionSig = `${action.action}:${action.target}:${(action.value || '').slice(0, 20)}`;
    if (actionSig === lastActionSig) {
      consecutiveSameAction++;
      if (consecutiveSameAction >= 5) {
        console.warn(`[cua] Action loop (${consecutiveSameAction} repeats). Aborting.`);
        return {
          verdict: 'FAIL',
          modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — repeated same action ${consecutiveSameAction} times.\nISSUES: Loop on ${action.action} ${action.target} at ${await adapter.getUrl()}`,
          turns: turn, totalTokens,
        };
      }
    } else {
      lastActionSig = actionSig;
      consecutiveSameAction = 0;
    }

    // ── Check abort before executing browser action ────────────
    if (abortSignal?.aborted) {
      return { verdict: 'FAIL', modelMessage: 'Test was aborted by user.', turns: turn, totalTokens };
    }

    // ── Execute through Action Engine (with validation) ─────────
    let result = await executeValidatedAction(adapter, action, state);

    // Smart event selection: if model clicks an event name (trigger/action event), use selectAppyPieEvent
    if (action.action === 'click' && !result.effective) {
      const clickText = action.value || action.reason || '';
      // Common trigger/action event patterns
      const eventPatterns = ['new spreadsheet', 'new opportunity', 'new form', 'new contact', 'create draft', 'create sale', 'new row', 'updated', 'new email', 'send email', 'create user'];
      const matchedEvent = eventPatterns.find(p => clickText.toLowerCase().includes(p));
      if (matchedEvent) {
        console.log(`[cua] Detected event selection: "${clickText}" → using selectAppyPieEvent`);
        const eventResult = await adapter.selectAppyPieEvent(clickText);
        if (eventResult.success) {
          result = { ...result, success: true, effective: true, description: `selected event "${clickText}" + clicked Continue`, error: undefined };
        }
      }
    }

    // Smart dropdown detection: if model clicks something with "Select" or "Choose" in the VALUE field,
    // treat it as a dropdown open request → use openAndSelectDropdown
    // IMPORTANT: Only match action.value, NOT action.reason — reason contains natural language
    // that often has "select" in it (e.g. "Select the Gmail app") causing false triggers
    if (action.action === 'click' && !result.effective && action.value) {
      const selectMatch = action.value.match(/^(?:select|choose)\s+(.+)/i);
      if (selectMatch) {
        const dropdownLabel = selectMatch[1].replace(/\s*(dropdown|field|option|from.*)/i, '').trim();
        if (dropdownLabel.length > 2) {
          console.log(`[cua] Detected dropdown click: "${dropdownLabel}" → using openAndSelectDropdown`);
          const ddResult = await adapter.openAndSelectDropdown(dropdownLabel, 'first');
          if (ddResult.success) {
            result = { ...result, success: true, effective: true, description: `opened dropdown "${dropdownLabel}" and selected first option`, error: undefined };
          }
        }
      }
    }

    // If select action failed, try smart dropdown handler
    if (!result.success && action.action === 'select' && action.target && action.value) {
      const el = state.elements.find(e => e.elementId === action.target);
      const label = el?.text || el?.placeholder || action.reason || '';
      if (label) {
        console.log(`[cua] Select failed → trying smart dropdown: "${label}" → "${action.value}"`);
        const ddResult = await adapter.openAndSelectDropdown(label, action.value);
        if (ddResult.success) {
          result = { ...result, success: true, effective: true, description: `selected "${action.value}" via dropdown handler`, error: undefined };
        }
      }
    }

    // If click failed and model provided explicit text in value, try panel text search
    // IMPORTANT: Only use action.value (explicit text the model wants to click), NOT action.reason
    // Reason contains natural language that causes false matches (e.g. matching "trigger application"
    // text when searching for "Select Action Event")
    if (!result.success && action.action === 'click' && action.value) {
      const cleanText = action.value
        .replace(/^(click|select|choose|pick)\s*/i, '')
        .replace(/\s*(button|link|option|item|from.*)/i, '')
        .trim();
      if (cleanText.length > 2 && cleanText.length < 60) {
        console.log(`[cua] Click failed → trying panel text search: "${cleanText}"`);
        const panelResult = await adapter.clickByPanelText(cleanText);
        if (panelResult.success) {
          result = {
            ...result,
            success: true,
            effective: true,
            description: `clicked "${cleanText}" (panel text search)`,
            error: undefined,
          };
        }
      }
    }

    lastResult = result;

    // ── Record in action history ─────────────────────────────────
    actionHistory.push({
      turn,
      action: action.action,
      target: action.target || action.value || '',
      value: action.value,
      effective: result.effective,
      description: result.description,
    });
    // Keep only the last N entries to control prompt size
    if (actionHistory.length > ACTION_HISTORY_SIZE) {
      actionHistory.shift();
    }

    callbacks.onActionsExecuted(turn, [{ type: action.action, ...action }]);

    if (result.success && result.effective) {
      consecutiveFailures = 0;
    } else if (!result.success) {
      consecutiveFailures++;
      console.warn(`[cua] Action failed: ${result.error}`);
      // Auto-switch to vision when DOM mode can't interact
      if (consecutiveFailures >= 2 && visionTurnsUsed < VISION_BUDGET) {
        useVisionNextTurn = true;
        console.log(`[cua] ${consecutiveFailures} consecutive failures — auto-switching to vision for next turn`);
      }
    } else if (result.success && !result.effective) {
      // Success but no effect — might be interacting with wrong elements
      consecutiveFailures++;
      if (consecutiveFailures >= 3 && visionTurnsUsed < VISION_BUDGET) {
        useVisionNextTurn = true;
        console.log(`[cua] ${consecutiveFailures} ineffective actions — auto-switching to vision`);
      }
    }

    // ── URL watchdog ────────────────────────────────────────────
    const currentUrl = await adapter.getUrl();
    if (isExternalTrap(currentUrl)) {
      console.warn(`[cua] External trap: ${currentUrl}. Bouncing back.`);
      await adapter.navigate(testUrl || 'about:blank');
    } else if (!isUrlAllowed(currentUrl) && testUrl) {
      console.warn(`[cua] Off-domain: ${currentUrl}. Bouncing back.`);
      await adapter.navigate(testUrl);
    }

    // ── Save screenshot (replay only, NOT sent to model) ────────
    const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
    callbacks.onScreenshot(turn, saved, {
      action: { type: action.action, target: action.target, value: action.value },
      result: { success: result.success, error: result.error, description: result.description },
      validation: result.validation,
      effective: result.effective,
      retryStrategy: result.retryStrategy,
      memory: action.memory || agentMemory,
      nextGoal: action.next_goal || nextGoal,
      domFingerprint: state.domFingerprint,
      confidence: action.confidence,
      visionUsed: visionTurnsUsed > 0 && useVisionNextTurn,
    });

    // ── Re-index DOM (fresh indices every turn) ─────────────────
    try {
      state = await adapter.getState();
    } catch (err) {
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: Page crashed.\nISSUES: DOM extraction failed: ${(err as Error).message}`,
        turns: turn, totalTokens,
      };
    }

    // ── Auto-open side panel on Appy Pie canvas ────────────────
    // Detects when we're on the canvas view with a closed side panel
    // (card visible but no config fields). Double-clicks the card to open it.
    const currentUrlForPanel = await adapter.getUrl();
    if (currentUrlForPanel.includes('/customeditor/')) {
      const hasSidePanel = state.elements.some(el =>
        el.text?.includes('Continue') ||
        el.text?.includes('Spreadsheet') ||
        el.text?.includes('Worksheet') ||
        el.text?.includes('Add an Account') ||
        el.text?.includes('Trigger Event') ||
        el.text?.includes('Trigger Details') ||
        el.text?.includes('Action Event') ||
        el.text?.includes('Action Details') ||
        el.text?.includes('Change') ||
        el.text?.includes('Connect Account') ||
        el.text?.includes('Skip Run Test') ||
        el.text?.includes('Set Up') ||
        el.placeholder?.includes('Search')
      );
      const hasCard = state.elements.some(el =>
        el.text?.includes('Trigger Application') ||
        el.text?.includes('Action Application') ||
        el.text?.includes('Select Trigger') ||
        el.text?.includes('Select Action')
      );

      if (!hasSidePanel && hasCard && state.elements.length < 15) {
        // Strategy 1: Click the panel toggle icon (◁▏) — most reliable
        // It's typically a small icon in the top-right area of the page
        const panelToggle = state.elements.find(el =>
          el.attributes?.['class']?.includes('collapse') ||
          el.attributes?.['class']?.includes('toggle') ||
          el.attributes?.['class']?.includes('panel') ||
          el.attributes?.['aria-label']?.toLowerCase().includes('panel') ||
          el.attributes?.['aria-label']?.toLowerCase().includes('collapse')
        );

        if (panelToggle && panelToggle.boundingBox) {
          console.log(`[cua] Side panel closed — clicking panel toggle icon to re-open`);
          await adapter.clickByCoordinates(
            panelToggle.boundingBox.x + panelToggle.boundingBox.w / 2,
            panelToggle.boundingBox.y + panelToggle.boundingBox.h / 2,
          );
        } else {
          // Strategy 2: Click the panel toggle at a known position (top-right area)
          // The ◁▏ icon is typically at ~(1355, 90) based on screenshots
          console.log(`[cua] Side panel closed — clicking panel toggle at top-right position`);
          await adapter.clickByCoordinates(1355, 90);
        }

        // Wait for panel to open
        await new Promise(r => setTimeout(r, 3000));
        // Re-index DOM after panel opens
        try { state = await adapter.getState(); } catch {}

        // If still no panel, try double-clicking the card as fallback
        const stillNoPanel = !state.elements.some(el =>
          el.text?.includes('Continue') ||
          el.text?.includes('Spreadsheet') ||
          el.text?.includes('Add an Account') ||
          el.text?.includes('Trigger Details') ||
          el.text?.includes('Action Details') ||
          el.text?.includes('Change') ||
          el.text?.includes('Connect Account') ||
          el.placeholder?.includes('Search')
        );
        if (stillNoPanel) {
          const card = state.elements.find(el =>
            el.text?.includes('Trigger Application') ||
            el.text?.includes('Google Sheets') ||
            el.text?.includes('Action Application')
          );
          if (card && card.boundingBox) {
            console.log(`[cua] Panel toggle didn't work — double-clicking card "${card.text?.slice(0, 30)}"`);
            await adapter.doubleClickByCoordinates(
              card.boundingBox.x + card.boundingBox.w / 2,
              card.boundingBox.y + card.boundingBox.h / 2,
            );
            await new Promise(r => setTimeout(r, 2000));
            try { state = await adapter.getState(); } catch {}
          }
        }
      }
    }

    // ── Stuck detection ─────────────────────────────────────────
    if (state.domFingerprint === lastDOMFingerprint) {
      consecutiveSameDOM++;
    } else {
      lastDOMFingerprint = state.domFingerprint;
      consecutiveSameDOM = 0;
    }

    const isStuck =
      consecutiveSameDOM >= STUCK_THRESHOLD ||
      consecutiveSameAction >= 2 ||
      consecutiveFailures >= 2 ||
      (action.confidence !== undefined && action.confidence < LOW_CONFIDENCE);

    const fewElements = state.elements.length < 3;

    if ((isStuck || fewElements) && visionTurnsUsed < VISION_BUDGET) {
      useVisionNextTurn = true;
      if (isStuck) console.log(`[cua] Stuck (sameDom=${consecutiveSameDOM}, sameAction=${consecutiveSameAction}, failures=${consecutiveFailures}). Vision next.`);
    }

    // ── Vision burst: delegate to vision CUA loop when truly stuck ──
    // Instead of just adding a screenshot to the DOM prompt, actually run
    // the vision model for several turns to break through stuck states
    const VISION_BURST_THRESHOLD = STUCK_THRESHOLD + 2; // trigger after 6 same-DOM turns
    const VISION_BURST_TURNS = 10;

    if (consecutiveSameDOM >= VISION_BURST_THRESHOLD && visionTurnsUsed < VISION_BUDGET) {
      console.log(`[cua] ═══ VISION BURST: DOM stuck for ${consecutiveSameDOM} turns — delegating ${VISION_BURST_TURNS} turns to vision CUA loop ═══`);

      // Build context for vision: tell it what DOM loop was trying to do
      const visionInstructions = [
        `CONTEXT: The DOM-based automation got stuck and could not make progress. You are taking over for ${VISION_BURST_TURNS} turns to UNBLOCK the stuck step only.`,
        `IMPORTANT: Do NOT try to complete the entire test. Just perform the NEXT GOAL below and then stop. Do NOT output a final VERDICT — you are only here to unstick one step.`,
        `CURRENT STATE: ${agentMemory}`,
        `NEXT GOAL (do ONLY this): ${nextGoal}`,
        `COMPLETED SO FAR: ${stepsCompleted.length > 0 ? stepsCompleted.join(', ') : 'None'}`,
        `RECENT FAILURES (these approaches did NOT work — try something different): ${actionHistory.filter(h => !h.effective).slice(-5).map(h => `${h.action} ${h.target} → ${h.description}`).join('; ')}`,
        '',
        'FULL TEST INSTRUCTIONS (for context only — focus on NEXT GOAL):',
        testInstructions,
      ].join('\n');

      try {
        const visionFn = await getVisionLoop();
        const visionResult = await visionFn(
          openai, page, visionInstructions, expectedOutcome,
          screenshotDir, runId, callbacks,
          testAccount, abortSignal,
          VISION_BURST_TURNS,  // only run for a few turns
          tokenBudget - (totalTokens.input + totalTokens.output), // remaining budget
          testUrl,
        );

        // Accumulate tokens from vision burst
        totalTokens.input += visionResult.totalTokens.input;
        totalTokens.output += visionResult.totalTokens.output;
        totalTokens.reasoning += visionResult.totalTokens.reasoning;
        visionTurnsUsed += VISION_BURST_TURNS;
        turn += visionResult.turns;

        // NEVER accept PASS/FAIL from vision burst — it's only meant to break through
        // stuck states, not to judge the entire test. The DOM loop handles final verdict.
        if (visionResult.verdict === 'PASS') {
          console.log(`[cua] Vision burst reported PASS — ignoring (only DOM loop can judge final result). Resuming DOM.`);
        } else if (visionResult.verdict === 'FAIL') {
          console.log(`[cua] Vision burst reported FAIL — ignoring (vision was only unsticking). Resuming DOM.`);
        }

        console.log(`[cua] ═══ Vision burst done (${visionResult.turns} turns used). Resuming DOM mode. ═══`);

        // Reset stuck counters — vision may have changed the page
        consecutiveSameDOM = 0;
        consecutiveSameAction = 0;
        consecutiveFailures = 0;
        lastDOMFingerprint = '';
        useVisionNextTurn = false;

        // Re-index DOM after vision changes
        try { state = await adapter.getState(); } catch {}

        // Record vision burst in action history
        actionHistory.push({
          turn, action: 'vision-burst', target: '',
          effective: true,
          description: `Vision CUA took over for ${visionResult.turns} turns`,
        });
        if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();

        continue; // Go to next DOM turn with fresh state
      } catch (err: any) {
        console.warn(`[cua] Vision burst failed: ${err.message}. Continuing in DOM mode.`);
      }
    }

    // Hard stuck abort — only after vision bursts are exhausted
    if (consecutiveSameDOM >= STUCK_THRESHOLD + VISION_BUDGET + VISION_BURST_TURNS + 4) {
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: Stuck on same page for ${consecutiveSameDOM} turns (including vision bursts).\nISSUES: No progress at ${await adapter.getUrl()}`,
        turns: turn, totalTokens,
      };
    }

    // ── Update agent memory (overwrite, NOT accumulate) ─────────
    agentMemory = action.memory || result.description;
    nextGoal = action.next_goal || 'Continue test';
    if (action.stepsCompleted?.length) {
      stepsCompleted = action.stepsCompleted;
    }

    // ── Token budget check ──────────────────────────────────────
    const totalUsed = totalTokens.input + totalTokens.output;
    if (totalUsed > tokenBudget * 0.8) {
      console.warn(`[cua] Token usage: ${Math.round(totalUsed / tokenBudget * 100)}% (${totalUsed.toLocaleString()} / ${tokenBudget.toLocaleString()})`);
    }

    // ── Structured log ──────────────────────────────────────────
    console.log(`[cua] T${turn}: ${action.action} ${action.target || ''} → ${result.success ? (result.effective ? 'ok' : 'ok[no-effect]') : 'FAIL'} | dom=${result.validation.domChanged ? 'Y' : 'N'} url=${result.validation.urlChanged ? 'Y' : 'N'} intent=${result.validation.intentMatch ? 'Y' : 'N'} | tokens: ${turnInput}+${turnOutput} | retry: ${result.retryStrategy || 'none'}`);
  }

  // ── Turn budget exhausted ─────────────────────────────────────
  let storageStatePath: string | undefined;
  try {
    const storageFile = path.join(screenshotDir, 'storage-state.json');
    await page.context().storageState({ path: storageFile });
    storageStatePath = storageFile;
  } catch {}

  return {
    verdict: 'TIMEOUT',
    modelMessage: `Reached maximum turn limit (${maxTurns}) without completing the test. Want to continue then increase maxturns!`,
    turns: maxTurns,
    totalTokens,
    pageState: {
      url: await adapter.getUrl(),
      title: await adapter.getTitle(),
      lastActions: [],
      storageStatePath,
    },
  };
}
