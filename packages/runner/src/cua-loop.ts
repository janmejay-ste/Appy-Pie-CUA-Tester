import OpenAI from 'openai';
import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { PlaywrightAdapter, executeValidatedAction } from './adapter/index.js';
import type { ActionStep, BrowserState, ActionTarget } from './adapter/types.js';
import type { ValidatedResult, ExecutionStrategy } from './adapter/action-engine.js';
import { deriveValidation } from './adapter/action-engine.js';
import {
  coerceLegacyTarget,
  targetToDisplay,
  targetElementId,
  resolveTargetElement,
  targetsEqual,
} from './adapter/target.js';
import { buildConstraints, formatConstraintsForPrompt } from './decision-engine.js';
import { fieldValueSignatureExpr, normalizeFieldKey } from './interaction/field-probe.js';
import type { DecisionConstraints, Constraint } from './decision-engine.js';
import {
  recordConstraintRespected,
  recordConstraintViolated,
  recordConstraintOutcome,
  recordBucketOutcome,
  autoDisableBadConstraints,
} from './constraint-metrics.js';
import {
  computeSystemHealth,
  formatSystemHealth,
  getSmoothedGlobalProgressRate,
  updateSmoothedGlobalProgressRate,
} from './system-health.js';
import {
  validateState,
  inferValidationRules,
  formatValidation,
  type ValidationRule,
  type ValidationResult,
} from './validation/validator.js';
import type { CUALoopCallbacks, TurnTokenUsage, CUALoopResult, PageState, ScreenshotRecord, TestAccountConfig } from './types.js';
import { VisionDecisionEngine } from './vision-decision.js';
import type { VisionBrowserState, VisionActionResult, VisionDecision } from './vision-decision.js';
import {
  getCachedAction, recordSuccessfulAction, recordFailedAction,
  getCachedSequence, recordSequence, recordFailedSequence,
  getCacheStats, getCacheHealth, resetRunCacheCounters, getRunCacheCounters,
  incrementCacheReject,
  maybeDisableCacheForRun, isRunCacheDisabled, getRunCacheDisabledReason,
  resetOverlayStreak,
  resolveTarget,
  type CachedAction, type DOMElement,
} from './action-cache.js';

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

/**
 * Did the executed action violate a given constraint?
 *   - avoid_action_target: exact signature match on "action target"
 *   - avoid_target: substring match on target display
 *   - avoid_url: post-action URL contains the constrained path
 */
function constraintMatchesAction(
  c: Constraint,
  actionSig: string,
  actionTarget: string,
  postUrl: string,
): boolean {
  if (c.type === 'avoid_action_target') {
    return actionSig.toLowerCase() === c.value.toLowerCase();
  }
  if (c.type === 'avoid_target') {
    return actionTarget.toLowerCase() === c.value.toLowerCase();
  }
  if (c.type === 'avoid_url') {
    const path = postUrl.replace(/https?:\/\/[^/]+/, '').split('?')[0];
    return path.toLowerCase().includes(c.value.toLowerCase());
  }
  return false;
}

// ── Config ──────────────────────────────────────────────────────
const MODEL = 'gpt-5.4';
const DEFAULT_MAX_TURNS = 40;
const MAX_RETRIES_PER_TURN = 2;

// ── System prompt (compact, strict) ─────────────────────────────
const SYSTEM_PROMPT = `You are a QA test executor. Follow the TEST STEPS exactly in order.

Respond ONLY with JSON. Two formats:

SINGLE ACTION (when unsure or complex):
{"action":"click|type|scroll|select|wait|navigate|keypress|done","target":"elementId","value":"","reason":"why","confidence":0.9,"memory":"1-line state","next_goal":"next step","stepsCompleted":["done steps"]}

BATCH ACTIONS (when 2-5 targets are all visible on current page and you're confident):
{"actions":[{"action":"click","target":"id1","value":""},{"action":"type","target":"id2","value":"text"}],"reason":"why","confidence":0.95,"memory":"1-line state","next_goal":"next step","stepsCompleted":["done steps"]}

TARGET SHAPE: "target" accepts either a bare elementId string (e.g. "a1b2c3d4") OR a structured object {"elementId":"a1b2c3d4","text":"optional visible text"}. Prefer the string form when you know the elementId. Use the object form when you want to express BOTH an elementId AND fallback text.

Use BATCH for: login flows (click email→type→click password→type→click login), filling multiple form fields, dismissing modals then clicking next. System executes in order, stops at first failure. Only batch when ALL targets are in the Elements list NOW.

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
12. ACCOUNT SETUP: First check for an account dropdown/select — if one exists, select the first available account from it, then click Continue. If a linked account is shown with a "Continue" button, click Continue immediately. ONLY click "Add an Account" as a LAST RESORT when there is no dropdown AND no Continue button. NEVER click "Change" or "Reconnect" on already-linked accounts.
13. CONNECT WORKFLOW: On action config pages with "+ Add or Select" buttons, click each button and pick the first available option from the picker that opens. If fields show "Items is a required parameter" or similar, scroll down to fill ALL required fields before clicking "Continue & Run Test".
14. DROPDOWN SELECTION: For Appy Pie custom dropdowns (with a small menu icon), click the icon to open, wait for options to load, then click the desired option. If options don't appear, wait 3 seconds and try again.
15. When done: {"action":"done","verdict":"PASS/FAIL","summary":"...","stepsCompleted":[...],"issuesFound":[]}`;

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

/** Parsed model response — either single action or batch */
interface ParsedResponse {
  actions: ActionStep[];
  meta: {
    reason?: string;
    memory?: string;
    next_goal?: string;
    confidence?: number;
    stepsCompleted?: string[];
    verdict?: string;
    summary?: string;
    issuesFound?: string[];
  };
}

function parseModelJSON(text: string): ActionStep | null {
  const parsed = parseModelResponse(text);
  if (!parsed || parsed.actions.length === 0) return null;
  // Return first action for backward compat — batch is accessed via parseModelResponse
  return parsed.actions[0];
}

