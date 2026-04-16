// ── Composite system-health metric ─────────────────────────────
//
// One number per run that aggregates the three signals we already track
// independently — gives us a single trajectory line to detect degradation
// across runs without hunting through verbose logs.
//
//   systemHealth = 0.4 * progressRate
//                + 0.3 * cacheHitRate
//                + 0.3 * constraintEffectiveness
//
// Range: 0..1. Higher = better.
//
//   progressRate          = effective turns / total turns
//   cacheHitRate          = cache hits / (hits + GPT decisions)
//   constraintEffectiveness = avg(respected→progressed rate across active constraints)
//
// Logged once per run. Persisted via run log so we can plot trajectories.

import fs from 'fs';
import path from 'path';
import { getRunCacheCounters } from './action-cache.js';
import { getConstraintMetrics } from './constraint-metrics.js';
import { logger } from './logger.js';

export interface SystemHealth {
  composite: number;
  progressRate: number;
  cacheHitRate: number;
  constraintEffectiveness: number;
  /** Pre-guardrail composite (before any penalty was applied). */
  compositeRaw: number;
  /** Human-readable warnings emitted by guardrails. */
  warnings: string[];
}

// Hard floor on progressRate. When below this, the composite score is
// penalized so cache/constraint wins can't paper over a system that's
// not making progress. Prevents false confidence.
const PROGRESS_FLOOR = 0.4;
const PROGRESS_PENALTY = 0.7;

// ── EMA-smoothed global progress baseline (PR A) ───────────────
// Persisted across runs so single-run jitter doesn't cause constraint
// lifecycle decisions to oscillate. Stored beside the other cache data.
//
//   smoothed = SMOOTH_ALPHA * prev + (1 - SMOOTH_ALPHA) * current
//
// With alpha=0.7 the smoothed value has ~3-run half-life: a single
// outlier barely moves it, but a sustained shift is reflected within
// ~5 runs.
const SMOOTH_ALPHA = 0.7;
const BASELINE_FILE = path.resolve(process.cwd(), 'data', 'cache', 'health-baseline.json');

interface BaselineFile {
  version: 1;
  smoothedProgressRate: number;
  samplesSeen: number;
  lastUpdated: number;
}

function loadBaseline(): BaselineFile {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
      if (raw && raw.version === 1) return raw;
    }
  } catch {}
  return { version: 1, smoothedProgressRate: 0.5, samplesSeen: 0, lastUpdated: Date.now() };
}

function saveBaseline(b: BaselineFile): void {
  try {
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[system-health] Failed to persist baseline');
  }
}

/** Read-only access to the smoothed baseline — used by constraint metrics. */
export function getSmoothedGlobalProgressRate(): number {
  return loadBaseline().smoothedProgressRate;
}

// Shock detection (PR A-v2): when a single run diverges sharply from the
// smoothed baseline (|delta| > SHOCK_THRESHOLD), the run is treated as a
// regime-change signal — baseline snaps to observed instead of averaging.
// Prevents the EMA from masking sudden UI breaks or backend outages that
// need immediate constraint-lifecycle reaction.
const SHOCK_THRESHOLD = 0.3;

/** Update EMA with this run's observation. Called once per run end. */
export function updateSmoothedGlobalProgressRate(observed: number): void {
  const b = loadBaseline();
  const prevRate = b.smoothedProgressRate;

  // Grace period: for the first 3 runs, accept raw observation.
  if (b.samplesSeen < 3) {
    b.smoothedProgressRate = observed;
  } else if (Math.abs(observed - prevRate) > SHOCK_THRESHOLD) {
    // Shock: abandon smoothing for this transition — regime changed.
    // Log it so operators can correlate with external events.
    b.smoothedProgressRate = observed;
    logger.warn(
      { prevRate, observed, delta: observed - prevRate },
      '[system-health] Shock detected — baseline snapped to observed',
    );
  } else {
    b.smoothedProgressRate = SMOOTH_ALPHA * prevRate + (1 - SMOOTH_ALPHA) * observed;
  }
  b.samplesSeen++;
  b.lastUpdated = Date.now();
  saveBaseline(b);
}

export interface SystemHealthInputs {
  effectiveTurns: number;
  totalTurns: number;
}

const W_PROGRESS = 0.4;
const W_CACHE = 0.3;
const W_CONSTRAINTS = 0.3;

export function computeSystemHealth(inputs: SystemHealthInputs): SystemHealth {
  // 1. Progress rate
  const progressRate = inputs.totalTurns > 0
    ? inputs.effectiveTurns / inputs.totalTurns
    : 0;

  // 2. Cache hit rate (this run only)
  const counters = getRunCacheCounters();
  const cacheHits = counters.hitsSingle + counters.hitsSequence;
  const cacheTotal = cacheHits +
    counters.rejects.lowSuccess +
    counters.rejects.tooManyFailures +
    counters.rejects.stale +
    counters.rejects.loopGuard +
    counters.rejects.afterGPT +
    counters.rejects.notEligible;
  const cacheHitRate = cacheTotal > 0 ? cacheHits / cacheTotal : 0;

  // 3. Constraint effectiveness — average respected-progress rate across
  //    constraints with enough data (≥5 respected). Uninitialized (no data)
  //    = neutral 0.5 so it doesn't tank composite for new systems.
  const constraints = getConstraintMetrics().filter(c => c.respected >= 5);
  const constraintEffectiveness = constraints.length > 0
    ? constraints.reduce((s, c) => s + (c.respectedAndProgressed / c.respected), 0) / constraints.length
    : 0.5;

  const compositeRaw =
    W_PROGRESS * progressRate +
    W_CACHE * cacheHitRate +
    W_CONSTRAINTS * constraintEffectiveness;

  // Guardrails (P4) — prevent cache/constraint wins from masking a system
  // that isn't making progress. Penalize composite AND emit a warning so
  // we don't log "Health: 0.65" while the run is actually failing.
  const warnings: string[] = [];
  let composite = compositeRaw;
  if (inputs.totalTurns >= 5 && progressRate < PROGRESS_FLOOR) {
    composite *= PROGRESS_PENALTY;
    warnings.push(
      `progress ${(progressRate * 100).toFixed(0)}% < ${(PROGRESS_FLOOR * 100).toFixed(0)}% floor — composite penalized ×${PROGRESS_PENALTY}`,
    );
  }

  return { composite, compositeRaw, progressRate, cacheHitRate, constraintEffectiveness, warnings };
}

export function formatSystemHealth(h: SystemHealth): string {
  const pct = (n: number) => (n * 100).toFixed(0);
  const line = `[cua] Health: ${h.composite.toFixed(2)} (progress=${pct(h.progressRate)}% cache=${pct(h.cacheHitRate)}% constraints=${pct(h.constraintEffectiveness)}%)`;
  if (h.warnings.length === 0) return line;
  return [
    line,
    ...h.warnings.map(w => `[cua] Health WARNING: ${w}`),
  ].join('\n');
}
