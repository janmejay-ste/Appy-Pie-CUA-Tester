import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * Action Cache v2 — two-tier caching for CUA loop speedup.
 *
 * Tier 1: Single-action cache (per page state)
 *   Key = hash(URL pattern + page title)  — stable across DOM re-renders
 *   Value = best action for that page state
 *
 * Tier 2: Sequence cache (multi-action flows)
 *   Key = hash(URL pattern + page title)
 *   Value = ordered action sequence that succeeded end-to-end
 *   Used to replay entire flows (login, form fill) without any GPT calls
 *
 * Target matching: stored by text + tag (not elementId) for cross-run stability.
 */

// ── Types ──────────────────────────────────────────────────────

export interface CachedAction {
  action: string;       // click, type, select, etc.
  targetText: string;   // visible text of target element (for re-matching)
  targetTag: string;    // tag name of target element
  value: string;        // typed text, selected option, etc.
  confidence: number;   // original model confidence
}

interface CachedSingleAction extends CachedAction {
  successCount: number;
  failureCount: number;     // ← NEW: entry is deleted when this reaches MAX_FAILURES_BEFORE_DELETE
  lastUsed: number;
  urlPattern: string;
  description: string;
}

export interface CachedSequence {
  actions: CachedAction[];
  successCount: number;
  failureCount: number;          // resets on successful re-recording (current run streak)
  totalHistoricalFailures: number; // never resets — drives escalating cooldowns
  lastUsed: number;
  disabledUntil?: number; // soft-disable: epoch ms after which the sequence is eligible again
  urlPattern: string;
  pageTitle: string;
  description: string;  // e.g. "login flow", "form fill: 5 fields"
  /** Weakest validation confidence across all actions in the sequence at record time. */
  confidenceLevel?: 'strong' | 'medium' | 'weak';
}

interface ActionCacheV2 {
  version: 2;
  singles: Record<string, CachedSingleAction>;     // page key → single action
  sequences: Record<string, CachedSequence>;        // page key → action sequence
}

// ── Config ─────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'action-cache-v2.json');
const MAX_SINGLE_ENTRIES = 1000;
const MAX_SEQUENCE_ENTRIES = 200;
const MIN_CONFIDENCE = 0.80;           // lowered from 0.85 — more actions get cached
const MIN_SUCCESS_TO_USE_SINGLE = 3;   // ← raised from 1 — proven-3x before replaying from cache
const MIN_SUCCESS_TO_USE_SEQUENCE = 1; // sequences are high-value, trust after 1
const MAX_FAILURES_BEFORE_DELETE = 2;  // drop single-action entry after 2 effective-failures
const MAX_SEQUENCE_FAILURES_BEFORE_DISABLE = 2; // soft-disable sequence after 2 replay failures in a streak
const SEQUENCE_COOLDOWN_BASE_MS = 5 * 60 * 1000;  // 5 min base; doubles per totalHistoricalFailures tier
const SEQUENCE_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000; // 24h cap — after this, sequence is effectively dead
const STALE_DAYS = 30;                 // raised from 7 — cache lasts longer
const MAX_SEQUENCE_LENGTH = 8;         // don't cache huge sequences
// Confidence scoring thresholds for sequence classification (Fix 5 — named, not magic numbers).
// Empirical tuning guidance: if sequences classified 'strong' still fail often, raise the threshold;
// if too few sequences qualify as 'strong', lower it. Start values calibrated for typical web flows.
const CONFIDENCE_STRONG_THRESHOLD = 0.9; // weighted-avg score → 'strong' (~90% of actions must be strong)
const CONFIDENCE_MEDIUM_THRESHOLD = 0.7; // weighted-avg score → 'medium'; below → 'weak'
// Loop guard: how long to block the same sequence from re-replaying (prevents SPA-sequence loops).
const SEQUENCE_REPLAY_COOLDOWN_MS = 30_000; // 30s — long enough to survive a SPA turn cycle

let cache: ActionCacheV2 | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirCreated = false;

// ── Per-run volatile state ──────────────────────────────────────
// These are reset at the start of each test run (via resetRunVolatileState).
// NOT persisted to disk — they exist only to guard against intra-run replay loops.

/** Timestamp of the last replay per sequence key — time-based cooldown. */
const _sequenceLastReplayedAt = new Map<string, number>();
/**
 * DOM fingerprint at the time the sequence was last replayed.
 * If the fingerprint is the same on the next lookup, the sequence had no effect — disable it.
 * Time-based cooldown alone is insufficient: same DOM 31s later still means no progress.
 */
const _sequenceReplayDomState = new Map<string, string>();

/**
 * Shadow-stat tracker: records weak-confidence signal count AND last timestamp per url+action key.
 * Storing the timestamp lets us discount stale signals — an action that was flaky 20 minutes
 * ago but succeeded reliably since then should not still be penalised today.
 */
const _shadowStats = new Map<string, { count: number; lastTs: number }>();

/** Signals older than this are considered stale and discounted (not removed — still observable). */
const SHADOW_RECENCY_MS = 10 * 60 * 1000; // 10 minutes

/** Reset per-run volatile state. Call at run start alongside resetOverlayStreak(). */
export function resetSequenceReplayGuard(): void {
  _sequenceLastReplayedAt.clear();
  _sequenceReplayDomState.clear();
}

/** Reset shadow stats (per-run). */
export function resetShadowStats(): void {
  _shadowStats.clear();
}

/**
 * Return shadow patterns that fired 3+ times this run AND whose last signal is recent
 * (within SHADOW_RECENCY_MS). Stale patterns are excluded — an action that was flaky
 * ten minutes ago but succeeded cleanly since then should not surface as a warning.
 */
export function getShadowPatterns(): Array<{ key: string; count: number }> {
  const now = Date.now();
  return [..._shadowStats.entries()]
    .filter(([, stat]) => stat.count >= 3 && now - stat.lastTs <= SHADOW_RECENCY_MS)
    .map(([key, stat]) => ({ key, count: stat.count }))
    .sort((a, b) => b.count - a.count);
}

