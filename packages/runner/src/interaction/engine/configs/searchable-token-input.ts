// ── SEARCHABLE_TOKEN_INPUT — the one config Phase 1 ships ──────
//
// Drives the Appy Pie "+ Add or Select" token picker deterministically:
//
//   open_overlay → wait_dropdown → wait_search → (type_search) → select_option
//
// Every transition is gated by a DOM predicate (adapter.waitUntil). No
// setTimeout(...). No "click and pray". If any step times out, the engine
// returns handled=false and the IAL executor falls back to insertVariableToken.
//
// DOM state signals come from reading the actual Appy Pie Angular component
// (app-edit-options.component.ts):
//   - overlay container gets `.open`  (MultipleCustomEditor{i} / Custom_value_Advanced{i})
//   - dropdown wrapper gets `.active_menu`  (.editoption-dropmenu)
//   - search input lives at `.editoption-dropmenu.active_menu .choices-search input`
//   - options render as `.menu_dropdown-option` inside `.choices`

import type { InteractionConfig, StepContext } from '../types.js';

// ── State probe ─────────────────────────────────────────────────
// Single expression evaluated in-page per attempt. Returns a PickerState.
// Must be throw-safe and cheap.
const STATE_PROBE = `
  (() => {
    const overlayOpen = !!document.querySelector(
      '[id^="MultipleCustomEditor"].open, [id^="Custom_value_Advanced"].open'
    );
    const dropdownEl = document.querySelector(
      '.editoption-dropmenu.active_menu, .menu.menu_active'
    );
    const dropdownOpen = !!dropdownEl;
    const searchReady = !!(dropdownEl && dropdownEl.querySelector('.choices-search input.formcontrol'));
    const options = dropdownEl ? dropdownEl.querySelectorAll('.menu_dropdown-option, li.choice') : [];
    return {
      overlayOpen,
      dropdownOpen,
      searchReady,
      optionsReady: options.length > 0,
      optionCount: options.length,
    };
  })()
`;

// ── Action helpers (in-page snippets) ──────────────────────────
// Returned as JS expression strings evaluated via adapter.evaluateExpr.
// Each returns truthy on success, false on no-op.

