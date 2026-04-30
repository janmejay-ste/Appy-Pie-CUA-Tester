// ── Constraint effectiveness tracking ──────────────────────────
//
// Every Constraint has a stable `id` (see decision-engine.ts constraintId()).
// When GPT's chosen action is emitted, the loop records whether that action
// RESPECTED the constraint (didn't match it) or VIOLATED it (matched anyway).
// When the following action resolves, the loop also records whether the
// constraint LED TO PROGRESS (action changed DOM/URL) or NOT.
//
// Aggregated over enough samples, this reveals:
//   - BAD constraints: GPT respects them but progress stalls → the constraint
//     is blocking the correct path. Auto-disabled after hitting thresholds.
//   - GOOD constraints: GPT respects them and progress follows → keep.
//
// Metrics are persisted to data/cache/constraint-metrics.json so they
// accumulate across runs. This is effectively a lightweight reinforcement
// signal without being a full learning loop.

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const METRICS_DIR = path.resolve(process.cwd(), 'data', 'cache');
const METRICS_FILE = path.join(METRICS_DIR, 'constraint-metrics.json');

export type ConstraintStatus = 'active' | 'disabled' | 'probation';

export interface ConstraintRecord {
  id: string;
  /** How many times this constraint was emitted in a prompt. */
  uses: number;
  /** Of those, how many times the chosen action respected it. */
  respected: number;
  /** Of those, how many respected decisions led to progress (effective action after). */
  respectedAndProgressed: number;
  /** How many respected decisions were followed by a no-progress action. */
  respectedAndStalled: number;
  /** How many times the chosen action violated the constraint (constraint failed). */
  violated: number;
  /** Manually / auto-disabled — skip emitting this constraint next time. */
  disabled: boolean;
  /**
   * Status lifecycle (supersedes `disabled`, but `disabled` is kept for wire-compat):
   *   active     → constraint is emitted normally
   *   disabled   → not emitted; may be promoted to probation after cooldown
   *   probation  → re-emitted for a small number of trials to re-verify
   */
  status?: ConstraintStatus;
  /** Epoch ms of disable event — used for probation promotion after cooldown. */
  disabledAt?: number;
  /** Counter during probation. On promotion we reset to 0. */
  probationUses?: number;
  /** Progressed count accumulated since this constraint was most recently promoted. */
  probationProgressed?: number;
  /** Epoch ms of the last time this constraint was emitted. */
  lastSeen: number;
}

// Probation thresholds — tuned conservatively.
const PROBATION_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const PROBATION_TRIAL_USES = 5;                        // min trials before re-judging
const PROBATION_PROGRESS_FLOOR = 0.4;                  // effectiveScore threshold
// Confidence smoothing (P2): effectiveScore = progressRate × (trials / (trials + 5))
// With 5 trials at 60% progress, effectiveScore = 0.6 × (5/10) = 0.30 → not reactivated.
// With 15 trials at 60% progress, effectiveScore = 0.6 × (15/20) = 0.45 → reactivated.
// Prevents lucky-streak false positives; requires sustained signal.
const PROBATION_CONFIDENCE_PRIOR = 5;

/**
 * Bucket-level outcome record. Buckets are formed by the SET of constraints
 * co-emitted on a turn: bucketId = hash(sorted constraint IDs).
 *
 * Why: when N constraints fire together, attributing each turn's outcome to
 * each of the N is biased — a good outcome would credit ALL of them, even
 * the ones that didn't actually help. We need a counterfactual.
 *
 * Bucket baseline gives one: the average progress rate observed when that
 * EXACT set of constraints fired together. A constraint's true contribution
 * is its progress rate MINUS the bucket baseline (relative lift).
 *
 * In practice, with limited samples, we use bucket prefix-hash modulo a small
 * number (16) so similar constraint sets share buckets — keeps the math
 * stable without needing huge data.
 */
export interface BucketRecord {
  bucketId: string;
  uses: number;
  progressed: number;
}

interface MetricsFile {
  version: 2;
  constraints: Record<string, ConstraintRecord>;
  buckets: Record<string, BucketRecord>;
}

let cache: MetricsFile | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): MetricsFile {
  if (cache) return cache;
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
      // v1 → v2 migration: add empty buckets dict.
      if (raw && raw.version === 1) {
        cache = { version: 2, constraints: raw.constraints ?? {}, buckets: {} };
        scheduleSave();
        return cache!;
      }
      if (raw && raw.version === 2) {
        cache = raw;
        return cache!;
      }
    }
  } catch {}
  cache = { version: 2, constraints: {}, buckets: {} };
  return cache;
}

function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty || !cache) return;
    try {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
      fs.writeFileSync(METRICS_FILE, JSON.stringify(cache, null, 2));
      dirty = false;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[constraint-metrics] Failed to save');
    }
  }, 10000);
}

