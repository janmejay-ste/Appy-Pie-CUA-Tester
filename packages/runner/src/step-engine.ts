/**
 * CUA Step Engine — Deterministic Workflow Progression
 *
 * Sits ABOVE the state machine in the authority hierarchy:
 *
 *   STEP ENGINE   (top authority — decides what step we're on and what must happen next)
 *       ↓
 *   STATE MACHINE (gating — blocks illegal actions in the current UI state)
 *       ↓
 *   ACTION ENGINE (execution — carries out the decided action)
 *
 * The step engine answers the question the state machine cannot:
 * "We are stable and a panel is open — but SHOULD we be here, or should we have moved on?"
 *
 * Without this layer the LLM can loop forever re-inspecting trigger fields after the
 * trigger test already succeeded, because nothing forces progression to the next step.
 */

import type { ExecutionAdapter } from './adapter/types.js';
import type { ActionStep } from './adapter/types.js';

// ── Step Definitions ──────────────────────────────────────────

export enum FlowStep {
  UNKNOWN           = 'UNKNOWN',
  TRIGGER_SETUP     = 'TRIGGER_SETUP',     // trigger app selected, config panel open, filling fields
  TRIGGER_TEST      = 'TRIGGER_TEST',      // clicked Continue/Run Test, awaiting result
  TRIGGER_COMPLETED = 'TRIGGER_COMPLETED', // test succeeded; "Add Action App" is the only next step
  ACTION_SETUP      = 'ACTION_SETUP',      // "Add Action App" visible, selecting action app
  ACTION_CONFIG     = 'ACTION_CONFIG',     // action app selected, config panel open
  FLOW_COMPLETE     = 'FLOW_COMPLETE',     // both trigger + action configured, workflow live
}

// ── Enforcement Result ────────────────────────────────────────

export type StepEnforcement =
  | { kind: 'allow' }
  | { kind: 'override'; action: ActionStep; logMsg: string }
  | { kind: 'block';    reason: string };

// ── Detection — single round-trip JS eval ─────────────────────
// Returns boolean signals that map to FlowStep without ambiguity.
// Uses targeted selectors and short-circuiting textExists to avoid
// scanning the entire DOM on every turn.

