// ── Execution Adapter Types ──────────────────────────────────────
// All CUA interaction goes through this interface. NO direct Playwright calls.

export interface IndexedElement {
  index: number;
  elementId: string;           // stable hash-based identity (survives re-indexing)
  tag: string;
  type?: string;               // input type, role
  text: string;                // visible text (trimmed, max 80 chars)
  value?: string;              // current input value
  placeholder?: string;
  attributes: Record<string, string>;  // data-testid, name, id, aria-*, href
  boundingBox: { x: number; y: number; w: number; h: number };
  isInteractable: boolean;
  isVisible: boolean;
}

export interface BrowserState {
  url: string;
  title: string;
  elements: IndexedElement[];
  keyText: string[];           // headings, labels, errors — max 10 items
  formValues: Record<string, string>;  // { "a1b2c3": "john@email.com" }
  domFingerprint: string;      // hash of DOM structure
  hasOverlay: boolean;         // modal/dialog detected
  hasCanvas: boolean;          // canvas/WebGL detected (needs vision)
  duplicateTextCount: number;  // elements with identical text (ambiguous for DOM mode)
  errorMessages: string[];     // visible validation errors
}

export interface ActionResult {
  success: boolean;
  effective: boolean;          // something actually changed (DOM/URL/value)
  error?: string;
  newUrl?: string;
  newTitle?: string;
}

export type ActionType = 'click' | 'type' | 'select' | 'scroll' | 'navigate' | 'keypress' | 'wait' | 'done';

// Structured target shape. Prefer elementId; fall back to text / domPath / index.
// The LLM may still emit a bare string elementId — normalize via coerceLegacyTarget()
// at the parser boundary (see adapter/target.ts).
export interface ActionTarget {
  elementId?: string;
  text?: string;
  domPath?: string;
  index?: number;
}

// Transition-period union — ActionStep.target accepts either shape.
// Downstream code should call coerceLegacyTarget() or resolveTargetElement()
// rather than consuming this raw.
export type ActionTargetLike = ActionTarget | string;

export interface ActionStep {
  action: ActionType;
  target?: ActionTargetLike;   // legacy string OR structured object — see adapter/target.ts
  value?: string;         // text to type, URL to navigate, key to press
  reason?: string;        // short reason for action
  expected?: string;      // expected outcome: "navigate_to_signup", "form_submit", "value_change"
  memory?: string;        // what the model remembers about this action
  next_goal?: string;     // what the model plans to do next
  confidence?: number;
  stepsCompleted?: string[];
  // "done" action fields
  verdict?: string;
  summary?: string;
  issuesFound?: string[];
}

export interface ExecutionAdapter {
  // State
  getState(): Promise<BrowserState>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;

  // Actions — adapter does raw execution only, NO fallback logic
  clickBySelector(selector: string): Promise<ActionResult>;
  clickByText(text: string, role?: string): Promise<ActionResult>;
  clickByCoordinates(x: number, y: number): Promise<ActionResult>;
  doubleClickByCoordinates(x: number, y: number): Promise<ActionResult>;
  doubleClickByText(text: string): Promise<ActionResult>;
  clickByPanelText(text: string): Promise<ActionResult>;  // search entire page for text match & click
  selectAppyPieEvent(eventText: string): Promise<ActionResult>;  // select event from checkbox list + click Continue
  openAndSelectDropdown(dropdownLabel: string, optionText: string): Promise<ActionResult>;  // open Appy Pie custom dropdown → select option
  insertVariableToken(fieldLabel: string, tokenText: string): Promise<ActionResult>;  // click "+ Add or Select" → pick variable from picker modal
  autoFillActionFields(): Promise<{ filled: number; fields: string[] }>;  // proactively fill all empty "+ Add or Select" fields on options page
  clickContinueRunTest(): Promise<ActionResult>;  // wait for "Continue & Run Test" to enable, then click
  typeBySelector(selector: string, text: string): Promise<ActionResult>;
  typeByContentEditable(selector: string, text: string): Promise<ActionResult>;
  typeByCoordinates(x: number, y: number, text: string): Promise<ActionResult>;
  selectBySelector(selector: string, value: string): Promise<ActionResult>;
  scroll(direction: 'up' | 'down', amount?: number): Promise<ActionResult>;
  navigate(url: string): Promise<ActionResult>;
  keypress(key: string): Promise<ActionResult>;
  wait(ms: number): Promise<ActionResult>;
  /**
   * Predicate-driven wait. Polls a JS expression in the page until it returns
   * truthy, or until timeout. Replaces blind `wait(3000)` with deterministic
   * "wait for this thing to be true". Returns success=true if predicate met,
   * effective=true means it actually had to wait (the predicate wasn't already true).
   */
  waitUntil(predicate: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<ActionResult>;
  /**
   * Evaluate a JS expression in-page and return its value. Used by the
   * state-aware execution layer to read a single snapshot of DOM signals
   * (overlayOpen, dropdownOpen, optionsReady, etc.) in one round-trip.
   * Returns undefined if the expression throws.
   */
  evaluateExpr<T = unknown>(expr: string): Promise<T | undefined>;

  // Screenshot (for replay only, NOT for model)
  screenshot(path: string): Promise<void>;
  screenshotJPEG(): Promise<string>;  // base64 JPEG for vision fallback

  // Lifecycle
  close(): Promise<void>;
}