function ensure(id: string): ConstraintRecord {
  const c = load();
  if (!c.constraints[id]) {
    c.constraints[id] = {
      id,
      uses: 0,
      respected: 0,
      respectedAndProgressed: 0,
      respectedAndStalled: 0,
      violated: 0,
      disabled: false,
      status: 'active',
      lastSeen: Date.now(),
    };
  }
  // Backfill status on legacy records that predate this field.
  const entry = c.constraints[id];
  if (!entry.status) entry.status = entry.disabled ? 'disabled' : 'active';
  return entry;
}

/** Record that the constraint was emitted in a prompt (one per turn per constraint). */
export function recordConstraintUse(id: string): void {
  const entry = ensure(id);
  entry.uses++;
  entry.lastSeen = Date.now();
  if (entry.status === 'probation') entry.probationUses = (entry.probationUses ?? 0) + 1;
  scheduleSave();
}

/** The action GPT chose respected this constraint (didn't collide with it). */
export function recordConstraintRespected(id: string): void {
  ensure(id).respected++;
  scheduleSave();
}

/** The action GPT chose violated this constraint (matched it anyway). */
export function recordConstraintViolated(id: string): void {
  ensure(id).violated++;
  scheduleSave();
}

/** After the action ran, did the page actually make progress? */
export function recordConstraintOutcome(id: string, progressed: boolean): void {
  const entry = ensure(id);
  if (progressed) {
    entry.respectedAndProgressed++;
    if (entry.status === 'probation') entry.probationProgressed = (entry.probationProgressed ?? 0) + 1;
  } else {
    entry.respectedAndStalled++;
  }
  scheduleSave();
}

/** Returns true if this constraint should be skipped in prompts. */
export function isConstraintDisabled(id: string): boolean {
  const c = load().constraints[id];
  if (!c) return false;
  // Probation entries ARE emitted (that's how we collect trial data).
  // Only 'disabled' hides them.
  return (c.status ?? (c.disabled ? 'disabled' : 'active')) === 'disabled';
}

/**
 * Auto-disable + probation lifecycle.
 *
 * 1. ACTIVE → DISABLED: constraint has ≥10 uses, ≥5 respected, >70% stall rate.
 * 2. DISABLED → PROBATION: cooldown of 3 days since disabledAt has elapsed.
 *    Counters are NOT reset (we want the historical context) but probation-
 *    scoped counters track ONLY post-promotion behavior.
 * 3. PROBATION → ACTIVE: ≥PROBATION_TRIAL_USES uses AND progress rate ≥ floor.
 * 4. PROBATION → DISABLED: ≥PROBATION_TRIAL_USES uses AND progress rate < floor.
 *
 * Conditions change over time (UI redesigns, new flows) so a rule that
 * hurt yesterday may help today. Probation prevents permanent dead zones.
 */
export function autoDisableBadConstraints(
  opts?: { globalProgressRate?: number },
): { disabled: string[]; promoted: string[]; reactivated: string[] } {
  const c = load();
  const disabled: string[] = [];
  const promoted: string[] = [];
  const reactivated: string[] = [];
  const now = Date.now();

  for (const entry of Object.values(c.constraints)) {
    const status: ConstraintStatus = entry.status ?? (entry.disabled ? 'disabled' : 'active');

    // 1. ACTIVE → DISABLED
    if (status === 'active') {
      if (entry.uses < 10 || entry.respected < 5) continue;
      const stallRate = entry.respectedAndStalled / Math.max(1, entry.respected);

      // Bucket baseline: only disable if stall rate is bad AND lift is non-positive.
      // This prevents disabling constraints that look bad in absolute terms but
      // are actually performing better than peers in the same co-emission context.
      // Pass globalProgressRate so lift is normalized — prevents "good in a
      // failing system" false positives.
      const lift = getConstraintLift(entry.id, { globalProgressRate: opts?.globalProgressRate });
      const liftSaysBad = lift === null ? true : lift <= 0;

      if (stallRate > 0.7 && liftSaysBad) {
        entry.status = 'disabled';
        entry.disabled = true;            // keep legacy flag in sync
        entry.disabledAt = now;
        entry.probationUses = 0;
        entry.probationProgressed = 0;
        disabled.push(entry.id);
      }
      continue;
    }

    // 2. DISABLED → PROBATION after cooldown
    if (status === 'disabled') {
      const disabledAt = entry.disabledAt ?? now;
      if (now - disabledAt >= PROBATION_COOLDOWN_MS) {
        entry.status = 'probation';
        entry.disabled = false;           // allow re-emission during probation
        entry.probationUses = 0;
        entry.probationProgressed = 0;
        promoted.push(entry.id);
      }
      continue;
    }

    // 3 & 4. PROBATION → ACTIVE | DISABLED
    // Confidence-weighted: small sample sizes get shrunk toward zero so
    // a 3-of-5 lucky streak doesn't false-positive a bad constraint back
    // into rotation. effectiveScore = rate × (trials / (trials + prior)).
    if (status === 'probation') {
      const trials = entry.probationUses ?? 0;
      if (trials < PROBATION_TRIAL_USES) continue;
      const progressRate = (entry.probationProgressed ?? 0) / trials;
      const confidence = trials / (trials + PROBATION_CONFIDENCE_PRIOR);
      const effectiveScore = progressRate * confidence;
      if (effectiveScore >= PROBATION_PROGRESS_FLOOR) {
        entry.status = 'active';
        entry.disabled = false;
        entry.disabledAt = undefined;
        reactivated.push(entry.id);
      } else {
        entry.status = 'disabled';
        entry.disabled = true;
        entry.disabledAt = now;           // reset the cooldown clock
      }
    }
  }

  if (disabled.length || promoted.length || reactivated.length) {
    scheduleSave();
    logger.warn(
      { disabled, promoted, reactivated },
      '[constraint-metrics] Constraint lifecycle transitions',
    );
  }
  return { disabled, promoted, reactivated };
}