const STEP_DETECT_EXPR = `
  (() => {
    try {
      // Targeted text search — checks headings, status areas, alerts, paragraphs
      // rather than every node in the tree.
      function textExists(pattern) {
        var re = new RegExp(pattern, 'i');
        var els = document.querySelectorAll(
          'h1,h2,h3,h4,p,span,[class*="status"],[class*="success"],[class*="alert"],[class*="message"],[role="alert"],[class*="title"],[class*="heading"],[class*="label"]'
        );
        for (var i = 0; i < els.length; i++) {
          if (re.test(els[i].textContent)) return true;
        }
        return false;
      }

      // ── Step signals ─────────────────────────────────────────

      // Trigger test completed: look for success phrases Appy Pie uses
      var testSuccessful =
        textExists('test.{0,10}successful') ||
        textExists('run test.{0,10}successful') ||
        textExists('test.{0,10}sent.{0,10}successful') ||
        textExists('node is now active') ||
        textExists('test was successful') ||
        !!document.querySelector('.test-success, [class*="testSuccess"], [class*="test-success"]');

      // "Add Action App" button row — appears on canvas after trigger is configured.
      // Appy Pie renders this inside div.toolbar-newStep > div.buttons_wrap when the
      // trigger node has class "blue-node" (configured state). The three buttons are
      // plain <button class="f-button btn"> with text "Add Action App" etc.
      var addActionAppVisible =
        textExists('add action app') ||
        textExists('add another action') ||
        !!document.querySelector('.toolbar-newStep') ||
        !!document.querySelector('.blue-plus-secondary') ||
        !!document.querySelector('.blue-plus-btn');

      // Side panel open at all
      var sidePanelOpen = !!document.querySelector(
        '.editoption_container, .side-panel, .app-detail-panel, .connect-detail'
      );

      // Trigger panel: panel open AND a heading (or label) contains "trigger".
      // Two-tier detection:
      // Tier 1: standard heading elements (most reliable, checked first).
      // Tier 2: fallback for the trigger TEST RESULTS panel — after the trigger test
      //   succeeds Appy Pie shows checkmark rows ("Trigger Application: X",
      //   "Trigger Event: Y") which are plain divs/spans, not heading elements.
      //   Without this fallback, detectFlowStep() returns ACTION_CONFIG instead of
      //   TRIGGER_COMPLETED and the step engine never overrides [wait] to Continue/Add Action App.
      var hasTriggerHeading = false;
      var headings = document.querySelectorAll(
        'h1,h2,h3,h4,[class*="heading"],[class*="title"],[class*="panel-head"]'
      );
      for (var j = 0; j < headings.length; j++) {
        if (/trigger/i.test(headings[j].textContent)) { hasTriggerHeading = true; break; }
      }
      if (!hasTriggerHeading && sidePanelOpen) {
        // Fallback: scan short elements for "Trigger Application" or "Trigger Event"
        // labels — unique to the trigger config / test-results panel.
        // Length cap (< 80 chars) prevents false-positives from long body paragraphs.
        var anyEls = document.querySelectorAll('p,span,div,li,label');
        for (var jj = 0; jj < anyEls.length; jj++) {
          var elT = (anyEls[jj].textContent || '').trim();
          if (/^trigger\s*(application|event)/i.test(elT) && elT.length < 80) {
            hasTriggerHeading = true;
            break;
          }
        }
      }
      var triggerPanelOpen = sidePanelOpen && hasTriggerHeading;

      // App-selector panel: side panel open (no trigger heading) AND it contains a
      // search input or app-card grid — this is the ACTION_SETUP context where the
      // user is choosing which action app to add. Distinct from ACTION_CONFIG (form fields).
      var appSelectorPanelOpen = sidePanelOpen && !hasTriggerHeading &&
        !!document.querySelector(
          '.editoption_container input[type="search"],' +
          '.side-panel input[type="search"],' +
          '.app-detail-panel input[type="search"],' +
          '[class*="app-item"],[class*="app-card"],[class*="chooseapps"] li,' +
          '[class*="app-list"] li,[class*="applist"] li'
        );

      // Action panel: side panel open but NOT a trigger heading (includes both
      // app-selector and config panels — kept for backward-compat signal consumers).
      var actionPanelOpen = sidePanelOpen && !hasTriggerHeading;

      // Workflow fully live — scoped to elements OUTSIDE the config panel so that
      // instructional text inside the panel (e.g. "your workflow is live once saved")
      // cannot produce a false FLOW_COMPLETE signal before activation is confirmed.
      var configPanelEl = document.querySelector(
        '.editoption_container,.side-panel,.app-detail-panel,.connect-detail'
      );
      function textExistsOutsidePanel(pattern) {
        var re = new RegExp(pattern, 'i');
        var els = document.querySelectorAll(
          'h1,h2,h3,h4,p,span,[class*="status"],[class*="success"],[class*="alert"],' +
          '[class*="message"],[role="alert"],[class*="title"],[class*="heading"],[class*="label"]'
        );
        for (var k = 0; k < els.length; k++) {
          if (configPanelEl && configPanelEl.contains(els[k])) continue;
          if (re.test(els[k].textContent)) return true;
        }
        return false;
      }
      // workflowLive uses three independent signal tiers, most-reliable first:
      //
      // Tier 1 — URL: Appy Pie adds ?status=live / /live/ after activation.
      //   Immune to DOM mutations, toast dismissals, text copy changes.
      //
      // Tier 2 — CSS class badge: structural, survives localization and toast auto-dismiss.
      //   Only elements OUTSIDE the config panel are queried so panel instructional
      //   text (e.g. "your workflow is live once saved") cannot match here.
      //
      // Tier 3 — text outside panel: last resort for plain-text banners and toasts
      //   that don't carry a structural class.
      var workflowLive =
        // Tier 1: URL-based (strongest — no DOM dependency)
        /[?&]status=(live|active|enabled)|\/live\/?($|\?|#)/i.test(location.href) ||
        // Tier 2: class-based badge outside the config panel
        !!(function() {
          var badge = document.querySelector(
            '[class*="workflow-live"],[class*="connect-live"],[class*="automation-active"],' +
            '[class*="workflow-active"],[data-status="live"],[data-status="active"],[class*="zap-on"]'
          );
          return badge && !(configPanelEl && configPanelEl.contains(badge));
        })() ||
        // Tier 3: text-based fallback (outside panel)
        textExistsOutsidePanel('workflow is live') ||
        textExistsOutsidePanel('connect is live') ||
        textExistsOutsidePanel('automation is active') ||
        textExistsOutsidePanel('your zap is on') ||
        textExistsOutsidePanel('is now live');

      return {
        testSuccessful,
        addActionAppVisible,
        triggerPanelOpen,
        actionPanelOpen,
        appSelectorPanelOpen,
        workflowLive,
      };
    } catch (e) {
      return {
        testSuccessful: false,
        addActionAppVisible: false,
        triggerPanelOpen: false,
        actionPanelOpen: false,
        appSelectorPanelOpen: false,
        workflowLive: false,
      };
    }
  })()
`.trim();

