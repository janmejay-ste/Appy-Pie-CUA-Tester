import type { ExecutionAdapter, ActionStep, ActionResult, BrowserState, IndexedElement, ActionTargetLike, ExpectedOutcome } from './types.js';
import { coerceLegacyTarget, resolveTargetElement, targetToDisplay, targetElementId } from './target.js';
import { classifyInteraction } from '../interaction/classifier.js';
import { executeInteraction } from '../interaction/executor.js';

// ── Strategy Types ──────────────────────────────────────────────
export type ExecutionStrategy = 'selector' | 'text' | 'role' | 'coordinates';

// Module-level counter for non-structured validation occurrences (aggregate logging).
// Reset via resetLegacyValidationCounter() at the start of each run.
let _legacyValidationCount = 0;

/** Reset the per-run legacy validation counter. Call at run start alongside resetOverlayStreak(). */
export function resetLegacyValidationCounter(): void {
  _legacyValidationCount = 0;
}

// Internal result type that carries which execution strategy was used
type StrategyResult = ActionResult & { strategyUsed: ExecutionStrategy };

// ── Action Signals ──────────────────────────────────────────────
// The three primary change signals. First-class on every ValidatedResult.
// `signals` is the single source of truth for what happened on the page.
// `details` carries secondary (non-signal) observations.
// `validation` is DERIVED from signals+details (frozen shallow merge) and is
//   preserved only for backward-compat with existing consumers and persisted
//   DB rows. New code must read from `signals` / `details`, never `validation`.
export interface ActionSignals {
  urlChanged: boolean;
  domChanged: boolean;
  valueChanged: boolean;
}

// Secondary validation details (non-signal observations).
export interface ValidationDetails {
  errorAppeared: boolean;
  errorMessage?: string;
  elementStillExists: boolean;
  intentMatch: boolean;
}

/**
 * Single-point derivation of the legacy `validation` shape from the new
 * first-class signals + details. Frozen so accidental mutations throw loudly
 * in dev, surfacing drift immediately instead of producing ghost bugs later.
 */
export function deriveValidation(
  signals: ActionSignals,
  details: ValidationDetails,
): Readonly<ActionSignals & ValidationDetails> {
  return Object.freeze({ ...signals, ...details });
}

// ── Validated Result ────────────────────────────────────────────
/**
 * How strong is the evidence that the action was effective?
 * - strong:  structured ExpectedOutcome validated a specific DOM/URL/value condition
 * - medium:  action-type inference matched a specific signal (urlChanged, valueChanged, elementGone)
 * - weak:    meaningfulDomChange was the deciding factor, or legacy string keyword matched
 *
 * Callers should not cache weak-confidence results — they are too heuristic to trust.
 */
export type ValidationConfidence = 'strong' | 'medium' | 'weak';

export interface ValidatedResult {
  success: boolean;
  effective: boolean;         // something actually changed
  validationConfidence: ValidationConfidence;
  error?: string;
  action: string;
  target?: string;
  value?: string;
  description: string;
  strategyUsed: ExecutionStrategy;   // which strategy actually executed the action
  retryStrategy?: 'change_target' | 'fix_input' | 'rescan_dom' | 'scroll' | 'none';
  /** First-class signals — single source of truth. */
  signals: ActionSignals;
  /** Secondary validation details (error/intent/exists). */
  details: ValidationDetails;
  /**
   * @deprecated Derived from `signals` + `details` via deriveValidation().
   *   Frozen. Do not read in new code — use `signals` and `details` instead.
   *   Kept populated solely for backward compatibility with persisted DB rows
   *   and legacy consumers. Will be removed once all readers migrate.
   */
  validation: Readonly<ActionSignals & ValidationDetails>;
  durationMs: number;
  /**
   * True when the IAL specialized handler ran (e.g. VARIABLE_PICKER →
   * insertVariableToken). cua-loop.ts consults this to SKIP the legacy
   * post-hoc detection blocks (smart Continue & Run Test, smart event
   * selection, smart variable token insertion, etc.) so we don't fire both
   * the IAL handler AND the legacy handler on the same turn.
   */
  ialHandled?: boolean;
  /** Which IAL interaction type was classified (always set, even on fallthrough). */
  ialType?: string;
  /**
   * Field label the specialized handler acted on — populated for
   * CUSTOM_DROPDOWN / VARIABLE_PICKER / SELECTABLE_LIST_ITEM. cua-loop
   * uses this as the key into its completed-field tracker; without it
   * the tracker would key on elementId hashes which don't match future
   * LLM-emitted target text.
   */
  ialFieldLabel?: string;
}

// ── Resolve target: find element by elementId / text / domPath ──
// Delegates to the shared helper in ./target.ts which handles both legacy
// string targets and the new structured ActionTarget object.
function resolveTarget(target: ActionTargetLike | undefined, elements: IndexedElement[]): IndexedElement | null {
  return resolveTargetElement(target, elements);
}

