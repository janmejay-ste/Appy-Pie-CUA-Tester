/**
 * CUA State Machine
 *
 * Deterministic action gating layer that sits between LLM output and
 * browser execution. The LLM proposes; the state machine decides whether
 * the proposed action is legal in the current UI state.
 *
 * States:
 *   LOADING        — loader/spinner active; hard-lock on everything except wait
 *   FIELD_SELECTING — a dropdown/picker is open; block continue and navigate
 *   PANEL_OPEN     — side-config panel is visible; normal interaction allowed
 *   PANEL_CLOSED   — no config panel; canvas view — scroll blocked, recover by clicking step card
 *   STABLE         — DOM settled, no loaders, no open dropdowns (rare: panel detection uncertainty)
 *   LOST_CONTEXT   — panel closed + multiple scrolls with no progress = canvas drift
 *
 * Rules (in priority order):
 *   1. LOADING         → only 'wait' allowed (safe substitute: waitForUIStability)
 *   2. FIELD_SELECTING → 'continue' and 'navigate' blocked
 *   3. PANEL_OPEN      → 'continue' blocked when required fields are empty
 *   4. PANEL_CLOSED    → 'scroll' blocked; recover by clicking step card
 *   5. LOST_CONTEXT    → only recovery actions allowed (click setup card)
 */

import type { ExecutionAdapter } from './adapter/types.js';

// ── State ─────────────────────────────────────────────────────

export type CUAState =
  | 'LOADING'
  | 'FIELD_SELECTING'
  | 'PANEL_OPEN'
  | 'PANEL_CLOSED'
  | 'STABLE'
  | 'LOST_CONTEXT';

export interface DetectedState {
  state: CUAState;
  loaderVisible: boolean;
  dropdownOpen: boolean;
  sidePanelVisible: boolean;
  interactableCount: number;
  emptyRequiredFieldCount: number;
}

// ── Detection expressions ─────────────────────────────────────
// Single round-trip eval — returns all signals at once.

