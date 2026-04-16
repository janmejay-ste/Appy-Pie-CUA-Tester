// ── ActionStep.target helpers ───────────────────────────────────
// Unifies the legacy-string and structured-object shapes for ActionStep.target.
// The CUA loop + action engine consume ActionTarget objects; the LLM may still
// emit a bare string for a transition period — coerceLegacyTarget normalizes
// at the parser boundary so downstream code never sees a string.

import type { IndexedElement } from './types.js';

export interface ActionTarget {
  elementId?: string;     // stable hash (primary)
  text?: string;          // visible text fallback
  domPath?: string;       // CSS/XPath escape hatch
  index?: number;         // positional fallback within matches
}

export type ActionTargetLike = ActionTarget | string | undefined;

const LEGACY_PLACEHOLDERS = new Set(['none', 'null', 'undefined', '']);

/**
 * Normalize any legacy-string or object target into a canonical ActionTarget.
 * - undefined / empty / "none" / "null" → undefined
 * - 6–12 char hex-ish string → { elementId }
 * - any other string → { text }
 * - object → passthrough (keys with empty-string values are dropped)
 */
export function coerceLegacyTarget(raw: unknown): ActionTarget | undefined {
  if (raw == null) return undefined;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || LEGACY_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
    // Stable elementIds are 6–12 chars hex-ish (md5 prefix). If it matches, treat as ID.
    if (/^[a-f0-9]{6,12}$/i.test(trimmed) || /^e\d+$/.test(trimmed)) {
      return { elementId: trimmed };
    }
    return { text: trimmed };
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const target: ActionTarget = {};
    if (typeof obj.elementId === 'string' && obj.elementId.trim()) target.elementId = obj.elementId.trim();
    if (typeof obj.text === 'string' && obj.text.trim()) target.text = obj.text.trim();
    if (typeof obj.domPath === 'string' && obj.domPath.trim()) target.domPath = obj.domPath.trim();
    if (typeof obj.index === 'number' && Number.isFinite(obj.index)) target.index = obj.index;
    return Object.keys(target).length > 0 ? target : undefined;
  }

  return undefined;
}

/**
 * Return the stable elementId when available, otherwise the text/domPath,
 * otherwise a placeholder. Used in log messages, SSE events, memory strings.
 */
export function targetToDisplay(target: ActionTargetLike): string {
  if (target == null) return '(none)';
  if (typeof target === 'string') return target || '(none)';
  if (target.elementId) return target.elementId;
  if (target.text) return target.text.slice(0, 40);
  if (target.domPath) return target.domPath.slice(0, 60);
  if (target.index != null) return `#${target.index}`;
  return '(none)';
}

/**
 * Extract the stable elementId if present, otherwise undefined.
 * Used when downstream code specifically needs the hash (cache lookups, dedup signatures).
 */
export function targetElementId(target: ActionTargetLike): string | undefined {
  if (target == null) return undefined;
  if (typeof target === 'string') {
    const coerced = coerceLegacyTarget(target);
    return coerced?.elementId;
  }
  return target.elementId;
}

/**
 * Find the IndexedElement this target resolves to in the given browser state.
 * Priority: elementId → index (e0, e1…) → domPath (not implemented) → text match.
 */
export function resolveTargetElement(
  target: ActionTargetLike,
  elements: IndexedElement[],
): IndexedElement | null {
  const canonical = typeof target === 'string' ? coerceLegacyTarget(target) : target;
  if (!canonical) return null;

  if (canonical.elementId) {
    const exact = elements.find(el => el.elementId === canonical.elementId);
    if (exact) return exact;
    const indexMatch = canonical.elementId.match(/^e(\d+)$/);
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10);
      return elements[idx] || null;
    }
  }

  if (typeof canonical.index === 'number') {
    return elements[canonical.index] || null;
  }

  if (canonical.text) {
    const needle = canonical.text.toLowerCase().trim();
    if (needle.length >= 2) {
      const exactText = elements.find(el => (el.text || '').toLowerCase().trim() === needle);
      if (exactText) return exactText;
      const contains = elements.find(el => (el.text || '').toLowerCase().includes(needle));
      if (contains) return contains;
    }
  }

  return null;
}

/**
 * True if two targets refer to the same element (for repeat detection).
 */
export function targetsEqual(a: ActionTargetLike, b: ActionTargetLike): boolean {
  const aId = targetElementId(a);
  const bId = targetElementId(b);
  if (aId && bId) return aId === bId;
  const aDisplay = targetToDisplay(a);
  const bDisplay = targetToDisplay(b);
  return aDisplay === bDisplay && aDisplay !== '(none)';
}