// ── Sequence health helpers ─────────────────────────────────────

function sequenceHealth(seq: CachedSequence): number {
  // Weight successCount by confidence quality: strong=1.0, medium=0.8, weak=0.5.
  // Sequences built on weak heuristics score lower and are replaced more easily.
  const confWeight = seq.confidenceLevel === 'strong' ? 1.0
    : seq.confidenceLevel === 'weak' ? 0.5
    : 0.8; // 'medium' or legacy entries without confidenceLevel
  return (seq.successCount * confWeight) - (seq.failureCount * 2);
}

function sequenceCooldownMs(totalHistoricalFailures: number): number {
  // Exponential backoff: 5m → 10m → 20m → ... capped at 24h
  const exponent = Math.max(0, totalHistoricalFailures - MAX_SEQUENCE_FAILURES_BEFORE_DISABLE);
  return Math.min(SEQUENCE_COOLDOWN_BASE_MS * Math.pow(2, exponent), SEQUENCE_COOLDOWN_MAX_MS);
}

// ── Persistence ────────────────────────────────────────────────

function loadCache(): ActionCacheV2 {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (raw && raw.version === 2) {
        // Backfill failureCount=0 on legacy entries that predate these fields.
        // Additive-only migration — no version bump required.
        for (const entry of Object.values(raw.singles || {}) as CachedSingleAction[]) {
          if (typeof entry.failureCount !== 'number') entry.failureCount = 0;
        }
        for (const entry of Object.values(raw.sequences || {}) as CachedSequence[]) {
          if (typeof entry.failureCount !== 'number') entry.failureCount = 0;
          if (typeof entry.totalHistoricalFailures !== 'number') entry.totalHistoricalFailures = entry.failureCount;
          if (!entry.confidenceLevel) entry.confidenceLevel = 'medium'; // legacy entries treated as medium
        }
        cache = raw;
        return cache!;
      }
    }
    // Try migrating v1 cache
    const v1File = path.join(CACHE_DIR, 'action-cache.json');
    if (fs.existsSync(v1File)) {
      const v1 = JSON.parse(fs.readFileSync(v1File, 'utf-8'));
      if (v1 && v1.entries) {
        // Migrate v1 entries to v2 singles
        const singles: Record<string, CachedSingleAction> = {};
        for (const [key, entry] of Object.entries(v1.entries) as any[]) {
          singles[key] = {
            action: entry.action,
            targetText: entry.target,  // v1 stored elementId, keep as-is for backwards compat
            targetTag: '',             // unknown in v1
            value: entry.value || '',
            confidence: entry.confidence || 0.9,
            successCount: entry.successCount || 1,
            failureCount: 0,
            lastUsed: entry.lastUsed || Date.now(),
            urlPattern: entry.urlPattern || '',
            description: entry.description || '',
          };
        }
        cache = { version: 2, singles, sequences: {} };
        logger.info({ migrated: Object.keys(singles).length }, '[cache] Migrated v1 cache to v2');
        scheduleSave();
        return cache;
      }
    }
  } catch {}
  cache = { version: 2, singles: {}, sequences: {} };
  return cache;
}

function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty || !cache) return;
    try {
      if (!dirCreated) { fs.mkdirSync(CACHE_DIR, { recursive: true }); dirCreated = true; }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      dirty = false;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[cache] Failed to save');
    }
  }, 10000);
}

process.on('exit', () => {
  if (dirty && cache) {
    try {
      if (!dirCreated) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch {}
  }
});

// ── Key Generation ─────────────────────────────────────────────

function normalizeUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/\/[a-f0-9]{24,}/g, '/*')     // MongoDB IDs
      .replace(/\/[a-z0-9]{20,}/g, '/*')     // generic long IDs
      .replace(/\/\d+/g, '/#');               // numeric IDs
  } catch {
    return url;
  }
}

function normalizeTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[-–—|:]/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Heuristic overlay detection for cache-key state — stable & cheap. Looks
 * for typical modal/dialog signatures in the indexed elements. Not exhaustive
 * (the DOM extractor itself has richer signals via BrowserState.hasOverlay)
 * but sufficient for a coarse cache-key discriminator.
 */
function detectRawOverlay(elements: DOMElement[]): boolean {
  for (const e of elements) {
    const tag = (e.tag || '').toLowerCase();
    const text = (e.text || '').toLowerCase();
    if (tag === 'dialog') return true;
    if (text.includes('close') && text.length < 30) {
      // "X close" / "Close" buttons are modal-adjacent heuristics
      return true;
    }
  }
  return false;
}

// ── Transient overlay filter (PR B) ───────────────────────────
// A modal that only flashes for 1 turn (e.g. loading spinner) shouldn't
// fragment cache keys. Track consecutive sightings — only treat as "real"
// overlay state after it's been visible for ≥2 consecutive calls.
let overlaySightingStreak = 0;
const OVERLAY_PERSISTENCE_THRESHOLD = 2;

function detectOverlayFromElements(elements: DOMElement[]): boolean {
  const raw = detectRawOverlay(elements);
  if (raw) {
    overlaySightingStreak++;
  } else {
    overlaySightingStreak = 0;
  }
  return overlaySightingStreak >= OVERLAY_PERSISTENCE_THRESHOLD;
}

/** Reset transient-overlay streak — called at loop start. */
export function resetOverlayStreak(): void {
  overlaySightingStreak = 0;
}

/**
 * Page key: stable across DOM re-renders.
 * Based on URL pattern + page title (what the user sees, not element IDs).
 *
 * Optional state discriminators (PR P3) add context awareness — same URL
 * can exist in multiple states (logged-in vs not, modal-open vs not,
 * step 1 vs step 3). Including coarse state signals in the hash prevents
 * cross-state cache pollution.
 *
 * Stability guarantee: the state params are bucketed/thresholded so
 * within-session noise (±1 element from rendering artifacts) produces
 * the same key. Only MEANINGFUL state differences change the key.
 */