function parseModelResponse(text: string): ParsedResponse | null {
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
    if (!parsed) return null;

    // Batch format: { actions: [...], reason, memory, ... }
    if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      const validActions = parsed.actions.filter(
        (a: any) => a && typeof a.action === 'string',
      ) as ActionStep[];
      if (validActions.length === 0) return null;
      // Propagate top-level meta + normalize target shape to structured ActionTarget
      for (const a of validActions) {
        if (!a.confidence && parsed.confidence) a.confidence = parsed.confidence;
        if (!a.memory && parsed.memory) a.memory = parsed.memory;
        if (!a.next_goal && parsed.next_goal) a.next_goal = parsed.next_goal;
        if (!a.stepsCompleted && parsed.stepsCompleted) a.stepsCompleted = parsed.stepsCompleted;
        a.target = coerceLegacyTarget(a.target);
      }
      return {
        actions: validActions,
        meta: {
          reason: parsed.reason,
          memory: parsed.memory,
          next_goal: parsed.next_goal,
          confidence: parsed.confidence,
          stepsCompleted: parsed.stepsCompleted,
          verdict: parsed.verdict,
          summary: parsed.summary,
          issuesFound: parsed.issuesFound,
        },
      };
    }

    // Single format: { action: "click", target: ..., ... }
    if (typeof parsed.action === 'string') {
      const single = parsed as ActionStep;
      single.target = coerceLegacyTarget(single.target);
      return {
        actions: [single],
        meta: {
          reason: parsed.reason,
          memory: parsed.memory,
          next_goal: parsed.next_goal,
          confidence: parsed.confidence,
          stepsCompleted: parsed.stepsCompleted,
          verdict: parsed.verdict,
          summary: parsed.summary,
          issuesFound: parsed.issuesFound,
        },
      };
    }

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
  /** Optional declarative validation rules run after the model emits PASS/FAIL. */
  validationRules?: import('./validation/validator.js').ValidationRule[],
): Promise<CUALoopResult> {
  if (mode === 'vision') {
    const visionFn = await getVisionLoop();
    return visionFn(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl);
  }
  return runCUALoopDOM(openai, page, testInstructions, expectedOutcome, screenshotDir, runId, callbacks, testAccount, abortSignal, maxTurns, tokenBudget, testUrl, validationRules);
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
  validationRules?: import('./validation/validator.js').ValidationRule[],
): Promise<CUALoopResult> {
  // ── Create adapter (CUA never touches Playwright directly) ─────
  const adapter = new PlaywrightAdapter(page, testAccount ? { email: testAccount.email, password: testAccount.password } : undefined);
  const totalTokens = { input: 0, output: 0, reasoning: 0 };

  // Cache observability — reset per-run counters and emit a health snapshot
  // at loop-start so we can tell at a glance whether the on-disk cache is
  // healthy (usable vs rejected ratios) before the run even begins.
  resetRunCacheCounters();
  // Reset transient-overlay streak so cache key discrimination on overlay
  // state is based on this run's observations only (prevents a phantom
  // streak carrying over from the previous test's final modal).
  resetOverlayStreak();
  const cacheStats = getCacheStats();
  const cacheHealth = getCacheHealth();
  if (cacheStats.singles > 0 || cacheStats.sequences > 0) {
    console.log(
      `[cua] Action cache: ${cacheStats.singles} singles (${cacheHealth.usable} usable, ` +
      `${cacheHealth.rejectedLowSuccess} lowSuccess, ${cacheHealth.rejectedTooManyFailures} tooManyFailures, ` +
      `${cacheHealth.rejectedStale} stale), ${cacheStats.sequences} sequences, ` +
      `${cacheStats.totalHits} lifetime hits`,
    );
  }
  // Auto-disable constraints the metrics layer has flagged as counterproductive.
  // Uses the EMA-smoothed global progress baseline so lift normalization is
  // stable across runs (single-run jitter won't flip lifecycle decisions).
  autoDisableBadConstraints({ globalProgressRate: getSmoothedGlobalProgressRate() });

  // Graded: cache tier is set once per run based on on-disk health.
  //   full     (≥ 80%): singles + sequences, standard threshold
  //   cautious (50-80%): singles only, +2 successCount floor
  //   strict   (20-50%): singles only, +5 successCount floor
  //   disabled (< 20%): no cache reads
  // This prevents the ON/OFF oscillation a single threshold would create.
  const cacheDecision = maybeDisableCacheForRun();
  if (cacheDecision.tier !== 'full') {
    const label = cacheDecision.tier === 'disabled' ? 'DISABLED' : `tier=${cacheDecision.tier}`;
    console.warn(`[cua] Cache ${label} for this run — ${cacheDecision.reason}`);
  }

  // ── State machine ───────────────────────────────────────────────
  let mode: Mode = 'DOM_NORMAL';
  let consecutiveFailures = 0;
  let consecutiveNonMeaningful = 0;  // catches scroll/wait loops
  let consecutiveScrolls = 0;        // scroll-specific: 3 in a row without DOM change = stuck

  // System-health inputs — feed computeSystemHealth() at end of run.
  let totalTurnsExecuted = 0;
  let effectiveTurnsExecuted = 0;

  // PR C: track the turn at which URL pattern most recently changed so the
  // constraint builder can drop stale cross-page constraints.
  // PR C-v2: also track a "soft-nav" flag — SPA routes can change URL
  // without meaningfully changing the UI. If the new page's top-text set
  // overlaps the previous page's > threshold, we treat it as context-
  // preserving and do NOT bump lastUrlChangeTurn (constraints survive).
  let lastUrlChangeTurn = 0;
  let lastSeenUrlPattern = '';
  let lastSeenTopTexts: Set<string> = new Set();
  const DOM_SIMILARITY_THRESHOLD = 0.7;

  // PR D + D-v2: predictive early-stagnation detection AND self-correction.
  // Fires once per run the first time we see N consecutive no-progress turns.
  // Self-correction: skips cache for STAGNATION_RECOVERY_TURNS turns so GPT
  // gets fresh control, forcing a re-evaluation of test-step progress.
  let noProgressStreak = 0;
  let earlyStagnationEmitted = false;
  let stagnationRecoveryTurnsRemaining = 0;
  const EARLY_STAGNATION_THRESHOLD = 3;
  const STAGNATION_RECOVERY_TURNS = 2;
  let stuckContext: StuckContext | null = null;
  let visionBurstsUsed = 0;
  const MAX_VISION_BURSTS = 6;

  // Actions where no-effect counts as a real failure
  const MEANINGFUL_ACTIONS = new Set(['click', 'type', 'select', 'navigate', 'keypress']);

  // Action repeat detection (safety — kept separate from stuck detection)
  let lastActionSig = '';
  let consecutiveSameAction = 0;

  // Cache loop guard — skip cache after N consecutive cache-only turns
  // to let GPT re-evaluate which test step we're actually on
  let consecutiveCacheHits = 0;
  const MAX_CONSECUTIVE_CACHE_HITS = 2;
  let lastTurnWasGPT = false; // Skip cache on the turn after GPT acts, so GPT can see its action's result

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

  // ── Visited URLs tracker (prevents backward-navigation cache loops) ──
  // Tracks URL paths we've progressed past. If a cache/batch action sends us
  // backward to a visited URL, flush the batch and force GPT.
  const visitedUrlPaths = new Set<string>();

  // ── NEW: Vision Decision Engine (parallel — log only, don't act) ──
  const visionEngine = new VisionDecisionEngine();
  let previousElementCount = 0;
  let lastVisionDecision: VisionDecision | null = null;

  // Agent memory (overwritten each turn, NOT accumulated)
  let agentMemory = 'Starting test';
  let nextGoal = 'Begin test instructions';
  let stepsCompleted: string[] = [];
  let lastResult: ValidatedResult | null = null;

  // ── Multi-action batch queue ──────────────────────────────────
  // When GPT returns an actions array, remaining actions are queued here.
  // Next turns consume from queue without calling GPT.
  let pendingBatchActions: ActionStep[] = [];
  let isBatchTurn = false; // true when executing from batch queue

  // ── Sequence recording ────────────────────────────────────────
  // Track successful actions on current page for sequence caching
  let currentPageKey = ''; // changes on URL change
  let currentPageTitle = '';
  let pageActionSequence: Array<{ action: string; targetText: string; targetTag: string; value: string; confidence: number }> = [];

  // ── Rolling action history (prevents loops) ─────────────────
  // Keeps last N turns. Structured form (signals + source) enables the picker
  // and learning layer (PR 8+). Legacy flat fields (target as display string,
  // etc.) preserved so existing prompt builders and log readers keep working.
  const ACTION_HISTORY_SIZE = 15;
  interface HistoryEntry {
    turn: number;
    // Legacy flat fields — consumed by prompt builder, runlog, etc.
    action: string;
    target: string;
    value?: string;
    effective: boolean;
    description: string;
    // Structured fields (new) — consumed by DecisionEngine / picker / learning.
    step?: ActionStep;
    signals?: { urlChanged: boolean; domChanged: boolean; valueChanged: boolean };
    source?: 'cache-single' | 'cache-sequence' | 'batch-queue' | 'gpt' | 'skipped';
    mode?: Mode;
  }
  const actionHistory: HistoryEntry[] = [];

  // ── FIX E: completed-field tracker ─────────────────────────────
  // Map<normalizedLabel, { filledSignature }>. Populated when a CUSTOM_DROPDOWN
  // / VARIABLE_PICKER / SELECTABLE_LIST_ITEM fires with success=true AND
  // effective=true on a given label. On re-click check we re-probe the field
  // signature — if the CURRENT signature still matches the stored filled one,
  // the field is still set → block. If it differs (page moved, value cleared,
  // different form) → drop the entry and allow. This is "block ONLY when
  // state hasn't changed since completion" per user feedback.
  const completedFields = new Map<string, { filledSignature: string; urlAt: string }>();

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

  // Check if auto-login already fired (adapter sets flag when it fills credentials)
  const autoLoginFired = adapter.autoLoginCompleted;
  if (autoLoginFired) {
    console.log(`[cua] Auto-login completed — skipping login steps in prompt`);
  }

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

    // Hoisted so the post-action block can record constraint outcomes
    // against GPT's chosen action. null on cache-hit turns.
    let turnConstraints: DecisionConstraints | null = null;

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

    // ── Prepare cache elements ────────────────────────────────────
    const cacheElements: DOMElement[] = state.elements.map(e => ({
      tag: e.tag, text: e.text, elementId: e.elementId,
      placeholder: e.placeholder, type: e.type,
    }));
    const pageTitle = state.title || '';
    isBatchTurn = false;

    // ── Check batch queue first (remaining actions from multi-action response) ──
    let batchAction: ActionStep | null = null;
    if (pendingBatchActions.length > 0 && mode === 'DOM_NORMAL' && consecutiveFailures === 0) {
      // Safety: verify the target element still exists in current DOM before executing
      const nextBatch = pendingBatchActions[0];
      const targetStillExists = !nextBatch.target ||
        resolveTargetElement(nextBatch.target, state.elements) !== null;
      if (targetStillExists) {
        batchAction = pendingBatchActions.shift()!;
        console.log(`[cua] T${turn} BATCH → ${batchAction.action} ${targetToDisplay(batchAction.target) || batchAction.value} (${pendingBatchActions.length} remaining)`);
        isBatchTurn = true;

        callbacks.onTurnComplete(turn, 0, { ...totalTokens });
        callbacks.onTurnTokens({
          turn, input: 0, output: 0, reasoning: 0, apiLatencyMs: 0,
          cumulativeInput: totalTokens.input, cumulativeOutput: totalTokens.output,
          cumulativeReasoning: totalTokens.reasoning, mode: 'dom',
        });
      } else {
        // Target element gone — page state changed, batch is stale
        console.warn(`[cua] Batch target "${targetToDisplay(nextBatch.target)}" not found in DOM — flushing ${pendingBatchActions.length} batch actions`);
        pendingBatchActions = [];
      }
    }

    // ── Check sequence cache (replay entire flows without GPT) ──
    // Observability: record the reason we skipped cache this turn (if any).
    // PR D-v2: during stagnation recovery, cache is bypassed so GPT gets
    // fresh control — self-correcting response to 3 consecutive no-progress turns.
    const inStagnationRecovery = stagnationRecoveryTurnsRemaining > 0;
    const cacheSkipReason: 'notEligible' | 'loopGuard' | 'afterGPT' | null =
      inStagnationRecovery ? 'notEligible'
      : (mode !== 'DOM_NORMAL' || !!stuckContext || consecutiveFailures !== 0) ? 'notEligible'
      : consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS ? 'loopGuard'
      : lastTurnWasGPT ? 'afterGPT'
      : null;
    if (!isBatchTurn && pendingBatchActions.length === 0 && cacheSkipReason) {
      incrementCacheReject(cacheSkipReason);
    }
    if (!isBatchTurn && pendingBatchActions.length === 0 && !inStagnationRecovery &&
        mode === 'DOM_NORMAL' && !stuckContext && consecutiveFailures === 0 &&
        consecutiveCacheHits < MAX_CONSECUTIVE_CACHE_HITS && !lastTurnWasGPT) {
      const cachedSeq = getCachedSequence(state.url, pageTitle, cacheElements);
      if (cachedSeq) {
        console.log(`[cua] T${turn} SEQUENCE HIT → "${cachedSeq.description}" (${cachedSeq.actions.length} actions)`);
        consecutiveCacheHits++;
        // Queue all sequence actions as a batch — first one is this turn's action
        const seqActions: ActionStep[] = cachedSeq.actions.map(a => ({
          action: a.action as any,
          target: a.resolvedTarget || a.targetText,
          value: a.value,
          confidence: a.confidence,
        }));
        batchAction = seqActions[0];
        pendingBatchActions = seqActions.slice(1);
        isBatchTurn = true;

        callbacks.onTurnComplete(turn, 0, { ...totalTokens });
        callbacks.onTurnTokens({
          turn, input: 0, output: 0, reasoning: 0, apiLatencyMs: 0,
          cumulativeInput: totalTokens.input, cumulativeOutput: totalTokens.output,
          cumulativeReasoning: totalTokens.reasoning, mode: 'dom',
        });
      }
    }

    // ── Check single action cache ──────────────────────────────
    if (!isBatchTurn && pendingBatchActions.length === 0 && !inStagnationRecovery &&
        mode === 'DOM_NORMAL' && !stuckContext && consecutiveFailures === 0 &&
        consecutiveCacheHits < MAX_CONSECUTIVE_CACHE_HITS && !lastTurnWasGPT) {
      const cachedAction = getCachedAction(state.url, pageTitle, cacheElements);
      if (cachedAction) {
        const target = cachedAction.resolvedTarget || cachedAction.targetText;
        console.log(`[cua] T${turn} CACHE HIT → ${cachedAction.action} "${cachedAction.targetText}" (${cachedAction.successCount}x success, saved ~5s)`);
        consecutiveCacheHits++;
        lastTurnWasGPT = false;
        isBatchTurn = true;

        callbacks.onTurnComplete(turn, 0, { ...totalTokens });
        callbacks.onTurnTokens({
          turn, input: 0, output: 0, reasoning: 0, apiLatencyMs: 0,
          cumulativeInput: totalTokens.input, cumulativeOutput: totalTokens.output,
          cumulativeReasoning: totalTokens.reasoning, mode: 'dom',
        });

        const step: ActionStep = { action: cachedAction.action as any, target, value: cachedAction.value };
        const result = await executeValidatedAction(adapter, step, state);
        const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved, {
          action: { type: step.action, target: targetToDisplay(step.target), value: step.value },
          result: { success: result.success, error: result.error, description: result.description },
          validation: result.validation, effective: result.effective,
          memory: agentMemory, nextGoal: nextGoal,
        });
        callbacks.onActionsExecuted(turn, [{ type: step.action }]);

        if (result.effective) {
          recordSuccessfulAction(state.url, pageTitle, cacheElements,
            { action: cachedAction.action, target, value: cachedAction.value, confidence: cachedAction.confidence },
            result.description, true);
          consecutiveFailures = 0;
          // Update action sig so cache actions break GPT repeat detection
          lastActionSig = `${cachedAction.action}:${target}:${(cachedAction.value || '').slice(0, 20)}`;
          consecutiveSameAction = 0;
          lastResult = result;
          state = await adapter.getState();
          continue;
        } else {
          recordFailedAction(state.url, pageTitle, cacheElements);
          console.log(`[cua] Cache miss (no effect) — falling through to AI`);
          lastResult = result;
          isBatchTurn = false; // fall through to GPT
        }
      }
    }

    // ── BATCH FAST PATH: skip GPT entirely for queued/cached actions ──
    let action: ActionStep | null = null;
    if (isBatchTurn && batchAction) {
      action = batchAction;
      // Flush batch if action failed on previous turn
      if (consecutiveFailures > 0) {
        console.log(`[cua] Flushing batch queue (${pendingBatchActions.length} actions) due to failure`);
        pendingBatchActions = [];
        isBatchTurn = false;
        action = null; // fall through to GPT
      }
    }

    if (!action) {
    // GPT is deciding — next turn should skip cache so GPT sees the result
    lastTurnWasGPT = true;

    // Cache loop guard — keep GPT in control until URL changes (navigation advances)
    let cacheLoopWarning = '';
    if (consecutiveCacheHits >= MAX_CONSECUTIVE_CACHE_HITS) {
      console.log(`[cua] T${turn} Cache loop guard — ${consecutiveCacheHits} consecutive cache hits, letting GPT re-evaluate test step`);
      // Build a summary of unique pages visited from action history
      const visitedPages = actionHistory
        .filter(h => h.effective)
        .map(h => h.description)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(-6);
      const visitedSummary = visitedPages.length > 0
        ? `\nPages/actions already completed: ${visitedPages.join(', ')}`
        : '';
      cacheLoopWarning = `\n=== IMPORTANT: CACHE LOOP DETECTED ===\nThe action cache has been repeating the same navigation pattern for ${consecutiveCacheHits} turns.\nThese cached actions already completed earlier test steps. Do NOT repeat them.\nLook at the ACTION HISTORY below — identify which steps are ALREADY DONE and ADVANCE to the NEXT UNCOMPLETED step.\nCRITICAL: If you have already navigated to a page (Pricing, Integrations, etc.) in the history, that step is DONE. Pick a DIFFERENT page you have NOT visited yet.\nIF ALL STEPS ARE COMPLETE: Use action "done" with verdict "PASS" immediately. Do not repeat navigation you have already verified.${visitedSummary}\n`;
      // Don't reset — GPT stays in control. Reset happens below when URL changes after action execution.
    } else {
      consecutiveCacheHits = 0;
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

    // If auto-login fired, tell the model to skip login steps
    if (autoLoginFired) {
      promptParts.push(`NOTE: Login was completed automatically. Credentials were filled and submitted. Skip ALL login steps and proceed directly to the first post-login step.`);
    }

    // TEST STEPS go FIRST — they are the primary instruction
    promptParts.push(`=== TEST STEPS (follow in order) ===`);
    promptParts.push(testInstructions);
    promptParts.push(`=== EXPECTED OUTCOME ===`);
    promptParts.push(expectedOutcome);
    promptParts.push(`=== PROGRESS ===`);
    promptParts.push(`Completed: ${stepsCompleted.length > 0 ? stepsCompleted.join(', ') : 'None yet'}`);
    promptParts.push(`Turn: ${turn}/${maxTurns}`);
    // FIX 2 (step completion detection): expose the completed-field set to the
    // model. Without this signal the LLM doesn't know "Worksheet is already
    // picked" and keeps emitting wait/wait/retry, stalling the run. Re-probe
    // live signatures here so we only list fields whose value is STILL set
    // (guards against stale entries after navigation).
    if (completedFields.size > 0) {
      const stillCompleted: string[] = [];
      for (const [key, record] of completedFields) {
        const currentSig = (await adapter.evaluateExpr<string>(fieldValueSignatureExpr(key))) || '';
        if (currentSig.length > 0 && currentSig === record.filledSignature) {
          stillCompleted.push(key);
        } else if (currentSig !== record.filledSignature) {
          // Stale — drop it
          completedFields.delete(key);
        }
      }
      if (stillCompleted.length > 0) {
        // Stronger phrasing: model was ignoring the advisory line in prior runs.
        // State this as a HARD constraint the model is expected to obey.
        promptParts.push(`=== FIELDS ALREADY COMPLETED (HARD CONSTRAINT) ===`);
        promptParts.push(`These fields are already filled with valid values: ${stillCompleted.join(', ')}`);
        promptParts.push(`You MUST NOT click, type into, or wait on these fields. Move to the NEXT unfilled step (e.g. Continue & Run Test, next dropdown, or submit).`);
      }
    }
    promptParts.push('');

    // ── Constraints (PR 5c): tell GPT explicitly what NOT to try ──────
    // Built from the same data the post-hoc loop guards check — but delivered
    // PROACTIVELY, with severity tiers so GPT avoids critical mistakes first.
    // Capped per-category so the prompt stays clean even on long runs.
    const constraints = buildConstraints({
      turn,
      recentHistory: actionHistory.slice(-5).map(h => ({
        action: h.action, target: h.target, effective: h.effective, turn: h.turn,
      })),
      stuckFailedActions: stuckContext?.failedActions.slice(-3).map(f => ({
        action: f.action, target: f.target,
      })) || [],
      visitedUrlPaths,
      goal: nextGoal || '',
      // PR C: drop stale constraints from before the most recent URL change.
      lastUrlChangeTurn,
    });
    turnConstraints = constraints;   // hoisted — used by effectiveness tracker below
    const constraintsBlock = formatConstraintsForPrompt(constraints);
    if (constraintsBlock) {
      promptParts.push(constraintsBlock);
      promptParts.push('');
    }
    promptParts.push('CURRENT PAGE STATE:');
    // Mark recently-failed targets as [DISCOURAGED] instead of removing them —
    // keeps options visible but deprioritized so model can use them if truly necessary
    const discouragedIds = stuckContext && stuckContext.failedActions.length > 0
      ? new Set(stuckContext.failedActions.slice(-3).map(f => f.target).filter(Boolean))
      : undefined;
    promptParts.push(formatStateForModel(state, discouragedIds));
    promptParts.push('');

    // ── Cache loop warning (injected when cache guard triggered) ──
    if (cacheLoopWarning) {
      promptParts.push(cacheLoopWarning);
    }

    // ── Action history — gives model full awareness of what it tried ──
    if (actionHistory.length > 0) {
      promptParts.push(`=== ACTION HISTORY (last ${actionHistory.length} actions) ===`);
      // Show all history entries with clear effective/ineffective markers
      for (const h of actionHistory) {
        const marker = h.effective ? 'OK' : 'NO-EFFECT';
        const valStr = h.value ? ` value="${h.value}"` : '';
        promptParts.push(`  T${h.turn}: ${h.action} ${h.target}${valStr} → [${marker}] ${h.description}`);
      }

      // Detect repeated actions — warn GPT to try something different
      const actionCounts: Record<string, number> = {};
      for (const h of actionHistory) {
        if (h.effective) {
          const key = `${h.action} ${h.target}`;
          actionCounts[key] = (actionCounts[key] || 0) + 1;
        }
      }
      const repeatedActions = Object.entries(actionCounts)
        .filter(([, count]) => count >= 3)
        .map(([key, count]) => `${key} (${count}x)`);
      if (repeatedActions.length > 0) {
        promptParts.push(`\nWARNING: You have repeated these actions multiple times: ${repeatedActions.join(', ')}`);
        promptParts.push(`These steps are ALREADY COMPLETED. Do NOT repeat them. Choose a DIFFERENT action to advance to the next uncompleted step.`);
        promptParts.push(`If ALL test steps are done, use action "done" with verdict "PASS".`);
        promptParts.push('');
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

    // ── Adaptive reasoning effort ─────────────────────────────────
    // 'high' only when stuck or vision mode — saves ~1-3s per turn on easy actions
    const reasoningEffort: string =
      mode !== 'DOM_NORMAL' || consecutiveFailures >= 2 ? 'high' :
      consecutiveFailures === 1 || stuckContext ? 'medium' :
      'low';

    try {
      const response = await openai.responses.create({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content }],
        reasoning: { effort: reasoningEffort as any },
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
    action = parseModelJSON(responseText);

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

    // ── Queue remaining batch actions from multi-action response ──
    if (!isBatchTurn) {
      const fullResponse = parseModelResponse(responseText);
      if (fullResponse && fullResponse.actions.length > 1) {
        // Model returned multiple actions — queue the rest
        pendingBatchActions = fullResponse.actions.slice(1);
        console.log(`[cua] T${turn} MULTI-ACTION: ${fullResponse.actions.length} actions, queued ${pendingBatchActions.length} for next turns`);
      }
    }

    } // end if (!action) — GPT call block

    // At this point 'action' is guaranteed non-null (from batch, cache, or GPT)

    // Validate action type
    const validActions = ['click', 'type', 'scroll', 'select', 'wait', 'navigate', 'keypress', 'done'];
    if (!validActions.includes(action!.action)) {
      console.warn(`[cua] Invalid action: ${action!.action}`);
      lastResult = null;
      consecutiveFailures++;
      pendingBatchActions = []; // flush batch on invalid action
      const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
      callbacks.onScreenshot(turn, saved);
      callbacks.onActionsExecuted(turn, [{ type: action!.action }]);
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

      // ── Hard-verification layer ──────────────────────────────
      // Run declarative rules against actual page state. If partial UI load
      // is detected (elements < 5), wait 2s and retry once — protects
      // against false negatives on slow-hydrating pages.
      const rules: ValidationRule[] = validationRules && validationRules.length > 0
        ? validationRules
        : inferValidationRules(expectedOutcome, state.url);
      let systemValidation: ValidationResult | undefined;
      if (rules.length > 0) {
        let stateForValidation = state;
        if (stateForValidation.elements.length < 5) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            stateForValidation = await adapter.getState();
          } catch { /* fall through with stale state */ }
        }
        systemValidation = validateState(stateForValidation, rules);
        console.log(formatValidation(systemValidation));
      } else {
        console.log('[validation] no rules defined or inferred — model verdict accepted');
      }

      const rawVerdict = action.verdict === 'PASS' ? 'PASS' : 'FAIL';
      // Filter out transient network errors — only real functional issues affect the verdict
      const transientPattern = /\b(503|502|504|500|timeout|network.?error|transient|ECONNRESET|ECONNREFUSED|blank.?(empty|content)|empty.?blank)\b/i;
      const allIssues = action.issuesFound || [];
      const functionalIssues = allIssues.filter((issue: string) => !transientPattern.test(issue));
      const transientIssues = allIssues.filter((issue: string) => transientPattern.test(issue));
      const summaryText = action.summary || action.reason || '';
      const summaryHasOnlyTransient = transientPattern.test(summaryText) &&
        !/\b(missing|broken|crash|not found|wrong|incorrect|unexpected)\b/i.test(summaryText);

      let finalVerdict: string;
      if (rawVerdict === 'PASS' && functionalIssues.length) {
        // Model said PASS but has real functional issues → FAIL
        finalVerdict = 'FAIL';
      } else if (rawVerdict === 'FAIL' && functionalIssues.length === 0) {
        // Model said FAIL but no real functional issues found
        // Check: either all issues are transient, or summary only mentions transient problems
        if (transientIssues.length > 0 || summaryHasOnlyTransient) {
          finalVerdict = 'PASS';
          console.log(`[cua] Verdict override: FAIL→PASS (${transientIssues.length} transient issues, summary-only-transient=${summaryHasOnlyTransient})`);
        } else {
          finalVerdict = rawVerdict;
        }
      } else {
        finalVerdict = rawVerdict;
      }

      const issuesSummary = functionalIssues.length
        ? `ISSUES: ${functionalIssues.join(', ')}`
        : transientIssues.length
          ? `WARNINGS (transient): ${transientIssues.join(', ')}`
          : 'ISSUES: None';

      // ── Combine model verdict with system validation ─────────
      // PASS only when BOTH the model claims success AND the validator
      // passes (or no rules were defined). If the model said PASS but the
      // validator caught a missing signal, we override to FAIL.
      const modelVerdictFinal: 'PASS' | 'FAIL' = finalVerdict === 'PASS' ? 'PASS' : 'FAIL';
      let overallVerdict: 'PASS' | 'FAIL' = modelVerdictFinal;
      let validationFailedIssues: string[] = [];
      if (systemValidation && !systemValidation.passed && modelVerdictFinal === 'PASS') {
        overallVerdict = 'FAIL';
        validationFailedIssues = systemValidation.checks
          .filter(c => !c.passed)
          .map(c => c.detail || `${c.rule.type}:${c.rule.value}`);
        console.warn(`[validation] OVERRIDE: model said PASS, system validation FAILED → final FAIL`);
      }

      const extendedIssues = [
        ...functionalIssues,
        ...validationFailedIssues.map(i => `validation: ${i}`),
      ];
      const finalIssuesSummary = extendedIssues.length
        ? `ISSUES: ${extendedIssues.join(', ')}`
        : transientIssues.length
          ? `WARNINGS (transient): ${transientIssues.join(', ')}`
          : 'ISSUES: None';

      return {
        verdict: overallVerdict as any,
        modelVerdict: modelVerdictFinal,
        modelMessage: [
          `VERDICT: ${overallVerdict}`,
          `MODEL VERDICT: ${modelVerdictFinal}`,
          systemValidation
            ? `SYSTEM VALIDATION: ${systemValidation.passed ? 'PASS' : 'FAIL'} (${(systemValidation.score * 100).toFixed(0)}%)`
            : 'SYSTEM VALIDATION: skipped (no rules)',
          `SUMMARY: ${action.summary || action.reason}`,
          `STEPS_COMPLETED: ${(action.stepsCompleted || stepsCompleted).join(', ')}`,
          finalIssuesSummary,
        ].join('\n'),
        turns: turn,
        totalTokens,
        systemValidation,
      };
    }

    // ── Memory enforcement — block redundant actions ────────────
    if (action.action === 'type' && action.target && action.value) {
      // If form already has this value filled, skip
      const actionTargetId = targetElementId(action.target);
      const actionTargetDisplay = targetToDisplay(action.target);
      const existingVal = (actionTargetId && state.formValues[actionTargetId]) || '';
      if (existingVal && existingVal.includes(action.value.slice(0, 15))) {
        console.log(`[cua] Memory enforcement: field ${actionTargetDisplay} already contains "${action.value.slice(0, 15)}". Skipping.`);
        const noopSignals = { urlChanged: false, domChanged: false, valueChanged: false };
        const noopDetails = { errorAppeared: false, elementStillExists: true, intentMatch: true };
        const skipResult: ValidatedResult = {
          success: true, effective: false, action: 'type',
          description: `skipped: field ${actionTargetDisplay} already contains "${action.value.slice(0, 15)}"`,
          strategyUsed: 'selector', retryStrategy: 'change_target' as any,
          signals: noopSignals, details: noopDetails,
          validation: deriveValidation(noopSignals, noopDetails),
          durationMs: 0,
        };
        lastResult = skipResult;
        // Record in history so model knows and stops retrying
        actionHistory.push({
          turn, action: 'type', target: actionTargetDisplay,
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
    const actionTargetDisplayForSig = targetToDisplay(action.target);
    const actionSig = `${action.action}:${actionTargetDisplayForSig}:${(action.value || '').slice(0, 20)}`;
    if (actionSig === lastActionSig) {
      consecutiveSameAction++;
      if (consecutiveSameAction >= 5) {
        console.warn(`[cua] Action loop (${consecutiveSameAction} repeats). Aborting.`);
        return {
          verdict: 'FAIL',
          modelMessage: `VERDICT: FAIL\nSUMMARY: Test aborted — repeated same action ${consecutiveSameAction} times.\nISSUES: Loop on ${action.action} ${actionTargetDisplayForSig} at ${await adapter.getUrl()}`,
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
      stuckContext.failedActions.slice(-3).some(f => f.target === actionTargetDisplayForSig && f.action === action.action)
    ) {
      console.warn(`[cua] Blocked: model retried failed action-target ${action.action}:${actionTargetDisplayForSig} — forcing replan`);
      consecutiveFailures++;
      stuckContext.failedActions.push({
        action: action.action,
        target: actionTargetDisplayForSig,
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
        target: actionTargetDisplayForSig,
        value: action.value,
        effective: false,
        description: `BLOCKED: repeated failed target ${actionTargetDisplayForSig}`,
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

    // ── FIX C: cap blind waits ──────────────────────────────────
    // Model-emitted `wait <ms>` is frequently a blind 3000/5000ms burn.
    // Those turns produce eff=0 and contribute nothing toward progress.
    // Cap at 1500ms — enough slack for network/render/async dropdown load,
    // short enough to force the model to find real progress signals rather
    // than paper over async UI with long sleeps.
    if (action.action === 'wait' && action.value) {
      const requestedMs = parseInt(action.value, 10);
      if (!Number.isNaN(requestedMs) && requestedMs > 1500) {
        console.log(`[cua] Cap wait ${requestedMs}ms → 1500ms (FIX C: no blind waits)`);
        action.value = '1500';
      }
    }

    // ── FIX F: state-driven wait rejection (SYSTEM STATE > LLM) ──
    // Run 1113dea4 failed because the LLM emitted wait→click→wait→click with
    // ~30% wait ratio while state probes (optionsReady: true, dropdownOpen: true)
    // already showed the UI was ready to interact. Ban waits when the page
    // already presents something actionable. This is NOT a cap — it's a REJECT.
    // The model is forced to re-plan with guidance: "state is ready, pick an
    // option instead of waiting".
    if (action.action === 'wait') {
      const readinessProbe = `
        (() => {
          try {
            // Signal A: a dropdown menu is open AND has rendered option items
            const menu = document.querySelector('.editoption-dropmenu.active_menu, .menu.menu_active');
            const menuOpenWithOptions = !!menu && menu.querySelectorAll('.menu_dropdown-option, li.choice').length > 0;
            // Signal B: a picker overlay is open AND its search input is focusable
            const overlay = document.querySelector('[id^="MultipleCustomEditor"].open, [id^="Custom_value_Advanced"].open');
            const overlayReady = !!overlay && !!overlay.querySelector('.choices-search input, input[placeholder*="earch"]');
            // Signal C: visible options list on the page (app list panel rendered)
            const appCardsVisible = document.querySelectorAll('.app-card, .app-tile, .chooseapps li').length > 2;
            // Signal D: page is stable (no pending top-level fetch-style loader)
            const loaderVisible = !!document.querySelector('.loader:not([style*="display: none"]), .spinner:not([style*="display: none"]), [class*="loading"][style*="block"]');
            const pageStable = document.readyState === 'complete' && !loaderVisible;
            return {
              menuOpenWithOptions,
              overlayReady,
              appCardsVisible,
              pageStable,
              anyActionable: menuOpenWithOptions || overlayReady || appCardsVisible,
            };
          } catch (e) { return { anyActionable: false, pageStable: true }; }
        })()
      `;
      type Readiness = { menuOpenWithOptions?: boolean; overlayReady?: boolean; appCardsVisible?: boolean; pageStable?: boolean; anyActionable?: boolean };
      const readiness = await adapter.evaluateExpr<Readiness>(readinessProbe) || {};

      // FIX F.2 (action forcing — don't block, redirect): when the dropdown
      // is open with options already rendered, pick an option matching LLM
      // intent and click it inline. If NO option matches intent, we DON'T
      // force — we fall through to the rejection path so the LLM re-plans.
      // This avoids the "deterministic wrong action" trap where forcing the
      // first option picks "Test Sheet" when the LLM wanted "Prod Sheet".
      if (readiness.menuOpenWithOptions) {
        // Assemble intent tokens from everything the system currently knows
        // about what the model is trying to do. Priority order:
        //   1. The latest `next_goal` the LLM stated
        //   2. The current action's reason / value (wait actions usually have
        //      empty value, but `reason` often reads "wait for worksheet to
        //      load" — the intent IS in there)
        //   3. The most recent non-wait action's value (e.g. the field label
        //      the LLM was clicking before the wait-spam started)
        const lastNonWait = [...actionHistory].reverse().find(h => h.action !== 'wait');
        const intentSource = [
          nextGoal,
          action.reason,
          action.value,
          lastNonWait?.value,
          typeof lastNonWait?.target === 'string' ? lastNonWait.target : '',
        ].filter(Boolean).join(' ').toLowerCase();
        const stopWords = new Set(['the','and','for','with','from','into','this','that','then','next','step','open','click','select','choose','pick','wait','will','load','ready','option','options','dropdown','menu','field','value','first','last']);
        const intentTokens = (intentSource.match(/\b[a-z0-9]{3,}\b/g) || []).filter(t => !stopWords.has(t));
        const intentTokensJson = JSON.stringify(intentTokens);
        const clicked = await adapter.evaluateExpr<{clicked: boolean; optionText: string; matchedBy: string; availableCount: number; skippedReason?: string}>(`
          (() => {
            try {
              const menu = document.querySelector('.editoption-dropmenu.active_menu, .menu.menu_active');
              if (!menu) return { clicked: false, optionText: '', matchedBy: 'no-menu', availableCount: 0 };
              const opts = Array.from(menu.querySelectorAll('.menu_dropdown-option, li.choice.menu_dropdown-option, li.choice'));
              if (opts.length === 0) return { clicked: false, optionText: '', matchedBy: 'no-options', availableCount: 0 };
              const tokens = ${intentTokensJson};
              // Score each option by count of intent tokens present in its text.
              let best = null; let bestScore = 0; let bestText = '';
              for (const o of opts) {
                const t = ((o.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim());
                let score = 0;
                for (const tk of tokens) if (t.includes(tk)) score++;
                if (score > bestScore) { bestScore = score; best = o; bestText = t; }
              }
              // HIGH-confidence force: only click when we have ≥1 token match.
              // If no token matched, return "no-match" so caller falls through
              // to the rejection path — LLM re-plans instead of us guessing.
              if (!best || bestScore === 0) {
                return { clicked: false, optionText: '', matchedBy: 'no-match', availableCount: opts.length, skippedReason: 'no intent token matched any option' };
              }
              const text = (best.textContent || '').trim().slice(0, 80);
              best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              best.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { clicked: true, optionText: text, matchedBy: 'token-score-' + bestScore, availableCount: opts.length };
            } catch (e) { return { clicked: false, optionText: '', matchedBy: 'error', availableCount: 0 }; }
          })()
        `);
        if (clicked?.clicked) {
          console.log(
            `[FORCED_ACTION] target="${clicked.optionText}" reason=wait_rejected matchedBy=${clicked.matchedBy} ` +
            `availableCount=${clicked.availableCount} intent="${intentTokens.slice(0, 6).join(',')}"`,
          );
          actionHistory.push({
            turn,
            action: 'click',
            target: `[forced] option "${clicked.optionText}"`,
            value: clicked.optionText,
            effective: true,
            description: `FORCED click "${clicked.optionText}" — matched ${clicked.matchedBy} of ${clicked.availableCount} options`,
          });
          if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
          const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
          callbacks.onScreenshot(turn, saved);
          callbacks.onActionsExecuted(turn, [{ type: 'click' }]);
          continue;
        }
        // Skipped (no intent match, no options, or error) → log and fall to
        // rejection path. The LLM gets hard guidance "pick an option" and
        // chooses for itself on next turn.
        if (clicked?.skippedReason) {
          console.log(`[FORCED_ACTION] SKIPPED — ${clicked.skippedReason} (${clicked.availableCount} options available, intent="${intentTokens.slice(0, 6).join(',')}")`);
        }
      }

      if (readiness.anyActionable === true || readiness.pageStable === true) {
        const reason = readiness.overlayReady
          ? 'picker overlay is open with search ready — type or click an option'
          : readiness.appCardsVisible
            ? 'app list is rendered — click an app, do not wait'
            : readiness.menuOpenWithOptions
              ? 'dropdown menu is OPEN with options already rendered — click an option'
              : 'page is in a stable state with no loader — wait is a no-op';
        console.warn(`[cua] REJECT wait: ${reason}`);
        actionHistory.push({
          turn,
          action: action.action,
          target: actionTargetDisplayForSig,
          value: action.value,
          effective: false,
          description: `REJECTED wait: ${reason}`,
        });
        if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
        // Push hard guidance into stuckContext so the next prompt tells the
        // model exactly what it should do instead.
        stuckContext = {
          goal: nextGoal,
          url: await adapter.getUrl(),
          trigger: `WAIT REJECTED — ${reason}. System state is READY. You must emit a click/type/select on a visible element. Do NOT emit wait again — it will be rejected.`,
          failedActions: stuckContext?.failedActions || [],
        };
        const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
        callbacks.onScreenshot(turn, saved);
        callbacks.onActionsExecuted(turn, [{ type: action.action }]);
        continue;
      }
    }

    // ── FIX D: block backward-navigation clicks ─────────────────
    // Block ONLY when all four conditions hold (avoid blocking legitimate
    // re-clicks like reopening a dropdown or retrying after a fail):
    //   (1) same target text as a prior click
    //   (2) same URL (no navigation happened)
    //   (3) no DOM change on prior clicks (signals.domChanged === false)
    //   (4) repeated ≥2× in last 3 turns
    if (action.action === 'click' && action.value) {
      const currentTargetText = (typeof action.value === 'string' ? action.value : '').toLowerCase().trim();
      if (currentTargetText.length > 3) {
        const recent = actionHistory.slice(-3);
        const sameTargetClicks = recent.filter(h =>
          h.action === 'click' &&
          typeof h.target === 'string' &&
          h.target.toLowerCase().includes(currentTargetText),
        );
        // Condition (3): none of the same-target clicks produced DOM change.
        const allNoDomChange = sameTargetClicks.length > 0 && sameTargetClicks.every(h =>
          h.signals ? h.signals.domChanged === false : h.effective === false,
        );
        // Condition (2): none of them produced URL change either.
        const allNoUrlChange = sameTargetClicks.length > 0 && sameTargetClicks.every(h =>
          h.signals ? h.signals.urlChanged === false : true,
        );
        const repeatedTwice = sameTargetClicks.length >= 2;
        if (repeatedTwice && allNoDomChange && allNoUrlChange) {
          console.warn(`[cua] BLOCK backward-nav: "${currentTargetText}" clicked ${sameTargetClicks.length}× in last 3 turns @ same URL with no DOM change`);
          actionHistory.push({
            turn,
            action: action.action,
            target: actionTargetDisplayForSig,
            value: action.value,
            effective: false,
            description: `BLOCKED: backward-nav repeat on "${currentTargetText}"`,
          });
          if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
          // Push a stuckContext entry so the next prompt tells the model to change strategy.
          if (!stuckContext) {
            stuckContext = {
              goal: nextGoal,
              url: await adapter.getUrl(),
              trigger: `Backward-nav loop on "${currentTargetText}" — click a different target`,
              failedActions: [],
            };
          }
          const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
          callbacks.onScreenshot(turn, saved);
          callbacks.onActionsExecuted(turn, [{ type: action.action }]);
          continue;
        }
      }
    }

    // ── FIX E: conditional block re-interaction on already-completed field ──
    // Now covers click / type / select (user feedback: "reject ANY action on
    // completed field"). Two-gate check:
    //   (1) target's normalized label matches an entry in completedFields
    //   (2) a RE-PROBE of that field's value signature STILL matches the
    //       signature captured at completion time (i.e. field is still set)
    // If (1) but not (2) — state has moved on (navigation, value cleared,
    // different form) — drop the entry and allow. This prevents the block
    // from breaking legit flows like dropdown-reopen or multi-select.
    if (['click', 'type', 'select'].includes(action.action) && completedFields.size > 0) {
      const candidates = [
        action.value,
        typeof action.target === 'string' ? action.target : action.target?.text,
      ].filter(Boolean) as string[];
      const hitKey = candidates
        .map(normalizeFieldKey)
        .find(k => k.length > 2 && completedFields.has(k));
      if (hitKey) {
        const record = completedFields.get(hitKey)!;
        // Re-probe the field's CURRENT signature. If unchanged → still filled.
        const currentSig = (await adapter.evaluateExpr<string>(fieldValueSignatureExpr(hitKey))) || '';
        const stillFilled = currentSig.length > 0 && currentSig === record.filledSignature;
        if (!stillFilled) {
          console.log(`[cua] completedFields drop "${hitKey}": signature changed (stored="${record.filledSignature.slice(0,40)}" current="${currentSig.slice(0,40)}") — allowing re-click`);
          completedFields.delete(hitKey);
        } else {
          console.warn(`[cua] BLOCK completed-field re-click: "${hitKey}" still holds filled signature`);
          actionHistory.push({
            turn,
            action: action.action,
            target: actionTargetDisplayForSig,
            value: action.value,
            effective: false,
            description: `BLOCKED: field "${hitKey}" already completed (signature unchanged)`,
          });
          if (actionHistory.length > ACTION_HISTORY_SIZE) actionHistory.shift();
          if (!stuckContext) {
            stuckContext = {
              goal: nextGoal,
              url: await adapter.getUrl(),
              trigger: `Field "${hitKey}" already filled — choose a different target`,
              failedActions: [],
            };
          }
          const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
          callbacks.onScreenshot(turn, saved);
          callbacks.onActionsExecuted(turn, [{ type: action.action }]);
          continue;
        }
      }
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

    // ── FIX E: mark field completed after successful specialized handler ──
    // Only CUSTOM_DROPDOWN / VARIABLE_PICKER / SELECTABLE_LIST_ITEM produce
    // "this field is now set" semantics. Other types (CONTINUE_RUN_TEST,
    // PANEL_SELECT, SEARCHABLE_APP_LIST) are navigation — don't track them.
    // FIX 4 (state refresh): we probe the field's signature AFTER the action
    // AFTER executeValidatedAction has already called adapter.getState() —
    // this guarantees the probe reflects post-action DOM, not pre-action.
    //
    // FIX (correctness validation before locking): only mark completed when
    // the resulting signature reflects the EXPECTED value. Expected = tokens
    // from action.value / action.reason / nextGoal / result.target. If none
    // of the expected tokens appear in the post-action signature, this was
    // a deterministic-wrong action (e.g. forced-click picked "Test Sheet"
    // when user wanted "Prod Sheet"). Don't lock — let the LLM re-plan.
    const SET_FIELD_TYPES = new Set(['CUSTOM_DROPDOWN', 'VARIABLE_PICKER', 'SELECTABLE_LIST_ITEM', 'DROPDOWN_OPTION_DIRECT']);
    if (result.success && result.effective && result.ialHandled && result.ialType && SET_FIELD_TYPES.has(result.ialType)) {
      // Use the IAL-surfaced field label (the semantic one the classifier
      // picked) — NOT action.value / result.target which can be an elementId
      // hash when the model clicked by id rather than by label text.
      const rawKey = result.ialFieldLabel || action.value || result.target || '';
      const key = normalizeFieldKey(rawKey);
      if (key.length > 2) {
        const sig = (await adapter.evaluateExpr<string>(fieldValueSignatureExpr(key))) || '';
        // Correctness check: extract expected tokens and test whether the
        // post-action signature mentions any of them. Skip check when we
        // have NO intent signal (then fall back to "value changed = enough").
        const expectedSource = [action.value, action.reason, nextGoal, result.target]
          .filter(Boolean).join(' ').toLowerCase();
        const stopWordsLock = new Set(['the','and','for','with','from','into','this','that','then','next','step','open','click','select','choose','pick','wait','will','load','ready','option','options','dropdown','menu','field','value','first','last','true','false']);
        const expectedTokens = (expectedSource.match(/\b[a-z0-9]{3,}\b/g) || []).filter(t => !stopWordsLock.has(t));
        const sigLower = sig.toLowerCase();
        const matchedTokens = expectedTokens.filter(t => sigLower.includes(t));
        // Lock policy:
        //   - No expected tokens → lock (we have no way to verify; trust the probe)
        //   - Expected tokens present, ≥1 matches signature → lock
        //   - Expected tokens present, 0 match signature → DO NOT lock; warn
        const shouldLock = expectedTokens.length === 0 || matchedTokens.length > 0;
        if (shouldLock) {
          const currentUrl = await adapter.getUrl();
          completedFields.set(key, { filledSignature: sig, urlAt: currentUrl });
          console.log(
            `[cua] mark-completed: "${key}" (via ${result.ialType}) sig="${sig.slice(0, 60)}" ` +
            `matched=[${matchedTokens.slice(0, 4).join(',')}]/${expectedTokens.length}`,
          );
        } else {
          console.warn(
            `[cua] mark-completed SKIPPED: "${key}" sig="${sig.slice(0, 60)}" ` +
            `did NOT contain any expected token from [${expectedTokens.slice(0, 6).join(',')}] — ` +
            `possibly wrong selection, not locking field`,
          );
          // Push to stuckContext so the next prompt tells the model the
          // current value may be wrong and it should verify / re-select.
          stuckContext = {
            goal: nextGoal,
            url: await adapter.getUrl(),
            trigger: `Field "${key}" was set, but the resulting value did not match expected tokens [${expectedTokens.slice(0, 6).join(',')}]. Verify the selection; if incorrect, re-open the dropdown and pick a different option.`,
            failedActions: stuckContext?.failedActions || [],
          };
        }
      }
    }

    // Legacy post-hoc detection blocks below — SKIPPED when IAL already
    // handled the action (result.ialHandled === true). This prevents
    // double-execution where both the specialized handler and the legacy
    // smart-detector would fire on the same turn.
    const skipLegacyHandlers = result.ialHandled === true;

    // Smart "Continue & Run Test" detection: always route through waitForEnabled method
    // The button stays disabled until dropdowns validate server-side (can take 2-5s after select)
    if (!skipLegacyHandlers && action.action === 'click') {
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
    if (!skipLegacyHandlers && action.action === 'click') {
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
    if (!skipLegacyHandlers && action.action === 'click' && !result.effective && action.value) {
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
      const el = resolveTargetElement(action.target, state.elements);
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
    if (!skipLegacyHandlers && !result.effective && action.action === 'type' && action.value && action.target) {
      const isVariableHint =
        /variable|token|map|data field|from trigger|add or select|dynamic/i.test(action.reason || '') ||
        /\{\{|from\s+\w+\s+trigger/i.test(action.value);
      if (isVariableHint) {
        const el = resolveTargetElement(action.target, state.elements);
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
    if (!skipLegacyHandlers && action.action === 'click') {
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
    // After any click: if an editable title input appeared (connect-name inline edit),
    // press Escape immediately so the canvas toolbar ("Add Action App") stays visible.
    if (action.action === 'click' && result.success) {
      try {
        const titleEditActive = await adapter.getState().then(s =>
          s.elements.some(e =>
            e.tag === 'input' &&
            (e.attributes['class'] || '').toLowerCase().includes('connect') ||
            (e.value && /integration|connect|workflow|google sheets|gmail/i.test(e.value) && e.tag === 'input' && !e.attributes['type'])
          )
        ).catch(() => false);
        if (titleEditActive) {
          console.log('[cua] Connect title inline-edit detected after click — pressing Escape to dismiss');
          await adapter.keypress('Escape');
        }
      } catch {}
    }

    // ── Record in action history ─────────────────────────────────
    // System-health: count this turn AND whether it made progress.
    totalTurnsExecuted++;
    if (result.effective) {
      effectiveTurnsExecuted++;
      noProgressStreak = 0;
    } else {
      noProgressStreak++;
      // PR D + D-v2: predictive early-stagnation warning + SELF-CORRECTION.
      // Emit once per run AND trigger corrective actions:
      //   (1) disable cache for next STAGNATION_RECOVERY_TURNS turns so GPT
      //       gets fresh control and re-evaluates where we are in the test.
      //   (2) (future) bump constraint severity weight during recovery.
      // This turns the signal into an action instead of just observability.
      if (noProgressStreak >= EARLY_STAGNATION_THRESHOLD && stagnationRecoveryTurnsRemaining === 0) {
        stagnationRecoveryTurnsRemaining = STAGNATION_RECOVERY_TURNS;
        if (!earlyStagnationEmitted) {
          earlyStagnationEmitted = true;
          console.warn(
            `[cua] EARLY STAGNATION (turn ${turn}): ${noProgressStreak} consecutive no-progress turns. ` +
            `Self-correcting: bypassing cache for next ${STAGNATION_RECOVERY_TURNS} turns. ` +
            `Recent actions: ` +
            actionHistory.slice(-3).map(h => `${h.action}:${h.target}`).join(', '),
          );
        } else {
          console.warn(`[cua] Stagnation recurrence (turn ${turn}) — bypassing cache again for ${STAGNATION_RECOVERY_TURNS} turns`);
        }
      }
    }
    // Decay the stagnation-recovery counter each turn (fires after stagnation detection
    // so a recovery window can't re-trigger itself).
    if (stagnationRecoveryTurnsRemaining > 0) stagnationRecoveryTurnsRemaining--;

    const actionTargetDisplay = targetToDisplay(action.target);
    const actionTargetIdForCache = targetElementId(action.target) ?? '';
    actionHistory.push({
      turn,
      action: action.action,
      target: actionTargetDisplay !== '(none)' ? actionTargetDisplay : (action.value || ''),
      value: action.value,
      effective: result.effective,
      description: result.description,
      // Structured fields (new) — enable future picker / learning without
      // forcing consumers to change shape today.
      step: action,
      signals: { ...result.signals },
      source: isBatchTurn ? 'batch-queue' : 'gpt',
      mode,
    });

    // ── Constraint effectiveness: did GPT respect each emitted constraint,
    //    and did that respect translate into progress? Skipped on cache/batch
    //    turns (turnConstraints is null) since the cache didn't see them.
    //    Also records ONE bucket outcome per turn (PR A) — bucket-level data
    //    gives us a baseline to compute relative lift instead of raw attribution.
    if (turnConstraints && turnConstraints.list.length > 0) {
      const postUrlForConstraints = await adapter.getUrl();
      const actionSig = `${action.action} ${actionTargetDisplay}`.trim();
      for (const c of turnConstraints.list) {
        const violated = constraintMatchesAction(c, actionSig, actionTargetDisplay, postUrlForConstraints);
        if (violated) {
          recordConstraintViolated(c.id);
        } else {
          recordConstraintRespected(c.id);
          // Action respected the rule. Did progress follow?
          recordConstraintOutcome(c.id, result.effective);
        }
      }
      // One bucket outcome per turn (NOT per constraint) — this is the baseline.
      recordBucketOutcome(turnConstraints.list.map(c => c.id), result.effective);
    }
    // Keep only the last N entries to control prompt size
    if (actionHistory.length > ACTION_HISTORY_SIZE) {
      actionHistory.shift();
    }

    // Record in action cache for future runs
    // Guard: don't record actions that result in backward navigation
    const postActionUrl = await adapter.getUrl();
    const postActionPath = postActionUrl.replace(/https?:\/\/[^/]+/, '').split('?')[0]
      .replace(/\/[a-f0-9]{24,}/g, '/*').replace(/\/[a-z0-9]{20,}/g, '/*');
    const isBackwardNav = result.signals.urlChanged && visitedUrlPaths.has(postActionPath);
    if (result.effective && !isBackwardNav && (action.confidence ?? 0) >= 0.80) {
      recordSuccessfulAction(state.url, pageTitle, cacheElements,
        { action: action.action, target: actionTargetIdForCache, value: action.value || '', confidence: action.confidence ?? 0.9 },
        result.description, true);

      // Track for sequence recording
      const targetEl = resolveTargetElement(action.target, state.elements);
      pageActionSequence.push({
        action: action.action,
        targetText: targetEl?.text || actionTargetDisplay || '',
        targetTag: targetEl?.tag || '',
        value: action.value || '',
        confidence: action.confidence ?? 0.9,
      });
    } else if (!result.effective) {
      recordFailedAction(state.url, pageTitle, cacheElements);
      // Flush batch on failure — remaining queued actions are stale
      if (pendingBatchActions.length > 0) {
        console.log(`[cua] Flushing ${pendingBatchActions.length} batch actions after failure`);
        pendingBatchActions = [];
      }
    }

    callbacks.onActionsExecuted(turn, [{ type: action.action, ...action, target: actionTargetDisplay }]);

    // ── NEW: Feed action result to Vision Decision Engine ──────
    visionEngine.setCurrentTurn(turn);
    const visionActionResult: VisionActionResult = {
      success: result.success,
      effective: result.effective,
      error: result.error,
      urlChanged: result.signals.urlChanged,
      domChanged: result.signals.domChanged,
      valueChanged: result.signals.valueChanged,
      intentMatch: result.details.intentMatch,
      elementStillExists: result.details.elementStillExists,
      isNetworkError: !!(result.error && (
        result.error.includes('ECONNREFUSED') || result.error.includes('ETIMEDOUT') ||
        result.error.includes('net::') || result.error.includes('ERR_CONNECTION')
      )),
    };
    const failureType = visionEngine.classifyFailure(visionActionResult, result.error);
    if (failureType) {
      visionEngine.recordFailure({ type: failureType, turn, target: actionTargetDisplay, description: result.description });
    } else if (result.success && result.effective) {
      // Successful action — decay failure history
      visionEngine.recordSuccess();
    }
    // Track progress
    if (result.success && result.effective) {
      if (result.signals.urlChanged) {
        visionEngine.recordProgress('strong');
      } else if (result.signals.domChanged || result.signals.valueChanged) {
        visionEngine.recordProgress('weak');
      }
    }
    // Feedback: if last turn used vision, record effectiveness
    if (lastVisionDecision && lastVisionDecision.mode !== 'dom') {
      visionEngine.recordVisionOutcome(result.signals.domChanged, result.success && result.effective);
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
      if (result.signals.urlChanged) {
        visionBurstsUsed = 0;
        consecutiveCacheHits = 0; // URL changed — cache can be trusted again for new page
      }
    } else {
      consecutiveFailures++;
      if (result.success && !result.effective) {
        console.warn(`[cua] No-effect: ${action.action} ${actionTargetDisplay} — "${result.description}"`);
      } else {
        console.warn(`[cua] Action failed: ${result.error}`);
      }

      // Build StuckContext on first failure
      if (!stuckContext) {
        stuckContext = {
          goal: action.next_goal || nextGoal,
          url: await adapter.getUrl(),
          trigger: `${action.action} ${actionTargetDisplay}`.trim(),
          failedActions: [],
        };
        console.log(`[cua] StuckContext created (turn ${turn}): goal="${stuckContext.goal}"`);
      }
      const resolvedEl = resolveTargetElement(action.target, state.elements);
      const failureType = classifyFailureType(result, result.validation, resolvedEl?.isInteractable);

      stuckContext.failedActions.push({
        action: action.action,
        target: actionTargetDisplay || '',
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

    // ── Backward navigation detection (prevents cache/batch replay loops) ──
    // If we navigated BACKWARD to a URL path we've already visited, the
    // cached/batched sequence is broken. Flush batch and force GPT next turn.
    const currentUrlPathForVisited = currentUrl.replace(/https?:\/\/[^/]+/, '').split('?')[0]
      .replace(/\/[a-f0-9]{24,}/g, '/*').replace(/\/[a-z0-9]{20,}/g, '/*');
    if (result.signals.urlChanged) {
      if (visitedUrlPaths.has(currentUrlPathForVisited) && pendingBatchActions.length > 0) {
        console.warn(`[cua] BACKWARD NAV detected → ${currentUrlPathForVisited} (already visited). Flushing ${pendingBatchActions.length} batch actions.`);
        pendingBatchActions = [];
        // Invalidate the sequence that caused this
        recordFailedSequence(currentUrl, state.title || '');
      }
      // Track where we've been (use normalized path, not full URL with IDs)
      visitedUrlPaths.add(currentUrlPathForVisited);
    }
    // PR C + C-v2: record the turn of the most recent URL pattern change so
    // the constraint builder can drop constraints predating this boundary.
    // Exception: "soft navigation" — SPA routes that change URL but keep
    // ≥70% of the top-text set identical. In that case constraints are still
    // relevant (the UI context persists), so we DON'T bump lastUrlChangeTurn.
    if (currentUrlPathForVisited !== lastSeenUrlPattern) {
      const currentTopTexts = new Set(
        state.elements
          .map(e => (e.text || '').trim().toLowerCase())
          .filter(t => t.length >= 2 && t.length <= 40)
          .slice(0, 10),
      );
      let similarity = 0;
      if (lastSeenTopTexts.size > 0 && currentTopTexts.size > 0) {
        let overlap = 0;
        for (const t of currentTopTexts) if (lastSeenTopTexts.has(t)) overlap++;
        similarity = overlap / Math.max(lastSeenTopTexts.size, currentTopTexts.size);
      }
      if (similarity < DOM_SIMILARITY_THRESHOLD) {
        lastUrlChangeTurn = turn;
      } else {
        console.log(`[cua] Soft nav detected (similarity=${similarity.toFixed(2)}) — preserving constraints`);
      }
      lastSeenUrlPattern = currentUrlPathForVisited;
      lastSeenTopTexts = currentTopTexts;
    }

    // ── Save screenshot (replay only, NOT sent to model) ────────
    const saved = await saveScreenshotToDisk(adapter, screenshotDir, turn, runId);
    callbacks.onScreenshot(turn, saved, {
      action: { type: action.action, target: actionTargetDisplay, value: action.value },
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

    // ── Sequence recording: save action sequence on page transition ──
    if (result.validation.urlChanged && pageActionSequence.length >= 2) {
      // Guard: don't record sequences that result in backward navigation
      // (e.g., redirect back to /connects after incomplete trigger setup)
      const destPath = currentUrl.replace(/https?:\/\/[^/]+/, '').split('?')[0];
      const isBackward = visitedUrlPaths.has(
        destPath.replace(/\/[a-f0-9]{24,}/g, '/*').replace(/\/[a-z0-9]{20,}/g, '/*'),
      );
      if (!isBackward) {
        const seqDesc = `${pageActionSequence.length} actions: ${pageActionSequence.map(a => a.action).join('→')}`;
        recordSequence(state.url, currentPageTitle, pageActionSequence, seqDesc);
        console.log(`[cua] Recorded sequence: "${seqDesc}" for ${currentPageKey}`);
      } else {
        console.warn(`[cua] Skipped recording sequence — destination is a previously visited URL`);
      }
    }
    if (result.validation.urlChanged || !currentPageKey) {
      // Reset sequence tracking for new page
      currentPageKey = state.url;
      currentPageTitle = state.title || '';
      pageActionSequence = [];
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
    const srcLabel = isBatchTurn ? 'batch' : 'gpt';
    console.log(`[cua] T${turn}: ${action.action} ${targetToDisplay(action.target)} → ${result.success ? (result.effective ? 'ok' : 'ok[no-effect]') : 'FAIL'} | dom=${result.signals.domChanged ? 'Y' : 'N'} url=${result.signals.urlChanged ? 'Y' : 'N'} intent=${result.details.intentMatch ? 'Y' : 'N'} | src=${srcLabel} | retry: ${result.retryStrategy || 'none'}`);
  }

  // ── Turn budget exhausted ─────────────────────────────────────
  let storageStatePath: string | undefined;
  try {
    const storageFile = path.join(screenshotDir, 'storage-state.json');
    await page.context().storageState({ path: storageFile });
    storageStatePath = storageFile;
  } catch {}

  // Cache observability: emit per-run counters at run end so we can see
  // at a glance whether this run benefited from cache (hits) vs paid to
  // skip it (rejects). Helps tune thresholds and catch cache rot.
  const runCache = getRunCacheCounters();
  console.log(
    `[cua] Run cache stats: ${runCache.hitsSingle} singleHits, ${runCache.hitsSequence} sequenceHits, ` +
    `rejects={ lowSuccess:${runCache.rejects.lowSuccess}, tooManyFailures:${runCache.rejects.tooManyFailures}, ` +
    `stale:${runCache.rejects.stale}, loopGuard:${runCache.rejects.loopGuard}, ` +
    `afterGPT:${runCache.rejects.afterGPT}, notEligible:${runCache.rejects.notEligible} }, ` +
    `recorded={ success:${runCache.recordedSuccess}, failure:${runCache.recordedFailure} }`,
  );

  // Composite system-health: one number per run that aggregates progress,
  // cache effectiveness, and constraint effectiveness. Trajectory across
  // runs is the single best degradation indicator.
  const health = computeSystemHealth({
    effectiveTurns: effectiveTurnsExecuted,
    totalTurns: totalTurnsExecuted,
  });
  console.log(formatSystemHealth(health));

  // Persist this run's progressRate into the EMA baseline before the final
  // constraint-lifecycle pass. The EMA protects future runs from single-run
  // jitter — alpha=0.7 gives ~3-run half-life.
  updateSmoothedGlobalProgressRate(health.progressRate);

  // End-of-run constraint lifecycle pass with NORMALIZATION against the
  // SMOOTHED baseline (just updated above — includes this run's observation
  // but with attenuated jitter). Corrects any loop-start false positives.
  autoDisableBadConstraints({ globalProgressRate: getSmoothedGlobalProgressRate() });

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
