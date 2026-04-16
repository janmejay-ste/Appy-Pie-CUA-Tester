// ── Hard verification layer ────────────────────────────────────
//
// The CUA model emits `VERDICT: PASS`. That's an opinion. This layer
// checks that opinion against the actual page state — final URL, visible
// text, specific elements — before accepting the verdict as ground truth.
//
// Input:   BrowserState + declarative ValidationRule[]
// Output:  ValidationResult { passed, checks }
//
// Philosophy: keep rules SIMPLE. 2–5 strong signals beat 20 weak ones.
// Soft matching (substring, case-insensitive) is preferred — we're verifying
// "the user sees what they should see", not running an exact-string assertion.

import type { BrowserState } from '../adapter/types.js';

// ── Rule shape ─────────────────────────────────────────────────

export type ValidationRuleType = 'url' | 'text' | 'element' | 'not_text';

export interface ValidationRule {
  type: ValidationRuleType;
  /**
   * Match value — interpreted per type:
   *   url       → substring of state.url (case-insensitive)
   *   text      → substring of any element's visible text (case-insensitive)
   *   element   → stable elementId hash OR tag:text signature
   *   not_text  → passes ONLY if no element text contains this string
   */
  value: string;
  /** Optional human-readable label for nicer log/dashboard output. */
  label?: string;
}

export interface ValidationCheck {
  rule: ValidationRule;
  passed: boolean;
  /** Short human description of what was checked / what was found. */
  detail?: string;
}

export interface ValidationResult {
  passed: boolean;
  /** Fraction of checks that passed (0..1). Useful for partial-credit logging. */
  score: number;
  checks: ValidationCheck[];
}

// ── Core: run rules against a state ────────────────────────────

export function validateState(
  state: BrowserState,
  rules: ValidationRule[],
): ValidationResult {
  if (!rules || rules.length === 0) {
    // No rules → full trust in the model verdict. We return passed=true with
    // an empty check list so callers can tell this from "passed because rules
    // passed" (score=1 with 0 checks means 'no rules defined').
    return { passed: true, score: 1, checks: [] };
  }

  const checks: ValidationCheck[] = rules.map(rule => {
    switch (rule.type) {
      case 'url': {
        const needle = rule.value.toLowerCase();
        const hay = (state.url || '').toLowerCase();
        const passed = hay.includes(needle);
        return {
          rule,
          passed,
          detail: passed ? `url contains "${rule.value}"` : `url="${state.url}" missing "${rule.value}"`,
        };
      }
      case 'text': {
        const needle = rule.value.toLowerCase();
        const hit = state.elements.find(e => (e.text || '').toLowerCase().includes(needle));
        // Also search keyText (headings/labels the DOM extractor surfaces).
        const hitKey = !hit && state.keyText
          ? state.keyText.find(t => t.toLowerCase().includes(needle))
          : undefined;
        const passed = !!hit || !!hitKey;
        return {
          rule,
          passed,
          detail: passed ? `found text "${rule.value}"` : `missing text "${rule.value}"`,
        };
      }
      case 'not_text': {
        const needle = rule.value.toLowerCase();
        const hit = state.elements.some(e => (e.text || '').toLowerCase().includes(needle))
          || (state.keyText || []).some(t => t.toLowerCase().includes(needle));
        const passed = !hit;
        return {
          rule,
          passed,
          detail: passed ? `correctly absent: "${rule.value}"` : `unexpectedly present: "${rule.value}"`,
        };
      }
      case 'element': {
        // Accept either a stable elementId hash OR a "tag:text" signature.
        const idMatch = state.elements.some(e => e.elementId === rule.value);
        if (idMatch) return { rule, passed: true, detail: `element id=${rule.value}` };
        if (rule.value.includes(':')) {
          const [tag, text] = rule.value.split(':', 2);
          const sigMatch = state.elements.some(e =>
            (e.tag || '').toLowerCase() === tag.toLowerCase() &&
            (e.text || '').toLowerCase().includes(text.toLowerCase()),
          );
          return {
            rule,
            passed: sigMatch,
            detail: sigMatch ? `found ${rule.value}` : `missing ${rule.value}`,
          };
        }
        return { rule, passed: false, detail: `no element matches "${rule.value}"` };
      }
      default:
        return { rule, passed: false, detail: `unknown rule type` };
    }
  });

  const passedCount = checks.filter(c => c.passed).length;
  return {
    passed: passedCount === checks.length,
    score: checks.length === 0 ? 1 : passedCount / checks.length,
    checks,
  };
}

// ── Fallback rule inference ────────────────────────────────────
//
// When a test has no declarative `validation` block, infer a minimal set
// from the goal/expected-outcome text. Keeps us from trusting the model
// blindly even for older tests.

const URL_HINT_RE = /(navigate|redirect|land).*?([/a-zA-Z0-9_-]+)/i;
const TEXT_HINT_RE = /(?:should\s+(?:see|show|display)|verify)\s+["']?([A-Za-z][A-Za-z0-9 _-]{2,40})["']?/i;

export function inferValidationRules(
  expectedOutcome: string,
  finalUrl?: string,
): ValidationRule[] {
  const rules: ValidationRule[] = [];
  if (!expectedOutcome) return rules;

  // Heuristic 1: if the outcome mentions a URL path, check it
  const urlMatch = expectedOutcome.match(URL_HINT_RE);
  if (urlMatch && urlMatch[2] && urlMatch[2].startsWith('/')) {
    rules.push({ type: 'url', value: urlMatch[2], label: 'inferred-url' });
  } else if (finalUrl && finalUrl.includes('://')) {
    // Fallback: assume the run should have stayed on the test's host
    try {
      const host = new URL(finalUrl).hostname;
      if (host) rules.push({ type: 'url', value: host, label: 'inferred-host' });
    } catch {}
  }

  // Heuristic 2: pull one text phrase out of phrases like
  //   "the user should see 'Welcome'" or "verify Dashboard"
  const textMatch = expectedOutcome.match(TEXT_HINT_RE);
  if (textMatch && textMatch[1]) {
    rules.push({ type: 'text', value: textMatch[1].trim(), label: 'inferred-text' });
  }

  return rules;
}

// ── Compact log formatter ──────────────────────────────────────

export function formatValidation(v: ValidationResult): string {
  if (v.checks.length === 0) return '[validation] no rules defined — model verdict accepted';
  const pctLabel = `${(v.score * 100).toFixed(0)}%`;
  const lines = [`[validation] ${v.passed ? 'PASSED' : 'FAILED'} (${v.checks.filter(c => c.passed).length}/${v.checks.length}, ${pctLabel})`];
  for (const c of v.checks) {
    lines.push(`  ${c.passed ? '✓' : '✗'} ${c.rule.type} "${c.rule.value}" — ${c.detail || ''}`);
  }
  return lines.join('\n');
}