export interface PageKeyState {
  /** Count of interactive elements, bucketed to nearest 10. */
  elementCount?: number;
  /** true if a modal/dialog overlay was detected on the page. */
  hasOverlay?: boolean;
  /**
   * Stable 6-char hash of the top-2 primary buttons/CTAs on the page.
   * PR B-v2 discriminator — prevents bucket collision when two different
   * states coincidentally share the same element-count bucket. The CTA set
   * is what makes a page visually and functionally distinct.
   */
  primaryCTAHash?: string;
}

/**
 * Compute the primary-CTA hash from elements. Picks top-2 button-like items
 * by text length + tag priority, joins their normalized text, hashes. Stable
 * across re-renders (text is DOM-extracted, not index-dependent).
 */
export function computePrimaryCTAHash(elements: DOMElement[]): string {
  const buttons = elements
    .filter(e => {
      const tag = (e.tag || '').toLowerCase();
      return tag === 'button' || tag === 'a' || tag === 'submit';
    })
    .filter(e => (e.text || '').length >= 2 && (e.text || '').length <= 40)
    .slice(0, 2)
    .map(e => (e.text || '').trim().toLowerCase())
    .sort();
  if (buttons.length === 0) return '';
  let h = 0;
  const s = buttons.join('|');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 6).padStart(6, '0');
}

