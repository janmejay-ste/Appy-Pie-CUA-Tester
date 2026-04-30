/**
 * Expected State Engine — DOM Contract Validation
 *
 * Sits between the Step Engine and the State Machine:
 *
 *   STEP ENGINE           (top authority — flow progression)
 *       ↓
 *   EXPECTED STATE ENGINE (DOM contract — is the UI in the right state for this step?)
 *       ↓
 *   STATE MACHINE         (action gating — blocks illegal actions)
 *       ↓
 *   ACTION ENGINE         (execution)
 *
 * Decision hierarchy per turn when contract fails:
 *   count=1 → wait  (give async canvas one stability-settled window to render)
 *   count≥2 → escalate (element confirmed absent after a full stability wait — stop
 *             blind-clicking; switch to vision so the LLM can re-plan with a screenshot)
 *
 * The `escalate` path (not `override`) is the key fix:
 *   WRONG: "button absent → wait → force click absent button → fail × 3 → vision"
 *   RIGHT: "button absent → wait → confirmed still absent → vision immediately"
 */

import type { ExecutionAdapter } from './adapter/types.js';
import type { ActionStep } from './adapter/types.js';
import { FlowStep } from './step-engine.js';

// ── Per-step DOM contracts ────────────────────────────────────────

export interface ExpectedState {
  mustAppear?: string[];          // regex patterns — all must match in DOM text
  mustAppearOneOf?: string[];     // regex patterns — at least one must match
  mustDisappear?: string[];       // regex patterns — none must be present
  mustAppearSelector?: string;    // CSS selector — present regardless of text copy
  panelOpen?: boolean;            // side panel visibility requirement
}

export interface ExpectedStateResult {
  success: boolean;
  reasons: string[];              // failure reasons (empty on success)
}

export type ExpectedStateDecision =
  | { kind: 'allow' }
  | { kind: 'wait';     logMsg: string }
  | { kind: 'escalate'; logMsg: string }   // confirmed absent → immediate vision escalation
  | { kind: 'override'; action: ActionStep; logMsg: string };

// ── Step → Expected State Map ─────────────────────────────────────

/**
 * Returns the DOM contract for a given flow step.
 * Empty contract → always passes (UNKNOWN and setup steps have no hard constraints).
 *
 * mustAppearSelector provides structural CSS detection independent of UI copy
 * (localization, casing, rewording). Text patterns serve as supplementary signals.
 * Either matching is sufficient — the selector covers structural presence, text
 * covers semantic presence.
 */
export function getExpectedState(step: FlowStep): ExpectedState {
  switch (step) {

    case FlowStep.TRIGGER_COMPLETED:
      // After trigger test, "Add Action App" must be on canvas.
      // Selectors derived from actual Appy Pie connect editor DOM:
      //   .toolbar-newStep       — wrapper div containing the three action buttons
      //   .blue-plus-secondary   — class on the secondary-btn-container when configured
      //   .blue-plus-btn         — class on the "+" button when trigger is done
      // Either text OR structural selector passing counts as success.
      return {
        mustAppear: ['Add Action App|add another action'],
        mustAppearSelector: '.toolbar-newStep,.blue-plus-secondary,.blue-plus-btn',
      };

    case FlowStep.ACTION_SETUP:
      return {
        mustAppear: ['Add Action App|add another action'],
        mustAppearSelector: '.toolbar-newStep,.blue-plus-secondary,.blue-plus-btn',
      };

    case FlowStep.FLOW_COMPLETE:
      // Structural selector mirrors step-engine.ts workflowLive Tier-2 class badges.
      // Either text OR structural selector passing counts as success — same dual-signal
      // logic as TRIGGER_COMPLETED so the contract stays consistent with detection.
      return {
        mustAppearOneOf: [
          'workflow is live',
          'connect is live',
          'automation is active',
          'is now live',
        ],
        mustAppearSelector:
          '[class*="workflow-live"],[class*="connect-live"],[class*="automation-active"],' +
          '[class*="workflow-active"],[data-status="live"],[data-status="active"],[class*="zap-on"]',
      };

    default:
      // UNKNOWN, TRIGGER_SETUP, TRIGGER_TEST, ACTION_CONFIG — no hard DOM contract.
      return {};
  }
}

