// ── IAL Executor ───────────────────────────────────────────────
//
// Dispatches an InteractionPlan to the appropriate adapter method.
//
// Returns null when the plan type is "generic" — the loop's existing
// strategy chain (selector → text → role → coordinates) handles those.
// Returns an ActionResult when a specialized handler ran (success or fail).
//
// Design rule: this layer NEVER decides — it only EXECUTES. All decisions
// happen in classifier.ts. Keep this file dispatch-only.

import type { ExecutionAdapter, ActionResult } from '../adapter/types.js';
import type { InteractionPlan } from './types.js';
import { runInteraction } from './engine/runner.js';
import { SEARCHABLE_TOKEN_INPUT } from './engine/configs/searchable-token-input.js';
import { fieldValueSignatureExpr } from './field-probe.js';

// Feature flag for the state-aware execution layer. Default OFF — the
// engine only runs when the env var is truthy. When it runs and fails
// (any step returns handled=false), we fall through to insertVariableToken
// so no regression vs. the legacy handler.
const USE_CONFIG_ENGINE = process.env.USE_CONFIG_ENGINE === '1'
  || process.env.USE_CONFIG_ENGINE === 'true';

/**
 * Result of an IAL execution. `handled === false` means the loop must fall
 * through to the generic strategy chain (i.e., the plan was a generic type
 * or the specialized handler couldn't act and wants to surrender).
 */
export interface InteractionExecutionResult {
  handled: boolean;
  result?: ActionResult;
  /** Which specialized handler ran (for logging). */
  handlerName?: string;
  /**
   * Field label that this interaction targeted — CUSTOM_DROPDOWN /
   * VARIABLE_PICKER / SELECTABLE_LIST_ITEM surface this so the outer loop
   * can key its completed-field tracker by the semantic label (not the
   * opaque elementId hash, which is what cua-loop would otherwise see).
   */
  fieldLabel?: string;
  /**
   * AUTHORITATIVE override for the outer `effective` computation. When set,
   * action-engine.ts uses this value instead of deriving effective from
   * urlChanged || domChanged || valueChanged. Populated ONLY when the IAL
   * handler has a strong signal (before/after signature probe, highlight-or-
   * next-step check) that DOM diff would lie about.
   *
   * Rule: set to `false` when the specialized handler proved the action did
   * NOT advance semantic state, even though DOM changed. Leave undefined to
   * let DOM-diff stand.
   */
  authoritativeEffective?: boolean;
}

