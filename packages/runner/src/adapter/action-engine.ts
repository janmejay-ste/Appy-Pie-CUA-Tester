import type { ExecutionAdapter, ActionStep, ActionResult, BrowserState, IndexedElement } from './types.js';

// ── Strategy Types ──────────────────────────────────────────────
export type ExecutionStrategy = 'selector' | 'text' | 'role' | 'coordinates';

// Internal result type that carries which execution strategy was used
type StrategyResult = ActionResult & { strategyUsed: ExecutionStrategy };

// ── Validated Result ────────────────────────────────────────────
export interface ValidatedResult {
  success: boolean;
  effective: boolean;         // something actually changed
  error?: string;
  action: string;
  target?: string;
  value?: string;
  description: string;
  strategyUsed: ExecutionStrategy;   // which strategy actually executed the action
  retryStrategy?: 'change_target' | 'fix_input' | 'rescan_dom' | 'scroll' | 'none';
  validation: {
    urlChanged: boolean;
    domChanged: boolean;
    valueChanged: boolean;
    errorAppeared: boolean;
    errorMessage?: string;
    elementStillExists: boolean;
    intentMatch: boolean;     // did the action achieve its expected outcome?
  };
  durationMs: number;
}

// ── Resolve target: find element by stable elementId ────────────
function resolveTarget(targetId: string | undefined, elements: IndexedElement[]): IndexedElement | null {
  if (!targetId) return null;

  // Direct match by elementId
  const exact = elements.find(el => el.elementId === targetId);
  if (exact) return exact;

  // Fallback: try index-based (e0, e1, e2)
  const indexMatch = targetId.match(/^e(\d+)$/);
  if (indexMatch) {
    const idx = parseInt(indexMatch[1], 10);
    return elements[idx] || null;
  }

  return null;
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
    } else if (forcedStrategy === 'text' && el.text?.length > 2) {
      forcedResult = await adapter.clickByText(el.text.slice(0, 40));
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

  if (!hasStableSelector && (el as any)._cssSelector) {
    strategies.push({ fn: () => adapter.clickBySelector((el as any)._cssSelector), type: 'selector' });
  }

  if (hasRole && !hasUniqueText) {
    strategies.push({ fn: () => adapter.clickByText('', el.attributes['role'] || el.tag), type: 'role' });
  }

  // Coordinates last — only include when actually needed (not blocked by allowCoordinates=false)
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
  const selectors = [
    el.attributes['id'] ? `#${el.attributes['id']}` : null,
    (el as any)._cssSelector || null,
    el.attributes['name'] ? `${el.tag}[name="${el.attributes['name']}"]` : null,
  ].filter(Boolean) as string[];

  for (const sel of selectors) {
    const r = await adapter.typeBySelector(sel, text);
    if (r.success) return { ...r, strategyUsed: 'selector' };
  }

  return { ...(await adapter.typeByCoordinates(cx, cy, text)), strategyUsed: 'coordinates' };
}