/** Find the "+ Add or Select" button nearest to a field label and click it. */
function clickAddOrSelectNearLabel(fieldLabel: string): string {
  // Normalize + escape the fieldLabel for embedding in a JS string literal.
  const needle = fieldLabel.replace(/['\\]/g, '\\$&').toLowerCase();
  return `
    (() => {
      const labels = Array.from(document.querySelectorAll('label, .editoption label, .form-check label'));
      const target = labels.find(l => (l.textContent || '').trim().toLowerCase().includes(${JSON.stringify(needle)}));
      if (!target) return false;
      // Walk up to the form-check / multiple-menu container, then find the + Add or Select inside.
      let container = target.closest('.form-check, .multiple-menu, .dropdownMenu-repeat') || target.parentElement;
      // Try a few levels up in case the label sits higher than the field wrapper.
      for (let i = 0; i < 3 && container; i++) {
        const addBtn = container.querySelector('.contenteditable6, [class*="Add or Select"], span.whitespace-to-addinputbox')
          || Array.from(container.querySelectorAll('div')).find(d =>
               (d.textContent || '').trim().toLowerCase().replace(/\\s+/g, ' ').includes('add or select'));
        if (addBtn) {
          addBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          addBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
        container = container.parentElement;
      }
      return false;
    })()
  `;
}

/** Type a string into the active dropdown's search input. */
function typeIntoSearch(value: string): string {
  return `
    (() => {
      const input = document.querySelector(
        '.editoption-dropmenu.active_menu .choices-search input.formcontrol, .menu.menu_active .choices-search input.formcontrol'
      );
      if (!input) return false;
      input.focus();
      // Set value via native setter so Angular's change detection fires.
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(input, ${JSON.stringify(value)}); else input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      return true;
    })()
  `;
}

/** Click the first visible option in the active dropdown. */
const CLICK_FIRST_OPTION = `
  (() => {
    const dropdown = document.querySelector(
      '.editoption-dropmenu.active_menu, .menu.menu_active'
    );
    if (!dropdown) return false;
    const opt = dropdown.querySelector('.menu_dropdown-option, li.choice.menu_dropdown-option, li.choice');
    if (!opt) return false;
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()
`;

// ── Config ─────────────────────────────────────────────────────

export const SEARCHABLE_TOKEN_INPUT: InteractionConfig = {
  type: 'SEARCHABLE_TOKEN_INPUT',
  stateProbe: STATE_PROBE,
  steps: [
    {
      name: 'open_overlay',
      // Skip if overlay already open for another field — we'll still need to
      // re-click the right "+ Add or Select" though, so only skip when the
      // dropdown ALSO looks ready and the options are for the target field.
      condition: (ctx: StepContext) => !ctx.state.dropdownOpen,
      action: async (ctx: StepContext) => {
        const ok = await ctx.adapter.evaluateExpr<boolean>(clickAddOrSelectNearLabel(ctx.fieldLabel));
        return { success: !!ok, effective: !!ok };
      },
      // Either the overlay opens OR the dropdown opens — we accept either
      // signal because Appy Pie uses two different containers for mobile vs
      // desktop.
      waitFor: `
        !!document.querySelector('.editoption-dropmenu.active_menu, .menu.menu_active')
      `,
      waitForTimeoutMs: 4000,
    },
    {
      name: 'wait_search_ready',
      // The picker renders its search input lazily once the dropdown mounts.
      // No action — just wait for the input to exist.
      action: async () => ({ success: true, effective: false }),
      waitFor: `
        !!document.querySelector(
          '.editoption-dropmenu.active_menu .choices-search input.formcontrol, .menu.menu_active .choices-search input.formcontrol'
        )
      `,
      waitForTimeoutMs: 3000,
    },
    {
      name: 'type_search',
      // Only type if the classifier gave us a non-empty value to narrow by.
      // If the model just wants "open the picker", skip this step.
      condition: (ctx: StepContext) => !!ctx.value && ctx.value.length > 0,
      action: async (ctx: StepContext) => {
        const ok = await ctx.adapter.evaluateExpr<boolean>(typeIntoSearch(ctx.value));
        return { success: !!ok, effective: !!ok };
      },
      // Wait for options to re-render after the filter applies. If no option
      // matches, the picker shows "No result found" — we still accept that
      // and let select_option fail, so user sees an actionable error.
      waitFor: `
        document.querySelectorAll(
          '.editoption-dropmenu.active_menu .menu_dropdown-option, .menu.menu_active .menu_dropdown-option'
        ).length > 0
      `,
      waitForTimeoutMs: 3000,
    },
    {
      name: 'wait_options_ready',
      // Safety net: ensure options exist before we click. When type_search
      // was skipped (no value), this is the first place options get verified.
      action: async () => ({ success: true, effective: false }),
      waitFor: `
        document.querySelectorAll(
          '.editoption-dropmenu.active_menu .menu_dropdown-option, .menu.menu_active .menu_dropdown-option'
        ).length > 0
      `,
      waitForTimeoutMs: 4000,
    },
    {
      name: 'select_option',
      action: async (ctx: StepContext) => {
        const ok = await ctx.adapter.evaluateExpr<boolean>(CLICK_FIRST_OPTION);
        return { success: !!ok, effective: !!ok };
      },
      // Success signal: the dropdown closes (Appy Pie removes .active_menu on
      // select) OR a selected value label appears. We pick the close signal
      // because it's consistent across trigger/action/webhook contexts.
      waitFor: `
        !document.querySelector('.editoption-dropmenu.active_menu, .menu.menu_active')
        || !!document.querySelector('.selected-itemdropdwn')
      `,
      waitForTimeoutMs: 3000,
    },
  ],
};
