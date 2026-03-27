import type { ExecutionAdapter, ActionStep, ActionResult, BrowserState, IndexedElement } from './types.js';

// ── Validated Result ────────────────────────────────────────────
export interface ValidatedResult {
  success: boolean;
  effective: boolean;         // something actually changed
  error?: string;
  action: string;
  target?: string;
  value?: string;
  description: string;
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

  // Fuzzy: nearest by text similarity (last resort)
  return null;
}

// ── Execute with adaptive fallback (order depends on element attributes) ──
async function executeClick(adapter: ExecutionAdapter, el: IndexedElement): Promise<ActionResult> {
  // Build fallback chain adaptively based on what the element has
  const strategies: Array<() => Promise<ActionResult>> = [];

  const hasStableSelector = !!(el.attributes['data-testid'] || el.attributes['id'] || el.attributes['name']);
  const hasUniqueText = !!(el.text && el.text.length > 2 && el.text.length < 60);
  const hasRole = !!(el.attributes['role'] || el.tag === 'button' || el.tag === 'a');

  // Adaptive order: prioritize strongest signal
  if (hasStableSelector) {
    // Stable selectors first (data-testid, id, name)
    if (el.attributes['data-testid']) strategies.push(() => adapter.clickBySelector(`[data-testid="${el.attributes['data-testid']}"]`));
    if (el.attributes['id']) strategies.push(() => adapter.clickBySelector(`#${el.attributes['id']}`));
    if ((el as any)._cssSelector) strategies.push(() => adapter.clickBySelector((el as any)._cssSelector));
  }

  if (hasUniqueText) {
    const role = (el.tag === 'button' || el.attributes['role'] === 'button') ? 'button'
      : (el.tag === 'a') ? 'link' : undefined;
    strategies.push(() => adapter.clickByText(el.text.slice(0, 40), role));
  }

  if (!hasStableSelector && (el as any)._cssSelector) {
    // CSS selector as fallback if no stable attrs
    strategies.push(() => adapter.clickBySelector((el as any)._cssSelector));
  }

  if (hasRole && !hasUniqueText) {
    strategies.push(() => adapter.clickByText('', el.attributes['role'] || el.tag));
  }

  // Coordinates always last
  strategies.push(() => {
    const cx = el.boundingBox.x + el.boundingBox.w / 2;
    const cy = el.boundingBox.y + el.boundingBox.h / 2;
    return adapter.clickByCoordinates(cx, cy);
  });

  // Execute in order until one succeeds
  for (const strategy of strategies) {
    const r = await strategy();
    if (r.success) return r;
  }

  return { success: false, effective: false, error: `All ${strategies.length} click strategies failed for ${el.elementId}` };
}

async function executeType(adapter: ExecutionAdapter, el: IndexedElement, text: string): Promise<ActionResult> {
  // Layer 1: CSS selector
  const selectors = [
    el.attributes['id'] ? `#${el.attributes['id']}` : null,
    (el as any)._cssSelector || null,
    el.attributes['name'] ? `${el.tag}[name="${el.attributes['name']}"]` : null,
  ].filter(Boolean) as string[];

  for (const sel of selectors) {
    const r = await adapter.typeBySelector(sel, text);
    if (r.success) return r;
  }

  // Layer 2: Coordinates
  const cx = el.boundingBox.x + el.boundingBox.w / 2;
  const cy = el.boundingBox.y + el.boundingBox.h / 2;
  return adapter.typeByCoordinates(cx, cy, text);
}

async function executeSelect(adapter: ExecutionAdapter, el: IndexedElement, value: string): Promise<ActionResult> {
  const selectors = [
    el.attributes['id'] ? `#${el.attributes['id']}` : null,
    (el as any)._cssSelector || null,
    el.attributes['name'] ? `select[name="${el.attributes['name']}"]` : null,
  ].filter(Boolean) as string[];

  for (const sel of selectors) {
    const r = await adapter.selectBySelector(sel, value);
    if (r.success) return r;
  }

  // Fallback: try Appy Pie custom dropdown handler
  const dropdownLabel = el.text || el.placeholder || el.attributes['name'] || '';
  if (dropdownLabel) {
    const ddResult = await adapter.openAndSelectDropdown(dropdownLabel, value);
    if (ddResult.success) return ddResult;
  }

  // Fallback: click select, then click option text
  const clickResult = await executeClick(adapter, el);
  if (clickResult.success) {
    await new Promise(r => setTimeout(r, 300));
    return adapter.clickByText(value);
  }

  return { success: false, effective: false, error: `Select failed for ${el.elementId}` };
}

