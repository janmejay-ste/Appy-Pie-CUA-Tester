import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeValidatedAction, type ValidatedResult } from '../src/adapter/action-engine.js';
import type { ExecutionAdapter, ActionStep, BrowserState, IndexedElement, ActionResult } from '../src/adapter/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeElement(overrides: Partial<IndexedElement> = {}): IndexedElement {
  return {
    index: 0,
    elementId: 'abc12345',
    tag: 'button',
    text: 'Submit',
    attributes: {},
    boundingBox: { x: 100, y: 200, w: 80, h: 30 },
    isInteractable: true,
    isVisible: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    url: 'https://app.appypieautomate.ai/dashboard',
    title: 'Dashboard',
    elements: [makeElement()],
    keyText: [],
    formValues: {},
    domFingerprint: 'fp-before',
    hasOverlay: false,
    hasCanvas: false,
    duplicateTextCount: 0,
    errorMessages: [],
    ...overrides,
  };
}

function makeAfterState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    ...makeState(),
    domFingerprint: 'fp-after', // changed by default
    ...overrides,
  };
}

const successResult: ActionResult = { success: true, effective: true };
const failResult: ActionResult = { success: false, effective: false, error: 'Element not found' };

function createMockAdapter(afterState?: Partial<BrowserState>): ExecutionAdapter {
  return {
    getState: vi.fn().mockResolvedValue(makeAfterState(afterState)),
    getUrl: vi.fn().mockResolvedValue('https://app.appypieautomate.ai/dashboard'),
    getTitle: vi.fn().mockResolvedValue('Dashboard'),
    clickBySelector: vi.fn().mockResolvedValue(successResult),
    clickByText: vi.fn().mockResolvedValue(successResult),
    clickByCoordinates: vi.fn().mockResolvedValue(successResult),
    doubleClickByCoordinates: vi.fn().mockResolvedValue(successResult),
    doubleClickByText: vi.fn().mockResolvedValue(successResult),
    clickByPanelText: vi.fn().mockResolvedValue(failResult),
    selectAppyPieEvent: vi.fn().mockResolvedValue(successResult),
    openAndSelectDropdown: vi.fn().mockResolvedValue(failResult),
    insertVariableToken: vi.fn().mockResolvedValue(successResult),
    autoFillActionFields: vi.fn().mockResolvedValue({ filled: 0, fields: [] }),
    clickContinueRunTest: vi.fn().mockResolvedValue(successResult),
    typeBySelector: vi.fn().mockResolvedValue(successResult),
    typeByContentEditable: vi.fn().mockResolvedValue(successResult),
    typeByCoordinates: vi.fn().mockResolvedValue(successResult),
    selectBySelector: vi.fn().mockResolvedValue(successResult),
    scroll: vi.fn().mockResolvedValue(successResult),
    navigate: vi.fn().mockResolvedValue(successResult),
    keypress: vi.fn().mockResolvedValue(successResult),
    wait: vi.fn().mockResolvedValue(successResult),
    screenshot: vi.fn().mockResolvedValue(undefined),
    screenshotJPEG: vi.fn().mockResolvedValue(''),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('executeValidatedAction', () => {
  // ── Click Actions ────────────────────────────────────────────

  describe('click action', () => {
    it('should successfully click an element found in DOM', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'click', target: 'abc12345' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.action).toBe('click');
      expect(result.description).toContain('clicked');
    });

    it('should report failure when target element is not found', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'click', target: 'nonexistent' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
      expect(result.description).toContain('not found');
      expect(result.retryStrategy).toBe('rescan_dom');
    });

    it('should try fuzzy text match when target not found but text matches an element', async () => {
      const adapter = createMockAdapter();
      const el = makeElement({ elementId: 'abc12345', text: 'Submit Form' });
      const state = makeState({ elements: [el] });
      // Target is a text fragment matching the element's text
      const step: ActionStep = { action: 'click', target: 'submit' };

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('fuzzy match');
    });

    it('should try panel text search when target not found and value is provided', async () => {
      const adapter = createMockAdapter();
      // Panel text search succeeds
      (adapter.clickByPanelText as ReturnType<typeof vi.fn>).mockResolvedValue(successResult);
      const state = makeState({ elements: [] });
      const step: ActionStep = { action: 'click', target: 'missing-id', value: 'Connect to Google' };

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('text search');
    });
  });

  // ── Type Actions ─────────────────────────────────────────────

  describe('type action', () => {
    it('should type text into an element', async () => {
      const adapter = createMockAdapter();
      const el = makeElement({ tag: 'input', elementId: 'input1', attributes: { id: 'email-input' } });
      const state = makeState({ elements: [el] });
      const step: ActionStep = { action: 'type', target: 'input1', value: 'test@example.com' };

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.action).toBe('type');
      expect(result.description).toContain('typed');
    });

    it('should fail when value is missing for type action', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'type', target: 'abc12345' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
      expect(result.description).toContain('missing');
    });

    it('should fail when target is missing for type action', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'type', value: 'some text' };
      const state = makeState({ elements: [] });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
      expect(result.description).toContain('missing');
    });
  });

  // ── Select Actions ───────────────────────────────────────────

  describe('select action', () => {
    it('should select a value from a dropdown', async () => {
      const adapter = createMockAdapter();
      const el = makeElement({ tag: 'select', elementId: 'sel1', attributes: { id: 'country' } });
      const state = makeState({ elements: [el] });
      const step: ActionStep = { action: 'select', target: 'sel1', value: 'India' };

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.action).toBe('select');
      expect(result.description).toContain('selected');
    });

    it('should fail when value is missing for select action', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'select', target: 'abc12345' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
    });
  });

  // ── Scroll Action ────────────────────────────────────────────

  describe('scroll action', () => {
    it('should scroll down', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'scroll', value: 'down' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('scrolled down');
      expect(adapter.scroll).toHaveBeenCalledWith('down');
    });

    it('should scroll up when specified', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'scroll', value: 'up' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('scrolled up');
      expect(adapter.scroll).toHaveBeenCalledWith('up');
    });
  });

  // ── Navigate Action ──────────────────────────────────────────

  describe('navigate action', () => {
    it('should navigate to the provided URL', async () => {
      const adapter = createMockAdapter({ url: 'https://app.appypieautomate.ai/settings' });
      const step: ActionStep = { action: 'navigate', value: 'https://app.appypieautomate.ai/settings' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('navigated');
      expect(adapter.navigate).toHaveBeenCalledWith('https://app.appypieautomate.ai/settings');
    });

    it('should fail when no URL is provided', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'navigate' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
      expect(result.description).toContain('no URL');
    });
  });

  // ── Keypress Action ──────────────────────────────────────────

  describe('keypress action', () => {
    it('should press the specified key', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'keypress', value: 'Escape' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('pressed Escape');
    });

    it('should default to Enter when no key specified', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'keypress' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('pressed Enter');
    });
  });

  // ── Wait Action ──────────────────────────────────────────────

  describe('wait action', () => {
    it('should wait for the specified duration', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'wait', value: '1000' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(true);
      expect(result.description).toContain('waited');
      expect(adapter.wait).toHaveBeenCalledWith(1000);
    });
  });

  // ── Unknown Action ───────────────────────────────────────────

  describe('unknown action', () => {
    it('should return failure for unknown action types', async () => {
      const adapter = createMockAdapter();
      const step = { action: 'fly' } as unknown as ActionStep;
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.success).toBe(false);
      expect(result.description).toContain('unknown');
    });
  });

  // ── Validation Logic ─────────────────────────────────────────

  describe('validation', () => {
    it('should detect URL change in validation', async () => {
      const adapter = createMockAdapter({ url: 'https://app.appypieautomate.ai/settings' });
      const step: ActionStep = { action: 'click', target: 'abc12345' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.validation.urlChanged).toBe(true);
    });

    it('should detect DOM change in validation', async () => {
      const adapter = createMockAdapter({ domFingerprint: 'fp-after-changed' });
      const step: ActionStep = { action: 'click', target: 'abc12345' };
      const state = makeState({ domFingerprint: 'fp-before-original' });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.validation.domChanged).toBe(true);
    });

    it('should detect new error messages', async () => {
      const adapter = createMockAdapter({ errorMessages: ['Email is required'] });
      const step: ActionStep = { action: 'click', target: 'abc12345' };
      const state = makeState({ errorMessages: [] });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.validation.errorAppeared).toBe(true);
      expect(result.validation.errorMessage).toBe('Email is required');
    });

    it('should compute effective = true when DOM or URL changes', async () => {
      const adapter = createMockAdapter({ domFingerprint: 'fp-different' });
      const step: ActionStep = { action: 'click', target: 'abc12345' };
      const state = makeState({ domFingerprint: 'fp-original' });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.effective).toBe(true);
    });

    it('should suggest rescan_dom retry when element is not found', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'click', target: 'missing-id' };
      const state = makeState({ elements: [] });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.retryStrategy).toBe('rescan_dom');
    });

    it('should check intent match for navigate expectations', async () => {
      const adapter = createMockAdapter({ url: 'https://app.appypieautomate.ai/new-page' });
      const step: ActionStep = { action: 'click', target: 'abc12345', expected: 'navigate to new page' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.validation.intentMatch).toBe(true);
    });

    it('should detect failed intent match for value expectation', async () => {
      // After state has same form values
      const adapter = createMockAdapter({
        domFingerprint: 'fp-before', // no change
        formValues: {},
      });
      const step: ActionStep = { action: 'type', target: 'abc12345', value: 'test', expected: 'value should fill' };
      const el = makeElement({ tag: 'input', elementId: 'abc12345' });
      const state = makeState({ elements: [el], formValues: {} });

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.validation.intentMatch).toBe(false);
    });
  });

  // ── Strategy Options ─────────────────────────────────────────

  describe('strategy options', () => {
    it('should track which strategy was used', async () => {
      const adapter = createMockAdapter();
      const el = makeElement({ attributes: { 'data-testid': 'submit-btn' } });
      const state = makeState({ elements: [el] });
      const step: ActionStep = { action: 'click', target: 'abc12345' };

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.strategyUsed).toBeDefined();
      expect(['selector', 'text', 'role', 'coordinates']).toContain(result.strategyUsed);
    });

    it('should report duration in milliseconds', async () => {
      const adapter = createMockAdapter();
      const step: ActionStep = { action: 'wait', value: '10' };
      const state = makeState();

      const result = await executeValidatedAction(adapter, step, state);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });
  });
});
