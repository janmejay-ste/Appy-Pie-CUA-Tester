import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { PlaywrightAdapter, executeValidatedAction } from './adapter/index.js';
import type { ActionStep, BrowserState } from './adapter/types.js';
import type { ValidatedResult, ExecutionStrategy } from './adapter/action-engine.js';
import type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState, ScreenshotRecord, TestAccountConfig } from './types.js';
import { VisionDecisionEngine } from './vision-decision.js';
import type { VisionBrowserState, VisionActionResult, VisionDecision } from './vision-decision.js';

// Re-export for backward compatibility
export type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState };

// ── State Machine Types ─────────────────────────────────────────
type Mode = 'DOM_NORMAL' | 'DOM_WITH_VISION' | 'VISION_BURST';

type FailureType =
  | 'ELEMENT_NOT_FOUND'
  | 'NO_EFFECT_WRONG_TARGET'       // clicked/typed but nothing reacted — wrong element
  | 'NO_EFFECT_CLICK_BLOCKED'      // something intercepted the click (overlay, pointer-events)
  | 'NO_EFFECT_NOT_INTERACTABLE'   // element exists but is disabled/non-interactive
  | 'ACTION_FAILED'                // action returned success=false, element exists
  | 'VALIDATION_ERROR'             // form/page error appeared after action
  | 'STRATEGY_FAILURE'             // same failure type across 3+ different targets
  | 'BLOCKED_REPEAT'               // hard-blocked by guard
  | 'UNKNOWN';

interface FailedAction {
  action: string;
  target: string;
  error: string;
  type: FailureType;
  strategy: ExecutionStrategy;
}

// Maps failure type → suggested next strategy to try
function suggestStrategy(type: FailureType): ExecutionStrategy | null {
  switch (type) {
    case 'ELEMENT_NOT_FOUND':          return 'text';
    case 'NO_EFFECT_CLICK_BLOCKED':    return 'coordinates';
    case 'NO_EFFECT_NOT_INTERACTABLE': return 'text';
    case 'NO_EFFECT_WRONG_TARGET':     return 'coordinates';
    case 'STRATEGY_FAILURE':           return 'coordinates';
    case 'VALIDATION_ERROR':           return null; // input problem — strategy won't help
    default:                           return null;
  }
}

interface StuckContext {
  goal: string;
  url: string;
  trigger: string;
  failedActions: FailedAction[];
}

