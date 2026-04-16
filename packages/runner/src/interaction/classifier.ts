// ── IAL Classifier ─────────────────────────────────────────────
//
// classifyInteraction() takes the model's intent (action + target + value)
// plus current page state and returns a specialized InteractionPlan.
//
// Decision priority (first match wins):
//   1. Action-type fast paths (NAVIGATE, SCROLL, WAIT, KEYPRESS, DONE)
//   2. Specialized click handlers (SELECTABLE_LIST_ITEM, CONTINUE_RUN_TEST,
//      VARIABLE_PICKER, CUSTOM_DROPDOWN)
//   3. Specialized type handler (VARIABLE_PICKER for variable-hinted typing)
//   4. Generic primitives as fallback
//
// All decisions emit `reason` so the loop can log WHY a particular type
// was picked. This makes mis-classifications obvious without instrumentation.

import type { ClassifierInput, InteractionPlan } from './types.js';
import type { IndexedElement } from '../adapter/types.js';

// ── Element role detection (Phase 1 of role-first classifier) ──
// Returns a structural role for an element using fields already on
// IndexedElement (tag, attributes.class — captured by the extractor at
// playwright-adapter.ts:202, attributes.role). No regex on text.
//
// The classifier uses this to short-circuit text-based routing for
// high-confidence roles. Specifically: a click on DROPDOWN_OPTION must
// NEVER route through VARIABLE_PICKER / CUSTOM_DROPDOWN / SELECTABLE_LIST_ITEM
// regardless of what its text says — the option has been clicked, the
// raw click is the correct action.
export enum ElementRole {
  DROPDOWN_OPTION = 'DROPDOWN_OPTION',
  DROPDOWN_SEARCH_INPUT = 'DROPDOWN_SEARCH_INPUT',
  DROPDOWN_TRIGGER = 'DROPDOWN_TRIGGER',
  BUTTON = 'BUTTON',
  INPUT_FIELD = 'INPUT_FIELD',
  ANCHOR = 'ANCHOR',
  UNKNOWN = 'UNKNOWN',
}

export function detectElementRole(el: IndexedElement | null | undefined): ElementRole {
  if (!el) return ElementRole.UNKNOWN;
  const cls = (el.attributes?.['class'] || '').toLowerCase();
  const tag = (el.tag || '').toLowerCase();
  const role = (el.attributes?.['role'] || '').toLowerCase();

  // DROPDOWN_OPTION — match Appy Pie's `.menu_dropdown-option` and the
  // generic `li.choice` / `role=option` / Choices.js `choices__item` patterns.
  // This MUST come first; everything else is a tie-breaker.
  if (
    cls.includes('menu_dropdown-option') ||
    cls.includes('choices__item') ||
    /\bchoice\b/.test(cls) ||
    role === 'option'
  ) {
    return ElementRole.DROPDOWN_OPTION;
  }

  // DROPDOWN_SEARCH_INPUT — the `.formcontrol` input lives inside an open
  // `.editoption-dropmenu.active_menu .choices-search`. We can't see ancestors
  // from Node, but `formcontrol` + tag=input is a tight Appy Pie signal.
  if (tag === 'input' && cls.includes('formcontrol')) {
    return ElementRole.DROPDOWN_SEARCH_INPUT;
  }

  // DROPDOWN_TRIGGER — the `.menu_icon-box` / `.editoption-dropmenu` container
  // user clicks to open the dropdown. Defer to `elementLooksLikeDropdown` for
  // the canonical aria/role/class signal — defined later in this file.
  if (
    role === 'combobox' ||
    role === 'listbox' ||
    el.attributes?.['aria-expanded'] !== undefined ||
    el.attributes?.['aria-haspopup'] !== undefined ||
    /\b(menu_icon|editoption-dropmenu)\b/.test(cls)
  ) {
    return ElementRole.DROPDOWN_TRIGGER;
  }

  if (tag === 'button' || role === 'button' || el.attributes?.['type'] === 'submit') return ElementRole.BUTTON;
  if (tag === 'input' || tag === 'textarea') return ElementRole.INPUT_FIELD;
  if (tag === 'a') return ElementRole.ANCHOR;

  return ElementRole.UNKNOWN;
}

