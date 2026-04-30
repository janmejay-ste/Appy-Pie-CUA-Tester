// ── Field value signature probe ──────────────────────────────────
//
// Returns a JS expression (for adapter.evaluateExpr) that extracts the
// "current value state" of a labeled field as a short string signature.
// Callers use this BEFORE + AFTER a specialized handler to verify the
// value actually changed — not just that the overlay closed. Satisfies
// the "valueBefore === valueAfter → effective=false" rule.
//
// The signature is intentionally a flat string (pipe-joined) so callers
// can compare with a simple === check. Empty string means "could not
// locate field" or "field has no value-bearing children".

/**
 * Normalize a field label to a canonical comparison key. Strips all
 * asterisks (Appy Pie required-field marker) and collapses whitespace.
 * Applied both when storing completed fields and when re-probing.
 */
export function normalizeFieldKey(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\*/g, '')        // strip every asterisk, not just trailing
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an in-page JS expression that returns the value signature of
 * the field whose label contains `label`. Throw-safe — returns '' on
 * any error so callers never need try/catch.
 *
 * Signals captured (pipe-joined):
 *   a:<anchor text>   — dropdown selected display text
 *   v:<input value>   — <input>/<textarea> value
 *   ce:<ce text>      — contenteditable content (variable tokens)
 */
export function fieldValueSignatureExpr(label: string): string {
  const needle = JSON.stringify(normalizeFieldKey(label));
  return `
    (() => {
      try {
        const labels = Array.from(document.querySelectorAll('label, .editoption label, .form-check label'));
        const target = labels.find(l => {
          const t = (l.textContent || '').toLowerCase().replace(/\\*/g, '').replace(/\\s+/g, ' ').trim();
          return t.includes(${needle});
        });
        if (!target) return '';
        const container = target.closest('.form-check, .multiple-menu, .editoption, .dropdownMenu-repeat') || target.parentElement;
        if (!container) return '';
        const parts = [];
        const anchor = container.querySelector('.selected-itemdropdwn, .menu_icon-box, .dropdown-text, [class*="dropdown-value"], [class*="selected-value"]');
        if (anchor) parts.push('a:' + (anchor.textContent || '').trim().slice(0, 60));
        Array.from(container.querySelectorAll('input, textarea')).forEach(i => {
          parts.push('v:' + ((i && i.value) || '').slice(0, 60));
        });
        const ce = container.querySelector('[contenteditable="true"]');
        if (ce) parts.push('ce:' + (ce.textContent || '').trim().slice(0, 60));
        return parts.join('|');
      } catch (e) { return ''; }
    })()
  `;
}