// ── Bucket baseline (PR A: relative-lift attribution) ─────────
//
// The set of constraints emitted on a turn forms a bucket. Bucket-level
// outcome counters give us a baseline progress rate to subtract from each
// constraint's raw rate — yielding "lift" rather than raw attribution.
//
// Bucket size is bounded by hashing the sorted constraint IDs and taking
// modulo BUCKET_SHARDS so similar sets collapse into the same bucket. This
// keeps sample counts meaningful without requiring exact-match buckets.

const BUCKET_SHARDS = 16;

export function bucketIdForConstraints(ids: string[]): string {
  if (ids.length === 0) return 'empty';
  const sorted = [...ids].sort();
  let h = 0;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return `b${Math.abs(h) % BUCKET_SHARDS}`;
}

function ensureBucket(bucketId: string): BucketRecord {
  const c = load();
  if (!c.buckets[bucketId]) {
    c.buckets[bucketId] = { bucketId, uses: 0, progressed: 0 };
  }
  return c.buckets[bucketId];
}

/** Record one turn's bucket-level outcome. Call ONCE per turn (not per constraint). */
export function recordBucketOutcome(constraintIds: string[], progressed: boolean): void {
  if (constraintIds.length === 0) return;
  const bucket = ensureBucket(bucketIdForConstraints(constraintIds));
  bucket.uses++;
  if (progressed) bucket.progressed++;
  scheduleSave();
}

/**
 * Compute a constraint's TRUE contribution: its progress rate minus the
 * baseline progress rate of the buckets it participated in, NORMALIZED
 * against the global progress rate to prevent the "good in a bad system"
 * illusion.
 *
 * Without normalization: if every bucket performs poorly (baseline=0.1), a
 * constraint at 0.25 looks great (lift=+0.15) even though the system is
 * failing overall.
 *
 * With normalization: adjustedLift = rawLift × (baseline / globalRate).
 * When the baseline is well below global, we shrink the apparent lift
 * because the "win" is measured in a degraded context.
 *
 * Returns null when sample sizes aren't large enough to be meaningful.
 */
export function getConstraintLift(
  id: string,
  opts?: { globalProgressRate?: number },
): number | null {
  const entry = load().constraints[id];
  if (!entry || entry.respected < 5) return null;
  const ownRate = entry.respectedAndProgressed / entry.respected;

  // Baseline = average progress rate across ALL buckets (a lightweight prior).
  // A future PR can compute the per-bucket baseline that matches this constraint's
  // co-emission set; for now the global mean is the cheapest unbiased estimator.
  const buckets = Object.values(load().buckets).filter(b => b.uses >= 5);
  if (buckets.length === 0) return null;
  const totalUses = buckets.reduce((s, b) => s + b.uses, 0);
  const totalProgressed = buckets.reduce((s, b) => s + b.progressed, 0);
  const baseline = totalProgressed / Math.max(1, totalUses);

  const rawLift = ownRate - baseline;

  // Normalize against global progress rate (if provided and > 0). Shrinks
  // the lift when the local baseline is much worse than system-wide progress
  // — stops us rewarding constraints for being "best of a bad bunch".
  const globalRate = opts?.globalProgressRate;
  if (typeof globalRate === 'number' && globalRate > 0.01) {
    const normFactor = Math.min(1, baseline / globalRate);
    return rawLift * normFactor;
  }
  return rawLift;
}

/** Snapshot for logs / dashboards. */
export function getConstraintMetrics(): ConstraintRecord[] {
  return Object.values(load().constraints).sort((a, b) => b.uses - a.uses);
}

export function getBucketMetrics(): BucketRecord[] {
  return Object.values(load().buckets).sort((a, b) => b.uses - a.uses);
}

process.on('exit', () => {
  if (dirty && cache) {
    try {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
      fs.writeFileSync(METRICS_FILE, JSON.stringify(cache, null, 2));
    } catch {}
  }
});