// ── Execute click with strategy tracking + forced/preferred strategy support ──
async function executeClick(
  adapter: ExecutionAdapter,
  el: IndexedElement,
  forcedStrategy?: ExecutionStrategy,
  preferredStrategy?: ExecutionStrategy,
  allowCoordinates = true,
): Promise<StrategyResult> {
  const cx = el.boundingBox.x + el.boundingBox.w / 2;
  const cy = el.boundingBox.y + el.boundingBox.h / 2;

  // Forced strategy: try it first, but fall through to adaptive on failure
  if (forcedStrategy) {
    let forcedResult: ActionResult | null = null;
    if (forcedStrategy === 'coordinates') {
      forcedResult = await adapter.clickByCoordinates(cx, cy);
    } else if (forcedStrategy === 'text' && (el.text?.length > 2 || el.placeholder || el.attributes['placeholder'])) {
      const clickLabel = (el.text && el.text.length > 2) ? el.text : (el.placeholder || el.attributes['placeholder'] || '');
      forcedResult = await adapter.clickByText(clickLabel.slice(0, 40));
    } else if (forcedStrategy === 'selector') {
      const sel = el.attributes['data-testid'] ? `[data-testid="${el.attributes['data-testid']}"]`
        : el.attributes['id'] ? `#${el.attributes['id']}`
        : (el as any)._cssSelector;
      if (sel) forcedResult = await adapter.clickBySelector(sel);
    } else if (forcedStrategy === 'role') {
      const role = el.tag === 'button' ? 'button' : el.tag === 'a' ? 'link' : el.attributes['role'];
      forcedResult = await adapter.clickByText(el.text || '', role);
    }
    if (forcedResult?.success) {
      return { ...forcedResult, strategyUsed: forcedStrategy };
    }
    // Forced strategy failed or not applicable — fall through to adaptive chain
  }

  // Adaptive order: build strategy chain with type labels
  const hasStableSelector = !!(el.attributes['data-testid'] || el.attributes['id'] || el.attributes['name']);
  const hasUniqueText = !!(el.text && el.text.length > 2 && el.text.length < 60);
  const hasRole = !!(el.attributes['role'] || el.tag === 'button' || el.tag === 'a');
  const placeholderText = el.placeholder || el.attributes['placeholder'] || '';
  const hasPlaceholder = !!(placeholderText && placeholderText.length > 2);
  const isInputLike = el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select';

  const strategies: Array<{ fn: () => Promise<ActionResult>; type: ExecutionStrategy }> = [];

  if (hasStableSelector) {
    if (el.attributes['data-testid']) strategies.push({ fn: () => adapter.clickBySelector(`[data-testid="${el.attributes['data-testid']}"]`), type: 'selector' });
    if (el.attributes['id']) strategies.push({ fn: () => adapter.clickBySelector(`#${el.attributes['id']}`), type: 'selector' });
    if ((el as any)._cssSelector) strategies.push({ fn: () => adapter.clickBySelector((el as any)._cssSelector), type: 'selector' });
  }

  if (hasUniqueText) {
    const role = (el.tag === 'button' || el.attributes['role'] === 'button') ? 'button'
      : (el.tag === 'a') ? 'link' : undefined;
    strategies.push({ fn: () => adapter.clickByText(el.text.slice(0, 40), role), type: 'text' });
  }

  // Placeholder-based text strategy: for inputs with no id/name/text, use placeholder as clickByText target
  if (!hasUniqueText && hasPlaceholder && isInputLike) {
    strategies.push({ fn: () => adapter.clickByText(placeholderText.slice(0, 40)), type: 'text' });
  }

  if (!hasStableSelector && (el as any)._cssSelector) {
    strategies.push({ fn: () => adapter.clickBySelector((el as any)._cssSelector), type: 'selector' });
  }

  if (hasRole && !hasUniqueText) {
    strategies.push({ fn: () => adapter.clickByText('', el.attributes['role'] || el.tag), type: 'role' });
  }

  // Coordinates: always include for input-like elements (they are best clicked by coordinates),
  // and as last-resort fallback for everything else
  if (allowCoordinates) {
    strategies.push({ fn: () => adapter.clickByCoordinates(cx, cy), type: 'coordinates' });
  }

  // Preferred strategy: surface it to front of the chain (skip re-adding if already first)
  const orderedStrategies = preferredStrategy && strategies[0]?.type !== preferredStrategy
    ? [...strategies.filter(s => s.type === preferredStrategy), ...strategies.filter(s => s.type !== preferredStrategy)]
    : strategies;

  let lastType: ExecutionStrategy = 'coordinates';
  for (const s of orderedStrategies) {
    lastType = s.type;
    const r = await s.fn();
    if (r.success) return { ...r, strategyUsed: s.type };
  }

  return { success: false, effective: false, error: `All ${strategies.length} click strategies failed for ${el.elementId}`, strategyUsed: lastType };
}