// ── DOM Validation ────────────────────────────────────────────────

function buildValidationExpr(
  mustAppear: string[],
  mustDisappear: string[],
  mustAppearOneOf: string[],
  mustAppearSelector: string,
): string {
  return `
    (() => {
      try {
        function textExists(pattern) {
          var re = new RegExp(pattern, 'i');
          var els = document.querySelectorAll(
            'h1,h2,h3,h4,p,span,button,a,[class*="status"],[class*="success"],' +
            '[class*="alert"],[class*="message"],[role="alert"],[class*="title"],' +
            '[class*="heading"],[class*="label"],[class*="btn"]'
          );
          for (var i = 0; i < els.length; i++) {
            if (re.test(els[i].textContent)) return true;
          }
          return false;
        }
        var sidePanelOpen = !!document.querySelector(
          '.editoption_container, .side-panel, .app-detail-panel, .connect-detail'
        );
        // Structural selector check — copy-independent
        var selectorMatch = ${JSON.stringify(mustAppearSelector)}
          ? !!document.querySelector(${JSON.stringify(mustAppearSelector)})
          : null;
        return {
          mustAppear: ${JSON.stringify(mustAppear)}.map(function(p) {
            return { pattern: p, found: textExists(p) };
          }),
          mustDisappear: ${JSON.stringify(mustDisappear)}.map(function(p) {
            return { pattern: p, found: textExists(p) };
          }),
          mustAppearOneOf: ${JSON.stringify(mustAppearOneOf)}.map(function(p) {
            return { pattern: p, found: textExists(p) };
          }),
          sidePanelOpen: sidePanelOpen,
          selectorMatch: selectorMatch,
        };
      } catch(e) {
        return {
          mustAppear: [], mustDisappear: [], mustAppearOneOf: [],
          sidePanelOpen: false, selectorMatch: null,
        };
      }
    })()
  `.trim();
}

interface ValidationSignals {
  mustAppear:    { pattern: string; found: boolean }[];
  mustDisappear: { pattern: string; found: boolean }[];
  mustAppearOneOf: { pattern: string; found: boolean }[];
  sidePanelOpen: boolean;
  selectorMatch: boolean | null;
}

export async function validateExpectedState(
  adapter: ExecutionAdapter,
  expected: ExpectedState,
): Promise<ExpectedStateResult> {
  const mustAppear      = expected.mustAppear      ?? [];
  const mustDisappear   = expected.mustDisappear   ?? [];
  const mustAppearOneOf = expected.mustAppearOneOf ?? [];
  const mustAppearSelector = expected.mustAppearSelector ?? '';

  // Empty contract → always passes (fast path, no eval)
  if (
    !mustAppear.length &&
    !mustDisappear.length &&
    !mustAppearOneOf.length &&
    !mustAppearSelector &&
    expected.panelOpen === undefined
  ) {
    return { success: true, reasons: [] };
  }

  const expr = buildValidationExpr(mustAppear, mustDisappear, mustAppearOneOf, mustAppearSelector);
  const s = await adapter.evaluateExpr<ValidationSignals>(expr).catch(() => null) ?? {
    mustAppear: [],
    mustDisappear: [],
    mustAppearOneOf: [],
    sidePanelOpen: false,
    selectorMatch: null,
  };

  const reasons: string[] = [];

  // mustAppear + mustAppearSelector: text OR structural selector — either passes.
  // The structural selector is an alternative signal for the SAME UI element, so a
  // single selector match satisfies ALL mustAppear entries (not only index 0).
  for (let i = 0; i < s.mustAppear.length; i++) {
    const r = s.mustAppear[i];
    const satisfiedBySelector = s.selectorMatch === true;
    if (!r.found && !satisfiedBySelector) {
      // Distinguish: text absent AND no structural match
      if (s.selectorMatch === false) {
        reasons.push(`Missing (text + selector): "${r.pattern}" / "${mustAppearSelector}"`);
      } else if (s.selectorMatch === null) {
        reasons.push(`Missing required: "${r.pattern}"`);
      }
      // s.selectorMatch === true → satisfied by selector, no push
    }
  }

  // mustDisappear: no pattern must be found
  for (const r of s.mustDisappear) {
    if (r.found) reasons.push(`Still present (should be gone): "${r.pattern}"`);
  }

  // mustAppearOneOf: at least one text pattern must match, OR the structural selector
  // satisfies it — same dual-signal logic as mustAppear.  This lets FLOW_COMPLETE pass
  // when a class badge is present but the text banner has already dismissed (e.g. toast).
  if (mustAppearOneOf.length > 0 &&
      !s.mustAppearOneOf.some(r => r.found) &&
      s.selectorMatch !== true) {
    reasons.push(`None of expected signals found: [${mustAppearOneOf.join(', ')}]`);
  }

  // panelOpen
  if (expected.panelOpen !== undefined && s.sidePanelOpen !== expected.panelOpen) {
    reasons.push(`Panel mismatch: expected=${expected.panelOpen} actual=${s.sidePanelOpen}`);
  }

  return { success: reasons.length === 0, reasons };
}