async function executeSelect(adapter: ExecutionAdapter, el: IndexedElement, value: string): Promise<StrategyResult> {
  const selectors = [
    el.attributes['id'] ? `#${el.attributes['id']}` : null,
    (el as any)._cssSelector || null,
    el.attributes['name'] ? `select[name="${el.attributes['name']}"]` : null,
  ].filter(Boolean) as string[];

  for (const sel of selectors) {
    const r = await adapter.selectBySelector(sel, value);
    if (r.success) return { ...r, strategyUsed: 'selector' };
  }

  // Fallback: try Appy Pie custom dropdown handler
  const dropdownLabel = el.text || el.placeholder || el.attributes['name'] || '';
  if (dropdownLabel) {
    const ddResult = await adapter.openAndSelectDropdown(dropdownLabel, value);
    if (ddResult.success) return { ...ddResult, strategyUsed: 'text' };
  }

  // Fallback: click select, then click option text
  const clickResult = await executeClick(adapter, el);
  if (clickResult.success) {
    await new Promise(r => setTimeout(r, 300));
    return { ...(await adapter.clickByText(value)), strategyUsed: 'text' };
  }

  return { success: false, effective: false, error: `Select failed for ${el.elementId}`, strategyUsed: 'selector' };
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
  const before = currentState; // already have it, no extra call

  // ── Execute ───────────────────────────────────────────────
  let result: StrategyResult = { success: false, effective: false, strategyUsed: 'selector' };
  let description = '';

  switch (step.action) {
    case 'click': {
      if (!el) {
        // Smart panel search: element not in indexed DOM — try direct text match on page
        if (step.value && step.value.length > 2 && step.value.length < 60) {
          const searchText = step.value;
          console.log(`[action-engine] Element ${step.target} not found — trying panel text search: "${searchText.slice(0, 30)}"`);
          const panelResult = await adapter.clickByPanelText(searchText);
          if (panelResult.success) {
            result = { ...panelResult, strategyUsed: 'text' };
            description = `clicked panel item "${searchText.slice(0, 25)}" (text search)`;
            break;
          }
        }
        // Fuzzy: try text from target name
        const textFromTarget = currentState.elements.find(e =>
          e.text?.toLowerCase().includes(step.target?.toLowerCase() || '')
        );
        if (textFromTarget) {
          result = await executeClick(adapter, textFromTarget, options?.forcedStrategy);
          description = result.success
            ? `clicked "${textFromTarget.text?.slice(0, 25)}" (fuzzy match)`
            : `click fuzzy match failed: ${result.error}`;
          break;
        }
        result = { success: false, effective: false, error: `Element ${step.target} not found in DOM`, strategyUsed: 'selector' };
        description = `click ${step.target}: element not found`;
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

  // ── Settle delay ──────────────────────────────────────────
  if (result.success && step.action !== 'wait') {
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Get state AFTER ───────────────────────────────────────
  const after = await adapter.getState();

  // ── Validate ──────────────────────────────────────────────
  const urlChanged = before.url !== after.url;
  const domChanged = before.domFingerprint !== after.domFingerprint;

  // Value change
  let valueChanged = false;
  if ((step.action === 'type' || step.action === 'select') && step.target) {
    const targetId = el?.elementId || step.target;
    const beforeVal = before.formValues[targetId] || '';
    const afterVal = after.formValues[targetId] || '';
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
    ? after.elements.some(e => e.elementId === (el?.elementId || step.target))
    : true;

  // Intent match — supports SPA, modals, AJAX patterns
  let intentMatch = true;
  if (step.expected) {
    const exp = step.expected.toLowerCase();
    if (exp.includes('navigate') || exp.includes('redirect')) {
      intentMatch = urlChanged || domChanged;
    } else if (exp.includes('submit') || exp.includes('form')) {
      intentMatch = urlChanged || domChanged;
    } else if (exp.includes('value') || exp.includes('fill')) {
      intentMatch = valueChanged;
    } else if (exp.includes('modal') || exp.includes('dialog') || exp.includes('popup') || exp.includes('open')) {
      intentMatch = domChanged;
    } else if (exp.includes('update') || exp.includes('change') || exp.includes('ajax')) {
      intentMatch = domChanged || valueChanged;
    } else if (exp.includes('close') || exp.includes('dismiss')) {
      intentMatch = domChanged;
    }
  }

  // Effective = something actually changed
  const effective = urlChanged || domChanged || valueChanged || errorAppeared;

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

  return {
    success: result.success,
    effective,
    error: result.error,
    action: step.action,
    target: step.target,
    value: step.value,
    description,
    strategyUsed: result.strategyUsed,
    retryStrategy,
    validation: {
      urlChanged,
      domChanged,
      valueChanged,
      errorAppeared,
      errorMessage: newErrors[0],
      elementStillExists,
      intentMatch,
    },
    durationMs: Date.now() - start,
  };
}