function classifyFailureType(
  result: { success: boolean; effective: boolean; error?: string; description?: string },
  validation: { elementStillExists: boolean; errorAppeared: boolean },
  elInteractable?: boolean,
): FailureType {
  if (!result.success && !validation.elementStillExists) return 'ELEMENT_NOT_FOUND';
  if (result.success && !result.effective) {
    if (elInteractable === false) return 'NO_EFFECT_NOT_INTERACTABLE';
    const hint = ((result.error || '') + (result.description || '')).toLowerCase();
    if (hint.includes('intercept') || hint.includes('blocked') || hint.includes('overlay') || hint.includes('pointer')) return 'NO_EFFECT_CLICK_BLOCKED';
    return 'NO_EFFECT_WRONG_TARGET';
  }
  if (validation.errorAppeared) return 'VALIDATION_ERROR';
  if (!result.success) return 'ACTION_FAILED';
  return 'UNKNOWN';
}

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
12. ACCOUNT SETUP: When you see a linked account with a "Continue" button, ALWAYS click Continue. NEVER click "Add an Account", "Change", "Connect Account", or "Reconnect" — the account is already linked.
13. When done: {"action":"done","verdict":"PASS/FAIL","summary":"...","stepsCompleted":[...],"issuesFound":[]}`;

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

function formatStateForModel(state: BrowserState, discouragedIds?: Set<string>): string {
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
    if (discouragedIds?.has(el.elementId)) desc += ' [DISCOURAGED]';
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
  maxTurns = 500,
  tokenBudget = 500000,
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
  maxTurns = 500,
  tokenBudget = 500000,
  testUrl?: string,
): Promise<CUALoopResult> {
  // ── Create adapter (CUA never touches Playwright directly) ─────
  const adapter = new PlaywrightAdapter(page);
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // ── State machine ───────────────────────────────────────────────
  let mode: Mode = 'DOM_NORMAL';
  let consecutiveFailures = 0;
  let consecutiveNonMeaningful = 0;  // catches scroll/wait loops
  let consecutiveScrolls = 0;        // scroll-specific: 3 in a row without DOM change = stuck
  let stuckContext: StuckContext | null = null;
  let visionBurstsUsed = 0;
  const MAX_VISION_BURSTS = 3;

  // Actions where no-effect counts as a real failure
  const MEANINGFUL_ACTIONS = new Set(['click', 'type', 'select', 'navigate', 'keypress']);

  // Action repeat detection (safety — kept separate from stuck detection)
  let lastActionSig = '';
  let consecutiveSameAction = 0;

  // Confidence tracking
  let consecutiveLowConfidence = 0;

  // Strategy engine
  let forceStrategySwitch: ExecutionStrategy | null = null;
  let lastSuccessfulStrategy: ExecutionStrategy | null = null;

  // URL-based stuck detection — catches cases where DOM changes but page doesn't progress
  let lastUrlPath = '';
  let sameUrlTurns = 0;
  const MAX_SAME_URL_TURNS = 25; // abort after 25 turns on same URL path
  let lastProgressTurn = 0; // track last turn with real progress
  const MAX_NO_PROGRESS_TURNS = 30; // abort after 30 turns without progress

  // ── NEW: Vision Decision Engine (parallel — log only, don't act) ──
  const visionEngine = new VisionDecisionEngine();
  let previousElementCount = 0;
  let lastVisionDecision: VisionDecision | null = null;

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
  previousElementCount = state.elements.length; // initialize from first state

  if (state.elements.length < 3) {
    console.log(`[cua] Few DOM elements (${state.elements.length}), starting with vision`);
    mode = 'DOM_WITH_VISION';
    stuckContext = { goal: 'Begin test instructions', url: state.url, trigger: 'few DOM elements on start', failedActions: [] };
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
    // Mark recently-failed targets as [DISCOURAGED] instead of removing them —
    // keeps options visible but deprioritized so model can use them if truly necessary
    const discouragedIds = stuckContext && stuckContext.failedActions.length > 0
      ? new Set(stuckContext.failedActions.slice(-3).map(f => f.target).filter(Boolean))
      : undefined;
    promptParts.push(formatStateForModel(state, discouragedIds));
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

    // Predictive vision trigger — canvas or heavily duplicated DOM
    if (mode === 'DOM_NORMAL') {
      if (state.hasCanvas) {
        mode = 'DOM_WITH_VISION';
        if (!stuckContext) stuckContext = { goal: nextGoal, url: state.url, trigger: 'canvas detected', failedActions: [] };
        console.log('[cua] Canvas detected — switching to DOM_WITH_VISION');
      } else if (state.duplicateTextCount > 20) {
        mode = 'DOM_WITH_VISION';
        if (!stuckContext) stuckContext = { goal: nextGoal, url: state.url, trigger: `${state.duplicateTextCount} duplicate text elements`, failedActions: [] };
        console.log(`[cua] ${state.duplicateTextCount} duplicate text elements — switching to DOM_WITH_VISION`);
      }
    }

    // Attach screenshot when in vision-assist or burst mode
    if (mode !== 'DOM_NORMAL') {
      try {
        const jpegData = await adapter.screenshotJPEG();
        content.push({ type: 'input_image', image_url: jpegData });
        const recentFailures = stuckContext?.failedActions.slice(-3) ?? [];
        const failureSummary = recentFailures
          .map(f => `- ${f.action} on ${f.target} → ${f.type} (${f.error || 'no error'})`)
          .join('\n') || '(none yet)';
        const forbiddenList = recentFailures
          .map(f => `- DO NOT ${f.action} on ${f.target} (already tried, type=${f.type})`)
          .join('\n');
        const hasStrategyFailure = recentFailures.some(f => f.type === 'STRATEGY_FAILURE');
        const typeHints = [
          recentFailures.some(f => f.type === 'NO_EFFECT_WRONG_TARGET') && '- NO_EFFECT_WRONG_TARGET: element exists but is the wrong one — look for a sibling, parent, or label element',
          recentFailures.some(f => f.type === 'NO_EFFECT_CLICK_BLOCKED') && '- NO_EFFECT_CLICK_BLOCKED: an overlay or modal is blocking — dismiss it first or use coordinates',
          recentFailures.some(f => f.type === 'NO_EFFECT_NOT_INTERACTABLE') && '- NO_EFFECT_NOT_INTERACTABLE: element is disabled — find the enabled version or a triggering button',
          recentFailures.some(f => f.type === 'ELEMENT_NOT_FOUND') && '- ELEMENT_NOT_FOUND: scroll down or check collapsed panels/tabs for the missing element',
          recentFailures.some(f => f.type === 'VALIDATION_ERROR') && '- VALIDATION_ERROR: a form field has bad input — check error messages and correct the value',
          hasStrategyFailure && '- STRATEGY_FAILURE: your entire approach is wrong — try a completely different interaction (e.g. keyboard nav, different section, alternate flow)',
        ].filter(Boolean).join('\n');
        const visionNote = stuckContext
          ? `\n=== STUCK CONTEXT ===\nGoal: ${stuckContext.goal}\nURL: ${stuckContext.url}\nTrigger: ${stuckContext.trigger}\n\n=== FAILED ATTEMPTS ===\n${failureSummary}\n\n=== FORBIDDEN STRATEGIES ===\n${forbiddenList}\n\n=== TYPE-SPECIFIC HINTS ===\n${typeHints || '(none)'}\n\nSTRICT: Use the screenshot to identify a COMPLETELY DIFFERENT element or approach.`
          : '\nScreenshot attached. Use BOTH DOM listing AND screenshot.';
        content.push({ type: 'input_text', text: visionNote });
        console.log(`[cua] Vision attached (mode=${mode})`);
      } catch {}
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

    // ── Confidence-based escalation ─────────────────────────────
    if (typeof action.confidence === 'number') {
      if (action.confidence < 0.5) {
        consecutiveLowConfidence++;
        if (mode === 'DOM_NORMAL') {
          // Single low-confidence turn → vision assist
          console.log(`[cua] Low confidence (${action.confidence}, streak=${consecutiveLowConfidence}) → DOM_WITH_VISION`);
          mode = 'DOM_WITH_VISION';
          if (!stuckContext) stuckContext = { goal: action.next_goal || nextGoal, url: state.url, trigger: `low confidence (${action.confidence})`, failedActions: [] };
        } else if (consecutiveLowConfidence >= 3 && mode === 'DOM_WITH_VISION') {
          // 3+ consecutive low-confidence turns even with vision assist → burst
          console.log(`[cua] Low confidence streak ${consecutiveLowConfidence} turns → VISION_BURST`);
          mode = 'VISION_BURST';
        }
      } else {
        consecutiveLowConfidence = 0;
      }
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
        const skipResult: ValidatedResult = { success: true, effective: false, action: 'type', description: `skipped: field ${action.target} already contains "${action.value.slice(0, 15)}"`, strategyUsed: 'selector', retryStrategy: 'change_target' as any, validation: { urlChanged: false, domChanged: false, valueChanged: false, errorAppeared: false, elementStillExists: true, intentMatch: true }, durationMs: 0 };
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

    // ── Failed target guard ─────────────────────────────────────
    // Hard enforcement: if the model returns a target that's in the last 3
    // stuckContext.failedActions, block execution and advance state machine.
    if (
      stuckContext &&
      action.target &&
      stuckContext.failedActions.slice(-3).some(f => f.target === action.target && f.action === action.action)
    ) {
      console.warn(`[cua] Blocked: model retried failed action-target ${action.action}:${action.target} — forcing replan`);
      consecutiveFailures++;
      stuckContext.failedActions.push({
        action: action.action,
        target: action.target,
        error: 'Blocked: repeated failed action-target',
        type: 'BLOCKED_REPEAT' as FailureType,
        strategy: 'selector' as ExecutionStrategy, // unknown at guard time — default
      });
      if (consecutiveFailures === 1) {
        mode = 'DOM_WITH_VISION';
      } else if (consecutiveFailures >= 2) {
        mode = 'VISION_BURST';
      }
      actionHistory.push({
        turn,
        action: action.action,
        target: action.target,
        value: action.value,
        effective: false,
        description: `BLOCKED: repeated failed target ${action.target}`,
      });
      if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
      const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: action.action }]);
      continue;
    }

    // ── Check abort before executing browser action ────────────
    if (abortSignal?.aborted) {
      return { verdict: 'FAIL', modelMessage: 'Test was aborted by user.', turns: turn, totalTokens };
    }

    // ── Execute through Action Engine (with validation) ─────────
    // Coordinates are only appropriate when click-blocked (overlay) or explicitly forced
    const lastFailureType = stuckContext?.failedActions.slice(-1)[0]?.type;
    const allowCoordinates = !stuckContext || forceStrategySwitch === 'coordinates' || lastFailureType === 'NO_EFFECT_CLICK_BLOCKED';
    let result = await executeValidatedAction(adapter, action, state, {
      forcedStrategy: forceStrategySwitch ?? undefined,
      preferredStrategy: lastSuccessfulStrategy ?? undefined,
      allowCoordinates,
    });

    // Smart "Continue & Run Test" detection: always route through waitForEnabled method
    // The button stays disabled until dropdowns validate server-side (can take 2-5s after select)
    if (action.action === 'click') {
      const clickText = (action.value || '').toLowerCase();
      if (clickText.includes('continue & run test') || clickText.includes('skip run test') ||
          clickText.includes('continue and run') || clickText === 'continue & run test') {
        console.log(`[cua] Detected "Continue & Run Test" click — using clickContinueRunTest (waits for enabled)`);
        const crtResult = await adapter.clickContinueRunTest();
        if (crtResult.success) {
          result = { ...result, success: true, effective: true, description: 'clicked Continue & Run Test (waited for enabled)', error: undefined };
        }
      }
    }

    // Smart event selection: if model clicks on a trigger/action event page,
    // ALWAYS use selectAppyPieEvent to ensure the CORRECT event is selected by text match
    // This prevents the model from clicking the wrong checkbox (e.g. first one instead of target)
    if (action.action === 'click') {
      const clickText = action.value || '';
      const eventPatterns = ['new spreadsheet', 'new opportunity', 'new form', 'new contact', 'create draft', 'create sale', 'new row', 'updated', 'new email', 'send email', 'create user', 'add opportunity'];
      const matchedEvent = eventPatterns.find(p => clickText.toLowerCase().includes(p));
      if (matchedEvent) {
        console.log(`[cua] Detected event selection: "${clickText}" → using selectAppyPieEvent to ensure correct event`);
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

    // Smart variable token insertion — broadened triggers:
    // 1. type action fails + variable hints in reason/value
    // 2. click on "+ Add or Select" text (model trying to open variable picker)
    // 3. click fails on a field that needs dynamic mapping
    if (!result.effective && action.action === 'type' && action.value && action.target) {
      const isVariableHint =
        /variable|token|map|data field|from trigger|add or select|dynamic/i.test(action.reason || '') ||
        /\{\{|from\s+\w+\s+trigger/i.test(action.value);
      if (isVariableHint) {
        const el = state.elements.find(e => e.elementId === action.target);
        const fieldLabel = el?.placeholder || el?.text || el?.attributes['aria-label'] || '';
        if (fieldLabel) {
          console.log(`[cua] Detected variable mapping: "${fieldLabel}" → "${action.value}" — trying insertVariableToken`);
          const tokenResult = await adapter.insertVariableToken(fieldLabel, action.value);
          if (tokenResult.success) {
            result = { ...result, success: true, effective: true, description: `inserted variable token "${action.value}" into "${fieldLabel}"`, error: undefined };
          }
        }
      }
    }

    // Smart variable token: model clicks "+ Add or Select" → use autoFillActionFields to fill ALL empty fields at once
    if (action.action === 'click') {
      const clickVal = (action.value || '').toLowerCase();
      const clickReason = (action.reason || '').toLowerCase();
      if (clickVal.includes('add or select') || clickVal.includes('+ add') ||
          (clickReason.includes('add or select') && clickReason.includes('variable'))) {
        const currentUrl = await adapter.getUrl();
        if (currentUrl.includes('/customeditor/')) {
          console.log(`[cua] Detected "+ Add or Select" click → using autoFillActionFields for all empty fields`);
          const fillResult = await adapter.autoFillActionFields();
          if (fillResult.filled > 0) {
            result = { ...result, success: true, effective: true, description: `auto-filled ${fillResult.filled} fields: ${fillResult.fields.join(', ')}`, error: undefined };
          }
        }
      }
    }

    // If click failed and reason/value mentions "continue & run test", try the dedicated handler
    if (!result.success && action.action === 'click') {
      const failText = ((action.value || '') + ' ' + (action.reason || '')).toLowerCase();
      if (failText.includes('continue & run test') || failText.includes('continue and run test') || failText.includes('skip run test')) {
        console.log(`[cua] Click failed → trying clickContinueRunTest`);
        const crtResult = await adapter.clickContinueRunTest();
        if (crtResult.success) {
          result = { ...result, success: true, effective: true, description: 'clicked Continue & Run Test (waited for enabled)', error: undefined };
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

    // ── Canvas title-edit guard ───────────────────────────────────
    // After any click on the customeditor canvas: check if a title input became focused.
    // If so, blur + Escape to dismiss it and restore the "Add Action App" toolbar.
    if (action.action === 'click' && result.success) {
      try {
        const currentUrl = await adapter.getUrl();
        if (currentUrl.includes('/customeditor/')) {
          const dismissed = await (adapter as any).dismissTitleEdit?.();
          if (dismissed) {
            console.log('[cua] Connect title inline-edit detected after click — dismissed');
          }
        }
      } catch {}
    }

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

    // ── NEW: Feed action result to Vision Decision Engine ──────
    visionEngine.setCurrentTurn(turn);
    const visionActionResult: VisionActionResult = {
      success: result.success,
      effective: result.effective,
      error: result.error,
      urlChanged: result.validation.urlChanged,
      domChanged: result.validation.domChanged,
      valueChanged: result.validation.valueChanged,
      intentMatch: result.validation.intentMatch,
      elementStillExists: result.validation.elementStillExists,
      isNetworkError: !!(result.error && (
        result.error.includes('ECONNREFUSED') || result.error.includes('ETIMEDOUT') ||
        result.error.includes('net::') || result.error.includes('ERR_CONNECTION')
      )),
    };
    const failureType = visionEngine.classifyFailure(visionActionResult, result.error);
    if (failureType) {
      visionEngine.recordFailure({ type: failureType, turn, target: action.target, description: result.description });
    } else if (result.success && result.effective) {
      // Successful action — decay failure history
      visionEngine.recordSuccess();
    }
    // Track progress
    if (result.success && result.effective) {
      if (result.validation.urlChanged) {
        visionEngine.recordProgress('strong');
      } else if (result.validation.domChanged || result.validation.valueChanged) {
        visionEngine.recordProgress('weak');
      }
    }
    // Feedback: if last turn used vision, record effectiveness
    if (lastVisionDecision && lastVisionDecision.mode !== 'dom') {
      visionEngine.recordVisionOutcome(result.validation.domChanged, result.success && result.effective);
      visionEngine.startCooldown();
    }

    // ── State machine failure detection ────────────────────────────
    const isMeaningful = MEANINGFUL_ACTIONS.has(action.action);
    const isFailure = isMeaningful && (!result.success || !!result.error || !result.effective);

    if (!isFailure) {
      // Real progress — full reset
      consecutiveFailures = 0;
      stuckContext = null;
      mode = 'DOM_NORMAL';
      forceStrategySwitch = null;
      lastSuccessfulStrategy = result.strategyUsed;
      // Reset vision burst counter on URL change (real navigation = real progress)
      if (result.validation.urlChanged) visionBurstsUsed = 0;
    } else {
      consecutiveFailures++;
      if (result.success && !result.effective) {
        console.warn(`[cua] No-effect: ${action.action} ${action.target} — "${result.description}"`);
      } else {
        console.warn(`[cua] Action failed: ${result.error}`);
      }

      // Build StuckContext on first failure
      if (!stuckContext) {
        stuckContext = {
          goal: action.next_goal || nextGoal,
          url: await adapter.getUrl(),
          trigger: `${action.action} ${action.target || ''}`.trim(),
          failedActions: [],
        };
        console.log(`[cua] StuckContext created (turn ${turn}): goal="${stuckContext.goal}"`);
      }
      const resolvedEl = state.elements.find(e => e.elementId === (action.target || ''));
      const failureType = classifyFailureType(result, result.validation, resolvedEl?.isInteractable);

      stuckContext.failedActions.push({
        action: action.action,
        target: action.target || '',
        error: result.error || result.description,
        type: failureType,
        strategy: result.strategyUsed,
      });

      // Decay preferred strategy if the strategy that just failed WAS the preferred one
      if (lastSuccessfulStrategy && result.strategyUsed === lastSuccessfulStrategy) {
        console.log(`[cua] Cleared preferredStrategy: ${lastSuccessfulStrategy} just failed — removing bias`);
        lastSuccessfulStrategy = null;
      }

      // Cross-turn strategy failure: same NO_EFFECT type across 3+ different targets
      const recent4 = stuckContext.failedActions.slice(-4);
      const noEffectCount = recent4.filter(f => f.type.startsWith('NO_EFFECT')).length;
      const uniqueTargets = new Set(recent4.map(f => f.target)).size;
      if (noEffectCount >= 3 && uniqueTargets >= 2) {
        stuckContext.failedActions[stuckContext.failedActions.length - 1].type = 'STRATEGY_FAILURE';
        console.warn(`[cua] STRATEGY_FAILURE: ${noEffectCount} NO_EFFECT across ${uniqueTargets} targets — escalating`);
      }

      // Type-driven state transitions
      const lastType = stuckContext.failedActions[stuckContext.failedActions.length - 1].type;
      const isHighConfidenceFailure = typeof action.confidence === 'number' && action.confidence > 0.8;

      if (consecutiveFailures === 1) {
        if (isHighConfidenceFailure || lastType === 'STRATEGY_FAILURE') {
          // Model is confidently wrong OR strategy itself is failing — skip vision assist, burst immediately
          mode = 'VISION_BURST';
          console.log(`[cua] FAIL_1 (${isHighConfidenceFailure ? `high confidence=${action.confidence}` : 'strategy failure'}) → VISION_BURST immediately (turn ${turn})`);
        } else {
          mode = 'DOM_WITH_VISION';
          console.log(`[cua] FAIL_1 → DOM_WITH_VISION (turn ${turn})`);
        }
      } else if (consecutiveFailures >= 2) {
        if (lastType === 'VALIDATION_ERROR') {
          // Validation errors need input fix — vision can't help, stay in assist mode
          mode = 'DOM_WITH_VISION';
          console.log(`[cua] FAIL_${consecutiveFailures} VALIDATION_ERROR → stay DOM_WITH_VISION (turn ${turn})`);
        } else {
          mode = 'VISION_BURST';
          console.log(`[cua] FAIL_${consecutiveFailures} → VISION_BURST (turn ${turn})`);
        }
      }

      // Derive forced strategy for next execution attempt
      // suggestStrategy takes precedence; fall back to same-strategy rotation only if needed
      const suggested = suggestStrategy(lastType);
      if (suggested) {
        forceStrategySwitch = suggested;
        console.log(`[cua] Strategy switch: ${lastType} → force ${forceStrategySwitch}`);
      } else {
        // Same-strategy rotation: if last 2 failures used the same strategy, rotate to next
        const last2 = stuckContext.failedActions.slice(-2);
        if (last2.length === 2 && last2[0].strategy === last2[1].strategy) {
          const rotation: Record<ExecutionStrategy, ExecutionStrategy> = {
            selector: 'text', text: 'coordinates', role: 'coordinates', coordinates: 'selector',
          };
          forceStrategySwitch = rotation[last2[1].strategy];
          console.log(`[cua] Same-strategy rotation: ${last2[1].strategy} → ${forceStrategySwitch}`);
        }
      }

      // Strategy exhaustion: all 3 strategies tried on failures of the same type → force VISION_BURST
      // Only escalate when failures are coherent (same type), not unrelated noise
      const last4Exhaustion = stuckContext.failedActions.slice(-4);
      const triedStrategies = new Set(last4Exhaustion.map(f => f.strategy));
      const coherentFailures = last4Exhaustion.length >= 3 && last4Exhaustion.every(f => f.type === last4Exhaustion[0].type);
      if (coherentFailures && triedStrategies.size >= 3 && mode !== 'VISION_BURST') {
        console.warn(`[cua] All strategies exhausted on ${last4Exhaustion[0].type} (${[...triedStrategies].join(', ')}) → force VISION_BURST`);
        mode = 'VISION_BURST';
      }
    }

    // Non-meaningful loop trap (scroll/wait repeated 5+ times = invisible stuck)
    if (!isMeaningful) {
      consecutiveNonMeaningful++;
      if (consecutiveNonMeaningful >= 5) {
        mode = 'DOM_WITH_VISION';
        consecutiveNonMeaningful = 0;
        consecutiveScrolls = 0;
        if (!stuckContext) {
          stuckContext = {
            goal: nextGoal,
            url: await adapter.getUrl(),
            trigger: `non-meaningful loop (${action.action} repeated 5+ times)`,
            failedActions: [],
          };
        }
        console.log(`[cua] Non-meaningful loop detected → DOM_WITH_VISION`);
      }
    } else {
      consecutiveNonMeaningful = 0;
    }

    // Scroll-specific loop trap: 3 scrolls in a row without DOM fingerprint change
    if (action.action === 'scroll') {
      consecutiveScrolls++;
      if (consecutiveScrolls >= 3) {
        consecutiveScrolls = 0;
        if (mode === 'DOM_NORMAL') {
          mode = 'DOM_WITH_VISION';
          if (!stuckContext) stuckContext = { goal: nextGoal, url: await adapter.getUrl(), trigger: '3 consecutive scrolls without progress', failedActions: [] };
          console.log(`[cua] Scroll loop (3x) → DOM_WITH_VISION`);
        } else if (mode === 'DOM_WITH_VISION') {
          mode = 'VISION_BURST';
          if (!stuckContext) stuckContext = { goal: nextGoal, url: await adapter.getUrl(), trigger: '3 consecutive scrolls in DOM_WITH_VISION', failedActions: [] };
          console.log(`[cua] Scroll loop (3x in DOM_WITH_VISION) → VISION_BURST`);
        }
      }
    } else {
      consecutiveScrolls = 0;
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
      visionUsed: mode !== 'DOM_NORMAL',
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

    // ── Vision Decision Engine (logging only) ───────────────────
    const visionState: VisionBrowserState = {
      elementCount: state.elements.length,
      previousElementCount: previousElementCount,
      hasCanvas: state.hasCanvas,
      duplicateTextCount: state.duplicateTextCount,
      domFingerprint: state.domFingerprint,
      url: await adapter.getUrl(),
    };
    previousElementCount = state.elements.length;

    lastVisionDecision = visionEngine.decide(visionState, action.confidence, allowedDomains, EXTERNAL_TRAPS);
    console.log(`[vision-engine] T${turn} | score=${lastVisionDecision.visionScore.toFixed(2)} mode=${lastVisionDecision.mode} fsm=${mode} | path=[${lastVisionDecision.decisionPath.join(' → ')}] | signals: failure=${lastVisionDecision.signals.failureScore.toFixed(2)} stuck=${lastVisionDecision.signals.stuckDuration.toFixed(2)} | feedback: adj=${lastVisionDecision.feedback.adjustment.toFixed(2)} rate=${lastVisionDecision.feedback.visionSuccessRate}`);

    // ── Vision Burst execution ────────────────────────────────────
    const VISION_BURST_TURNS = 10;

    if (mode === 'VISION_BURST') {
      // Circuit breaker
      if (visionBurstsUsed >= MAX_VISION_BURSTS) {
        return {
          verdict: 'FAIL',
          modelMessage: `VERDICT: FAIL\nSUMMARY: Exhausted ${MAX_VISION_BURSTS} vision bursts without resolving stuck state.\nISSUES: Could not complete: ${stuckContext?.goal || nextGoal} at ${await adapter.getUrl()}`,
          turns: turn, totalTokens,
        };
      }

      visionBurstsUsed++;
      const failSummary = stuckContext?.failedActions.slice(-6)
        .map(f => `${f.action} ${f.target}: ${f.error}`).join('; ') || 'none';

      console.log(`[cua] ═══ VISION BURST ${visionBurstsUsed}/${MAX_VISION_BURSTS}: goal="${stuckContext?.goal}" — delegating ${VISION_BURST_TURNS} turns ═══`);

      const visionInstructions = [
        `CONTEXT: DOM automation failed. You are taking over to unblock ONE step only.`,
        `GOAL: ${stuckContext?.goal || nextGoal}`,
        `STATE: ${agentMemory}`,
        `URL: ${stuckContext?.url || await adapter.getUrl()}`,
        `FAILED APPROACHES (${stuckContext?.failedActions.length || 0} attempts — do NOT repeat these):`,
        `  ${failSummary}`,
        `COMPLETED SO FAR: ${stepsCompleted.length > 0 ? stepsCompleted.join(', ') : 'None'}`,
        `INSTRUCTION: Achieve ONLY the goal above using a completely different approach. Stop as soon as done.`,
        ``,
        `FULL TEST INSTRUCTIONS (context only):`,
        testInstructions,
      ].join('\n');

      try {
        const visionFn = await getVisionLoop();
        const visionResult = await visionFn(
          openai, page, visionInstructions, expectedOutcome,
          screenshotDir, runId, callbacks,
          testAccount, abortSignal,
          VISION_BURST_TURNS,
          tokenBudget - (totalTokens.input + totalTokens.output),
          testUrl,
        );

        totalTokens.input += visionResult.totalTokens.input;
        totalTokens.output += visionResult.totalTokens.output;
        totalTokens.reasoning += visionResult.totalTokens.reasoning;
        turn += visionResult.turns;

        if (visionResult.verdict === 'PASS') {
          console.log(`[cua] Vision burst reported PASS — ignoring (DOM loop judges final result). Resuming DOM.`);
        } else if (visionResult.verdict === 'FAIL') {
          console.log(`[cua] Vision burst reported FAIL — ignoring (was only unsticking). Resuming DOM.`);
        }

        console.log(`[cua] ═══ Vision burst done (${visionResult.turns} turns). Resuming DOM_NORMAL. ═══`);

        // Hard reset after burst
        mode = 'DOM_NORMAL';
        consecutiveFailures = 0;
        consecutiveNonMeaningful = 0;
        consecutiveScrolls = 0;
        stuckContext = null;

        try { state = await adapter.getState(); } catch {}

        actionHistory.push({
          turn, action: 'vision-burst', target: '',
          effective: true,
          description: `Vision burst ${visionBurstsUsed} — ${visionResult.turns} turns used`,
        });
        if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();

        continue;
      } catch (err: any) {
        console.warn(`[cua] Vision burst failed: ${err.message}. Resetting to DOM_NORMAL.`);
        mode = 'DOM_NORMAL';
        consecutiveFailures = 0;
        stuckContext = null;
      }
    }

    // Few elements — force vision next turn
    if (state.elements.length < 3 && mode === 'DOM_NORMAL') {
      mode = 'DOM_WITH_VISION';
      if (!stuckContext) stuckContext = { goal: nextGoal, url: state.url, trigger: 'few DOM elements', failedActions: [] };
    }

    // ── URL-based stuck detection ─────────────────────────────────
    // Catches cases where DOM fingerprint changes (dropdown opens/closes)
    // but the model isn't making real progress toward the goal
    const currentUrlPath = (await adapter.getUrl()).replace(/https?:\/\/[^/]+/, '').split('?')[0];
    if (currentUrlPath === lastUrlPath) {
      sameUrlTurns++;
    } else {
      lastUrlPath = currentUrlPath;
      sameUrlTurns = 0;
      lastProgressTurn = turn; // URL changed = progress
    }

    // Track progress: URL change or effective action = real progress
    if (result.success && result.effective && (result.validation.urlChanged || result.validation.domChanged)) {
      lastProgressTurn = turn;
    }

    // Abort if stuck on same URL too long
    if (sameUrlTurns >= MAX_SAME_URL_TURNS) {
      console.warn(`[cua] URL stuck abort: ${sameUrlTurns} turns on ${currentUrlPath}`);
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: Stuck on same URL for ${sameUrlTurns} turns without making progress.\nISSUES: Could not complete required actions at ${await adapter.getUrl()}`,
        turns: turn, totalTokens,
      };
    }

    // Abort if no real progress for too long
    if (turn - lastProgressTurn >= MAX_NO_PROGRESS_TURNS) {
      console.warn(`[cua] No progress abort: ${turn - lastProgressTurn} turns since last progress (T${lastProgressTurn})`);
      return {
        verdict: 'FAIL',
        modelMessage: `VERDICT: FAIL\nSUMMARY: No meaningful progress for ${turn - lastProgressTurn} turns. Last progress was at turn ${lastProgressTurn}.\nISSUES: Model could not advance the test flow.`,
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