// ── Hybrid Force Probe ────────────────────────────────────────────

/**
 * Context-aware DOM probe for "Add Action App" with optional interaction anchor.
 *
 * Two-priority scan — canvas context first, then any visible button:
 *
 *   Priority 1 (canvas-first): search only within workflow/canvas DOM containers.
 *     These containers enclose the node graph where "Add Action App" legitimately
 *     lives. Matching here is high-confidence.
 *
 *   Priority 2 (visible buttons): search any button/role=button visible in the
 *     viewport. Requires getBoundingClientRect visibility to exclude hidden chrome
 *     and collapsed menus that the strict contract correctly ignores.
 *
 * When an interaction anchor is provided (center of last successfully clicked
 * element), candidates within each priority tier are sorted by proximity to that
 * point. This handles the edge case where multiple "Add Action App"-like buttons
 * are present and ensures we prefer the one geometrically nearest to where the
 * user was last interacting — the workflow canvas node area.
 *
 * Intentionally excludes:
 *   - Attribute-only scans ([title],[data-tooltip]) — too permissive; they match
 *     nav tooltips and unrelated UI labels with similar text.
 *   - Non-interactive elements ([onclick],[class*="node"]) — fire on structural
 *     wrappers, not the actual clickable button target.
 *   - Off-viewport elements — invisible elements are not actionable and would
 *     cause a force-click to land incorrectly.
 */