async function executeType(
  adapter: ExecutionAdapter,
  el: IndexedElement,
  text: string,
  forcedStrategy?: ExecutionStrategy,
): Promise<StrategyResult> {
  const cx = el.boundingBox.x + el.boundingBox.w / 2;
  const cy = el.boundingBox.y + el.boundingBox.h / 2;

  // Forced coordinates
  if (forcedStrategy === 'coordinates') {
    return { ...(await adapter.typeByCoordinates(cx, cy, text)), strategyUsed: 'coordinates' };
  }

  // Detect contenteditable / rich-text editors — skip fill(), use keyboard API directly
  const isContentEditable =
    el.attributes['contenteditable'] === 'true' ||
    el.attributes['contenteditable'] === '' ||
    el.attributes['role'] === 'textbox' ||
    el.attributes['data-slate-editor'] !== undefined ||
    el.attributes['data-lexical-editor'] !== undefined ||
    el.attributes['data-prosemirror'] !== undefined ||
    // Quill, TipTap, CodeMirror often wrap in a div with class hints
    /ql-editor|ProseMirror|cm-content|tiptap|rich-text/i.test(el.attributes['class'] || '');

  if (isContentEditable) {
    const selectors = [
      el.attributes['id'] ? `#${el.attributes['id']}` : null,
      (el as any)._cssSelector || null,
    ].filter(Boolean) as string[];

    for (const sel of selectors) {
      const r = await adapter.typeByContentEditable(sel, text);
      if (r.success) return { ...r, strategyUsed: 'selector' };
    }
    // Final fallback: coordinates-based keyboard typing
    return { ...(await adapter.typeByCoordinates(cx, cy, text)), strategyUsed: 'coordinates' };
  }

  // Default: try selectors first, then coordinates
  const placeholderVal = el.placeholder || el.attributes['placeholder'] || '';
  const selectors = [
    el.attributes['id'] ? `#${el.attributes['id']}` : null,
    (el as any)._cssSelector || null,
    el.attributes['name'] ? `${el.tag}[name="${el.attributes['name']}"]` : null,
    // Placeholder-based selector: useful for inputs with no id/name (e.g., "Search for an trigger app")
    placeholderVal ? `${el.tag}[placeholder="${placeholderVal}"]` : null,
  ].filter(Boolean) as string[];

  for (const sel of selectors) {
    const r = await adapter.typeBySelector(sel, text);
    if (r.success) return { ...r, strategyUsed: 'selector' };
  }

  return { ...(await adapter.typeByCoordinates(cx, cy, text)), strategyUsed: 'coordinates' };
}

async function executeSelect(adapter: ExecutionAdapter, el: IndexedElement, value: string): Promise<StrategyResult> {
  // "first" is a special value meaning "select first available option" — skip native <select> attempt
  const isFirstOption = value.toLowerCase() === 'first';

  if (!isFirstOption) {
    const selectors = [
      el.attributes['id'] ? `#${el.attributes['id']}` : null,
      (el as any)._cssSelector || null,
      el.attributes['name'] ? `select[name="${el.attributes['name']}"]` : null,
    ].filter(Boolean) as string[];

    for (const sel of selectors) {
      const r = await adapter.selectBySelector(sel, value);
      if (r.success) return { ...r, strategyUsed: 'selector' };
    }
  }

  // Appy Pie custom dropdown handler — works for both specific values and "first"
  const dropdownLabel = el.text || el.placeholder || el.attributes['name'] || '';
  if (dropdownLabel) {
    const ddResult = await adapter.openAndSelectDropdown(dropdownLabel, isFirstOption ? '' : value);
    if (ddResult.success) return { ...ddResult, strategyUsed: 'text' };
  }

  // Fallback: click the element to open it, then try clicking the option by text
  // Skip this for "first" since there's no literal text to match
  if (!isFirstOption) {
    const clickResult = await executeClick(adapter, el);
    if (clickResult.success) {
      await new Promise(r => setTimeout(r, 500));
      return { ...(await adapter.clickByText(value)), strategyUsed: 'text' };
    }
  }

  return { success: false, effective: false, error: `Select failed for ${el.elementId}`, strategyUsed: 'selector' };
}

