import type { Page } from 'playwright';
import type { DOMElement, DOMPageState } from './types.js';

const MAX_ELEMENTS = 25;
const MAX_TEXT_LEN = 80;
const MAX_KEY_TEXT = 200;
const MAX_OPTIONS = 10;

// ── Extract structured DOM from page ────────────────────────────
export async function extractPageState(page: Page): Promise<DOMPageState> {
  const result = await page.evaluate(({ maxElements, maxTextLen, maxOptions, maxKeyText }) => {
    // ── Helpers ──
    function isVisible(el: Element): boolean {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    function isInViewport(rect: DOMRect): boolean {
      const margin = 100; // allow elements near viewport edge
      return (
        rect.top < window.innerHeight + margin &&
        rect.bottom > -margin &&
        rect.left < window.innerWidth + margin &&
        rect.right > -margin
      );
    }

    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (testId) return `[data-testid="${testId}"]`;
      // Build nth-child path (max 3 levels)
      let path = '';
      let current: Element | null = el;
      let depth = 0;
      while (current && current !== document.body && depth < 3) {
        const tag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (parent) {
          const currentTag = current.tagName;
          const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === currentTag);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(current) + 1;
            path = `${tag}:nth-child(${idx})${path ? ' > ' + path : ''}`;
          } else {
            path = `${tag}${path ? ' > ' + path : ''}`;
          }
        } else {
          path = `${tag}${path ? ' > ' + path : ''}`;
        }
        current = parent;
        depth++;
      }
      return path || el.tagName.toLowerCase();
    }

    function getText(el: Element): string {
      // Prefer: aria-label > title > direct text content
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim().slice(0, maxTextLen);
      const title = el.getAttribute('title');
      if (title) return title.trim().slice(0, maxTextLen);
      // Get direct text (not deeply nested children text)
      const text = (el as HTMLElement).innerText || el.textContent || '';
      return text.trim().replace(/\s+/g, ' ').slice(0, maxTextLen);
    }

    // ── Collect elements ──
    const selectors = [
      'input:not([type="hidden"])',
      'textarea',
      'select',
      'button',
      '[role="button"]',
      'a[href]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
    ];

    const seen = new Set<Element>();
    const rawElements: Array<{
      el: Element;
      priority: number;
      rect: DOMRect;
    }> = [];

    for (const selector of selectors) {
      try {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          if (seen.has(el)) continue;
          seen.add(el);

          if (!isVisible(el)) continue;
          // Skip elements inside script/style/template
          if (el.closest('script, style, noscript, template')) continue;

          const rect = el.getBoundingClientRect();
          if (!isInViewport(rect)) continue;

          // Priority: inputs(1) > buttons(2) > links(3) > others(4)
          const tag = el.tagName.toLowerCase();
          let priority = 4;
          if (tag === 'input' || tag === 'textarea' || tag === 'select') priority = 1;
          else if (tag === 'button' || el.getAttribute('role') === 'button') priority = 2;
          else if (tag === 'a') priority = 3;

          rawElements.push({ el, priority, rect });
        }
      } catch { /* selector may fail */ }
    }

    // Sort by priority, then by distance from viewport center
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    rawElements.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const da = Math.abs(a.rect.x + a.rect.width / 2 - cx) + Math.abs(a.rect.y + a.rect.height / 2 - cy);
      const db = Math.abs(b.rect.x + b.rect.width / 2 - cx) + Math.abs(b.rect.y + b.rect.height / 2 - cy);
      return da - db;
    });

    // Cap at max
    const capped = rawElements.slice(0, maxElements);

    // ── Build elements array ──
    const elements: Array<{
      id: string; tag: string; type?: string; text?: string;
      placeholder?: string; value?: string; href?: string;
      ariaLabel?: string; role?: string; disabled?: boolean;
      checked?: boolean; options?: string[];
      rect: { x: number; y: number; width: number; height: number };
      selector: string;
    }> = [];

    for (let i = 0; i < capped.length; i++) {
      const { el, rect } = capped[i];
      const tag = el.tagName.toLowerCase();
      const inputEl = el as HTMLInputElement;
      const selectEl = el as HTMLSelectElement;

      const entry: typeof elements[0] = {
        id: `e${i + 1}`,
        tag,
        selector: getSelector(el),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };

      // Type
      if (tag === 'input') entry.type = inputEl.type || 'text';

      // Text
      const text = getText(el);
      if (text) entry.text = text;

      // Placeholder
      const ph = el.getAttribute('placeholder');
      if (ph) entry.placeholder = ph.trim().slice(0, 60);

      // Value
      if (tag === 'input' || tag === 'textarea') {
        entry.value = inputEl.value || '';
      } else if (tag === 'select') {
        entry.value = selectEl.value || '';
      }

      // Href
      if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href) entry.href = href.slice(0, 100);
      }

      // ARIA
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) entry.ariaLabel = ariaLabel.trim().slice(0, 60);
      const role = el.getAttribute('role');
      if (role) entry.role = role;

      // State
      if (inputEl.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
      if (tag === 'input' && (inputEl.type === 'checkbox' || inputEl.type === 'radio')) {
        entry.checked = inputEl.checked;
      }

      // Select options
      if (tag === 'select') {
        entry.options = Array.from(selectEl.options)
          .slice(0, maxOptions)
          .map(o => o.text.trim())
          .filter(Boolean);
      }

      elements.push(entry);
    }

    // ── Key text: headings, labels, errors — NOT random text ──
    const keyParts: string[] = [];
    // Headings
    document.querySelectorAll('h1, h2, h3').forEach(h => {
      const t = (h as HTMLElement).innerText?.trim();
      if (t && t.length > 2) keyParts.push(t.slice(0, 60));
    });
    // Labels
    document.querySelectorAll('label').forEach(l => {
      const t = (l as HTMLElement).innerText?.trim();
      if (t && t.length > 2 && t.length < 40) keyParts.push(t);
    });
    // Errors
    const errorEls = document.querySelectorAll(
      '[role="alert"], .error, .error-message, [class*="alert-danger"], [class*="error"], .text-danger, .text-red'
    );
    const errorTexts: string[] = [];
    errorEls.forEach(e => {
      const t = (e as HTMLElement).innerText?.trim();
      if (t && t.length > 2 && (e as HTMLElement).offsetParent !== null) {
        errorTexts.push(t.slice(0, 80));
      }
    });

    const keyText = keyParts.join(' | ').slice(0, maxKeyText);

    // ── Form state ──
    const formState: Record<string, string> = {};
    for (const entry of elements) {
      if (entry.value !== undefined && entry.value !== '') {
        formState[entry.id] = entry.value;
      }
    }

    return {
      url: location.href,
      title: document.title,
      elements,
      keyText,
      formState: Object.keys(formState).length > 0 ? formState : undefined,
      errors: errorTexts.length > 0 ? errorTexts : undefined,
    };
  }, { maxElements: MAX_ELEMENTS, maxTextLen: MAX_TEXT_LEN, maxOptions: MAX_OPTIONS, maxKeyText: MAX_KEY_TEXT });

  return result as DOMPageState;
}