function buildProbeExpr(anchor?: { cx: number; cy: number }): string {
  const hasAnchor = !!anchor;
  const anchorCx = anchor?.cx ?? 0;
  const anchorCy = anchor?.cy ?? 0;
  return `
    (() => {
      try {
        function isVisible(el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 &&
                 r.top < (window.innerHeight + 200) && r.bottom > 0 &&
                 r.left < window.innerWidth && r.right > 0;
        }
        function matchText(el) {
          // Test textContent and aria-label independently to prevent cross-attribute
          // concatenation false-positives (e.g. button text "Add" + aria-label
          // "Shopping cart action" would match /add.{0,10}action/ but is not our target).
          var tc = (el.textContent || '').trim();
          var al = (el.getAttribute('aria-label') || '').trim();
          var matched = /add action|add another action/i.test(tc) || /add action|add another action/i.test(al);
          return matched ? (tc || al).slice(0, 80) : null;
        }
        function cleanText(el) {
          return (el.textContent || '').trim().slice(0, 80);
        }
        // Returns center coordinates and anchor-distance in one getBoundingClientRect call.
        function measure(el) {
          var r = el.getBoundingClientRect();
          var cx = Math.round(r.left + r.width / 2);
          var cy = Math.round(r.top  + r.height / 2);
          var d  = ${hasAnchor}
            ? Math.sqrt((cx - ${anchorCx}) * (cx - ${anchorCx}) + (cy - ${anchorCy}) * (cy - ${anchorCy}))
            : 0;
          return { cx: cx, cy: cy, d: d };
        }

        var candidates = [];

        // Priority 1: inside workflow/canvas container — high-confidence context
        var containers = document.querySelectorAll(
          '[class*="canvas"],[class*="workflow"],[class*="flow-editor"],[class*="connect-editor"],' +
          '[id*="canvas"],[id*="workflow"],[data-testid*="canvas"],[data-testid*="workflow"]'
        );
        for (var c = 0; c < containers.length; c++) {
          var inner = containers[c].querySelectorAll('button,[role="button"],a');
          for (var i = 0; i < inner.length; i++) {
            if (!isVisible(inner[i])) continue;
            var m = matchText(inner[i]);
            if (m) {
              var ms = measure(inner[i]);
              candidates.push({ text: m, clickText: cleanText(inner[i]), cx: ms.cx, cy: ms.cy, context: 'canvas', dist: ms.d });
            }
          }
        }

        // Priority 2: any visible button (not collapsed/hidden chrome)
        var els = document.querySelectorAll('button,[role="button"]');
        for (var j = 0; j < els.length; j++) {
          if (!isVisible(els[j])) continue;
          var m2 = matchText(els[j]);
          if (m2) {
            var already = candidates.some(function(x) { return x.text === m2 && x.context === 'canvas'; });
            if (!already) {
              var ms2 = measure(els[j]);
              candidates.push({ text: m2, clickText: cleanText(els[j]), cx: ms2.cx, cy: ms2.cy, context: 'visible', dist: ms2.d });
            }
          }
        }

        if (!candidates.length) return { found: false, text: '', clickText: '', cx: 0, cy: 0, context: 'none' };

        // Sort: canvas-first; within same context sort by anchor distance
        candidates.sort(function(a, b) {
          if (a.context !== b.context) return a.context === 'canvas' ? -1 : 1;
          return ${hasAnchor} ? a.dist - b.dist : 0;
        });

        var best = candidates[0];
        return { found: true, text: best.text, clickText: best.clickText, cx: best.cx, cy: best.cy, context: best.context };
      } catch(e) { return { found: false, text: '', clickText: '', cx: 0, cy: 0, context: 'error' }; }
    })()
  `.trim();
}

interface ProbeResult { found: boolean; text: string; clickText: string; cx: number; cy: number; context: string; }

/**
 * Returns the best candidate's label and viewport-center coordinates when
 * "Add Action App" is detectable by a context-aware scan but missed by the
 * strict contract, or null when absent.
 *
 * Returning coordinates (in addition to text) allows the caller to execute a
 * coordinate-based click on the EXACT element the probe selected — bypassing
 * `clickByPanelText`'s first-match priority, which may pick the wrong element
 * when multiple buttons share the same text (e.g. "Add Action App" on the
 * canvas AND a sidebar entry). Coordinates are computed from the probe's own
 * `getBoundingClientRect` call, so there is no extra round-trip.
 *
 * `text` is the element's clean textContent (not the combined textContent +
 * aria-label used for matching). When textContent is empty (aria-label-only
 * icon button), null is returned — coordinate-clicking an icon button with
 * no text label would silently succeed or fail with no feedback, so we let
 * vision escalation handle that case via its own coordinate targeting.
 *
 * An optional interaction anchor biases candidate ordering to prefer the button
 * geometrically nearest to the prior interaction point.
 */
