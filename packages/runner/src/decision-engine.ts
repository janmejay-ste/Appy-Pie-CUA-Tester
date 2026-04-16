// ── DecisionEngine ──────────────────────────────────────────────
// Single-candidate decision pipeline extracted from cua-loop.ts.
//
// For each turn the engine resolves in order:
//   1. Batch queue  — queued action from a previous multi-action GPT response
//   2. Sequence cache — replay an entire proven flow (no GPT call)
//   3. Single cache  — replay a proven single action (no GPT call)
//   4. null          — caller must fall through to GPT
//
// The GPT call itself is NOT yet extracted from cua-loop.ts; this engine only
// handles the cache/batch path. Once callers are migrated this class can grow
// a decide() method that wraps the GPT path too.

import type { ActionStep, BrowserState } from './adapter/types.js';
import {
  getCachedAction,
  getCachedSequence,
  type DOMElement,
} from './action-cache.js';
import { isConstraintDisabled, recordConstraintUse } from './constraint-metrics.js';

export type DecisionSource = 'batch-queue' | 'cache-sequence' | 'cache-single' | 'gpt-needed';

/**
 * Per-constraint severity. STRONG = hard failure; MEDIUM = no effect;
 * WEAK = informational / historical. The prompt renders these in priority
 * tiers so GPT understands which to avoid hardest.
 */
export type ConstraintSeverity = 'strong' | 'medium' | 'weak';

/**
 * Reason the constraint exists. Used for observability + effectiveness tracking.
 */
export type ConstraintReason = 'failed' | 'no_effect' | 'loop' | 'visited';

/**
 * A single constraint. Each has a stable ID so effectiveness can be tracked
 * across runs (see constraint-metrics.ts).
 */
export interface Constraint {
  /** sha1(type + value).slice(0,10) — stable across runs for metrics. */
  id: string;
  type: 'avoid_action_target' | 'avoid_target' | 'avoid_url';
  /** Human-readable value — e.g. "click a1b2c3" or "/customeditor/..." */
  value: string;
  severity: ConstraintSeverity;
  reason: ConstraintReason;
  /** Turn number when this constraint was created (for decay ranking). */
  turn: number;
}

/**
 * Constraints the loop derives from recent history & failures. Passed through
 * Perception so the engine (and GPT, once it lives here) can make repetition-
 * aware decisions without re-deriving them per turn.
 *
 * Also serializable into the GPT prompt so the model is told explicitly what
 * NOT to try — which eliminates a big class of post-GPT loop-guard interventions.
 */
export interface DecisionConstraints {
  /** All constraints this turn, already ranked + capped. See buildConstraints. */
  list: Constraint[];
  /** Current goal from the model's last emitted next_goal. */
  goal: string;
}

// Diversity-aware cap. Two-pass:
//   Pass 1: take TOP-K per type so each constraint category has guaranteed
//           coverage — prevents 6 dropdown constraints crowding out URL/avoid_target.
//   Pass 2: fill remaining global slots by ranked priority (severity + recency).
//
// Total cap = MAX_GLOBAL ensures the prompt budget stays bounded regardless
// of how many types contribute.
const MIN_PER_TYPE = 2;
const MAX_GLOBAL = 12;

function severityScore(s: ConstraintSeverity): number {
  return s === 'strong' ? 3 : s === 'medium' ? 2 : 1;
}

function rankConstraints(list: Constraint[]): Constraint[] {
  return [...list].sort((a, b) =>
    severityScore(b.severity) - severityScore(a.severity) || b.turn - a.turn,
  );
}

// Temporal buckets for diversity — "recent/mid/older" relative to current turn.
// Forces the cap to keep some historical context instead of overfitting to
// the last 2 turns. `turn` on each constraint is its origin turn.
function timeBucketRelative(constraint: Constraint, currentTurn: number): 'recent' | 'mid' | 'older' {
  const age = currentTurn - constraint.turn;
  if (age <= 2) return 'recent';
  if (age <= 5) return 'mid';
  return 'older';
}