// ── Format DOM state as compact text for the model ──────────────
export function formatPageStateForModel(state: DOMPageState): string {
  const lines: string[] = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Title: ${state.title}`);
  lines.push('');
  lines.push('Elements:');

  for (const el of state.elements) {
    let line = `${el.id}: <${el.tag}`;
    if (el.type) line += ` type="${el.type}"`;
    line += '>';

    if (el.text) line += ` "${el.text}"`;
    if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
    if (el.value !== undefined) line += ` value="${el.value}"`;
    if (el.href) line += ` href="${el.href}"`;
    if (el.disabled) line += ' [disabled]';
    if (el.checked !== undefined) line += el.checked ? ' [checked]' : ' [unchecked]';
    if (el.options?.length) line += ` options=[${el.options.map(o => `"${o}"`).join(',')}]`;

    line += ` [${el.rect.x},${el.rect.y}]`;
    lines.push(line);
  }

  if (state.keyText) {
    lines.push('');
    lines.push(`Key text: ${state.keyText}`);
  }

  if (state.errors?.length) {
    lines.push(`Errors: ${state.errors.join(' | ')}`);
  }

  if (state.formState && Object.keys(state.formState).length > 0) {
    const formParts = Object.entries(state.formState).map(([k, v]) => `${k}="${v}"`);
    lines.push(`Form: ${formParts.join(' ')}`);
  }

  return lines.join('\n');
}

// ── Build element map for action execution ──────────────────────
export function buildElementMap(state: DOMPageState): Map<string, DOMElement> {
  const map = new Map<string, DOMElement>();
  for (const el of state.elements) {
    map.set(el.id, el);
  }
  return map;
}

// ── DOM fingerprint for stuck detection ─────────────────────────
export function getDOMFingerprint(state: DOMPageState): string {
  const elementSig = state.elements.map(e => `${e.tag}:${e.text?.slice(0, 10) || ''}:${e.value || ''}`).join('|');
  return `${state.url}|${state.elements.length}|${elementSig.slice(0, 200)}`;
}