export async function executeInteraction(
  plan: InteractionPlan,
  adapter: ExecutionAdapter,
): Promise<InteractionExecutionResult> {
  switch (plan.type) {
    case 'CONTINUE_RUN_TEST': {
      const result = await adapter.clickContinueRunTest();
      return { handled: true, result, handlerName: 'clickContinueRunTest' };
    }

    case 'SELECTABLE_LIST_ITEM': {
      // Angular event tile click (trigger/action event list). Uses the
      // existing adapter method (selectAppyPieEvent) which clicks the tile +
      // the Continue button. Post-verification: tile highlighted OR next-step
      // heading visible. If neither, downgrade effective=false so the loop
      // doesn't mark this as forward progress.
      const eventText = plan.hints?.eventText || plan.value || '';
      if (!eventText) return { handled: false };
      const result = await adapter.selectAppyPieEvent(eventText);
      if (!result.success) {
        return { handled: true, result, handlerName: 'selectAppyPieEvent' };
      }
      // Post-action validation — two OR'd signals:
      //   A) the clicked event tile is now highlighted (.selected / .active / aria-selected="true")
      //   B) a "Choose Account" / "Continue" / "Setup" heading appeared (panel advanced)
      const needleLower = eventText.toLowerCase().replace(/["\\]/g, '').slice(0, 40);
      const verifyExpr = `
        (() => {
          // Signal A: selected class or aria-selected on a tile containing the event text
          const tiles = Array.from(document.querySelectorAll(
            '.event-tile, .form-checkbox, .multiple-menu li, [class*="event"], [class*="tile"]'
          ));
          const highlighted = tiles.some(t => {
            const txt = (t.textContent || '').toLowerCase();
            if (!txt.includes(${JSON.stringify(needleLower)})) return false;
            const cls = (t.className || '').toString().toLowerCase();
            const ariaSel = t.getAttribute && t.getAttribute('aria-selected');
            const checkedInput = t.querySelector && t.querySelector('input:checked');
            return /selected|active|checked/.test(cls) || ariaSel === 'true' || !!checkedInput;
          });
          if (highlighted) return true;
          // Signal B: next-step heading visible
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, label')).map(el => (el.textContent || '').toLowerCase()).join(' | ');
          return /choose\\s+account|connect\\s+your|set\\s*up|add\\s+an\\s+account|options/.test(headings);
        })()
      `;
      const verify = await adapter.waitUntil(verifyExpr, { timeoutMs: 3000 });
      return {
        handled: true,
        result: {
          success: result.success,
          effective: verify.success,  // only effective if state actually advanced
          error: verify.success ? undefined : 'event tile clicked but neither highlight nor next-step heading appeared',
        },
        handlerName: 'selectAppyPieEvent+verify',
        fieldLabel: eventText,
        // FIX 1: AUTHORITATIVE — if verify failed, outer must NOT override
        // back to true via DOM diff. The probe's signal is the truth.
        authoritativeEffective: verify.success ? undefined : false,
      };
    }

    case 'VARIABLE_PICKER': {
      // Two paths:
      //   - "type" intent with a variable hint  → insertVariableToken with the typed value
      //   - "click" intent on a + Add or Select → insertVariableToken with picker label
      // Both end at the same adapter method; field label comes from hints.
      const fieldLabel = plan.hints?.fieldLabel || '';
      const tokenText = plan.value || '';

      // Phase 1: state-aware execution engine (flag-gated, fallback safe).
      // Only runs when fieldLabel is known — no label means we can't locate
      // the + Add or Select button deterministically, so we skip straight to
      // the legacy autoFillActionFields path.
      if (USE_CONFIG_ENGINE && fieldLabel) {
        // Strong validation around the engine path (mirrors the legacy
        // insertVariableToken path at the bottom of this case). The engine's
        // internal waitFor predicates confirm DOM transitions, but they CAN
        // be satisfied by a wrong-option selection (engine sees "dropdown
        // closed", reports success, but the field didn't actually advance
        // to the value the caller wanted). The sig-probe is the ground
        // truth: if the field's visible value didn't change, the engine
        // lied about making progress.
        const sigExpr = fieldValueSignatureExpr(fieldLabel);
        const beforeSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
        const engineRes = await runInteraction(SEARCHABLE_TOKEN_INPUT, {
          adapter,
          fieldLabel,
          value: tokenText,
        });
        if (engineRes.handled) {
          const afterSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
          const valueChanged = beforeSig !== afterSig && afterSig.length > 0;
          const probeHadSignal = beforeSig.length > 0 || afterSig.length > 0;
          const er = engineRes.result;
          return {
            handled: true,
            result: er
              ? {
                  success: er.success,
                  effective: valueChanged ? er.effective : false,
                  error: valueChanged
                    ? er.error
                    : 'engine completed but field value unchanged — downgraded',
                }
              : undefined,
            handlerName: `configEngine:SEARCHABLE_TOKEN_INPUT@${engineRes.lastStep || '?'}`,
            fieldLabel,
            // Authoritative only when we actually SAW a same-signature state.
            // Probe-empty (label not found) falls back to outer DOM-diff.
            authoritativeEffective: probeHadSignal && !valueChanged ? false : undefined,
          };
        }
        console.log(
          `[ENGINE] SEARCHABLE_TOKEN_INPUT failed at "${engineRes.lastStep}" — falling back to insertVariableToken (${engineRes.error || 'no error'})`,
        );
        // fall through to legacy handler below
      }

      if (!fieldLabel) {
        // No usable label — fall back to the page-wide auto-fill helper that
        // covers all empty + Add or Select fields at once.
        const fillResult = await adapter.autoFillActionFields();
        if (fillResult.filled > 0) {
          return {
            handled: true,
            result: {
              success: true,
              effective: true,
              newUrl: undefined,
              newTitle: undefined,
            },
            handlerName: `autoFillActionFields (filled ${fillResult.filled})`,
          };
        }
        return { handled: false };
      }
      // FIX 1 (strong validation): snapshot the field value BEFORE, run the
      // adapter, snapshot AFTER. effective=true ONLY when (a) the picker
      // overlay is closed AND (b) the field's value signature actually
      // changed. Prevents the "menu closed but value not applied" false
      // positive that lets the loop mark fake progress.
      const sigExpr = fieldValueSignatureExpr(fieldLabel);
      const beforeSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
      const result = await adapter.insertVariableToken(fieldLabel, tokenText);
      if (!result.success) {
        return { handled: true, result, handlerName: 'insertVariableToken', fieldLabel };
      }
      const overlayClosed = await adapter.evaluateExpr<boolean>(`
        !document.querySelector(
          '[id^="MultipleCustomEditor"].open, [id^="Custom_value_Advanced"].open, .editoption-dropmenu.active_menu, .menu.menu_active'
        )
      `);
      const afterSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
      const valueChanged = beforeSig !== afterSig && afterSig.length > 0;
      // Safety net per user feedback: if probe returned '' (label not found /
      // dynamic layout), we CANNOT downgrade — fall back to outer DOM-diff
      // with weak confidence. Only force-false when we actually SAW a
      // same-signature or still-open state.
      const probeHadSignal = beforeSig.length > 0 || afterSig.length > 0;
      const trulyEffective = overlayClosed === true && valueChanged;
      return {
        handled: true,
        result: {
          success: result.success,
          effective: trulyEffective ? result.effective : false,
          error: trulyEffective
            ? result.error
            : !overlayClosed
              ? 'picker overlay still open after insert — downgraded'
              : 'field value unchanged (before===after) — downgraded',
        },
        handlerName: 'insertVariableToken+verify',
        fieldLabel,
        // FIX 1: authoritative only when probe had a real signal. If probe
        // failed to locate the field (returned ''), let outer DOM-diff decide.
        authoritativeEffective: probeHadSignal && !trulyEffective ? false : undefined,
      };
    }

    case 'CUSTOM_DROPDOWN': {
      const label = plan.hints?.fieldLabel || '';
      // Default to "first" when the model didn't specify which option
      const optionText = plan.value && plan.value !== label ? plan.value : 'first';
      if (!label) return { handled: false };
      // FIX 1 (strong validation): snapshot BEFORE + AFTER. A "success" from
      // openAndSelectDropdown counts as effective ONLY when (a) the dropdown
      // menu is closed AND (b) the field signature changed. The prior version
      // only checked menu-closed which still produced false positives when the
      // menu closed via outside-click without applying a value.
      const sigExpr = fieldValueSignatureExpr(label);
      const beforeSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
      const result = await adapter.openAndSelectDropdown(label, optionText);
      if (!result.success) {
        return { handled: true, result, handlerName: 'openAndSelectDropdown', fieldLabel: label };
      }
      const menuClosed = await adapter.evaluateExpr<boolean>(
        `!document.querySelector('.editoption-dropmenu.active_menu, .menu.menu_active')`
      );
      const afterSig = (await adapter.evaluateExpr<string>(sigExpr)) || '';
      const valueChanged = beforeSig !== afterSig && afterSig.length > 0;
      const probeHadSignal = beforeSig.length > 0 || afterSig.length > 0;
      const trulyEffective = menuClosed === true && valueChanged;
      return {
        handled: true,
        result: {
          success: result.success,
          effective: trulyEffective ? result.effective : false,
          error: trulyEffective
            ? result.error
            : !menuClosed
              ? 'dropdown menu still open after select — downgraded'
              : 'dropdown value unchanged (before===after) — downgraded',
        },
        handlerName: 'openAndSelectDropdown+verify',
        fieldLabel: label,
        // FIX 1: authoritative only when probe had a real signal — probe-empty
        // fallback lets outer DOM-diff stand (per "probe can silently fail").
        authoritativeEffective: probeHadSignal && !trulyEffective ? false : undefined,
      };
    }

    case 'AUTO_FILL_FIELDS': {
      const fillResult = await adapter.autoFillActionFields();
      return {
        handled: true,
        result: {
          success: true,
          effective: fillResult.filled > 0,
        },
        handlerName: `autoFillActionFields (filled ${fillResult.filled})`,
      };
    }

    case 'PANEL_TEXT_FALLBACK': {
      const text = plan.hints?.panelText || plan.value || '';
      if (!text) return { handled: false };
      const result = await adapter.clickByPanelText(text);
      return { handled: true, result, handlerName: 'clickByPanelText' };
    }

    case 'DROPDOWN_OPTION_DIRECT': {
      // Role-first direct click on a `.menu_dropdown-option` (or equivalent).
      // Classifier already determined this is an option element by structure
      // (class membership), so the right action is just to click it — no
      // picker engine, no overlay open/close dance.
      //
      // We use clickByText because option text is unique within an open
      // dropdown context, and the IndexedElement's `text` field IS the
      // option's display text. If the click fails, fall through to the
      // strategy chain (selector → coords → panel) so robustness isn't lost.
      //
      // No pre/post sig-probe here: we DON'T know which labeled field this
      // option belongs to (the option's text is its own label, not the
      // field's). cua-loop's completed-fields tracker at cua-loop.ts:1638
      // does the post-action sig-probe + token-match correctness check
      // using `ialFieldLabel` (which we surface as the option text).
      const optionText = plan.value || plan.hints?.fieldLabel || '';
      if (!optionText) return { handled: false };
      const clickRes = await adapter.clickByText(optionText);
      if (!clickRes.success) {
        return { handled: false };
      }
      return {
        handled: true,
        result: {
          success: true,
          effective: clickRes.effective,
        },
        handlerName: 'role:DROPDOWN_OPTION_DIRECT',
        fieldLabel: optionText,
      };
    }

    case 'PANEL_SELECT': {
      // FIX 1: side-panel option click (Google Sheets / trigger event / etc.).
      // Uses adapter.clickByText (trusted-event Playwright click), then waits
      // on a DOM predicate indicating the panel state advanced. NO blind wait.
      const text = plan.hints?.panelOptionText || plan.value || '';
      if (!text) return { handled: false };
      const clickRes = await adapter.clickByText(text);
      if (!clickRes.success) {
        // Let the legacy engine strategy chain have a shot.
        return { handled: false };
      }
      // Post-click verification — two deterministic signals (OR):
      //   A) the clicked option text is no longer a panel heading (panel
      //      advanced away from the "Choose App" step)
      //   B) a new section heading appeared (Choose Account / Set up / etc.)
      // Combining both handles SPA updates where the panel replaces content
      // in-place without closing.
      const textLower = text.toLowerCase().replace(/["\\]/g, '');
      const verifyExpr = `
        (() => {
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, label, .chooseapps h3, .multiple-menu label'));
          const headingText = headings.map(el => (el.textContent || '').toLowerCase()).join(' | ');
          // Signal A: clicked text no longer dominates a panel heading
          const clickedStillHeading = headingText.includes(${JSON.stringify(textLower)})
            && /choose|select|add\\s+(action|trigger)/.test(headingText);
          // Signal B: next-step heading appeared
          const nextSectionVisible = /choose\\s+account|set\\s*up|add\\s+an\\s+account|options|fields/.test(headingText);
          return (!clickedStillHeading) || nextSectionVisible;
        })()
      `;
      const wait = await adapter.waitUntil(verifyExpr, { timeoutMs: 4000 });
      return {
        handled: true,
        result: {
          success: clickRes.success,
          effective: wait.success,  // only effective if panel actually advanced
          error: wait.success ? undefined : 'clicked but panel did not advance',
        },
        handlerName: `PANEL_SELECT(${text.slice(0, 25)})`,
      };
    }

    case 'SEARCHABLE_APP_LIST': {
      // FIX 3: find an app in a virtualized list. Two-tier strategy:
      //   Tier 1 (preferred): use the panel's search input if present.
      //   Tier 2 (fallback): scroll-and-probe with DOM re-check between scrolls.
      // No blind waits — every transition is gated by waitUntil.
      const target = plan.hints?.targetAppName || plan.value || '';
      if (!target) return { handled: false };
      const targetLower = target.toLowerCase();

      // ── Tier 1: search input ─────────────────────────────────────
      // Appy Pie app-selection panels have a `.app-search input` /
      // `.chooseapps input[type="search"]` field. If present, use it.
      const SEARCH_SELECTOR = 'input[type="search"], input[placeholder*="Search" i], .chooseapps input, .app-search input';
      const hasSearch = await adapter.evaluateExpr<boolean>(`!!document.querySelector(${JSON.stringify(SEARCH_SELECTOR)})`);
      if (hasSearch) {
        const typeRes = await adapter.typeBySelector(SEARCH_SELECTOR, target);
        if (typeRes.success) {
          // Wait for filtered results to render.
          const waitExpr = `
            Array.from(document.querySelectorAll('.app-card, .app-tile, [class*="app"] [class*="item"], li')).some(el =>
              (el.textContent || '').toLowerCase().includes(${JSON.stringify(targetLower)})
            )
          `;
          const waitRes = await adapter.waitUntil(waitExpr, { timeoutMs: 4000 });
          if (waitRes.success) {
            const clickRes = await adapter.clickByText(target);
            return {
              handled: true,
              result: clickRes,
              handlerName: `SEARCHABLE_APP_LIST:search("${target.slice(0, 20)}")`,
            };
          }
        }
      }

      // ── Tier 2: scroll-probe ─────────────────────────────────────
      // Scroll down, check if target appeared, click. Re-check DOM each
      // iteration. Hard termination: if post-scroll element count equals
      // pre-scroll count, we've hit the bottom — break immediately.
      const existsExpr = `
        Array.from(document.querySelectorAll('*')).some(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t.length > 0 && t.length < 80 && t === ${JSON.stringify(targetLower)};
        })
      `;
      const elementCountExpr = `document.querySelectorAll('*').length`;
      const MAX_SCROLL_ATTEMPTS = 8;
      let scrolledBottom = false;
      for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
        // Probe BEFORE scroll: target may already be visible from prior action.
        const exists = await adapter.evaluateExpr<boolean>(existsExpr);
        if (exists) {
          const clickRes = await adapter.clickByText(target);
          return {
            handled: true,
            result: clickRes,
            handlerName: `SEARCHABLE_APP_LIST:scroll-probe@${i}`,
          };
        }
        // Explicit prev/next comparison around the scroll. If scroll adds
        // nothing to the DOM, we're at the bottom of a finite list — no
        // point continuing.
        const prevCount = (await adapter.evaluateExpr<number>(elementCountExpr)) ?? 0;
        await adapter.scroll('down', 600);
        // Small settle wait so virtualized list can render. Not blind —
        // we break out as soon as readyState is complete.
        await adapter.waitUntil(`document.readyState === "complete"`, { timeoutMs: 1200 });
        const newCount = (await adapter.evaluateExpr<number>(elementCountExpr)) ?? 0;
        if (newCount === prevCount) {
          scrolledBottom = true;
          break;
        }
      }
      // Not found after all attempts — let the loop's strategy chain handle.
      return {
        handled: true,
        result: {
          success: false,
          effective: false,
          error: `SEARCHABLE_APP_LIST: "${target}" not found after ${MAX_SCROLL_ATTEMPTS} scroll attempts`,
        },
        handlerName: `SEARCHABLE_APP_LIST:not-found`,
      };
    }

    // Generic primitives — let the existing engine strategy chain handle them.
    case 'GENERIC_CLICK':
    case 'GENERIC_TYPE':
    case 'GENERIC_SELECT':
    case 'NAVIGATE':
    case 'SCROLL':
    case 'WAIT':
    case 'KEYPRESS':
    case 'DONE':
    default:
      return { handled: false };
  }
}