// ── Pattern detectors ──────────────────────────────────────────

const CONTINUE_RUN_TEST_RE = /\b(continue\s*&\s*run\s*test|skip\s*run\s*test|continue\s+and\s+run)\b/i;
const VARIABLE_PICKER_TEXT_RE = /\+\s*(add\s+or\s+select|add\b)/i;
const VARIABLE_HINT_REASON_RE = /variable|token|map|data\s+field|from\s+trigger|add\s+or\s+select|dynamic/i;
const VARIABLE_HINT_VALUE_RE = /\{\{|from\s+\w+\s+trigger/i;
// FIX 1: picker-field label recognition. When the model clicks/types into a
// labeled action field on /customeditor/.../options/, the target IS a picker
// even if no explicit "Add or Select" text is in the value. These are the
// recurring Appy Pie action field names across Gmail / Slack / Sheets / etc.
// Tokens are word-bounded. The Sheet-family tokens (`sheet`/`spreadsheet`/
// `worksheet`) are intentionally NOT in this list: they collided with option
// text "Test sheet" and "Sheet 1" inside open dropdowns, causing the
// dd186b23 misroute. The role-first early return now blocks option clicks
// before this regex runs, but defense-in-depth: the role detector is the
// only barrier, so we keep the regex narrow on tokens that are uniquely
// field-like (not common values).
const KNOWN_PICKER_FIELD_RE = /\b(subject|body|message|email\s*body|to|from|cc|bcc|recipient|sender|title|content|description|attachment|row|column|cell|folder|channel|user|name|value|data|field|draft|note|comment|tag|label|status|priority|due\s*date|assignee)\b/i;
const EVENT_PATTERNS = [
  'new spreadsheet', 'new opportunity', 'new form', 'new contact',
  'create draft', 'create sale', 'new row', 'updated', 'new email',
  'send email', 'create user', 'add opportunity',
];
const SELECT_DROPDOWN_RE = /^(?:select|choose|pick)\s+(.+)/i;

// FIX 1: known app names in the Appy Pie side panel. Clicking one of these
// on /customeditor/ (but NOT on /options/ — that's picker context) should
// route to PANEL_SELECT, which uses clickByText + waitUntil(state change).
// Keep tight: common Appy Pie integrations, Title-Case brand names only.
const KNOWN_PANEL_APP_RE = /^(google\s+(sheets|drive|calendar|docs|forms|contacts|analytics|ads)|gmail|slack|trello|asana|hubspot|salesforce|zoho|outlook|excel|office\s*365|dropbox|onedrive|github|gitlab|discord|whatsapp|twitter|x\s*\(twitter\)|facebook|instagram|linkedin|mailchimp|stripe|paypal|shopify|woocommerce|wordpress|pipedrive|monday|clickup|notion|airtable|typeform|jotform|calendly|zoom|microsoft\s+teams|telegram|mailgun|sendgrid|twilio|intercom|zendesk|freshdesk|jira|bitbucket|quickbooks|xero|basecamp|todoist|evernote)$/i;

// FIX 3: contexts where SEARCHABLE_APP_LIST fires — the "Add Action App" or
// "Add Trigger App" panel. These lists are virtualized; a blind click on an
// app name outside the viewport will always fail.
const APP_LIST_CONTEXT_RE = /\b(add\s+action\s+app|add\s+trigger\s+app|choose\s+(action|trigger)\s+app|select\s+app)\b/i;

// Negative filter for PANEL_SELECT — these are navigation / submit buttons
// that happen to appear in the side panel but are NOT app or event
// selections. Without this filter, clicks on Continue/Back/Save would be
// misrouted to PANEL_SELECT and override the correct specialized handlers.
const PANEL_NAV_BUTTON_RE = /\b(continue|back|cancel|save|run|skip|close|next|previous|done|finish|submit|retry|refresh)\b/i;

// FIX 2: signals that an element IS a dropdown (not just a button that
// happens to have "menu" in its text).
function elementLooksLikeDropdown(el: { tag?: string; attributes?: Record<string, string>; text?: string } | null | undefined): boolean {
  if (!el) return false;
  const attrs = el.attributes || {};
  if (attrs['aria-expanded'] !== undefined) return true;
  if (attrs['aria-haspopup']) return true;
  if (attrs['role'] === 'combobox' || attrs['role'] === 'listbox') return true;
  const cls = (attrs['class'] || '').toLowerCase();
  if (/\b(dropdown|combobox|select|menu_icon|menu_dropdown|editoption-dropmenu)\b/.test(cls)) return true;
  return false;
}

function sidePanelOpen(state: ClassifierInput['state']): boolean {
  // The Appy Pie editor opens its side panel for app / event selection. When
  // open, known selectors appear in the element list. Tightest signal: the
  // "Choose App" / "Select Event" headings or the chooseapps container class.
  const panelHeadings = ['choose app', 'choose an app', 'choose event', 'select event', 'select an event', 'add action app', 'add trigger app', 'choose action app', 'choose trigger app'];
  const hasPanelHeading = state.elements.some(e => {
    const t = (e.text || '').toLowerCase();
    return panelHeadings.some(h => t.includes(h));
  });
  if (hasPanelHeading) return true;
  if (state.keyText && state.keyText.some(t => panelHeadings.some(h => t.toLowerCase().includes(h)))) return true;
  return false;
}

function isAddAppListContext(state: ClassifierInput['state']): boolean {
  // Signal A ONLY: explicit UI copy mentions "Add Action App" / "Add Trigger
  // App" / "Choose App". No search-input fallback — that caused T15 misfire
  // where the Spreadsheet dropdown's "Search..." was mistaken for the app
  // list panel. Dropdown-record search and Available-Data-Fields search both
  // have placeholder=search too, so we rely strictly on explicit text.
  const hasCtx = state.elements.some(e => APP_LIST_CONTEXT_RE.test((e.text || '')));
  if (hasCtx) return true;
  if (state.keyText && state.keyText.some(t => APP_LIST_CONTEXT_RE.test(t))) return true;
  return false;
}

// ── Helpers ────────────────────────────────────────────────────

function lower(s: string | undefined | null): string {
  return (s || '').toLowerCase();
}

function isOnOptionsPage(url: string): boolean {
  return url.includes('/customeditor/') && url.includes('/options/');
}

/**
 * PR V2 guard: confirm the VARIABLE_PICKER infrastructure actually exists on
 * the page before classifying as VARIABLE_PICKER. If the page has no
 * `+ Add or Select` link AND no token/chip markers, the classification is a
 * false positive — the model's intent probably doesn't map to a picker.
 *
 * Returns true when at least ONE signal of picker infrastructure is present.
 */
/**
 * FIX 5: Panel state detection. Returns true when the token picker overlay is
 * CURRENTLY OPEN (not just present). A click on a picker-field label while the
 * overlay is already open is redundant — the config engine's `open_overlay`
 * step will skip, and we avoid the "click → close → retry" bounce loop.
 *
 * Signals that the overlay is actively displayed (not just in the DOM):
 *   - "Search or select a dynamic value" picker heading is visible (elements/keyText)
 *   - search input is indexed (implies dropdown is rendered, not collapsed)
 */
function isPickerOverlayActive(state: ClassifierInput['state']): boolean {
  // Signal A: outer token-picker overlay heading is visible.
  const searchForTokens = ['search or select a dynamic value', 'search or select'];
  const hasPickerHeading = state.elements.some(e => {
    const t = (e.text || '').toLowerCase();
    return searchForTokens.some(tok => t.includes(tok));
  });
  if (hasPickerHeading) return true;
  if (state.keyText && state.keyText.some(t => /search\s+or\s+select/i.test(t))) return true;
  // Signal B: any indexed element carries `.active_menu` or `.menu_active`
  // — Appy Pie's open-dropdown class. The outer heading is missing for
  // INNER dropdowns (e.g. the Spreadsheet list inside an opened picker),
  // so heading-only detection misses the dd186b23 path. Class attribute
  // is captured by the extractor at playwright-adapter.ts:202.
  const hasActiveMenu = state.elements.some(e => {
    const cls = (e.attributes?.['class'] || '').toLowerCase();
    return cls.includes('active_menu') || cls.includes('menu_active');
  });
  if (hasActiveMenu) return true;
  return false;
}

function pickerInfrastructurePresent(state: ClassifierInput['state']): boolean {
  // Signal 1: a `+ Add or Select` link is indexed
  const hasAddOrSelectLink = state.elements.some(e => {
    const t = (e.text || '').toLowerCase();
    return t.includes('+ add or select') || t === 'add or select' || t === '+ add';
  });
  if (hasAddOrSelectLink) return true;

  // Signal 2: keyText (headings/labels) mentions Add or Select
  if (state.keyText && state.keyText.some(t => /add\s+or\s+select/i.test(t))) return true;

  // Signal 3: we're on a /customeditor/.../options/ page — assume infrastructure
  // is loaded even if elements slice happens to miss it this frame.
  if (state.url.includes('/customeditor/') && state.url.includes('/options/')) return true;

  return false;
}

function targetText(input: ClassifierInput): string {
  const t = input.step.target as any;
  if (t && typeof t === 'object' && typeof t.text === 'string') return t.text;
  if (input.resolvedElement?.text) return input.resolvedElement.text;
  return '';
}

/**
 * Interactable check: is this element actually clickable/typable, or is
 * it a static label/heading? Labels match by text but can't accept clicks.
 */
function isInteractable(e: { tag?: string; isInteractable?: boolean; attributes?: Record<string, string> }): boolean {
  const tag = (e.tag || '').toLowerCase();
  if (['input', 'button', 'textarea', 'select', 'a'].includes(tag)) return true;
  if (e.isInteractable === true) return true;
  const attrs = e.attributes || {};
  if (attrs['onclick']) return true;
  if (attrs['role'] === 'button' || attrs['role'] === 'combobox' || attrs['role'] === 'listbox' || attrs['role'] === 'option' || attrs['role'] === 'tab') return true;
  if (attrs['contenteditable'] === 'true') return true;
  if (attrs['tabindex'] && attrs['tabindex'] !== '-1') return true;
  return false;
}

/**
 * FIX B (v2): Text-based element resolution, upgraded with two rules:
 *
 *   1. INTERACTABLE FILTER — only return elements that can actually accept
 *      clicks. Filters out static labels / headings / panel text which
 *      previously poisoned classification downstream.
 *
 *   2. LABEL→INPUT NEAREST MAPPING — when the text match lands on a
 *      non-interactable label like "Worksheet *", scan the indexed element
 *      list for the nearest interactable element (input/dropdown/button).
 *      Matches Angular/HTML convention where `<label>` is immediately
 *      followed by its paired `<input>` or dropdown trigger.
 *
 * Only fires when value is 2-40 chars.
 */
function resolveByText(
  input: ClassifierInput,
): ClassifierInput['resolvedElement'] {
  if (input.resolvedElement) return input.resolvedElement;
  const value = (input.step.value || '').trim();
  if (value.length < 2 || value.length > 40) return null;
  // Normalize — strip trailing asterisk (required-field marker), trim.
  const needle = value.toLowerCase().replace(/\s*\*\s*$/, '').trim();
  const els = input.state.elements;

  const textEq = (s: string | undefined): boolean => {
    const t = (s || '').toLowerCase().trim().replace(/\s*\*\s*$/, '');
    return t === needle;
  };
  const textStarts = (s: string | undefined): boolean => {
    const t = (s || '').toLowerCase().trim();
    return t.startsWith(needle);
  };
  const textIncludes = (s: string | undefined): boolean => {
    const t = (s || '').toLowerCase().trim();
    return t.includes(needle);
  };
  const visible = (e: { isVisible?: boolean }): boolean => e.isVisible !== false;

  // STEP 1: exact match on an interactable element (best case)
  let hit = els.find(e => visible(e) && isInteractable(e) && textEq(e.text));
  if (hit) return hit;

  // STEP 2: label→input mapping. Text matches a non-interactable label?
  // Two-tier strategy per user feedback — SEMANTIC before POSITIONAL to
  // avoid silent wrong-element mapping in grid/flex layouts:
  //
  //   Tier A (semantic): candidate's placeholder / aria-label / name / id /
  //   data-* attribute contains the label text. Strong signal the input
  //   actually belongs to this label regardless of DOM order.
  //
  //   Tier B (positional): nearest interactable by index distance, bounded
  //   to within 5 positions. Only accepted when Tier A finds nothing.
  const labelIdx = els.findIndex(e => visible(e) && textEq(e.text));
  if (labelIdx >= 0) {
    // Tier A: semantic match
    const semanticHit = els.find((e, i) => {
      if (i === labelIdx) return false;
      if (!visible(e) || !isInteractable(e)) return false;
      const attrs = e.attributes || {};
      const candidates = [
        e.placeholder,
        attrs['aria-label'],
        attrs['aria-labelledby'],
        attrs['name'],
        attrs['id'],
        attrs['data-label'],
        attrs['data-field'],
        attrs['data-testid'],
      ].filter(Boolean).map(s => (s || '').toLowerCase());
      return candidates.some(s => s.includes(needle));
    });
    if (semanticHit) return semanticHit;

    // Tier B: positional fallback
    let best: (typeof els)[number] | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < els.length; i++) {
      if (i === labelIdx) continue;
      const cand = els[i];
      if (!visible(cand) || !isInteractable(cand)) continue;
      const dist = Math.abs(i - labelIdx);
      if (dist < bestDist) {
        best = cand;
        bestDist = dist;
      }
    }
    if (best && bestDist <= 5) return best;
  }

  // STEP 3: interactable with startsWith match
  hit = els.find(e => visible(e) && isInteractable(e) && textStarts(e.text));
  if (hit) return hit;

  // STEP 4: interactable with contains match (last resort)
  hit = els.find(e => visible(e) && isInteractable(e) && textIncludes(e.text));
  return hit ?? null;
}

// ── Main entry ─────────────────────────────────────────────────

export function classifyInteraction(input: ClassifierInput): InteractionPlan {
  const { step, url } = input;
  const action = step.action;
  const value = step.value || '';
  const reason = step.reason || '';
  // FIX B: try text-based resolution when adapter failed to resolve target.
  // Non-destructive — only fills resolvedElement if it was null.
  if (!input.resolvedElement && value) {
    const textResolved = resolveByText(input);
    if (textResolved) {
      // Inject into the input object so all downstream branches see it.
      // This mirrors what the adapter would have produced on success.
      (input as { resolvedElement: typeof textResolved }).resolvedElement = textResolved;
    }
  }
  const elText = targetText(input);

  // 1. Action-type fast paths
  if (action === 'navigate') {
    return { type: 'NAVIGATE', target: step.target, value, reason: 'action=navigate' };
  }
  if (action === 'scroll') {
    return { type: 'SCROLL', target: step.target, value, reason: 'action=scroll' };
  }
  if (action === 'wait') {
    return { type: 'WAIT', target: step.target, value, reason: 'action=wait' };
  }
  if (action === 'keypress') {
    return { type: 'KEYPRESS', target: step.target, value, reason: 'action=keypress' };
  }
  if (action === 'done') {
    return { type: 'DONE', reason: 'action=done' };
  }

  // 2. Click classification
  if (action === 'click') {
    const valLower = lower(value);
    const elTextLower = lower(elText);
    const reasonLower = lower(reason);

    // 2-pre. Role-first early return (Phase 1 of role-based classifier).
    // A click on a DROPDOWN_OPTION must always land as a raw click — the
    // option element is the final intent. Without this gate, the option's
    // visible text drives downstream regex routing (KNOWN_PICKER_FIELD_RE
    // on "Test sheet" → VARIABLE_PICKER → wrong selection). DROPDOWN_OPTION_DIRECT
    // routes to a thin executor handler that performs the click and surfaces
    // ialFieldLabel so the cua-loop completed-fields tracker can fire.
    const elementRole = detectElementRole(input.resolvedElement);
    if (elementRole === ElementRole.DROPDOWN_OPTION) {
      const optionText = elText || value || '';
      return {
        type: 'DROPDOWN_OPTION_DIRECT',
        target: step.target,
        value: optionText,
        hints: { fieldLabel: optionText },
        reason: `role=DROPDOWN_OPTION → direct click on "${optionText.slice(0, 40)}"`,
      };
    }

    // 2a. Continue & Run Test — wait-for-enabled then click
    if (CONTINUE_RUN_TEST_RE.test(valLower) || CONTINUE_RUN_TEST_RE.test(elTextLower)) {
      return {
        type: 'CONTINUE_RUN_TEST',
        target: step.target,
        value,
        reason: 'click on Continue & Run Test pattern',
      };
    }

    // 2b-app. SEARCHABLE_APP_LIST — model wants an app from a virtualized
    // list ("Add Action App" / "Add Trigger App" panel). Classifier fires
    // when we're in that context AND the click target text looks like an
    // app name. Executor prefers search input, falls back to scroll-probe.
    // FIX 3.
    const urlIsCustomEditor = url.includes('/customeditor');
    const inAppListCtx = urlIsCustomEditor && isAddAppListContext(input.state);
    if (inAppListCtx) {
      // Preferred target text: the value (model's stated target) or the
      // element's resolved text. Must look like a short app name.
      const targetText = (value || elText || '').trim();
      if (targetText.length >= 2 && targetText.length < 30) {
        return {
          type: 'SEARCHABLE_APP_LIST',
          target: step.target,
          value: targetText,
          hints: { targetAppName: targetText },
          reason: `click in app-list context → SEARCHABLE_APP_LIST (target="${targetText}")`,
        };
      }
    }

    // 2b. SELECTABLE_LIST_ITEM (event tile) — must come BEFORE PANEL_SELECT so
    // events don't get swallowed by the panel-select routing. Events ARE a
    // sub-type of panel click but require a dedicated handler (selectAppyPieEvent
    // + post-verify highlight/next-step), not the generic panel-text click.
    const matchedEvent = EVENT_PATTERNS.find(p => valLower.includes(p) || elTextLower.includes(p));
    if (matchedEvent) {
      return {
        type: 'SELECTABLE_LIST_ITEM',
        target: step.target,
        value: value || elText,
        hints: { eventText: value || elText },
        reason: `click matched event pattern "${matchedEvent}" → SELECTABLE_LIST_ITEM`,
      };
    }

    // 2b-panel. PANEL_SELECT — side-panel option click for APPS ONLY. Fires when:
    //   - URL is /customeditor/ but NOT /options/ (that's picker context)
    //   - side panel heading is visible (Choose App / Select Event etc.)
    //   - target element text matches a known app name (events now route to
    //     SELECTABLE_LIST_ITEM above — don't double-route here)
    //   - target element is clickable div/span/li (not input/dropdown)
    // FIX 1.
    const isOnOptionsCtx = isOnOptionsPage(url);
    const panelIsOpen = urlIsCustomEditor && !isOnOptionsCtx && sidePanelOpen(input.state);
    if (panelIsOpen) {
      const candidateText = (elText || value || '').trim();
      const tag = (input.resolvedElement?.tag || '').toLowerCase();
      const isTextTag = ['div', 'span', 'li', 'p', 'h3', 'h4', 'a'].includes(tag);
      const notInputLike = tag !== 'input' && tag !== 'textarea' && tag !== 'select' && tag !== 'button';
      const looksLikeDropdown = elementLooksLikeDropdown(input.resolvedElement as any);
      const matchesApp = candidateText.length > 0 && candidateText.length < 50 && KNOWN_PANEL_APP_RE.test(candidateText);
      // FIX tighten: negative filter — reject navigation/submit button text.
      // "Continue", "Back", "Save", "Run" all should route to their own
      // specialized handlers (or generic click), never be mistaken for a
      // panel option selection.
      const isNavButton = PANEL_NAV_BUTTON_RE.test(candidateText);
      if (isTextTag && notInputLike && !looksLikeDropdown && !isNavButton && matchesApp) {
        return {
          type: 'PANEL_SELECT',
          target: step.target,
          value: candidateText,
          hints: { panelOptionText: candidateText },
          reason: `panel open + app name "${candidateText}" on clickable ${tag}`,
        };
      }
    }

    // 2c. Variable token picker — multiple entry points, each independently sufficient:
    //   (a) literal "+ Add or Select" in value or resolved element text
    //   (b) /options/ URL + "add or select" in value or reason (model's intent)
    //   (c) FIX 1: /options/ URL + resolved element text matches a known picker
    //       field label (Subject/Body/To/etc). This catches the common
    //       misclassification where the model clicks on the labeled field and
    //       we previously emitted GENERIC_CLICK → system chaos downstream.
    const isOnOptions = isOnOptionsPage(url);
    const resolvedText = input.resolvedElement?.text || '';
    // FIX 1 over-trigger guard: the target must BE an interactable element
    // (input / button / contenteditable / clickable div), not a heading or
    // static label. Prevents "Email Settings" / "Body Preview" / "Message
    // Template" from false-positiving into the picker.
    const interactableTags = new Set(['input', 'button', 'textarea', 'select', 'div', 'span', 'a']);
    const el = input.resolvedElement;
    const isInteractableTarget = !!el && (
      el.isInteractable === true ||
      interactableTags.has((el.tag || '').toLowerCase()) ||
      (el.attributes && (
        el.attributes['contenteditable'] === 'true' ||
        !!el.attributes['role'] ||
        !!el.attributes['onclick']
      ))
    );
    // Root-cause guard (run dd186b23 regression): when the picker overlay is
    // ALREADY OPEN, a click whose resolvedText matches a known picker field
    // is almost always a dropdown-option click (e.g. clicking "Test sheet"
    // inside an open Spreadsheet picker), NOT a request to reopen a field.
    // Routing such clicks through VARIABLE_PICKER → SEARCHABLE_TOKEN_INPUT
    // with an empty `value` skips type_search and the engine's select_option
    // step picks the first visible option — silent wrong selection.
    // Emit GENERIC_CLICK instead; the raw click will land on the <li>.
    const overlayAlreadyOpen = isPickerOverlayActive(input.state);
    // Note: a separate `elementRole !== DROPDOWN_OPTION` guard is unnecessary
    // here — the role-first early return at the top of this branch already
    // returned for that role, so TypeScript narrows `elementRole` to exclude
    // it for the remainder of this scope. The early return IS the guard.
    const matchesPickerFieldLabel = isOnOptions &&
      resolvedText.length > 0 &&
      resolvedText.length < 40 &&  // labels are short; reject long panel text
      isInteractableTarget &&       // must be clickable/input-like — not a heading
      !overlayAlreadyOpen &&        // ← guard: inside-open-picker clicks must fall through
      KNOWN_PICKER_FIELD_RE.test(resolvedText);

    if (
      VARIABLE_PICKER_TEXT_RE.test(valLower) ||
      VARIABLE_PICKER_TEXT_RE.test(elTextLower) ||
      (isOnOptions && (valLower.includes('add or select') || reasonLower.includes('add or select'))) ||
      matchesPickerFieldLabel
    ) {
      // False-positive guard: only dispatch if picker infrastructure is
      // actually present on the page. Otherwise fall through to generic click.
      if (pickerInfrastructurePresent(input.state)) {
        // FIX 5: if overlay is ALREADY open, annotate the reason so engine
        // logs are self-explanatory. The engine's open_overlay step will
        // correctly skip via its `condition: !state.overlayOpen`, so we
        // don't have to prevent routing — we just want observability.
        const baseReason = matchesPickerFieldLabel
          ? `click on picker field "${resolvedText}" (/options/ + known label)`
          : 'click on + Add or Select token picker';
        const classifyReason = overlayAlreadyOpen
          ? `${baseReason} [panel already open — engine will skip open step]`
          : baseReason;
        return {
          type: 'VARIABLE_PICKER',
          target: step.target,
          value,
          hints: { fieldLabel: resolvedText || elText || value || '' },
          reason: classifyReason,
        };
      }
      return {
        type: 'GENERIC_CLICK',
        target: step.target,
        value,
        reason: 'VARIABLE_PICKER downgraded: no picker infrastructure on page',
      };
    }

    // 2d. Custom dropdown — two entry points:
    //   (i) model-stated "Select X / Choose X" value pattern (legacy)
    //   (ii) FIX 2: element itself carries dropdown markers (aria-expanded,
    //        role=combobox, class matches dropdown/menu_icon etc.)
    const selectMatch = value.match(SELECT_DROPDOWN_RE);
    if (selectMatch) {
      const dropdownLabel = selectMatch[1].replace(/\s*(dropdown|field|option|from.*)/i, '').trim();
      if (dropdownLabel.length > 2) {
        return {
          type: 'CUSTOM_DROPDOWN',
          target: step.target,
          value,
          hints: { fieldLabel: dropdownLabel },
          reason: `click value "${value.slice(0, 30)}" → CUSTOM_DROPDOWN`,
        };
      }
    }
    // FIX 2: element-marker detection for dropdown. Only fires when the
    // classifier hasn't already routed somewhere else above. Uses element
    // metadata (tag + aria + class) — no text heuristics — so this is
    // high-precision.
    if (elementLooksLikeDropdown(input.resolvedElement as any)) {
      const label = (input.resolvedElement?.attributes?.['aria-label']
        || input.resolvedElement?.attributes?.['data-label']
        || elText || value || '').trim();
      if (label.length > 0 && label.length < 40) {
        return {
          type: 'CUSTOM_DROPDOWN',
          target: step.target,
          value: value || 'first',  // default to first option when value unspecified
          hints: { fieldLabel: label },
          reason: `element has dropdown markers (aria/role/class) — label="${label}"`,
        };
      }
    }

    // 2e. Click on options page with no resolved element + non-empty value
    //     → fall back to panel text search
    if (!input.resolvedElement && value && value.length > 2 && value.length < 60) {
      return {
        type: 'PANEL_TEXT_FALLBACK',
        target: step.target,
        value,
        hints: { panelText: value },
        reason: 'click target unresolved, value present → panel text search',
      };
    }

    // 2f. Generic click fallback
    return {
      type: 'GENERIC_CLICK',
      target: step.target,
      value,
      reason: 'no specialized click handler matched',
    };
  }

  // 3. Type classification
  if (action === 'type') {
    const valLower = lower(value);
    const reasonLower = lower(reason);
    const isVariableHint =
      VARIABLE_HINT_REASON_RE.test(reasonLower) || VARIABLE_HINT_VALUE_RE.test(valLower);

    if (isVariableHint && step.target) {
      // False-positive guard: only dispatch to picker if infrastructure exists.
      if (pickerInfrastructurePresent(input.state)) {
        return {
          type: 'VARIABLE_PICKER',
          target: step.target,
          value,
          hints: { fieldLabel: elText || step.value || '' },
          reason: 'type with variable-token hint',
        };
      }
      // Otherwise fall through to GENERIC_TYPE with a downgrade reason.
      return {
        type: 'GENERIC_TYPE',
        target: step.target,
        value,
        reason: 'VARIABLE_PICKER downgraded: no picker infrastructure on page',
      };
    }

    return {
      type: 'GENERIC_TYPE',
      target: step.target,
      value,
      reason: 'type without variable hint',
    };
  }

  // 4. Select classification
  if (action === 'select') {
    // FIX A: when the model emits `select first` / `select <value>` on an
    // Appy Pie Angular dropdown, the native <select> path in adapter fails
    // (these are custom dropdowns, not real selects). Route to CUSTOM_DROPDOWN
    // which opens the dropdown and clicks an option via the legacy handler.
    // Trigger conditions: element has dropdown markers OR value looks like
    // a select semantic ("first", "last", option name) on an Appy Pie page.
    const elText2 = targetText(input);
    const el2 = input.resolvedElement;
    const looksLikeDropdown2 = elementLooksLikeDropdown(el2 as any);
    const onAppyPieEditor = url.includes('/customeditor') || url.includes('/options/');
    if (looksLikeDropdown2 || onAppyPieEditor) {
      const label = (el2?.attributes?.['aria-label']
        || el2?.attributes?.['data-label']
        || elText2 || '').trim();
      if (label.length > 0 && label.length < 60) {
        return {
          type: 'CUSTOM_DROPDOWN',
          target: step.target,
          value: value || 'first',
          hints: { fieldLabel: label },
          reason: `action=select → CUSTOM_DROPDOWN (${looksLikeDropdown2 ? 'dropdown markers' : 'Appy Pie editor context'})`,
        };
      }
    }
    return {
      type: 'GENERIC_SELECT',
      target: step.target,
      value,
      reason: 'action=select (no dropdown markers, no editor context)',
    };
  }

  // Unknown action — let the engine handle it generically
  return {
    type: 'GENERIC_CLICK',
    target: step.target,
    value,
    reason: `unknown action "${action}"`,
  };
}