export function generatePageKey(
  url: string,
  title: string,
  state?: PageKeyState,
): string {
  const urlPattern = normalizeUrlPattern(url);
  const normTitle = normalizeTitle(title);
  // State suffix: empty when no state provided → identical hash to legacy key.
  // Bucket element count to nearest 10 (coarser than original /5) to prevent
  // over-fragmentation. A single logical page rarely has 10-element variance
  // between renders, but a real state change (step 1 vs step 3) typically
  // shifts element count by ≥10.
  //
  // primaryCTAHash (PR B-v2) is an additional discriminator for when two
  // different states happen to share the same element-count bucket but have
  // different primary actions — e.g. "Continue" vs "Submit" at turn 3 vs 5.
  let stateSuffix = '';
  if (state) {
    const bucket = typeof state.elementCount === 'number'
      ? Math.round(state.elementCount / 10) * 10
      : '';
    const overlay = state.hasOverlay ? '1' : '0';
    const cta = state.primaryCTAHash || '';
    if (bucket !== '' || overlay !== '0' || cta) {
      stateSuffix = `||e=${bucket}|o=${overlay}|c=${cta}`;
    }
  }
  const raw = `${urlPattern}||${normTitle}${stateSuffix}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

/**
 * Legacy element-based key (kept for backward compatibility with v1 entries).
 */
export function generateElementKey(url: string, elements: Array<{ tag: string; text: string; elementId: string }>): string {
  const urlPattern = normalizeUrlPattern(url);
  const sig = elements.slice(0, 10)
    .map(e => `${e.tag}:${(e.text || '').slice(0, 20)}`)
    .sort()
    .join('|');
  const raw = `${urlPattern}||${sig}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

// ── Target Resolution ──────────────────────────────────────────

export interface DOMElement {
  tag: string;
  text: string;
  elementId: string;
  placeholder?: string;
  type?: string;
  isVisible?: boolean;      // from IndexedElement — present when called from adapter
  isInteractable?: boolean; // from IndexedElement — present when called from adapter
}

/**
 * Resolve a cached target (text + tag) to a current DOM element.
 * Returns the elementId if found, null otherwise.
 *
 * Matching strategy (in priority order):
 * 1. Exact text + tag match
 * 2. Text contains/contained-in match + same tag
 * 3. Text fuzzy match (case-insensitive, trimmed) + same tag
 */
export function resolveTarget(
  targetText: string,
  targetTag: string,
  elements: DOMElement[],
): string | null {
  if (!targetText && !targetTag) return null;

  const normTarget = targetText.toLowerCase().trim();

  // 1. Exact match
  for (const el of elements) {
    if (el.tag === targetTag && el.text.toLowerCase().trim() === normTarget) {
      return el.elementId;
    }
  }

  // 2. Contains match (either direction) — same tag
  if (normTarget.length > 3) {
    for (const el of elements) {
      if (el.tag !== targetTag) continue;
      const elText = el.text.toLowerCase().trim();
      if (elText.includes(normTarget) || normTarget.includes(elText)) {
        return el.elementId;
      }
    }
  }

  // 3. Placeholder match (for input fields)
  if (targetTag === 'input' || targetTag === 'textarea') {
    for (const el of elements) {
      if (el.tag !== targetTag) continue;
      const ph = (el.placeholder || '').toLowerCase().trim();
      if (ph && (ph.includes(normTarget) || normTarget.includes(ph))) {
        return el.elementId;
      }
    }
  }

  // 4. Any tag, exact text (fallback for tag mismatches)
  for (const el of elements) {
    if (el.text.toLowerCase().trim() === normTarget) {
      return el.elementId;
    }
  }

  return null;
}

// ── Single Action Cache ────────────────────────────────────────

const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Look up a cached single action for the given page.
 * Tries page key (URL+title) first, falls back to element key.
 */
export function getCachedAction(
  url: string,
  title: string,
  elements: DOMElement[],
): (CachedSingleAction & { resolvedTarget: string | null }) | null {
  const c = loadCache();

  // State-aware page key (P3): two states of the same URL produce different
  // keys so cache doesn't leak across e.g. logged-in vs logged-out, modal
  // open vs not, step 1 vs step 3.
  const pageState: PageKeyState = {
    elementCount: elements.length,
    hasOverlay: detectOverlayFromElements(elements),
    primaryCTAHash: computePrimaryCTAHash(elements),
  };
  const pageKey = generatePageKey(url, title, pageState);

  // Per-page tier — pages with healthy local cache stay at 'full' even when
  // global health is poor; pages with rotten local cache get stricter floors.
  if (tierForPage(pageKey, url) === 'disabled') return null;

  let entry = c.singles[pageKey];

  // Fallback 1: state-agnostic key (legacy entries written before P3).
  if (!entry) {
    const legacyKey = generatePageKey(url, title);
    entry = c.singles[legacyKey];
  }

  // Fallback 2: element-based key (backward compat with v1 cache)
  if (!entry) {
    const elKey = generateElementKey(url, elements);
    entry = c.singles[elKey];
  }

  if (!entry) return null;
  const floor = effectiveSuccessFloorForPage(pageKey, url);
  if (entry.successCount < floor) {
    incrementCacheReject('lowSuccess');
    return null;
  }
  if ((entry.failureCount ?? 0) >= MAX_FAILURES_BEFORE_DELETE) {
    // Entry exceeded failure budget — evict and refuse replay.
    incrementCacheReject('tooManyFailures');
    delete c.singles[pageKey];
    scheduleSave();
    return null;
  }
  if (Date.now() - entry.lastUsed > staleMs) {
    incrementCacheReject('stale');
    delete c.singles[pageKey];
    return null;
  }

  // Shadow downgrade: if this url+action has produced 3+ *recent* weak-confidence signals
  // this run, it is a repeatedly unreliable target. Require double the normal success count
  // before trusting the cached action — prevents known-flaky actions from replaying.
  // "Recent" = within SHADOW_RECENCY_MS so that actions corrected long ago are not
  // still penalised for an earlier fluke.
  const targetKey = (entry.targetText || '').toLowerCase().slice(0, 30);
  const shadowKey = `${entry.action}:${normalizeUrlPattern(url)}:${targetKey}`;
  const shadowStat = _shadowStats.get(shadowKey);
  const shadowCount = (shadowStat && Date.now() - shadowStat.lastTs <= SHADOW_RECENCY_MS)
    ? shadowStat.count : 0;
  if (shadowCount >= 3) {
    const shadowFloor = effectiveSuccessFloorForPage(pageKey, url) * 2;
    if (entry.successCount < shadowFloor) {
      logger.debug({ tag: 'cache', event: 'shadow-downgrade', shadowKey, shadowCount, required: shadowFloor, have: entry.successCount });
      incrementCacheReject('shadowDowngrade');
      return null;
    }
  }

  // Resolve target text to current DOM elementId
  const resolvedTarget = entry.targetTag
    ? resolveTarget(entry.targetText, entry.targetTag, elements)
    : null; // v1 migrated entry — targetText is already elementId

  incrementCacheHit('single');
  return { ...entry, resolvedTarget };
}

/**
 * Record a successful single action.
 * validationConfidence='weak' actions are not recorded — heuristic signals
 * cannot be trusted as ground truth for cache decisions.
 */
export function recordSuccessfulAction(
  url: string,
  title: string,
  elements: DOMElement[],
  action: { action: string; target: string; value: string; confidence: number },
  description: string,
  effective: boolean,
  validationConfidence?: 'strong' | 'medium' | 'weak',
): void {
  if (!effective) return;
  if (validationConfidence === 'weak') {
    // Shadow-log: preserve the observation for diagnostics but don't cache it.
    // UI timing issues and partial DOM updates produce weak signals that can
    // harden into strong evidence on retry — discarding them silently loses that signal.
    const targetKey = (action.target || '').toLowerCase().slice(0, 30);
    const shadowKey = `${action.action}:${normalizeUrlPattern(url)}:${targetKey}`;
    const existing = _shadowStats.get(shadowKey);
    const shadowCount = (existing?.count ?? 0) + 1;
    _shadowStats.set(shadowKey, { count: shadowCount, lastTs: Date.now() });
    if (shadowCount >= 3) {
      // Repeated weak signal on the same url+action — likely a UI timing/flicker issue.
      // Surface as warn so it's visible in logs without being buried in debug noise.
      logger.warn({ tag: 'cache', event: 'shadow-pattern', shadowKey, count: shadowCount, reason: 'repeatedWeakSignal — possible UI timing issue or wrong target' });
    } else {
      logger.debug({ tag: 'cache', event: 'shadow', action: action.action, url, confidence: action.confidence, count: shadowCount });
    }
    return;
  }
  if (action.confidence < MIN_CONFIDENCE) return;
  if (action.action === 'wait' || action.action === 'done') return;

  // Don't cache homepage actions — the homepage is a critical decision point
  // where the AI must evaluate test step progress, not replay cached nav
  const urlPat = normalizeUrlPattern(url);
  if (urlPat === '/' || urlPat === '') return;

  const c = loadCache();
  // Record with STATEFUL key so we don't pollute a different state's cache.
  const pageState: PageKeyState = {
    elementCount: elements.length,
    hasOverlay: detectOverlayFromElements(elements),
    primaryCTAHash: computePrimaryCTAHash(elements),
  };
  const pageKey = generatePageKey(url, title, pageState);
  const urlPattern = normalizeUrlPattern(url);

  // Find target element to store text+tag
  const targetEl = elements.find(e => e.elementId === action.target);
  const targetText = targetEl?.text || action.target;
  const targetTag = targetEl?.tag || '';

  const existing = c.singles[pageKey];
  if (existing && existing.action === action.action && existing.targetText === targetText) {
    existing.successCount++;
    existing.failureCount = 0;   // success resets the failure streak
    existing.lastUsed = Date.now();
    existing.confidence = Math.max(existing.confidence, action.confidence);
  } else {
    c.singles[pageKey] = {
      action: action.action,
      targetText,
      targetTag,
      value: action.value || '',
      confidence: action.confidence,
      successCount: 1,
      failureCount: 0,
      lastUsed: Date.now(),
      urlPattern,
      description,
    };
  }

  evictSingles(c);
  scheduleSave();
  incrementCacheRecord('success');
}

/**
 * Penalize a failed cached action. Increments failureCount; deletes the entry
 * when it reaches MAX_FAILURES_BEFORE_DELETE.
 */
export function recordFailedAction(
  url: string,
  title: string,
  elements?: DOMElement[],
): void {
  const c = loadCache();
  // Try stateful key first (matches how getCachedAction looked it up), then
  // fall back to the legacy key for old entries.
  const tryKeys: string[] = [];
  if (elements && elements.length > 0) {
    tryKeys.push(generatePageKey(url, title, {
      elementCount: elements.length,
      hasOverlay: detectOverlayFromElements(elements),
    }));
  }
  tryKeys.push(generatePageKey(url, title));

  let entry: CachedSingleAction | undefined;
  let hitKey = '';
  for (const k of tryKeys) {
    if (c.singles[k]) { entry = c.singles[k]; hitKey = k; break; }
  }
  if (!entry) return;
  entry.failureCount = (entry.failureCount ?? 0) + 1;
  if (entry.failureCount >= MAX_FAILURES_BEFORE_DELETE) {
    delete c.singles[hitKey];
  }
  scheduleSave();
  incrementCacheRecord('failure');
}

function evictSingles(c: ActionCacheV2): void {
  const keys = Object.keys(c.singles);
  if (keys.length > MAX_SINGLE_ENTRIES) {
    const sorted = keys.sort((a, b) => (c.singles[a].lastUsed || 0) - (c.singles[b].lastUsed || 0));
    for (let i = 0; i < sorted.length - MAX_SINGLE_ENTRIES; i++) {
      delete c.singles[sorted[i]];
    }
  }
}

// ── Sequence Cache ─────────────────────────────────────────────

/**
 * Look up a cached action sequence for the current page.
 * Returns ordered actions to replay, or null.
 *
 * Sequences use a stateless key (url+title only). Unlike single-action cache,
 * sequences represent full flows that must apply regardless of minor page-state
 * variance. Target resolution (resolveTarget) acts as the applicability gate.
 */
export function getCachedSequence(
  url: string,
  title: string,
  elements: DOMElement[],
  progressSignature?: string,
): { actions: Array<CachedAction & { resolvedTarget: string | null }>; description: string } | null {
  const pageKey = generatePageKey(url, title); // stateless — flow-level, not state-level
  if (tierForPage(pageKey, url) !== 'full') return null;
  const c = loadCache();
  const seq = c.sequences[pageKey];

  if (!seq) return null;
  if (seq.successCount < MIN_SUCCESS_TO_USE_SEQUENCE) {
    logger.debug({ tag: 'seq-cache', event: 'reject', reason: 'lowSuccess', key: pageKey, successCount: seq.successCount });
    return null;
  }
  if (seq.disabledUntil && Date.now() < seq.disabledUntil) {
    logger.info({ tag: 'seq-cache', event: 'reject', reason: 'cooldown', key: pageKey, totalHistoricalFailures: seq.totalHistoricalFailures, resumesAt: new Date(seq.disabledUntil).toISOString() });
    return null;
  }
  if (Date.now() - seq.lastUsed > staleMs) {
    logger.debug({ tag: 'seq-cache', event: 'evict', reason: 'stale', key: pageKey });
    delete c.sequences[pageKey];
    scheduleSave();
    return null;
  }
  // Medium-confidence sequences with any failure are not reliable enough to replay.
  // Strong sequences have deterministic evidence and survive one failure.
  if (seq.confidenceLevel === 'medium' && (seq.failureCount ?? 0) > 0) {
    logger.info({ tag: 'seq-cache', event: 'reject', reason: 'mediumConfidenceWithFailure', key: pageKey, failureCount: seq.failureCount });
    return null;
  }
  // Loop guard — two layers:
  // Layer 1 (state): if the semantic progress signature (url + visible headings) is identical
  // to when this sequence last ran, the sequence made no meaningful progress. This is a stronger
  // signal than a raw DOM hash: URL + key headings reflects what the user actually sees, not
  // ephemeral rendering artifacts. Same signature after replay → disable with cooldown.
  if (progressSignature) {
    const lastSig = _sequenceReplayDomState.get(pageKey);
    if (lastSig !== undefined && lastSig === progressSignature) {
      seq.failureCount = (seq.failureCount ?? 0) + 1;
      seq.totalHistoricalFailures = (seq.totalHistoricalFailures ?? 0) + 1;
      const cooldown = sequenceCooldownMs(seq.totalHistoricalFailures);
      if (seq.failureCount >= MAX_SEQUENCE_FAILURES_BEFORE_DISABLE) {
        seq.disabledUntil = Date.now() + cooldown;
        logger.warn({ tag: 'seq-cache', event: 'state-loop-disable', key: pageKey, reason: 'same progress signature after replay — sequence had no semantic effect', progressSignature, cooldownMin: Math.round(cooldown / 60_000), totalHistoricalFailures: seq.totalHistoricalFailures });
      } else {
        logger.info({ tag: 'seq-cache', event: 'state-loop-penalize', key: pageKey, failureCount: seq.failureCount, progressSignature });
      }
      scheduleSave();
      return null;
    }
  }
  // Layer 2 (time): block fast re-replay even when progressSignature is not available.
  const nowMs = Date.now();
  const lastReplay = _sequenceLastReplayedAt.get(pageKey);
  if (lastReplay !== undefined && nowMs - lastReplay < SEQUENCE_REPLAY_COOLDOWN_MS) {
    logger.debug({ tag: 'seq-cache', event: 'reject', reason: 'recentReplay', key: pageKey, cooldownRemainMs: SEQUENCE_REPLAY_COOLDOWN_MS - (nowMs - lastReplay) });
    return null;
  }

  // Resolve all targets — if ANY required target can't be found or looks non-interactable, reject.
  // Also strip wait/scroll from stored sequences (legacy entries may contain them).
  const resolved: Array<CachedAction & { resolvedTarget: string | null }> = [];
  for (const a of seq.actions.filter(a => a.action !== 'wait' && a.action !== 'scroll')) {
    const resolvedTarget = resolveTarget(a.targetText, a.targetTag, elements);
    const needsTarget = ['click', 'type', 'select', 'keypress'].includes(a.action);
    if (needsTarget && !resolvedTarget) {
      logger.info({ tag: 'seq-cache', event: 'reject', reason: 'targetMiss', key: pageKey, missingTarget: a.targetText, action: a.action });
      return null;
    }
    // Interactability gate: reject sequence if the resolved element is known to be
    // non-visible or non-interactable (uses adapter-supplied fields when available,
    // falls back to text/tag heuristic for older call sites).
    if (resolvedTarget && needsTarget) {
      const el = elements.find(e => e.elementId === resolvedTarget);
      if (el) {
        const interactable =
          el.isInteractable !== undefined ? el.isInteractable :
          el.isVisible !== undefined ? el.isVisible :
          // Heuristic fallback when adapter fields absent: inputs/textareas/selects
          // are always candidates; others need visible text.
          el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select' ||
          (el.text || '').trim().length > 0 || (el.placeholder || '').trim().length > 0;
        if (!interactable) {
          logger.info({ tag: 'seq-cache', event: 'reject', reason: 'notInteractable', key: pageKey, targetTag: el.tag, targetText: a.targetText });
          return null;
        }
      }
    }
    resolved.push({ ...a, resolvedTarget });
  }

  // Mark replay state before returning so both guards fire on the NEXT lookup.
  _sequenceLastReplayedAt.set(pageKey, Date.now());
  if (progressSignature) {
    _sequenceReplayDomState.set(pageKey, progressSignature);
  }
  logger.info({ tag: 'seq-cache', event: 'hit', key: pageKey, description: seq.description, actions: seq.actions.length, successCount: seq.successCount, confidenceLevel: seq.confidenceLevel });
  incrementCacheHit('sequence');
  return { actions: resolved, description: seq.description };
}

/**
 * Record a successful action sequence for future replay.
 * Called after a batch of actions all succeeded on a page.
 *
 * Sequences are stored under a stateless key (url+title only) so they are
 * found by getCachedSequence regardless of minor page-state variation between
 * runs. Target resolution inside getCachedSequence is the applicability gate.
 */
export function recordSequence(
  url: string,
  title: string,
  rawActions: Array<{ action: string; targetText: string; targetTag: string; value: string; confidence: number; validationConfidence?: 'strong' | 'medium' | 'weak' }>,
  description: string,
  elements?: DOMElement[], // kept for API compat — no longer used for key generation
): void {
  // Strip wait/scroll — timing artifacts that cause replay loops (e.g. login stuck on wait 0ms).
  const actions = rawActions.filter(a => a.action !== 'wait' && a.action !== 'scroll');
  if (actions.length < 2 || actions.length > MAX_SEQUENCE_LENGTH) return;
  if (actions.some(a => a.confidence < MIN_CONFIDENCE)) return;
  // Fix 1: reject sequences with any weak-confidence action — heuristic evidence
  // poisons the replay cache and was the original cause of corrupt recordings.
  if (actions.some(a => a.validationConfidence === 'weak')) {
    logger.debug({ tag: 'seq-cache', event: 'skip', reason: 'weakConfidence', url });
    return;
  }
  // Derive weakest confidence level to store on the sequence (used by sequenceHealth weighting).
  // Fix 3: weighted-average confidence instead of min.
  // Min penalizes the entire sequence for one uncertain action (e.g. 5 strong + 1 medium → medium).
  // Average is fairer: mostly-strong sequences stay 'strong' even with one medium step.
  // Thresholds: >= 0.9 → strong (requires ~90% strong actions), >= 0.7 → medium, else weak.
  // Actions without validationConfidence (legacy callers) contribute as 'medium' (0.8).
  const confScore = actions.reduce((sum, a) => {
    const w = a.validationConfidence === 'strong' ? 1.0
      : a.validationConfidence === 'medium' ? 0.8
      : 0.8; // no validationConfidence = treat as medium (legacy callers, weak already blocked)
    return sum + w;
  }, 0) / actions.length;
  // Fix 4: adaptive thresholds — when the cache is degraded (many entries failing), the system
  // needs MORE alternatives, not fewer. Lower the 'strong' bar so more sequences survive
  // as 'strong' and get one extra failure tolerance before being discarded.
  // WRONG direction (old): failure ↑ → threshold ↑ → fewer 'strong' → more rigidity → more loops.
  // CORRECT direction: failure ↑ → threshold ↓ → more 'strong' → more alternatives → recovery.
  const health = getCacheHealth();
  const failureRatio = health.total > 0 ? health.rejectedTooManyFailures / health.total : 0;
  const thresholdAdjust = failureRatio > 0.3 ? -0.05 : 0; // LOWER bar when >30% entries are failing
  const adaptiveStrong = Math.max(0.80, CONFIDENCE_STRONG_THRESHOLD + thresholdAdjust);
  const confidenceLevel: 'strong' | 'medium' | 'weak' =
    confScore >= adaptiveStrong ? 'strong'
    : confScore >= CONFIDENCE_MEDIUM_THRESHOLD ? 'medium'
    : 'weak';

  const c = loadCache();
  const pageKey = generatePageKey(url, title); // stateless — matches getCachedSequence
  const urlPattern = normalizeUrlPattern(url);

  const existing = c.sequences[pageKey];
  if (existing && existing.actions.length === actions.length) {
    // Same page, same length — reinforce. Clear current-run failure streak and cooldown,
    // but preserve totalHistoricalFailures so escalating cooldowns remain in effect.
    existing.successCount++;
    existing.failureCount = 0;
    existing.disabledUntil = undefined;
    existing.lastUsed = Date.now();
    existing.actions = actions;
    existing.confidenceLevel = confidenceLevel; // update to reflect latest recording's quality
    logger.info({ tag: 'seq-cache', event: 'reinforce', key: pageKey, successCount: existing.successCount, totalHistoricalFailures: existing.totalHistoricalFailures, confidenceLevel, description });
  } else {
    const existingHealth = existing ? sequenceHealth(existing) : -Infinity;
    if (existing && existingHealth > 1) {
      // Healthy sequence (health score > 1 = net positive record). Protect from
      // replacement by a weaker first-time recording.
      logger.info({ tag: 'seq-cache', event: 'overwrite-blocked', key: pageKey, health: existingHealth, newLength: actions.length });
    } else {
      // No existing sequence, or existing is degraded (health <= 1) — allow fresh recording.
      c.sequences[pageKey] = {
        actions,
        successCount: 1,
        failureCount: 0,
        totalHistoricalFailures: existing?.totalHistoricalFailures ?? 0, // carry forward history
        lastUsed: Date.now(),
        urlPattern,
        pageTitle: normalizeTitle(title),
        description,
        confidenceLevel,
      };
      logger.info({ tag: 'seq-cache', event: 'record', key: pageKey, actions: actions.length, totalHistoricalFailures: existing?.totalHistoricalFailures ?? 0, confidenceLevel, description });
    }
  }

  evictSequences(c);
  scheduleSave();
}

/**
 * Penalize a failed sequence (e.g., one of the actions in the sequence failed on replay).
 */
export function recordFailedSequence(url: string, title: string, elements?: DOMElement[]): void {
  const c = loadCache();
  const pageKey = generatePageKey(url, title); // stateless — matches recordSequence/getCachedSequence
  const seq = c.sequences[pageKey];
  if (seq) {
    seq.failureCount = (seq.failureCount ?? 0) + 1;
    seq.totalHistoricalFailures = (seq.totalHistoricalFailures ?? 0) + 1;
    if (seq.failureCount >= MAX_SEQUENCE_FAILURES_BEFORE_DISABLE) {
      // Exponential soft-disable: cooldown doubles with each historical failure tier.
      // totalHistoricalFailures never resets, so repeated bad sequences get longer
      // cooldowns even after a temporary recovery.
      const cooldown = sequenceCooldownMs(seq.totalHistoricalFailures);
      seq.disabledUntil = Date.now() + cooldown;
      logger.warn({
        tag: 'seq-cache', event: 'soft-disable', key: pageKey,
        failureCount: seq.failureCount, totalHistoricalFailures: seq.totalHistoricalFailures,
        cooldownMin: Math.round(cooldown / 60000), resumesAt: new Date(seq.disabledUntil).toISOString(),
        description: seq.description,
      });
    } else {
      logger.info({ tag: 'seq-cache', event: 'penalize', key: pageKey, failureCount: seq.failureCount, totalHistoricalFailures: seq.totalHistoricalFailures, description: seq.description });
    }
    scheduleSave();
  }
}

function evictSequences(c: ActionCacheV2): void {
  const keys = Object.keys(c.sequences);
  if (keys.length > MAX_SEQUENCE_ENTRIES) {
    const sorted = keys.sort((a, b) => (c.sequences[a].lastUsed || 0) - (c.sequences[b].lastUsed || 0));
    for (let i = 0; i < sorted.length - MAX_SEQUENCE_ENTRIES; i++) {
      delete c.sequences[sorted[i]];
    }
  }
}

// ── Stats ──────────────────────────────────────────────────────

export function getCacheStats(): { singles: number; sequences: number; totalHits: number } {
  const c = loadCache();
  const singles = Object.keys(c.singles).length;
  const sequences = Object.keys(c.sequences).length;
  const totalHits =
    Object.values(c.singles).reduce((sum, e) => sum + e.successCount, 0) +
    Object.values(c.sequences).reduce((sum, e) => sum + e.successCount, 0);
  return { singles, sequences, totalHits };
}

// ── Health snapshot (observability for the decision path) ──────
//
// Returns a breakdown of what's in the cache and why entries are (or aren't)
// usable. Call this once per run on loop-start so we can tell at a glance
// whether the cache is healthy or slowly degrading.
export interface CacheHealthStats {
  total: number;               // all single entries on disk
  usable: number;              // singles that pass ALL eligibility checks
  rejectedLowSuccess: number;  // successCount < MIN_SUCCESS_TO_USE_SINGLE
  rejectedTooManyFailures: number; // failureCount >= MAX_FAILURES_BEFORE_DELETE
  rejectedStale: number;       // lastUsed older than STALE_DAYS
  sequences: number;           // sequence-cache size
  lifetimeHits: number;        // sum of all successCount (singles + sequences)
}

export function getCacheHealth(): CacheHealthStats {
  const c = loadCache();
  const entries = Object.values(c.singles);
  const nowStale = Date.now() - staleMs;

  let usable = 0;
  let rejectedLowSuccess = 0;
  let rejectedTooManyFailures = 0;
  let rejectedStale = 0;

  for (const e of entries) {
    if (e.lastUsed < nowStale) { rejectedStale++; continue; }
    if ((e.failureCount ?? 0) >= MAX_FAILURES_BEFORE_DELETE) { rejectedTooManyFailures++; continue; }
    if (e.successCount < MIN_SUCCESS_TO_USE_SINGLE) { rejectedLowSuccess++; continue; }
    usable++;
  }

  const lifetimeHits =
    entries.reduce((s, e) => s + e.successCount, 0) +
    Object.values(c.sequences).reduce((s, e) => s + e.successCount, 0);

  return {
    total: entries.length,
    usable,
    rejectedLowSuccess,
    rejectedTooManyFailures,
    rejectedStale,
    sequences: Object.keys(c.sequences).length,
    lifetimeHits,
  };
}

// ── Graded per-page cache control ──────────────────────────────
//
// Cache health is now computed PER PAGE. A page where every entry is
// well-proven keeps tier=full even when other pages are at tier=strict.
// This stops cross-page contamination — bad cache for /signup doesn't
// poison decisions for /pricing.
//
// Global aggregate is still computed once at loop start (logging only).
// Per-page tier is computed lazily on first read for that pageKey and
// memoized for the duration of the run.
//
// Tier semantics (unchanged):
//   full      ≥ 80% usable on this page    floor = MIN (3)
//   cautious  50–80%                       floor = 5
//   strict    20–50%                       floor = 8
//   disabled  < 20%                        no cache reads

export type CacheTier = 'full' | 'cautious' | 'strict' | 'disabled';

const HEALTH_MIN_ENTRIES_PER_PAGE = 3; // sample threshold per page (lower than global)
const TIER_FLOOR_BUMP: Record<CacheTier, number> = {
  full: 0,
  cautious: 2,
  strict: 5,
  disabled: Number.POSITIVE_INFINITY,
};

// Aggregate fallback when a page has too few entries to grade independently.
let runGlobalTier: CacheTier = 'full';
let runGlobalTierReason: string | null = null;

// Per-page tier cache for the current run. Keyed by generatePageKey() output.
const perPageTier = new Map<string, CacheTier>();

function classifyHealth(usability: number): CacheTier {
  if (usability >= 0.8) return 'full';
  if (usability >= 0.5) return 'cautious';
  if (usability >= 0.2) return 'strict';
  return 'disabled';
}

/**
 * Compute per-page health from currently-loaded cache entries that share
 * the same pageKey or normalized urlPattern. Lazy & memoized for the run.
 */
function tierForPage(pageKey: string, url: string): CacheTier {
  const cached = perPageTier.get(pageKey);
  if (cached) return cached;

  const c = loadCache();
  const urlPat = normalizeUrlPattern(url);

  // Find all entries whose urlPattern matches (peer entries on this page).
  const peers = Object.values(c.singles).filter(e => e.urlPattern === urlPat);
  if (peers.length < HEALTH_MIN_ENTRIES_PER_PAGE) {
    perPageTier.set(pageKey, runGlobalTier);
    return runGlobalTier;
  }

  const nowStale = Date.now() - staleMs;
  let usable = 0;
  for (const e of peers) {
    if (e.lastUsed < nowStale) continue;
    if ((e.failureCount ?? 0) >= MAX_FAILURES_BEFORE_DELETE) continue;
    if (e.successCount < MIN_SUCCESS_TO_USE_SINGLE) continue;
    usable++;
  }
  const tier = classifyHealth(usable / peers.length);
  perPageTier.set(pageKey, tier);
  return tier;
}

/**
 * Called once at loop start. Sets the per-run AGGREGATE tier (used as fallback
 * for pages with too few entries) and resets per-page memoization.
 */
export function maybeDisableCacheForRun(): { disabled: boolean; tier: CacheTier; reason?: string } {
  perPageTier.clear();
  const health = getCacheHealth();
  if (health.total < 5) {
    runGlobalTier = 'full';
    runGlobalTierReason = null;
    return { disabled: false, tier: 'full' };
  }
  const usability = health.usable / health.total;
  runGlobalTier = classifyHealth(usability);
  runGlobalTierReason = `${(usability * 100).toFixed(0)}% usable (${health.usable}/${health.total} entries) → global tier=${runGlobalTier} (per-page tiers may differ)`;
  return {
    disabled: runGlobalTier === 'disabled',
    tier: runGlobalTier,
    reason: runGlobalTierReason,
  };
}

export function getRunCacheTier(): CacheTier {
  return runGlobalTier;
}

export function isRunCacheDisabled(): boolean {
  // Used by callers without page context — return global tier disabled state.
  return runGlobalTier === 'disabled';
}

export function getRunCacheDisabledReason(): string | null {
  return runGlobalTierReason;
}

/** Effective successCount floor for a specific page. */
function effectiveSuccessFloorForPage(pageKey: string, url: string): number {
  return MIN_SUCCESS_TO_USE_SINGLE + TIER_FLOOR_BUMP[tierForPage(pageKey, url)];
}

// ── Per-run hit / reject counters ──────────────────────────────
//
// Tracked in-memory for the duration of a run. Call resetRunCacheCounters()
// at loop-start, then the get/record helpers below update it as turns fire.
// The loop reads these at run-end and includes them in the run log.
export interface RunCacheCounters {
  hitsSingle: number;
  hitsSequence: number;
  rejects: {
    lowSuccess: number;
    tooManyFailures: number;
    stale: number;
    loopGuard: number;     // consecutiveCacheHits hit MAX
    afterGPT: number;      // lastTurnWasGPT skip
    notEligible: number;   // mode / failures / stuckContext
    shadowDowngrade: number; // repeated weak-confidence signals downgraded the entry
  };
  recordedSuccess: number;
  recordedFailure: number;
}

let runCounters: RunCacheCounters = freshCounters();

function freshCounters(): RunCacheCounters {
  return {
    hitsSingle: 0,
    hitsSequence: 0,
    rejects: { lowSuccess: 0, tooManyFailures: 0, stale: 0, loopGuard: 0, afterGPT: 0, notEligible: 0, shadowDowngrade: 0 },
    recordedSuccess: 0,
    recordedFailure: 0,
  };
}

export function resetRunCacheCounters(): void {
  runCounters = freshCounters();
}

export function getRunCacheCounters(): RunCacheCounters {
  return runCounters;
}

export function incrementCacheHit(kind: 'single' | 'sequence'): void {
  if (kind === 'single') runCounters.hitsSingle++;
  else runCounters.hitsSequence++;
}

export function incrementCacheReject(reason: keyof RunCacheCounters['rejects']): void {
  runCounters.rejects[reason]++;
}

export function incrementCacheRecord(kind: 'success' | 'failure'): void {
  if (kind === 'success') runCounters.recordedSuccess++;
  else runCounters.recordedFailure++;
}
