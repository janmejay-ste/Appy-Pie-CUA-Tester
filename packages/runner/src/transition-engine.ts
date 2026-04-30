/**
 * Transition Engine — Step Advancement Verification
 *
 * Top authority in the execution hierarchy:
 *
 *   TRANSITION ENGINE     (proves step advancement — "did we actually progress?")
 *       ↓
 *   EXPECTED STATE ENGINE (DOM contracts — "is the UI in the right state?")
 *       ↓
 *   STEP ENGINE           (flow progression — "what step are we on?")
 *       ↓
 *   STATE MACHINE         (action gating)
 *       ↓
 *   ACTION ENGINE         (execution)
 *
 * The fundamental invariant this layer enforces:
 *
 *   SUCCESS = STEP TRANSITION, not DOM change
 *
 * This kills the remaining class of bugs:
 *   - toast disappears → same step → failure (not success)
 *   - DOM changed but stayed on same step → no progress → stall counter
 *   - backward jump detected → INVALID_TRANSITION → reset and re-detect
 *   - N turns without advancement → force canonical action
 *
 * Integration points in cua-loop.ts:
 *   PRE-action  — track transition from previous turn to now, force if stalled
 *   POST-action — re-detect step; if it advanced, upgrade result.effective=true
 */

import { FlowStep } from './step-engine.js';
import type { ActionStep } from './adapter/types.js';

// ── Valid Transitions (forward-only) ──────────────────────────────

export const VALID_TRANSITIONS: Partial<Record<FlowStep, FlowStep[]>> = {
  // TRIGGER_TEST is intentionally omitted from TRIGGER_SETUP's targets:
  // detectFlowStep() never returns TRIGGER_TEST (no detection path for it).
  // Adding it here would accept a transition that can never actually occur.
  [FlowStep.TRIGGER_SETUP]:     [FlowStep.TRIGGER_COMPLETED],
  [FlowStep.TRIGGER_TEST]:      [FlowStep.TRIGGER_COMPLETED],
  // Clicking "Add Action App" can open a panel directly (→ ACTION_CONFIG) or show
  // an in-canvas app selector (→ ACTION_SETUP). Both are valid exits.
  [FlowStep.TRIGGER_COMPLETED]: [FlowStep.ACTION_SETUP, FlowStep.ACTION_CONFIG],
  [FlowStep.ACTION_SETUP]:      [FlowStep.ACTION_CONFIG],
  [FlowStep.ACTION_CONFIG]:     [FlowStep.FLOW_COMPLETE],
  [FlowStep.FLOW_COMPLETE]:     [],
};

// ── Transition Result ─────────────────────────────────────────────

export type TransitionResult =
  | { ok: true;  type: 'ADVANCED' }
  | { ok: false; type: 'NO_PROGRESS' | 'INVALID_TRANSITION' };

/**
 * Checks whether `prev → current` is a valid forward transition.
 *
 * UNKNOWN is a wildcard on both sides — can never be INVALID_TRANSITION:
 *   UNKNOWN → X   : treated as ADVANCED (first detection, no history)
 *   X → UNKNOWN   : treated as ADVANCED (transient — canvas closed, re-detect next turn)
 *   UNKNOWN → UNKNOWN : NO_PROGRESS (still haven't identified the step)
 */
export function checkTransition(prev: FlowStep, current: FlowStep): TransitionResult {
  if (prev === FlowStep.UNKNOWN || current === FlowStep.UNKNOWN) {
    return prev === current
      ? { ok: false, type: 'NO_PROGRESS' }
      : { ok: true,  type: 'ADVANCED' };
  }
  if (prev === current) return { ok: false, type: 'NO_PROGRESS' };
  const allowed = VALID_TRANSITIONS[prev];
  if (!allowed?.includes(current)) {
    return { ok: false, type: 'INVALID_TRANSITION' };
  }
  return { ok: true, type: 'ADVANCED' };
}

// Stall force-action removed: expected-state-engine now owns escalation authority.
// When "Add Action App" is confirmed absent, expected-state returns `escalate`
// (vision re-plan) rather than a blind force-click. The step engine's own
// FORCE_AFTER_TURNS (5) remains as the catch-all for other stuck scenarios.