// ── UI Stabilization ───────────────────────────────────────────
// After click/select/navigate/keypress, SPAs enter a transient loading state
// (loader appears, intermediate DOM renders, final DOM settles). Acting on the
// intermediate state causes NO_EFFECT loops because targets referenced mid-flight
// no longer exist by execution time.
//
// Strategy:
//   1. 100ms initial pause — lets the transition START (avoids reading pre-transition state).
//   2. Loop: detect active loaders → poll a lightweight DOM fingerprint (element count +
//      title + URL) → require 2 consecutive identical polls (400ms stable window) before
//      returning. Max wait = 8 s; on timeout we proceed and let validation catch it.
//   3. Canvas dual-loader buffer (connectcloud /customeditor/ only): the connect editor
//      fires TWO sequential loaders on every canvas operation. The first loader is visible
//      (caught by LOADER_EXPR). The second fires silently immediately after the first
//      clears — no spinner, but it locks all canvas interactive elements. After the
//      standard stability window, a mandatory extra poll cycle absorbs the second loader.
//
// Uses evaluateExpr (cheap, no full DOM extraction) for both loader detection and
// the lightweight fingerprint. The full getState() happens AFTER stability, ensuring
// validation signals reflect the final DOM, not a transient one.
const STABILITY_ACTIONS = new Set(['click', 'select', 'navigate', 'keypress']);
const STABILITY_POLL_MS = 200;
const STABILITY_STABLE_POLLS = 2;   // 2 identical polls = 400ms of no-change
const STABILITY_MAX_MS = 8_000;
const STABILITY_INITIAL_DELAY_MS = 100;

// Extra buffer for the silent second loader on /customeditor/ canvas pages.
// Applied unconditionally after first stability window — the second loader has
// no visual indicator so it cannot be detected; a fixed gap is the only reliable guard.
const CANVAS_DUAL_LOADER_BUFFER_MS = 1_500;
const CANVAS_EDITOR_PATTERN = /\/customeditor\//;

const LOADER_EXPR = `
  (() => {
    try {
      const sel = [
        '.loader:not([style*="display: none"])',
        '.loading:not([style*="display: none"])',
        '.spinner:not([style*="display: none"])',
        '[class*="loading"][style*="block"]',
        '[aria-busy="true"]',
        '[class*="skeleton"]:not([style*="display: none"])',
        '.page-loading',
      ].join(',');
      return !!document.querySelector(sel);
    } catch { return false; }
  })()
`.trim();

const STABILITY_FP_EXPR = `
  (() => {
    try {
      // Count interactive elements only — avoids false instability from React reconciliation,
      // animation frames, and script/style node churn that constantly flip total node count
      // on SPAs without indicating any meaningful UI change.
      return document.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[role="button"]'
      ).length + '|' + document.title.slice(0, 30) + '|' + location.href;
    } catch { return ''; }
  })()
`.trim();

export async function waitForUIStability(
  adapter: ExecutionAdapter,
  action: string,
): Promise<void> {
  if (!STABILITY_ACTIONS.has(action)) {
    await new Promise(r => setTimeout(r, 150));
    return;
  }
  await new Promise(r => setTimeout(r, STABILITY_INITIAL_DELAY_MS));
  const deadline = Date.now() + STABILITY_MAX_MS;
  let lastFp = '';
  let stableCount = 0;
  while (Date.now() < deadline) {
    const loaderActive = await adapter.evaluateExpr<boolean>(LOADER_EXPR).catch(() => false);
    if (loaderActive) {
      stableCount = 0;
      lastFp = '';
      await new Promise(r => setTimeout(r, STABILITY_POLL_MS));
      continue;
    }
    const fp = (await adapter.evaluateExpr<string>(STABILITY_FP_EXPR).catch(() => '')) ?? '';
    if (fp !== lastFp) {
      stableCount = 0;
      lastFp = fp;
    } else {
      stableCount++;
      if (stableCount >= STABILITY_STABLE_POLLS) {
        // Canvas dual-loader: /customeditor/ fires a second silent loader right after
        // the first one clears. Wait for it before returning so the next action does
        // not land on a still-locked canvas (missing buttons / failed clicks).
        const url = await adapter.evaluateExpr<string>('location.href').catch(() => '');
        if (url && CANVAS_EDITOR_PATTERN.test(url)) {
          console.debug(`[action-engine] canvas dual-loader buffer up to ${CANVAS_DUAL_LOADER_BUFFER_MS}ms (action=${action})`);
          // Poll during the buffer window. Exit early if the "+" circle button
          // appears — that is the definitive signal both loaders have completed.
          // Selectors derived from actual Appy Pie connect editor DOM:
          //   button[data-tooltip="Add New Step"]  — the "+" circle below any canvas node
          //   button.center-btn                     — same button, class-based fallback
          //   .secondary-btn-container              — wrapper div always present with the "+"
          const CANVAS_READY_EXPR = `
            (() => {
              try {
                return !!(
                  document.querySelector('button[data-tooltip="Add New Step"]') ||
                  document.querySelector('button.center-btn') ||
                  document.querySelector('.secondary-btn-container')
                );
              } catch { return false; }
            })()
          `.trim();
          const bufferEnd = Date.now() + CANVAS_DUAL_LOADER_BUFFER_MS;
          while (Date.now() < bufferEnd) {
            await new Promise(r => setTimeout(r, 200));
            const canvasReady = await adapter.evaluateExpr<boolean>(CANVAS_READY_EXPR).catch(() => false);
            if (canvasReady) {
              console.debug('[action-engine] canvas dual-loader: "+" button detected — canvas ready early');
              break;
            }
          }
          // One final loader check — if a second loader surfaced, reset and continue polling.
          const secondLoaderActive = await adapter.evaluateExpr<boolean>(LOADER_EXPR).catch(() => false);
          if (secondLoaderActive) {
            stableCount = 0;
            lastFp = '';
            continue;
          }
        }
        return;
      }
    }
    await new Promise(r => setTimeout(r, STABILITY_POLL_MS));
  }
  console.debug(`[action-engine] UI stability timeout after ${STABILITY_MAX_MS}ms — proceeding (action=${action})`);
}