const DETECT_EXPR = `
  (() => {
    try {
      const loaderVisible = !!document.querySelector([
        '.loader:not([style*="display: none"])',
        '.loading:not([style*="display: none"])',
        '.spinner:not([style*="display: none"])',
        '[class*="loading"][style*="block"]',
        '[aria-busy="true"]',
        '.page-loading',
      ].join(','));

      // ARIA-aware dropdown detection: covers React portals and shadow-DOM patterns.
      // Appy Pie-specific class selectors are checked globally (they only appear in
      // Appy Pie's own dropdown components). The broader ARIA selectors
      // ([aria-expanded], [role=listbox]) are scoped to the active config panel to
      // avoid false positives from navigation menus, accordion panels, and header
      // dropdowns that also use aria-expanded="true".
      const appyPieDropdownOpen = !!document.querySelector([
        '.editoption-dropmenu.active_menu',
        '.menu.menu_active',
        '[class*="dropdown"].open',
        '[class*="dropdown"][class*="active"]',
        '[id^="MultipleCustomEditor"].open',
        '[id^="Custom_value_Advanced"].open',
      ].join(','));
      const panelEl = document.querySelector(
        '.editoption_container,.side-panel,.app-detail-panel,.connect-detail'
      );
      const ariaDropdownInPanel = !!panelEl && !!(
        panelEl.querySelector('[aria-expanded="true"][aria-haspopup]') ||
        panelEl.querySelector('[role="listbox"]:not([hidden]):not([style*="display: none"])')
      );
      const dropdownOpen = appyPieDropdownOpen || ariaDropdownInPanel;

      const sidePanelVisible = !!document.querySelector([
        '.side-panel',
        '.config-panel',
        '.app-detail-panel',
        '[class*="side-panel"]',
        '[class*="sidePanel"]',
        '.editoption_container',
        '.connect-detail',
      ].join(','));

      const interactableCount = document.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [role="button"]'
      ).length;

      // Count unfilled required fields on the active config panel.
      //
      // Detection strategy — three tiers in descending reliability:
      //
      //   Gate 0: If the Continue/Next/Save button is explicitly ENABLED, the UI's own
      //     validation has certified all required fields are filled.  Trust the form —
      //     short-circuit to 0 without inspecting individual fields.  This is the most
      //     reliable signal because it is the same logic the user would rely on.
      //
      //   Tier 1: HTML-native [required] / [aria-required="true"] attributes on inputs.
      //     Structural, localization-immune, works across any form framework that emits
      //     standard attributes.
      //
      //   Tier 2: Appy Pie-specific "Add or Select" anchors — unfilled variable-picker
      //     entry points.  Optional containers (labelled "optional"/"if needed") excluded.
      //
      //   Tier 3: Fallback — any visible, empty text input in the panel (no required attr,
      //     no anchor).  Only runs when Tiers 1+2 find nothing, so it cannot double-count.
      let emptyRequiredFieldCount = 0;
      const panel = document.querySelector(
        '.editoption_container, .side-panel, .app-detail-panel, .connect-detail'
      );
      if (panel) {
        // Gate 0: Continue/Next/Save enabled → form is valid per the UI itself
        var continueEnabled = false;
        var btns = panel.querySelectorAll('button:not([disabled]),[role="button"]:not([disabled])');
        for (var bi = 0; bi < btns.length; bi++) {
          if (/^\s*(continue|next|save|proceed|submit)\s*$/i.test(btns[bi].textContent || '')) {
            continueEnabled = true; break;
          }
        }

        if (!continueEnabled) {
          // Tier 1: native required attrs — reliable when present
          panel.querySelectorAll(
            'input[required]:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),' +
            'select[required]:not([disabled]),textarea[required]:not([disabled]),' +
            '[aria-required="true"]:not([disabled])'
          ).forEach(function(el) {
            if (!(el.value || '').trim()) emptyRequiredFieldCount++;
          });

          // Tier 2: Appy Pie "Add or Select" anchors (variable-picker entry points)
          panel.querySelectorAll(
            'a[href*="addselect"], [class*="addselect"], [class*="add_select"], [class*="AddSelect"]'
          ).forEach(function(el) {
            var container = el.closest('[class*="field"],[class*="row"],[class*="group"],[class*="item"]') || el.parentElement;
            var containerText = container ? (container.textContent || '').toLowerCase() : '';
            if (!/optional|if\s+needed|not\s+required/i.test(containerText)) {
              emptyRequiredFieldCount++;
            }
          });

          // Tier 3: fallback — empty visible text inputs, only if no structured signal found.
          // Avoids double-counting with Tier 1 (already checked required inputs there).
          if (emptyRequiredFieldCount === 0) {
            panel.querySelectorAll(
              'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([required])'
            ).forEach(function(el) { if (!(el.value || '').trim()) emptyRequiredFieldCount++; });
          }
        }
      }

      return { loaderVisible, dropdownOpen, sidePanelVisible, interactableCount, emptyRequiredFieldCount };
    } catch {
      return { loaderVisible: false, dropdownOpen: false, sidePanelVisible: false, interactableCount: 10, emptyRequiredFieldCount: 0 };
    }
  })()
`.trim();

// ── Classify ──────────────────────────────────────────────────

export async function detectPageState(
  adapter: ExecutionAdapter,
  consecutiveScrolls: number,
): Promise<DetectedState> {
  type Raw = {
    loaderVisible: boolean;
    dropdownOpen: boolean;
    sidePanelVisible: boolean;
    interactableCount: number;
    emptyRequiredFieldCount: number;
  };
  const raw = await adapter.evaluateExpr<Raw>(DETECT_EXPR).catch(() => null) ?? {
    loaderVisible: false, dropdownOpen: false, sidePanelVisible: false,
    interactableCount: 10, emptyRequiredFieldCount: 0,
  };

  let state: CUAState;
  if (raw.loaderVisible) {
    state = 'LOADING';
  } else if (raw.dropdownOpen) {
    state = 'FIELD_SELECTING';
  } else if (!raw.sidePanelVisible && raw.interactableCount > 50) {
    // Many interactive elements = regular website being tested, not the Connect builder canvas.
    // PANEL_CLOSED / LOST_CONTEXT rules only apply to the builder UI (which has few elements).
    state = 'STABLE';
  } else if (!raw.sidePanelVisible && consecutiveScrolls >= 2) {
    // Panel absent + repeated scrolling = canvas drift (stronger signal than interactableCount).
    // consecutiveScrolls >= 2 (not 3) catches drift one turn earlier.
    state = 'LOST_CONTEXT';
  } else if (raw.sidePanelVisible) {
    state = 'PANEL_OPEN';
  } else {
    // Panel absent but no scrolling yet — Connect builder canvas view, not yet drifted.
    state = 'PANEL_CLOSED';
  }

  return { state, ...raw };
}