// ── Detection ─────────────────────────────────────────────────

interface StepSignals {
  testSuccessful: boolean;
  addActionAppVisible: boolean;
  triggerPanelOpen: boolean;
  actionPanelOpen: boolean;
  appSelectorPanelOpen: boolean;   // true when panel is the app-chooser (ACTION_SETUP context)
  workflowLive: boolean;
}

export async function detectFlowStep(adapter: ExecutionAdapter): Promise<FlowStep> {
  const s = await adapter.evaluateExpr<StepSignals>(STEP_DETECT_EXPR).catch(() => null) ?? {
    testSuccessful: false,
    addActionAppVisible: false,
    triggerPanelOpen: false,
    actionPanelOpen: false,
    appSelectorPanelOpen: false,
    workflowLive: false,
  };

  // Priority order: present-state signals beat retrospective signals.
  //
  // CRITICAL: testSuccessful fires AFTER panel signals and addActionAppVisible.
  //
  // Why: AppyPie renders a persistent "Test Successful" badge on the trigger node.
  // It does NOT disappear when "Add Action App" is clicked and the action panel opens.
  // If testSuccessful were checked first, detectFlowStep would return TRIGGER_COMPLETED
  // forever — even when actionPanelOpen=true — because the badge persists in DOM.
  // This would block the step engine from ever advancing to ACTION_CONFIG.
  //
  // appSelectorPanelOpen: app-chooser panel is open (ACTION_SETUP — picking an action app).
  // actionPanelOpen && !appSelectorPanelOpen: form config panel is open (ACTION_CONFIG).
  // Both are present-state signals; testSuccessful is retrospective (UI artifact). Present wins.
  if (s.workflowLive)                               return FlowStep.FLOW_COMPLETE;
  if (s.actionPanelOpen && !s.appSelectorPanelOpen) return FlowStep.ACTION_CONFIG;  // config panel open
  if (s.appSelectorPanelOpen)                       return FlowStep.ACTION_SETUP;   // app-chooser open
  if (s.testSuccessful)                             return FlowStep.TRIGGER_COMPLETED;
  if (s.addActionAppVisible)                        return FlowStep.ACTION_SETUP;
  if (s.triggerPanelOpen)                           return FlowStep.TRIGGER_SETUP;
  return FlowStep.UNKNOWN;
}

// ── Enforcement ───────────────────────────────────────────────

// Targets that are illegal when trigger is already completed
const TRIGGER_STALE_TARGETS = /spreadsheet|worksheet|trigger.{0,10}detail|reopen|reconnect|account/i;

// Targets that are illegal when selecting action app (no going backward)
const ACTION_SETUP_BLOCKED_TARGETS = /trigger|spreadsheet|worksheet/i;

// Turns in same step before forcing the canonical next action
const FORCE_AFTER_TURNS = 5;

