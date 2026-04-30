// ── Interaction Abstraction Layer (IAL) — Types ────────────────
//
// The model emits a generic action ("click X", "type Y in Z"). The IAL
// CLASSIFIES that intent into a specific InteractionType, then dispatches
// to the right adapter method.
//
// Why this exists: today the cua-loop has ~12 scattered if-blocks that
// detect "Continue & Run Test" / "+ Add or Select" / event checkboxes /
// custom dropdowns / etc. Each is a post-hoc fixup AFTER a generic action
// failed. IAL flips this to PROACTIVE classification — pick the right
// handler upfront, not after wasting a turn.
//
// Rule: Model decides WHAT (target + value). System decides HOW (interaction type).

import type { ActionStep, BrowserState, IndexedElement } from '../adapter/types.js';

export type InteractionType =
  // Generic primitives — used when no specialized type matches
  | 'GENERIC_CLICK'
  | 'GENERIC_TYPE'
  | 'GENERIC_SELECT'
  | 'NAVIGATE'
  | 'SCROLL'
  | 'WAIT'
  | 'KEYPRESS'
  | 'DONE'
  // Appy Pie-specific specialized handlers
  | 'CUSTOM_DROPDOWN'      // .menu_icon-box / .menu_dropdown — open + pick option
  | 'VARIABLE_PICKER'      // + Add or Select token picker
  | 'SELECTABLE_LIST_ITEM' // Angular event tile / trigger-event list selection (was CHECKBOX_EVENT)
  | 'CONTINUE_RUN_TEST'    // wait-for-enabled then click
  | 'AUTO_FILL_FIELDS'     // multi-pass scroll-and-fill on options page
  | 'PANEL_TEXT_FALLBACK'  // free-text search fallback when no elementId
  // Role-first direct handlers (Phase 1 of role-based classifier)
  | 'DROPDOWN_OPTION_DIRECT' // role=DROPDOWN_OPTION — raw click + sig-probe + surface fieldLabel
  // Side-panel navigation (FIX 1 + FIX 3)
  | 'PANEL_SELECT'         // side-panel option selection (Google Sheets, trigger event)
  | 'SEARCHABLE_APP_LIST'; // virtualized app list — prefer search, fall back to scroll-probe

export interface InteractionPlan {
  type: InteractionType;
  /** The target identifier (string, ActionTarget object, or null for generic). */
  target?: string | { elementId?: string; text?: string; domPath?: string; index?: number };
  value?: string;
  /** Hints derived during classification, used by specialized handlers. */
  hints?: {
    fieldLabel?: string;       // for VARIABLE_PICKER / CUSTOM_DROPDOWN
    eventText?: string;        // for CHECKBOX_EVENT
    panelText?: string;        // for PANEL_TEXT_FALLBACK
    waitForSelector?: string;  // for CONTINUE_RUN_TEST
    panelOptionText?: string;  // for PANEL_SELECT — exact text of the option to click
    targetAppName?: string;    // for SEARCHABLE_APP_LIST — app to find
  };
  /** Why the classifier picked this type — for logging & debugging. */
  reason: string;
}

/**
 * Inputs to the classifier. Pure function — given the same inputs always
 * returns the same plan. Makes it unit-testable.
 */
export interface ClassifierInput {
  step: ActionStep;
  state: BrowserState;
  /** The IndexedElement the target resolved to (null if not found). */
  resolvedElement: IndexedElement | null;
  /** Current URL — used to detect /options/ context for VARIABLE_PICKER. */
  url: string;
}