// ── Gating ────────────────────────────────────────────────────

/** Returns a human-readable block reason, or null if the action is allowed. */
export function gateAction(
  action: string,
  targetDisplay: string,
  detected: DetectedState,
): string | null {
  const { state } = detected;
  const isContinue = action === 'click' && /continue/i.test(targetDisplay);
  const isNavigate = action === 'navigate';

  // Rule 1: LOADING hard-lock
  if (state === 'LOADING' && action !== 'wait') {
    return `UI is loading — only 'wait' is allowed until the loader clears`;
  }

  // Rule 2: Dropdown/picker open — no continue or navigation
  if (state === 'FIELD_SELECTING') {
    if (isContinue) return `Dropdown is open — close it or select a value before clicking Continue`;
    if (isNavigate) return `Dropdown is open — navigation blocked until dropdown closes`;
  }

  // Rule 3: Continue blocked when required fields are still empty.
  // Panel must be open (fields are visible) and at least one is unfilled.
  if (isContinue && state === 'PANEL_OPEN' && detected.emptyRequiredFieldCount > 0) {
    return `${detected.emptyRequiredFieldCount} required field(s) still empty — fill all fields before clicking Continue`;
  }

  // Rule 4: Panel closed — scrolling is canvas drift, not progress.
  // Block scroll and force a recovery click to reopen the panel.
  if (state === 'PANEL_CLOSED' && action === 'scroll') {
    return `Config panel is closed (canvas view) — scroll blocked; click a step card to open the config panel`;
  }

  // Rule 5: Lost context — only recovery clicks allowed.
  // Allowlist covers step-card labels across all flow steps:
  //   TRIGGER_SETUP  → "Set up", "Trigger"
  //   ACTION_SETUP   → "Add Action App" (handled by step engine override before this runs)
  //   ACTION_CONFIG  → "Configure", "Step N", "Connect"
  if (state === 'LOST_CONTEXT' && action !== 'wait') {
    if (!(action === 'click' && /set.?up|trigger|configure|step\s*\d|connect|reset.?view|home|back/i.test(targetDisplay))) {
      return `Canvas drift detected (panel gone, multiple scrolls) — only step-card recovery clicks allowed`;
    }
  }

  return null; // allowed
}

/** Safe substitute action to execute when the proposed action is blocked. */
export function safeSubstitute(detected: DetectedState): { action: string; value: string; reason: string } {
  switch (detected.state) {
    case 'LOADING':
      // Caller (cua-loop.ts) detects '__stability__' and calls waitForUIStability() directly.
      return { action: 'wait', value: '__stability__', reason: 'waiting for UI to stabilise before proceeding' };
    case 'FIELD_SELECTING':
      return { action: 'wait', value: '400', reason: 'waiting for dropdown to close' };
    case 'PANEL_CLOSED':
      // Try to click the first visible "Set up" step card to reopen the config panel.
      return { action: 'click', value: 'Set up', reason: 'panel closed — clicking step card to recover' };
    case 'LOST_CONTEXT':
      return { action: 'click', value: 'Set up', reason: 'canvas drift recovery — clicking step card' };
    default:
      return { action: 'wait', value: '500', reason: 'state gate: safe pause' };
  }
}