export function enforceFlowStep(
  step: FlowStep,
  action: ActionStep,
  turnsInStep: number,
): StepEnforcement {
  const targetStr =
    (typeof action.target === 'string'
      ? action.target
      : (action.target as { text?: string } | undefined)?.text ?? '') +
    ' ' +
    (action.value ?? '');

  switch (step) {

    case FlowStep.TRIGGER_COMPLETED: {
      // Fail-safe: LLM hasn't progressed after N turns → force it
      if (turnsInStep >= FORCE_AFTER_TURNS) {
        return {
          kind: 'override',
          action: { action: 'click', value: 'Add Action App', reason: '[step-engine] Fail-safe: forcing Add Action App after stall' },
          logMsg: `Fail-safe: ${turnsInStep} turns at TRIGGER_COMPLETED → forcing "Add Action App"`,
        };
      }
      // Allow "Continue" click to close the trigger test results panel.
      // After the trigger test succeeds, the panel stays open showing results + a Continue
      // button. This Continue MUST be clicked to dismiss the panel before "Add Action App"
      // on the canvas becomes clickable. Overriding it to "Add Action App" while the panel
      // is still open causes the click to fail because the panel covers the canvas button.
      if (action.action === 'click' && /\bcontinue\b/i.test(targetStr)) {
        return { kind: 'allow' };
      }
      // Allow explicit "Add Action App" clicks — the panel is already closed by this point.
      if (action.action === 'click' && /add action app|add another action/i.test(targetStr)) {
        return { kind: 'allow' };
      }
      // Block stale trigger interactions
      if (TRIGGER_STALE_TARGETS.test(targetStr)) {
        return {
          kind: 'override',
          action: { action: 'click', value: 'Add Action App', reason: '[step-engine] Blocked stale trigger interaction — clicking Add Action App' },
          logMsg: `Blocked stale target "${targetStr.trim()}" at TRIGGER_COMPLETED → redirecting to Add Action App`,
        };
      }
      // LLM is not progressing (chose wait/scroll/other non-action).
      // First 2 turns: the trigger test-results panel is very likely still open and
      // covering the "Add Action App" canvas button. Override to "Continue" to close
      // the panel first — otherwise clicking Add Action App will fail silently.
      // After turn 2: assume panel is closed and go straight to Add Action App.
      if (turnsInStep < 2) {
        return {
          kind: 'override',
          action: { action: 'click', value: 'Continue', reason: '[step-engine] Trigger done — closing test-results panel before Add Action App' },
          logMsg: `LLM chose ${action.action}:"${targetStr.trim()}" at TRIGGER_COMPLETED (turn ${turnsInStep}) → forcing "Continue" to close panel first`,
        };
      }
      return {
        kind: 'override',
        action: { action: 'click', value: 'Add Action App', reason: '[step-engine] Trigger done — must click Add Action App next' },
        logMsg: `LLM chose ${action.action}:"${targetStr.trim()}" at TRIGGER_COMPLETED (turn ${turnsInStep}) → forcing "Add Action App"`,
      };
    }

    case FlowStep.ACTION_SETUP: {
      // Hard block: backward clicks into trigger territory
      if (ACTION_SETUP_BLOCKED_TARGETS.test(targetStr)) {
        return {
          kind: 'block',
          reason: `[step-engine] Backward navigation blocked at ACTION_SETUP: "${targetStr.trim()}" references trigger/spreadsheet`,
        };
      }
      // Fail-safe: stuck on action app selection
      if (turnsInStep >= FORCE_AFTER_TURNS) {
        return {
          kind: 'override',
          action: { action: 'click', value: 'Add Action App', reason: '[step-engine] Fail-safe: re-clicking Add Action App' },
          logMsg: `Fail-safe: ${turnsInStep} turns at ACTION_SETUP → re-clicking Add Action App`,
        };
      }
      return { kind: 'allow' };
    }

    case FlowStep.FLOW_COMPLETE: {
      return {
        kind: 'override',
        action: { action: 'done', verdict: 'PASS', summary: 'Workflow is live', reason: '[step-engine] Workflow fully configured and live' },
        logMsg: 'FLOW_COMPLETE detected — emitting done:PASS',
      };
    }

    default:
      return { kind: 'allow' };
  }
}