export async function probeForAddAction(
  adapter: ExecutionAdapter,
  anchor?: { cx: number; cy: number },
): Promise<{ text: string; cx: number; cy: number } | null> {
  const expr = buildProbeExpr(anchor);
  const r = await adapter.evaluateExpr<ProbeResult>(expr).catch(() => null);
  if (r?.found && r.clickText) {
    console.log(`[probe] found via ${r.context} context${anchor ? ' (anchor-sorted)' : ''}: "${r.clickText}" at (${r.cx},${r.cy}) (matched: "${r.text}")`);
    return { text: r.clickText, cx: r.cx, cy: r.cy };
  }
  return null;
}

// ── Panel Open Probe ──────────────────────────────────────────────

const SIDE_PANEL_OPEN_EXPR = `
  !!document.querySelector(
    '.editoption_container,.side-panel,.app-detail-panel,.connect-detail'
  )
`.trim();

/**
 * Checks whether the action/trigger side panel is currently open.
 * Used for explicit exit-state validation after "Add Action App" clicks.
 */
export async function probePanelOpen(adapter: ExecutionAdapter): Promise<boolean> {
  const r = await adapter.evaluateExpr<boolean>(SIDE_PANEL_OPEN_EXPR).catch(() => null);
  return r === true;
}

// ── Panel Content Validation ──────────────────────────────────────

/**
 * Step-specific text patterns expected to be visible inside the side panel.
 * Scoped to the panel DOM only — text outside the panel cannot satisfy this.
 *
 * These patterns reflect AppyPie Automate's panel vocabulary.
 */
const PANEL_CONTENT_PATTERNS: Partial<Record<FlowStep, string[]>> = {
  [FlowStep.ACTION_SETUP]: [
    'choose an app',
    'select.{0,5}app',
    'search.{0,10}app',
    'what.{0,20}connect',
    'choose a service',
    'add action',
  ],
  [FlowStep.ACTION_CONFIG]: [
    'connect',
    'choose an action',
    'select action',
    'action event',
    'choose an account',
    'which account',
    'how should this',
  ],
};

/**
 * Structural selectors — checked inside the panel element (not the full page).
 * Validates that the panel contains actual interactive form elements, not just
 * heading or label text. Either the text contract OR the structural contract
 * satisfies validation — both are independently sufficient.
 *
 *   ACTION_SETUP  — app-selector panel: search input or app grid items
 *   ACTION_CONFIG — config panel: form inputs, selects, or dropdowns
 */
const PANEL_STRUCTURAL_SELECTORS: Partial<Record<FlowStep, string>> = {
  [FlowStep.ACTION_SETUP]: [
    'input[type="search"],input[type="text"],[placeholder*="search" i]',
    '[class*="app-item"],[class*="app-card"],[class*="app-list"] > *',
    '[class*="service-item"],[class*="connector-item"],[class*="integration"]',
  ].join(','),
  [FlowStep.ACTION_CONFIG]: [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
    'select,[role="combobox"],[role="listbox"]',
    '[class*="form-field"],[class*="form-group"],[class*="field-wrap"]',
    '[class*="dropdown-input"],[class*="select-container"]',
  ].join(','),
};

export interface PanelContentResult {
  valid: boolean;
  matchedPattern: string | null;
  structureFound: boolean;    // true if interactive form elements detected in panel
  snippet: string;            // first 150 chars of panel text, for logging
}

function buildPanelContentExpr(patterns: string[], structuralSelector: string): string {
  return `
    (() => {
      try {
        var panel = document.querySelector(
          '.editoption_container,.side-panel,.app-detail-panel,.connect-detail'
        );
        if (!panel) return { matched: null, structureFound: false, snippet: '' };
        var panelText = panel.textContent || '';

        // Semantic text validation
        var matched = null;
        var pats = ${JSON.stringify(patterns)};
        for (var i = 0; i < pats.length; i++) {
          if (new RegExp(pats[i], 'i').test(panelText)) { matched = pats[i]; break; }
        }

        // Structural validation — interactive form elements inside panel
        var structureFound = ${
          structuralSelector
            ? `!!panel.querySelector(${JSON.stringify(structuralSelector)})`
            : 'false'
        };

        return { matched: matched, structureFound: structureFound, snippet: panelText.slice(0, 150).trim() };
      } catch(e) { return { matched: null, structureFound: false, snippet: '' }; }
    })()
  `.trim();
}