// ── Main: Execute + Validate ────────────────────────────────────
export async function executeValidatedAction(
  adapter: ExecutionAdapter,
  step: ActionStep,
  currentState: BrowserState,
  options?: { forcedStrategy?: ExecutionStrategy; preferredStrategy?: ExecutionStrategy; allowCoordinates?: boolean },
): Promise<ValidatedResult> {
  const start = Date.now();
  const el = resolveTarget(step.target, currentState.elements);

  // ── Get state BEFORE ──────────────────────────────────────
  const before = await adapter.getState();

  // ── IAL: classify intent → run specialized handler if applicable ──
  // Proactive classification — picks the right handler upfront instead of
  // letting cua-loop's post-hoc fixup blocks (Continue & Run Test detector,
  // event-pattern matcher, variable-token detector, etc.) catch things AFTER
  // a generic action wastes a turn.
  //
  // If IAL handles the action, we skip the strategy chain entirely and use
  // its result. Otherwise (generic primitives) we fall through.
  let result: StrategyResult = { success: false, effective: false, strategyUsed: 'selector' };
  let description = '';

  const iaPlan = classifyInteraction({
    step, state: currentState,
    resolvedElement: el,
    url: currentState.url,
  });
  const isSpecializedType =
    iaPlan.type !== 'GENERIC_CLICK' &&
    iaPlan.type !== 'GENERIC_TYPE' &&
    iaPlan.type !== 'GENERIC_SELECT' &&
    iaPlan.type !== 'NAVIGATE' &&
    iaPlan.type !== 'SCROLL' &&
    iaPlan.type !== 'WAIT' &&
    iaPlan.type !== 'KEYPRESS' &&
    iaPlan.type !== 'DONE';

  let ialHandlerName: string | undefined;
  let ialFieldLabel: string | undefined;
  let ialAuthoritativeEffective: boolean | undefined;
  if (options?.forcedStrategy === undefined && isSpecializedType) {
    const ialResult = await executeInteraction(iaPlan, adapter);
    if (ialResult.handled && ialResult.result) {
      ialHandlerName = ialResult.handlerName;
      ialFieldLabel = ialResult.fieldLabel;
      ialAuthoritativeEffective = ialResult.authoritativeEffective;
      result = { ...ialResult.result, strategyUsed: 'text' };
      description = `${iaPlan.type.toLowerCase()}: ${ialResult.handlerName || ''}`.trim();
    }
    // If !handled, fall through to the generic strategy chain below.
  }
  // Track whether IAL already produced a result so the strategy switch below
  // can skip its own work.
  const ialAlreadyRan = result.success;

  // ── IAL observability (PR V1) ───────────────────────────────
  // Single log line per turn with: target / classified type / handler / effective.
  // Lets us measure classification accuracy over runs. Emit BEFORE knowing
  // `effective` when fall-through happened; `effective` filled in later from validation.
  // For now we emit a lightweight pre-line here; the post-line (with effective)
  // fires after validation at the bottom of this function.
  console.log(
    `[IAL:classify] target=${targetToDisplay(step.target)} action=${step.action} → ${iaPlan.type}` +
    (ialHandlerName ? ` handler=${ialHandlerName}` : ' handler=—') +
    ` reason="${iaPlan.reason}"`,
  );

  const targetDisplay = targetToDisplay(step.target);

  // Skip the strategy chain when IAL already produced a successful result.
  if (!ialAlreadyRan) switch (step.action) {
    case 'click': {
      if (!el) {
        // Smart panel search: element not in indexed DOM — try direct text match on page
        if (step.value && step.value.length > 2 && step.value.length < 60) {
          const searchText = step.value;
          console.log(`[action-engine] Element ${targetDisplay} not found — trying panel text search: "${searchText.slice(0, 30)}"`);
          const panelResult = await adapter.clickByPanelText(searchText);
          if (panelResult.success) {
            result = { ...panelResult, strategyUsed: 'text' };
            description = `clicked panel item "${searchText.slice(0, 25)}" (text search)`;
            break;
          }
        }
        // Fuzzy: try text from target (the target may itself carry a text hint)
        const canonicalTarget = coerceLegacyTarget(step.target);
        const fuzzyNeedle = (canonicalTarget?.text || canonicalTarget?.elementId || '').toLowerCase();
        const textFromTarget = fuzzyNeedle
          ? currentState.elements.find(e => e.text?.toLowerCase().includes(fuzzyNeedle))
          : undefined;
        if (textFromTarget) {
          result = await executeClick(adapter, textFromTarget, options?.forcedStrategy);
          description = result.success
            ? `clicked "${textFromTarget.text?.slice(0, 25)}" (fuzzy match)`
            : `click fuzzy match failed: ${result.error}`;
          break;
        }
        result = { success: false, effective: false, error: `Element ${targetDisplay} not found in DOM`, strategyUsed: 'selector' };
        description = `click ${targetDisplay}: element not found`;
        break;
      }
      result = await executeClick(adapter, el, options?.forcedStrategy, options?.preferredStrategy, options?.allowCoordinates ?? true);
      description = result.success
        ? `clicked ${el.elementId} "${el.text?.slice(0, 25) || el.tag}" [${result.strategyUsed}]`
        : `click ${el.elementId} failed: ${result.error}`;
      // If all indexed strategies failed, try panel text search as last resort
      if (!result.success && el.text && el.text.length > 2) {
        console.log(`[action-engine] Indexed click failed — trying panel text: "${el.text.slice(0, 30)}"`);
        const panelResult = await adapter.clickByPanelText(el.text);
        if (panelResult.success) {
          result = { ...panelResult, strategyUsed: 'text' };
          description = `clicked "${el.text.slice(0, 25)}" (panel text fallback)`;
        }
      }
      break;
    }

    case 'type': {
      if (!el || !step.value) {
        result = { success: false, effective: false, error: 'Missing target or value for type', strategyUsed: 'selector' };
        description = 'type: missing target/value';
        break;
      }
      result = await executeType(adapter, el, step.value, options?.forcedStrategy);
      description = result.success
        ? `typed "${step.value.slice(0, 20)}" into ${el.elementId} [${result.strategyUsed}]`
        : `type ${el.elementId} failed: ${result.error}`;
      break;
    }

    case 'select': {
      if (!el || !step.value) {
        result = { success: false, effective: false, error: 'Missing target or value for select', strategyUsed: 'selector' };
        description = 'select: missing target/value';
        break;
      }
      result = await executeSelect(adapter, el, step.value);
      description = result.success
        ? `selected "${step.value.slice(0, 20)}" on ${el.elementId} [${result.strategyUsed}]`
        : `select ${el.elementId} failed: ${result.error}`;
      break;
    }

    case 'scroll': {
      const dir = step.value === 'up' ? 'up' as const : 'down' as const;
      result = { ...(await adapter.scroll(dir)), strategyUsed: 'coordinates' };
      description = `scrolled ${dir}`;
      break;
    }

    case 'navigate': {
      if (!step.value) {
        result = { success: false, effective: false, error: 'No URL', strategyUsed: 'selector' };
        description = 'navigate: no URL';
        break;
      }
      // Safety guard: never navigate to localhost/loopback (test-runner own pages)
      try {
        const navHost = new URL(step.value).hostname;
        if (navHost === 'localhost' || navHost === '127.0.0.1' || navHost.startsWith('::')) {
          result = { success: false, effective: false, error: `Navigate to localhost blocked`, strategyUsed: 'selector' };
          description = `navigate blocked: localhost URL "${step.value.slice(0, 60)}"`;
          break;
        }
      } catch { /* malformed URL — fall through */ }
      result = { ...(await adapter.navigate(step.value)), strategyUsed: 'selector' };
      description = result.success ? `navigated to ${step.value.slice(0, 50)}` : `navigate failed: ${result.error}`;
      break;
    }

    case 'keypress': {
      const key = step.value || 'Enter';
      result = { ...(await adapter.keypress(key)), strategyUsed: 'selector' };
      description = result.success ? `pressed ${key}` : `keypress ${key} failed: ${result.error}`;
      break;
    }

    case 'wait': {
      result = { ...(await adapter.wait(parseInt(step.value || '500', 10))), strategyUsed: 'selector' };
      description = `waited ${step.value || 500}ms`;
      break;
    }

    default:
      result = { success: false, effective: false, error: `Unknown: ${step.action}`, strategyUsed: 'selector' };
      description = `unknown: ${step.action}`;
  }

  // ── UI Stabilization (replaces fixed settle delay) ───────────
  // Waits for loaders to clear and DOM to stop changing before reading `after`.
  // Prevents acting on transient intermediate states (e.g. loader shows "Add Account"
  // briefly before the real next step renders).
  if (result.success) {
    await waitForUIStability(adapter, step.action);
  }

  // ── Get state AFTER ───────────────────────────────────────
  const after = await adapter.getState();

  // ── Validate ──────────────────────────────────────────────
  const urlChanged = before.url !== after.url;
  const domChanged = before.domFingerprint !== after.domFingerprint;

  // Value change
  let valueChanged = false;
  const targetIdForValidation = el?.elementId || targetElementId(step.target);
  if ((step.action === 'type' || step.action === 'select') && targetIdForValidation) {
    const beforeVal = before.formValues[targetIdForValidation] || '';
    const afterVal = after.formValues[targetIdForValidation] || '';
    valueChanged = beforeVal !== afterVal;
    if (!valueChanged && step.value) {
      valueChanged = Object.values(after.formValues).some(v => v.includes(step.value!.slice(0, 20)));
    }
  }

  // Error detection
  const newErrors = after.errorMessages.filter(e => !before.errorMessages.includes(e));
  const errorAppeared = newErrors.length > 0;

  // Element still exists?
  const elementStillExists = step.target
    ? (targetIdForValidation ? after.elements.some(e => e.elementId === targetIdForValidation) : true)
    : true;

  // ── Centralized outcome validation ───────────────────────────
  // Single source of truth for "did the action achieve its intent?"
  // Structured ExpectedOutcome (preferred) → deterministic check.
  // Legacy string expected → keyword fallback (backward compat).
  // No expected → action-type inference as last resort.

  function validateOutcome(expected: ExpectedOutcome): boolean {
    switch (expected.type) {
      case 'navigation':
        return before.url !== after.url &&
               (!expected.urlIncludes || after.url.includes(expected.urlIncludes));
      case 'value_change':
        return valueChanged;
      case 'element_appears': {
        const wasAbsent = !before.elements.some(e => (e.text || '').toLowerCase().includes(expected.text.toLowerCase()));
        const nowPresent = after.elements.some(e => (e.text || '').toLowerCase().includes(expected.text.toLowerCase()));
        return wasAbsent && nowPresent;
      }
      case 'element_disappears': {
        const wasPresent = before.elements.some(e => (e.text || '').toLowerCase().includes(expected.text.toLowerCase()));
        const nowAbsent = !after.elements.some(e => (e.text || '').toLowerCase().includes(expected.text.toLowerCase()));
        return wasPresent && nowAbsent;
      }
      case 'dom_change':
        // Meaningful structural change: element count shifted or key text changed.
        return after.elements.length !== before.elements.length ||
               JSON.stringify(after.keyText) !== JSON.stringify(before.keyText);
      case 'none':
        return true; // action expected to produce no observable change
    }
  }

  // Strict mode: set VALIDATION_STRICT_MODE=true to reject string-based expected entirely.
  // Lenient (default): string path fires with a warning so migration can be tracked in logs.
  const STRICT = process.env.VALIDATION_STRICT_MODE === 'true';

  function legacyStringOutcome(exp: string): boolean {
    // Keyword fallback for LLM free-form strings. Narrowed signals per keyword category
    // to avoid false positives from toast/SPA noise.
    // Default is FALSE — unknown phrases don't silently pass.
    console.warn(`[validation] string expected="${exp}" — migrate to ExpectedOutcome for deterministic validation`);
    if (STRICT) return false; // strict mode rejects all string-based validation

    const s = exp.toLowerCase();
    // Navigation: only URL change is proof (not domChanged — toasts satisfy domChanged)
    if (s.includes('navigate') || s.includes('redirect')) return urlChanged;
    // Form submit: URL change preferred; domChanged only if AJAX confirmed by keyword
    if (s.includes('submit') || s.includes('form')) return urlChanged || domChanged;
    // Value/input: value change only
    if (s.includes('value') || s.includes('fill') || s.includes('type') || s.includes('input')) return valueChanged;
    // Structural UI: dom or value change (modal appearing changes DOM count)
    if (s.includes('modal') || s.includes('dialog') || s.includes('popup')) return domChanged;
    if (s.includes('open') || s.includes('close') || s.includes('dismiss')) return domChanged;
    if (s.includes('update') || s.includes('change') || s.includes('ajax')) return domChanged || valueChanged;
    return false;
  }

  // Meaningful structural DOM change: element count shift OR key text shift.
  // NOT raw domChanged — CSS hover states, toasts, and SPA micro-updates all
  // flip domChanged without indicating the action's intended outcome.
  const meaningfulDomChange =
    after.elements.length !== before.elements.length ||
    JSON.stringify(after.keyText) !== JSON.stringify(before.keyText);

  let baseEffective: boolean;
  let validationPath: 'structured' | 'legacy-string' | 'type-inference';
  let validationConfidence: ValidationConfidence;

  if (step.expected && typeof step.expected !== 'string') {
    baseEffective = validateOutcome(step.expected);
    validationPath = 'structured';
    validationConfidence = 'strong'; // structured outcome = deterministic check
    if (step.expected.type === 'element_appears') {
      validationConfidence = 'medium'; // never allow 'strong' — DOM extractor is a top-25 sample, not exhaustive
    }
  } else if (step.expected && typeof step.expected === 'string') {
    baseEffective = legacyStringOutcome(step.expected);
    validationPath = 'legacy-string';
    validationConfidence = 'weak'; // keyword heuristics
  } else {
    // No expected — action-type inference. Track which signal was decisive to grade confidence.
    // strong signal (urlChanged, valueChanged, elementGone) → medium confidence
    // weak signal (meaningfulDomChange, domChanged) → weak confidence
    switch (step.action) {
      case 'navigate':
        baseEffective = urlChanged;
        validationConfidence = urlChanged ? 'medium' : 'weak';
        break;
      case 'type':
      case 'select':
        baseEffective = valueChanged || domChanged;
        validationConfidence = valueChanged ? 'medium' : 'weak';
        break;
      case 'click':
        if (urlChanged || !elementStillExists || valueChanged) {
          baseEffective = true;
          validationConfidence = 'medium'; // specific signal proved the click
        } else if (meaningfulDomChange) {
          baseEffective = true;
          validationConfidence = 'weak'; // structural change is still a guess
        } else {
          baseEffective = false;
          validationConfidence = 'weak';
        }
        break;
      case 'keypress':
        baseEffective = urlChanged || domChanged;
        validationConfidence = urlChanged ? 'medium' : 'weak';
        break;
      default:
        baseEffective = urlChanged || domChanged || valueChanged || errorAppeared;
        validationConfidence = 'weak';
        break;
    }
    validationPath = 'type-inference';
  }

  // intentMatch preserved for DB logging compat — derives from baseEffective.
  const intentMatch = baseEffective;
  const effective = ialAuthoritativeEffective !== undefined ? ialAuthoritativeEffective : baseEffective;

  // Aggregate-log non-structured validation. Emit one line every 10 occurrences
  // so logs stay usable — not one warning per action per run.
  if (validationPath !== 'structured' && step.action !== 'wait' && step.action !== 'scroll' && step.action !== 'done') {
    _legacyValidationCount++;
    if (_legacyValidationCount % 10 === 1 || STRICT) {
      console.log(`[validation] non-structured path=${validationPath} action=${step.action} effective=${effective} count=${_legacyValidationCount} (set VALIDATION_STRICT_MODE=true to enforce structured outcomes)`);
    }
  }

  // Actions that are expected to produce a visible page change. Actions NOT
  // in this set (wait, scroll, done) are treated as neutral — a successful
  // run that produces no change is normal and must not be marked [no effect]
  // nor trigger a retry. wait is a deliberate pause; scroll may simply move
  // the viewport without mutating DOM/URL/values.
  const EXPECTS_CHANGE = new Set(['click', 'type', 'select', 'navigate', 'keypress']);
  if (result.success && EXPECTS_CHANGE.has(step.action) && !effective) {
    description += ' [no effect]';
  }

  // ── Retry strategy ────────────────────────────────────────
  let retryStrategy: ValidatedResult['retryStrategy'] = 'none';
  if (!result.success) {
    if (!el) retryStrategy = 'rescan_dom';
    else retryStrategy = 'change_target';
  } else if (!effective && EXPECTS_CHANGE.has(step.action)) {
    retryStrategy = 'change_target';
  } else if (errorAppeared) {
    retryStrategy = 'fix_input';
  } else if (!elementStillExists) {
    retryStrategy = 'rescan_dom';
  }

  const signals: ActionSignals = { urlChanged, domChanged, valueChanged };
  const details: ValidationDetails = {
    errorAppeared,
    errorMessage: newErrors[0],
    elementStillExists,
    intentMatch,
  };

  // IAL post-result observability — now with effective ground truth.
  // Use this to measure (correct / total) classification accuracy by eyeballing
  // the logs or by grepping for `[IAL:result]` lines with effective=false on
  // specialized types (those are the misclassifications to investigate).
  if (ialAlreadyRan) {
    console.log(
      `[IAL:result] ${iaPlan.type} handler=${ialHandlerName || '—'} effective=${effective} ` +
      `urlΔ=${signals.urlChanged?1:0} domΔ=${signals.domChanged?1:0} valΔ=${signals.valueChanged?1:0}`,
    );
  }

  return {
    success: result.success,
    effective,
    validationConfidence,
    error: result.error,
    action: step.action,
    target: targetDisplay,   // canonical string representation for logs/persistence
    value: step.value,
    description,
    strategyUsed: result.strategyUsed,
    retryStrategy,
    signals,
    details,
    // Derived (frozen) — legacy shape only. New code reads signals/details.
    validation: deriveValidation(signals, details),
    durationMs: Date.now() - start,
    // IAL metadata — cua-loop consults ialHandled to skip legacy post-hoc
    // detection blocks when IAL already fired the specialized handler.
    ialHandled: ialAlreadyRan,
    ialType: iaPlan.type,
    ialFieldLabel: ialFieldLabel || iaPlan.hints?.fieldLabel || iaPlan.hints?.eventText,
  };
}