function capByCategory(list: Constraint[]): Constraint[] {
  if (list.length === 0) return [];
  const ranked = rankConstraints(list);
  const currentTurn = Math.max(...list.map(c => c.turn));

  const byType: Record<Constraint['type'], Constraint[]> = {
    avoid_action_target: [],
    avoid_target: [],
    avoid_url: [],
  };
  for (const c of ranked) byType[c.type].push(c);

  // Pass 1: guaranteed TYPE coverage — top MIN_PER_TYPE from each type.
  const picked: Constraint[] = [];
  const seen = new Set<string>();
  for (const t of ['avoid_action_target', 'avoid_target', 'avoid_url'] as const) {
    for (const c of byType[t].slice(0, MIN_PER_TYPE)) {
      picked.push(c);
      seen.add(c.id);
    }
  }

  // Pass 2: guaranteed TEMPORAL coverage — at least one from each time
  // bucket (recent / mid / older) when available. Prevents the cap from
  // overfitting to the last 2 turns and losing useful historical context.
  const byBucket: Record<'recent' | 'mid' | 'older', Constraint[]> = {
    recent: [], mid: [], older: [],
  };
  for (const c of ranked) byBucket[timeBucketRelative(c, currentTurn)].push(c);
  for (const b of ['recent', 'mid', 'older'] as const) {
    const first = byBucket[b].find(c => !seen.has(c.id));
    if (first) {
      picked.push(first);
      seen.add(first.id);
      if (picked.length >= MAX_GLOBAL) break;
    }
  }

  // Pass 3: fill remaining global slots by priority across all types.
  for (const c of ranked) {
    if (picked.length >= MAX_GLOBAL) break;
    if (seen.has(c.id)) continue;
    picked.push(c);
    seen.add(c.id);
  }

  // Final stable ordering: by type (matches prompt grouping), then by rank.
  return [
    ...picked.filter(c => c.type === 'avoid_action_target'),
    ...picked.filter(c => c.type === 'avoid_target'),
    ...picked.filter(c => c.type === 'avoid_url'),
  ];
}