interface PanelContentSignals { matched: string | null; structureFound: boolean; snippet: string; }

/**
 * Validates that the open side panel contains content appropriate for the
 * given flow step using two independent signals:
 *
 *   1. Text contract  — semantic vocabulary patterns (mustAppearOneOf style)
 *   2. Structural contract — presence of interactive form elements (inputs, selects)
 *
 * Either signal alone is sufficient. This prevents a generic "Choose an App"
 * heading from passing when the app-grid hasn't rendered, while also surviving
 * UI copy changes where the structural elements are present but text differs.
 *
 * Returns valid=true when no contract is defined for the step (non-blocking).
 */
export async function validatePanelContent(
  adapter: ExecutionAdapter,
  step: FlowStep,
): Promise<PanelContentResult> {
  const patterns = PANEL_CONTENT_PATTERNS[step] ?? [];
  const structuralSelector = PANEL_STRUCTURAL_SELECTORS[step] ?? '';

  if (!patterns.length && !structuralSelector) {
    return { valid: true, matchedPattern: null, structureFound: false, snippet: '' };
  }

  const expr = buildPanelContentExpr(patterns, structuralSelector);
  const r = await adapter.evaluateExpr<PanelContentSignals>(expr).catch(() => null);
  // Eval error → unknown state, not confirmed absent. Return valid=true so the
  // soft check doesn't emit a false "no match" warning when the DOM was unreadable.
  if (!r) return { valid: true, matchedPattern: null, structureFound: false, snippet: '' };

  return {
    valid: r.matched !== null || r.structureFound,
    matchedPattern: r.matched,
    structureFound: r.structureFound,
    snippet: r.snippet,
  };
}

// ── Enforcement ───────────────────────────────────────────────────

/**
 * Decides what to do when the expected DOM contract for the current step is not met.
 *
 * Decision priority:
 *   1. success → allow
 *   2. count=1 → wait (one stability-settled window for async canvas render)
 *   3. count=2 → probe (caller probes DOM; if element likely exists → force click;
 *                        if confirmed absent → escalate)
 *   4. count≥3 → escalate (element confirmed absent after wait + probe; vision re-plan)
 *
 * count=2 returns `escalate` here as a signal that the probe threshold has been
 * reached. The caller (cua-loop) intercepts this and runs probeForAddAction()
 * before deciding whether to force-click or truly escalate. This keeps the
 * enforce function synchronous while allowing the async probe in cua-loop.
 */
export function enforceExpectedState(
  step: FlowStep,
  result: ExpectedStateResult,
  stepFailureCount: number,
): ExpectedStateDecision {
  if (result.success) return { kind: 'allow' };

  switch (step) {
    case FlowStep.TRIGGER_COMPLETED:
    case FlowStep.ACTION_SETUP:
      if (stepFailureCount >= 3) {
        // Element confirmed absent even after wait + force-click attempt.
        // Vision is the only remaining option.
        return {
          kind: 'escalate',
          logMsg: `${step}: element still absent after ${stepFailureCount} turns (wait + force) — escalating to vision — ${result.reasons.join('; ')}`,
        };
      }
      if (stepFailureCount >= 2) {
        // Wait complete; element still not detected by strict contract.
        // Caller will probe DOM broadly and decide: force click or escalate.
        // We return escalate as a signal; cua-loop intercepts it for the probe.
        return {
          kind: 'escalate',
          logMsg: `${step}: element absent after wait (count=${stepFailureCount}) — probing before escalation — ${result.reasons.join('; ')}`,
        };
      }
      // First failure: give the async canvas one stability-settled window to render.
      return {
        kind: 'wait',
        logMsg: `${step}: element not yet visible — waiting for canvas render — ${result.reasons.join('; ')}`,
      };

    default:
      return { kind: 'allow' };
  }
}
