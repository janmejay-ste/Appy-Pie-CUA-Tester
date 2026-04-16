import { describe, it, expect } from 'vitest';
import { classifyInteraction, detectElementRole, ElementRole } from '../src/interaction/classifier.js';
import type { ActionStep, BrowserState, IndexedElement } from '../src/adapter/types.js';
import type { ClassifierInput } from '../src/interaction/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeElement(overrides: Partial<IndexedElement> = {}): IndexedElement {
  return {
    index: 0,
    elementId: 'abc12345',
    tag: 'div',
    text: '',
    attributes: {},
    boundingBox: { x: 0, y: 0, w: 100, h: 30 },
    isInteractable: true,
    isVisible: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    url: 'https://connectcloud.appypie.com/customeditor/abc/options/xyz',
    title: '',
    elements: [],
    keyText: [],
    formValues: {},
    domFingerprint: 'fp',
    hasOverlay: false,
    hasCanvas: false,
    duplicateTextCount: 0,
    errorMessages: [],
    ...overrides,
  };
}

function makeInput(
  step: ActionStep,
  resolvedElement: IndexedElement | null,
  state?: Partial<BrowserState>,
): ClassifierInput {
  const fullState = makeState(state);
  return {
    step,
    state: fullState,
    resolvedElement,
    url: fullState.url,
  };
}

// ── detectElementRole ──────────────────────────────────────────────