// ── Main: Execute + Validate ────────────────────────────────────
export async function executeValidatedAction(
  adapter: ExecutionAdapter,
  step: ActionStep,
  currentState: BrowserState,
): Promise<ValidatedResult> {
  const start = Date.now();
  const el = resolveTarget(step.target, currentState.elements);

  // ── Get state BEFORE ──────────────────────────────────────
  const before = currentState; // already have it, no extra call

  // ── Execute ───────────────────────────────────────────────
  let result: ActionResult;
  let description = '';

  switch (step.action) {
    case 'click': {
      if (!el) {
        // Smart panel search: element not in indexed DOM — try direct text match on page
        // This handles right-panel items, dropdown options, Angular dynamic elements
        // IMPORTANT: Only use step.value for text search, NOT step.reason
        // Reason contains natural language that causes false matches
        if (step.value && step.value.length > 2 && step.value.length < 60) {
          const searchText = step.value;
          console.log(`[action-engine] Element ${step.target} not found — trying panel text search: "${searchText.slice(0, 30)}"`);
          const panelResult = await adapter.clickByPanelText(searchText);
          if (panelResult.success) {
            result = panelResult;
            description = `clicked panel item "${searchText.slice(0, 25)}" (text search)`;
            break;
          }
        }
        // Also try text from the model's reason field
        const textFromTarget = currentState.elements.find(e =>
          e.text?.toLowerCase().includes(step.target?.toLowerCase() || '')
        );
        if (textFromTarget) {
          result = await executeClick(adapter, textFromTarget);
          description = result.success
            ? `clicked "${textFromTarget.text?.slice(0, 25)}" (fuzzy match)`
            : `click fuzzy match failed: ${result.error}`;
          break;
        }
        result = { success: false, effective: false, error: `Element ${step.target} not found in DOM` };
        description = `click ${step.target}: element not found`;
        break;
      }
      result = await executeClick(adapter, el);
      description = result.success
        ? `clicked ${el.elementId} "${el.text?.slice(0, 25) || el.tag}"`
        : `click ${el.elementId} failed: ${result.error}`;
      // If all indexed strategies failed, try panel text search as last resort
      if (!result.success && el.text && el.text.length > 2) {
        console.log(`[action-engine] Indexed click failed — trying panel text: "${el.text.slice(0, 30)}"`);
        const panelResult = await adapter.clickByPanelText(el.text);
        if (panelResult.success) {
          result = panelResult;
          description = `clicked "${el.text.slice(0, 25)}" (panel text fallback)`;
        }
      }
      break;
    }

    case 'type': {
      if (!el || !step.value) {
        result = { success: false, effective: false, error: 'Missing target or value for type' };
        description = 'type: missing target/value';
        break;
      }
      result = await executeType(adapter, el, step.value);
      description = result.success
        ? `typed "${step.value.slice(0, 20)}" into ${el.elementId}`
        : `type ${el.elementId} failed: ${result.error}`;
      break;
    }

    case 'select': {
      if (!el || !step.value) {
        result = { success: false, effective: false, error: 'Missing target or value for select' };
        description = 'select: missing target/value';
        break;
      }
      result = await executeSelect(adapter, el, step.value);
      description = result.success
        ? `selected "${step.value.slice(0, 20)}" on ${el.elementId}`
        : `select ${el.elementId} failed: ${result.error}`;
      break;
    }

    case 'scroll': {
      const dir = step.value === 'up' ? 'up' as const : 'down' as const;
      result = await adapter.scroll(dir);
      description = `scrolled ${dir}`;
      break;
    }

    case 'navigate': {
      if (!step.value) {
        result = { success: false, effective: false, error: 'No URL' };
        description = 'navigate: no URL';
        break;
      }
      result = await adapter.navigate(step.value);
      description = result.success ? `navigated to ${step.value.slice(0, 50)}` : `navigate failed: ${result.error}`;
      break;
    }

    case 'keypress': {
      const key = step.value || 'Enter';
      result = await adapter.keypress(key);
      description = result.success ? `pressed ${key}` : `keypress ${key} failed: ${result.error}`;
      break;
    }

    case 'wait': {
      result = await adapter.wait(parseInt(step.value || '500', 10));
      description = `waited ${step.value || 500}ms`;
      break;
    }

    default:
      result = { success: false, effective: false, error: `Unknown: ${step.action}` };
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
    // Also check if value appeared anywhere in form
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
      intentMatch = urlChanged || domChanged; // SPA nav = DOM change without URL
    } else if (exp.includes('submit') || exp.includes('form')) {
      intentMatch = urlChanged || domChanged;
    } else if (exp.includes('value') || exp.includes('fill')) {
      intentMatch = valueChanged;
    } else if (exp.includes('modal') || exp.includes('dialog') || exp.includes('popup') || exp.includes('open')) {
      intentMatch = domChanged; // modal/popup = DOM change
    } else if (exp.includes('update') || exp.includes('change') || exp.includes('ajax')) {
      intentMatch = domChanged || valueChanged;
    } else if (exp.includes('close') || exp.includes('dismiss')) {
      intentMatch = domChanged;
    }
  }

  // Effective = something actually changed
  const effective = urlChanged || domChanged || valueChanged || errorAppeared;

  // Append "[no effect]" if action succeeded but nothing changed
  const EXPECTS_CHANGE = new Set(['click', 'type', 'select', 'navigate']);
  if (result.success && EXPECTS_CHANGE.has(step.action) && !effective) {
    description += ' [no effect]';
  }

  // ── Retry strategy based on failure type ──────────────────
  let retryStrategy: ValidatedResult['retryStrategy'] = 'none';
  if (!result.success) {
    if (!el) retryStrategy = 'rescan_dom';
    else retryStrategy = 'change_target';
  } else if (!effective) {
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
