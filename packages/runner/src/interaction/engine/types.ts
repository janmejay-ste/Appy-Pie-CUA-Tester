// ── State-Aware Execution Engine — Types ───────────────────────
//
// This is NOT a full config-driven replacement. It's a minimal state-driven
// execution layer that sits UNDER the IAL executor for one known-bad flow
// (SEARCHABLE_TOKEN_INPUT). Existing handlers remain; this engine is tried
// first behind a flag, with fallback to the legacy handler on failure.
//
// Design rule: every step must be idempotent AND observable. `waitFor`
// replaces every setTimeout — no blind waits. State is a single in-page
// evaluate snapshot, refreshed at the top of each attempt.

import type { ExecutionAdapter, ActionResult } from '../../adapter/types.js';

/**
 * Snapshot of DOM signals at a point in time. Shape is specific to the
 * current config (not a universal state object). Keep this small — one
 * page.evaluate per state read is already a network hop.
 */
export interface PickerState {
  overlayOpen: boolean;
  dropdownOpen: boolean;
  searchReady: boolean;
  optionsReady: boolean;
  optionCount: number;
}

export interface StepContext {
  adapter: ExecutionAdapter;
  /** Text of the + Add or Select / field label the classifier identified. */
  fieldLabel: string;
  /** Optional token text the model wants to type into the picker search. */
  value: string;
  /** Most recent state snapshot. Refreshed by the runner at each attempt. */
  state: PickerState;
}

export interface InteractionStep {
  name: string;
  /** Skip the step when this returns false against the current state. */
  condition?: (ctx: StepContext) => boolean;
  /** The actual adapter call. Must be idempotent. */
  action: (ctx: StepContext) => Promise<ActionResult | void>;
  /**
   * JS expression evaluated in-page to confirm the step landed. The engine
   * polls this via adapter.waitUntil. Omit only for fire-and-forget steps.
   */
  waitFor?: string;
  /** Per-step timeout override (ms). */
  waitForTimeoutMs?: number;
  /** Max attempts before giving up and returning handled=false. */
  retries?: number;
}

export interface InteractionConfig {
  type: string;
  /** Ordered steps. Engine evaluates condition+action+waitFor per step. */
  steps: InteractionStep[];
  /**
   * JS expression that produces a PickerState object. Single probe read
   * at the top of each attempt. Must be cheap and throw-safe.
   */
  stateProbe: string;
}

export interface EngineResult {
  handled: boolean;
  result?: ActionResult;
  /** Step name where the engine stopped (either success or failure point). */
  lastStep?: string;
  error?: string;
}