describe('detectElementRole', () => {
  it('detects DROPDOWN_OPTION from .menu_dropdown-option class', () => {
    const el = makeElement({
      tag: 'li',
      text: 'Test sheet',
      attributes: { class: 'menu_dropdown-option ps-25' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_OPTION);
  });

  it('detects DROPDOWN_OPTION from li.choice', () => {
    const el = makeElement({
      tag: 'li',
      text: 'Some option',
      attributes: { class: 'choice menu_dropdown-option' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_OPTION);
  });

  it('detects DROPDOWN_OPTION from role=option', () => {
    const el = makeElement({
      tag: 'div',
      text: 'Foo',
      attributes: { role: 'option' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_OPTION);
  });

  it('detects DROPDOWN_SEARCH_INPUT from formcontrol input', () => {
    const el = makeElement({
      tag: 'input',
      attributes: { class: 'formcontrol bg-white' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_SEARCH_INPUT);
  });

  it('detects DROPDOWN_TRIGGER from aria-haspopup', () => {
    const el = makeElement({
      tag: 'div',
      attributes: { 'aria-haspopup': 'listbox' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_TRIGGER);
  });

  it('detects DROPDOWN_TRIGGER from .menu_icon class', () => {
    const el = makeElement({
      tag: 'div',
      attributes: { class: 'menu_icon-box' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_TRIGGER);
  });

  it('detects BUTTON', () => {
    const el = makeElement({ tag: 'button', text: 'Save' });
    expect(detectElementRole(el)).toBe(ElementRole.BUTTON);
  });

  it('detects INPUT_FIELD for plain input', () => {
    const el = makeElement({ tag: 'input', attributes: { type: 'text' } });
    expect(detectElementRole(el)).toBe(ElementRole.INPUT_FIELD);
  });

  it('detects ANCHOR for tag=a', () => {
    const el = makeElement({ tag: 'a', attributes: { href: '/foo' } });
    expect(detectElementRole(el)).toBe(ElementRole.ANCHOR);
  });

  it('returns UNKNOWN for plain div with no signals', () => {
    const el = makeElement({ tag: 'div', text: 'random text' });
    expect(detectElementRole(el)).toBe(ElementRole.UNKNOWN);
  });

  it('returns UNKNOWN for null element', () => {
    expect(detectElementRole(null)).toBe(ElementRole.UNKNOWN);
  });

  it('precedence: option class wins over button tag', () => {
    // An <li class="menu_dropdown-option"> rendered as `<button>` (unusual
    // but defensive) should still classify as option, not button.
    const el = makeElement({
      tag: 'button',
      text: 'Test sheet',
      attributes: { class: 'menu_dropdown-option' },
    });
    expect(detectElementRole(el)).toBe(ElementRole.DROPDOWN_OPTION);
  });
});

// ── classifyInteraction — regression for run dd186b23 ─────────────

describe('classifyInteraction — DROPDOWN_OPTION early return', () => {
  it('routes click on .menu_dropdown-option to DROPDOWN_OPTION_DIRECT (regression: run dd186b23 turn 19)', () => {
    // Exact reproduction of the misclassification:
    //   - Open Spreadsheet picker, dropdown rendered with options
    //   - Model clicks element 5ae8633e which is "Test sheet" <li>
    //   - Old behavior: KNOWN_PICKER_FIELD_RE matched "sheet", routed to
    //     VARIABLE_PICKER → engine ran with empty value → wrong selection
    //   - New behavior: role-first early return emits DROPDOWN_OPTION_DIRECT
    const optionEl = makeElement({
      elementId: '5ae8633e',
      tag: 'li',
      text: 'Test sheet',
      attributes: { class: 'menu_dropdown-option ps-25' },
    });
    const input = makeInput(
      { action: 'click', target: '5ae8633e', value: '', reason: 'select Test sheet' },
      optionEl,
      // Active dropdown signal in state.elements (for isPickerOverlayActive
      // strengthening — also exercised here):
      {
        elements: [
          optionEl,
          makeElement({ tag: 'div', text: '', attributes: { class: 'editoption-dropmenu active_menu' } }),
        ],
      },
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('DROPDOWN_OPTION_DIRECT');
    expect(plan.value).toBe('Test sheet');
    expect(plan.hints?.fieldLabel).toBe('Test sheet');
  });

  it('routes click on li.choice with collision text "Body" to DROPDOWN_OPTION_DIRECT (not VARIABLE_PICKER)', () => {
    // Defense-in-depth: option text "Body" collides with KNOWN_PICKER_FIELD_RE.
    // Before the role gate, this would route to VARIABLE_PICKER. Now it
    // takes the early-return path regardless of text.
    const optionEl = makeElement({
      tag: 'li',
      text: 'Body',
      attributes: { class: 'menu_dropdown-option choice' },
    });
    const input = makeInput(
      { action: 'click', target: 'opt-body', value: '' },
      optionEl,
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('DROPDOWN_OPTION_DIRECT');
  });

  it('routes click on option with role=option to DROPDOWN_OPTION_DIRECT', () => {
    const optionEl = makeElement({
      tag: 'div',
      text: 'Sheet 1',
      attributes: { role: 'option' },
    });
    const input = makeInput(
      { action: 'click', target: 'opt-1', value: '' },
      optionEl,
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('DROPDOWN_OPTION_DIRECT');
  });
});

// ── classifyInteraction — positive cases must remain intact ────────

describe('classifyInteraction — existing routes preserved', () => {
  it('routes "+ Add or Select" click to VARIABLE_PICKER (literal text path still fires)', () => {
    const el = makeElement({
      tag: 'div',
      text: '+ Add or Select',
      attributes: { class: 'contenteditable6' },
    });
    const input = makeInput(
      { action: 'click', target: 'add-btn', value: '+ Add or Select' },
      el,
      // Picker infrastructure must be present for VARIABLE_PICKER to fire
      // (pickerInfrastructurePresent uses /options/ URL as a sufficient signal).
      { url: 'https://connectcloud.appypie.com/customeditor/abc/options/xyz' },
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('VARIABLE_PICKER');
  });

  it('routes click on event tile "New Spreadsheet Row" to SELECTABLE_LIST_ITEM', () => {
    const el = makeElement({
      tag: 'li',
      text: 'New Spreadsheet Row',
      attributes: { class: 'event-tile' },
    });
    const input = makeInput(
      { action: 'click', target: 'evt-1', value: 'New Spreadsheet Row' },
      el,
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('SELECTABLE_LIST_ITEM');
  });

  it('routes click on dropdown trigger (aria-haspopup) to CUSTOM_DROPDOWN', () => {
    const el = makeElement({
      tag: 'div',
      text: 'Worksheet',
      attributes: { 'aria-haspopup': 'listbox', 'aria-label': 'Worksheet' },
    });
    const input = makeInput(
      { action: 'click', target: 'ws-trigger', value: '' },
      el,
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('CUSTOM_DROPDOWN');
  });

  it('routes plain button click to GENERIC_CLICK', () => {
    const el = makeElement({ tag: 'button', text: 'Save Changes' });
    const input = makeInput(
      { action: 'click', target: 'save', value: '' },
      el,
      { url: 'https://app.example.com/' },  // not /options/
    );
    const plan = classifyInteraction(input);
    expect(plan.type).toBe('GENERIC_CLICK');
  });
});