// Stable-ish ID used for cross-run effectiveness metrics. Lightweight hash —
// collisions are acceptable (effectiveness is advisory, not correctness-critical).
function constraintId(type: Constraint['type'], value: string): string {
  let h = 0;
  const s = `${type}|${value}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 10).padStart(10, '0');
}

/** Context passed in on every turn. */
export interface Perception {
  state: BrowserState;
  turn: number;
  pendingBatchActions: ActionStep[];

  // Mode / failure counters — cache is skipped under many of these.
  mode: 'DOM_NORMAL' | 'DOM_WITH_VISION' | 'VISION_BURST';
  stuckContextActive: boolean;
  consecutiveFailures: number;
  consecutiveCacheHits: number;
  lastTurnWasGPT: boolean;
  maxConsecutiveCacheHits: number;

  /** Repetition/loop constraints derived from history + stuckContext. */
  constraints: DecisionConstraints;
}

/** Result of a cache / batch-queue decision. */
export interface CacheDecision {
  action: ActionStep;
  source: DecisionSource;
  confidence: number;
  description: string;
  // When the source is cache-sequence, the remaining actions are returned so
  // the loop can enqueue them as the batch queue for the following turns.
  sequenceRemainder?: ActionStep[];
  // Echoed back so the loop can update its internal counters consistently.
  nextConsecutiveCacheHits: number;
  // When a cache single is chosen, the underlying entry metadata is forwarded
  // for the loop's own recordSuccessfulAction call after execution.
  singleMeta?: {
    action: string;
    target: string;
    value: string;
    confidence: number;
    resolvedTargetText: string;
  };
}

/** Signal that the caller must run the GPT path to produce an action. */
export interface NeedsGPTDecision {
  action: null;
  source: 'gpt-needed';
  reason: 'no-batch-no-cache' | 'loop-guard' | 'after-gpt' | 'not-eligible';
}

/** The engine called GPT (via injected deps) and it returned a usable action. */
export interface GPTDecision {
  action: ActionStep;
  source: 'gpt';
  confidence: number;
  /** Remaining actions from a multi-action GPT response — loop queues these. */
  queuedBatch: ActionStep[];
  /** Token usage reported by the OpenAI API for this call. */
  tokens: { input: number; output: number; reasoning: number; latencyMs: number };
  /** Raw model text for logging. */
  responseText: string;
  /** Top-level meta emitted by the model (memory, next_goal, verdict, …). */
  meta: Record<string, unknown>;
  /** How many retries the engine performed before this success (0..MAX). */
  retriesUsed: number;
}

/** GPT orchestration dependencies — the loop injects how to talk to OpenAI. */
export interface DecideDeps {
  /**
   * Perform ONE GPT call and return the parsed response. The engine calls
   * this up to maxAttempts times on parse failure. `attempt` starts at 0.
   * `previousResponseText` is non-empty on retries so the caller can inject
   * a "last response was invalid, try again" repair hint.
   */
  callGPT: (ctx: {
    perception: Perception;
    attempt: number;
    previousResponseText?: string;
  }) => Promise<{
    responseText: string;
    parsed: {
      actions: ActionStep[];
      meta: Record<string, unknown>;
    } | null;
    tokens: { input: number; output: number; reasoning: number; latencyMs: number };
  }>;
  maxAttempts?: number;     // default 3
}

export type Decision = CacheDecision | NeedsGPTDecision | GPTDecision;

export class DecisionEngine {
  /**
   * Single entry point for every turn's decision.
   *
   * Behavior:
   *   1. Check cache/batch-queue first. If hit, return CacheDecision.
   *   2. Otherwise, if `deps.callGPT` is provided, orchestrate the GPT call
   *      with retries on parse failure. Return GPTDecision on success.
   *   3. If no deps are provided (e.g. tests), return NeedsGPTDecision so
   *      caller can fall back to legacy inline GPT handling.
   *
   * The engine owns retry logic for JSON-parse failures. Token accounting
   * is returned as data; the LOOP emits SSE callbacks (clean separation —
   * engine decides, loop reports).
   */
  async decide(p: Perception, deps?: DecideDeps): Promise<Decision> {
    const cache = this.decideFromCache(p);
    if (cache) return cache;

    // No GPT deps injected — fall back to legacy signal so existing callers
    // (or tests that only care about cache decisions) keep working.
    if (!deps) {
      return {
        action: null,
        source: 'gpt-needed',
        reason: this.describeCacheSkip(p),
      };
    }

    // Orchestrate GPT with retries. Token usage accumulates across attempts
    // so the caller records the FULL cost, not just the last successful one.
    const maxAttempts = deps.maxAttempts ?? 3;
    let lastText = '';
    let totalTokens = { input: 0, output: 0, reasoning: 0, latencyMs: 0 };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { responseText, parsed, tokens } = await deps.callGPT({
        perception: p,
        attempt,
        previousResponseText: attempt === 0 ? undefined : lastText,
      });
      totalTokens = {
        input: totalTokens.input + tokens.input,
        output: totalTokens.output + tokens.output,
        reasoning: totalTokens.reasoning + tokens.reasoning,
        latencyMs: totalTokens.latencyMs + tokens.latencyMs,
      };
      if (parsed && parsed.actions.length > 0) {
        const first = parsed.actions[0];
        return {
          action: first,
          source: 'gpt',
          confidence: first.confidence ?? 0.9,
          queuedBatch: parsed.actions.slice(1),
          tokens: totalTokens,
          responseText,
          meta: parsed.meta,
          retriesUsed: attempt,
        };
      }
      lastText = responseText;
    }
    // All attempts exhausted. Surface a GPT-needed signal so the loop can
    // fall through to its legacy error-path handling (same as the pre-5b
    // behavior when parseModelJSON returned null).
    return {
      action: null,
      source: 'gpt-needed',
      reason: 'not-eligible',
    };
  }

  private describeCacheSkip(p: Perception): NeedsGPTDecision['reason'] {
    if (p.pendingBatchActions.length > 0) return 'not-eligible';
    if (p.mode !== 'DOM_NORMAL' || p.stuckContextActive || p.consecutiveFailures !== 0) return 'not-eligible';
    if (p.consecutiveCacheHits >= p.maxConsecutiveCacheHits) return 'loop-guard';
    if (p.lastTurnWasGPT) return 'after-gpt';
    return 'no-batch-no-cache';
  }

  /**
   * Resolve the next action from cache / batch queue. Returns null if the
   * caller should fall through to the GPT path. Does NOT mutate perception.
   * Prefer decide() as the public entry point; decideFromCache is kept
   * public so tests can assert cache behavior in isolation.
   */
  decideFromCache(p: Perception): CacheDecision | null {
    // 1. Batch queue — only safe in normal mode without active failures.
    const batchDecision = this.tryBatchQueue(p);
    if (batchDecision) return batchDecision;

    // Gate 2 & 3 on the same criteria: we must not be stuck / failing / hitting
    // the cache too many turns in a row / or immediately following a GPT turn.
    if (!this.cacheEligible(p)) return null;

    const cacheElements: DOMElement[] = p.state.elements.map(e => ({
      tag: e.tag,
      text: e.text,
      elementId: e.elementId,
      placeholder: e.placeholder,
      type: e.type,
    }));
    const pageTitle = p.state.title || '';

    // 2. Sequence cache — replay an entire proven flow.
    const seqDecision = this.trySequenceCache(p, cacheElements, pageTitle);
    if (seqDecision) return seqDecision;

    // 3. Single cache — single proven action.
    const singleDecision = this.trySingleCache(p, cacheElements, pageTitle);
    if (singleDecision) return singleDecision;

    return null;
  }

  // ── Private steps ──────────────────────────────────────────────

  private tryBatchQueue(p: Perception): CacheDecision | null {
    if (p.pendingBatchActions.length === 0) return null;
    if (p.mode !== 'DOM_NORMAL' || p.consecutiveFailures > 0) return null;
    const next = p.pendingBatchActions[0];
    return {
      action: next,
      source: 'batch-queue',
      confidence: next.confidence ?? 0.9,
      description: `queued batch action (${p.pendingBatchActions.length} remaining)`,
      nextConsecutiveCacheHits: p.consecutiveCacheHits,
    };
  }

  private cacheEligible(p: Perception): boolean {
    if (p.pendingBatchActions.length > 0) return false;
    if (p.mode !== 'DOM_NORMAL') return false;
    if (p.stuckContextActive) return false;
    if (p.consecutiveFailures !== 0) return false;
    if (p.consecutiveCacheHits >= p.maxConsecutiveCacheHits) return false;
    if (p.lastTurnWasGPT) return false;
    return true;
  }

  private trySequenceCache(
    p: Perception,
    cacheElements: DOMElement[],
    pageTitle: string,
  ): CacheDecision | null {
    const cachedSeq = getCachedSequence(p.state.url, pageTitle, cacheElements);
    if (!cachedSeq) return null;

    const seqActions: ActionStep[] = cachedSeq.actions.map(a => ({
      action: a.action as any,
      target: a.resolvedTarget || a.targetText,
      value: a.value,
      confidence: a.confidence,
    }));
    return {
      action: seqActions[0],
      source: 'cache-sequence',
      confidence: seqActions[0].confidence ?? 0.9,
      description: `SEQUENCE HIT → "${cachedSeq.description}" (${cachedSeq.actions.length} actions)`,
      sequenceRemainder: seqActions.slice(1),
      nextConsecutiveCacheHits: p.consecutiveCacheHits + 1,
    };
  }

  private trySingleCache(
    p: Perception,
    cacheElements: DOMElement[],
    pageTitle: string,
  ): CacheDecision | null {
    const cachedAction = getCachedAction(p.state.url, pageTitle, cacheElements);
    if (!cachedAction) return null;
    const target = cachedAction.resolvedTarget || cachedAction.targetText;
    const step: ActionStep = {
      action: cachedAction.action as any,
      target,
      value: cachedAction.value,
    };
    return {
      action: step,
      source: 'cache-single',
      confidence: cachedAction.confidence,
      description: `CACHE HIT → ${cachedAction.action} "${cachedAction.targetText}" (${cachedAction.successCount}x success)`,
      nextConsecutiveCacheHits: p.consecutiveCacheHits + 1,
      singleMeta: {
        action: cachedAction.action,
        target,
        value: cachedAction.value,
        confidence: cachedAction.confidence,
        resolvedTargetText: cachedAction.targetText,
      },
    };
  }
}

// Shared singleton — cua-loop.ts creates one per run.
export function createDecisionEngine(): DecisionEngine {
  return new DecisionEngine();
}

/**
 * Serialize DecisionConstraints into a compact, model-friendly block for
 * inclusion in the GPT prompt. Constraints are rendered in severity TIERS so
 * GPT can distinguish what to avoid hardest. Empty tiers are dropped.
 */
export function formatConstraintsForPrompt(c: DecisionConstraints): string {
  if (c.list.length === 0 && !c.goal) return '';

  // Record that each emitted constraint was USED — the effectiveness tracker
  // needs the use-count to compute stall rates later.
  for (const x of c.list) recordConstraintUse(x.id);

  const strong = c.list.filter(x => x.severity === 'strong');
  const medium = c.list.filter(x => x.severity === 'medium');
  const weak = c.list.filter(x => x.severity === 'weak');

  const parts: string[] = [];
  if (strong.length) {
    parts.push('STRONGLY AVOID (hard failures):');
    for (const x of strong) parts.push(`  - ${x.value}`);
  }
  if (medium.length) {
    parts.push('AVOID (no effect on last attempt):');
    for (const x of medium) parts.push(`  - ${x.value}`);
  }
  if (weak.length) {
    parts.push('LOW PRIORITY AVOID:');
    for (const x of weak) parts.push(`  - ${x.value}`);
  }
  if (c.goal) parts.push(`CURRENT GOAL: ${c.goal}`);
  return parts.length > 0 ? `CONSTRAINTS:\n${parts.join('\n')}` : '';
}

/**
 * Build a DecisionConstraints from the loop's live state. Pure function —
 * keep it here so there's ONE place that knows how constraints are derived.
 *
 * Severity assignment:
 *   - STRONG: hard failure (stuckContext.failedActions) — these are actions
 *             the engine explicitly classified as failed.
 *   - MEDIUM: no-effect attempts (history.effective === false) — action ran
 *             but didn't change page state.
 *   - WEAK:   already-visited URLs — historical, advisory only.
 *
 * Each category is capped at MAX_CONSTRAINTS_PER_TYPE after ranking so the
 * prompt doesn't bloat past ~18 lines of CONSTRAINTS block.
 */
export function buildConstraints(params: {
  turn: number;
  recentHistory: Array<{ action: string; target: string; effective: boolean; turn: number }>;
  stuckFailedActions: Array<{ action: string; target: string }>;
  visitedUrlPaths: Iterable<string>;
  goal: string;
  /**
   * PR C: turn number at which the most recent URL change happened. Any
   * constraint whose `turn` is earlier is from a different page and gets
   * dropped — prevents stale-page constraints from polluting decisions.
   * When undefined, no filtering is applied (backward compat).
   */
  lastUrlChangeTurn?: number;
}): DecisionConstraints {
  const list: Constraint[] = [];

  // STRONG: explicit failures (classified NO_EFFECT_WRONG_TARGET / ACTION_FAILED / etc.)
  for (const f of params.stuckFailedActions) {
    if (!f.target) continue;
    const value = `${f.action} ${f.target}`.trim();
    list.push({
      id: constraintId('avoid_action_target', value),
      type: 'avoid_action_target',
      value,
      severity: 'strong',
      reason: 'failed',
      turn: params.turn,
    });
    if (f.target) {
      list.push({
        id: constraintId('avoid_target', f.target),
        type: 'avoid_target',
        value: f.target,
        severity: 'strong',
        reason: 'failed',
        turn: params.turn,
      });
    }
  }

  // MEDIUM: no-effect attempts from recent history (dedup against STRONG).
  const strongSigs = new Set(list.map(c => `${c.type}|${c.value}`));
  for (const h of params.recentHistory) {
    if (h.effective) continue;
    const value = `${h.action} ${h.target}`.trim();
    const key = `avoid_action_target|${value}`;
    if (strongSigs.has(key)) continue;
    list.push({
      id: constraintId('avoid_action_target', value),
      type: 'avoid_action_target',
      value,
      severity: 'medium',
      reason: 'no_effect',
      turn: h.turn,
    });
  }

  // WEAK: visited URL paths — don't navigate back.
  const visitedArr = Array.from(params.visitedUrlPaths);
  for (const p of visitedArr) {
    list.push({
      id: constraintId('avoid_url', p),
      type: 'avoid_url',
      value: p,
      severity: 'weak',
      reason: 'visited',
      turn: params.turn,
    });
  }

  // Filter pipeline:
  //   1. Drop constraints auto-disabled by the metrics layer.
  //   2. (PR C) Drop constraints that predate the last URL change — they
  //      belong to a different page and would just be noise now. avoid_url
  //      constraints are exempt (navigation history IS cross-page info).
  const filtered = list.filter(c => {
    if (isConstraintDisabled(c.id)) return false;
    if (
      typeof params.lastUrlChangeTurn === 'number' &&
      c.turn < params.lastUrlChangeTurn &&
      c.type !== 'avoid_url'
    ) {
      return false;
    }
    return true;
  });

  return {
    list: capByCategory(filtered),
    goal: params.goal || '',
  };
}
