// ── Vision Decision Engine v2 ───────────────────────────────────
// 3-layer decision system: Hard Rules → Failure Classification → Vision Probability
// With: recency decay, DOM similarity, progress granularity, stuck duration,
//       adaptive cooldown, clamped feedback, decision path logging

// ── Failure Types ───────────────────────────────────────────────
export type FailureType = 'NO_ELEMENT' | 'NO_EFFECT' | 'WRONG_PAGE' | 'TIMEOUT' | 'INTENT_MISMATCH';

export interface FailureRecord {
  type: FailureType;
  turn: number;
  target?: string;
  description?: string;
}

export type VisionMode = 'dom' | 'hybrid' | 'full-vision';

export interface VisionDecision {
  mode: VisionMode;
  reason: string;
  visionScore: number;
  hardRule: string | null;
  cooldownRemaining: number;
  decisionPath: string[];  // trace of decision steps for debugging
  signals: {
    sameDOM: number;
    failureScore: number;
    lowElements: number;
    dupText: number;
    lowConfidence: number;
    intentMismatch: number;
    stuckDuration: number;
    progressBoost: number;
  };
  feedback: {
    adjustment: number;
    visionSuccessRate: string;
  };
}

// ── Progress types ──────────────────────────────────────────────
export type ProgressType = 'strong' | 'weak';

// ── Config (tunable, not hardcoded) ─────────────────────────────
export interface VisionDecisionConfig {
  normalization: {
    sameDOM: number;
    failureScore: number;
    lowElements: number;
    duplicateText: number;
    intentMismatch: number;
    stuckDuration: number;
  };
  weights: {
    sameDOM: number;
    failureScore: number;
    lowElements: number;
    dupText: number;
    lowConfidence: number;
    intentMismatch: number;
    stuckDuration: number;
  };
  fullVisionThreshold: number;
  hybridThreshold: number;
  cooldownBreakThreshold: number;
  cooldownTurns: number;
  maxAdjustment: number;
  adjustmentStep: number;
  progressReduction: { strong: number; weak: number };
  maxConsecutiveVisionTurns: number;
  failureWeights: {
    NO_ELEMENT: number;
    NO_EFFECT: number;
    WRONG_PAGE: number;
    TIMEOUT: number;
  };
  // Recency decay: failures older than this many turns get half weight
  failureDecayTurns: number;
  // DOM similarity: threshold for "similar enough" (0-1, 1=exact)
  domSimilarityThreshold: number;
  // External domain tolerance: allow N turns on unknown domain before hard rule
  externalDomainTolerance: number;
}

const DEFAULT_CONFIG: VisionDecisionConfig = {
  normalization: {
    sameDOM: 3,
    failureScore: 0.8,  // 2 NO_EFFECT failures (0.3*2=0.6) → normalized to 0.75
    lowElements: 8,
    duplicateText: 4,
    intentMismatch: 2,
    stuckDuration: 8,
  },
  weights: {
    sameDOM: 0.20,
    failureScore: 0.40,
    lowElements: 0.15,
    dupText: 0.10,
    lowConfidence: 0.10,
    intentMismatch: 0.25,
    stuckDuration: 0.10,
  },
  fullVisionThreshold: 0.80,
  hybridThreshold: 0.55,
  cooldownBreakThreshold: 0.6,
  cooldownTurns: 2,
  maxAdjustment: 0.20,
  adjustmentStep: 0.05,
  progressReduction: { strong: 0.20, weak: 0.05 },
  maxConsecutiveVisionTurns: 3,
  failureWeights: {
    NO_ELEMENT: 0.4,
    NO_EFFECT: 0.3,
    WRONG_PAGE: 0.5,
    TIMEOUT: 0.2,
  },
  failureDecayTurns: 3,
  domSimilarityThreshold: 0.7,
  externalDomainTolerance: 2,
};

// ── Helpers ─────────────────────────────────────────────────────
function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.max(value / max, 0), 1);
}

// Simple string similarity (Jaccard on character bigrams)
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }
  return intersection / (bigramsA.size + bigramsB.size - intersection);
}

// ── Browser state interface ─────────────────────────────────────
export interface VisionBrowserState {
  elementCount: number;
  previousElementCount: number;
  hasCanvas: boolean;
  duplicateTextCount: number;
  domFingerprint: string;
  url: string;
}

// ── Action result interface ─────────────────────────────────────
export interface VisionActionResult {
  success: boolean;
  effective: boolean;
  error?: string;
  urlChanged: boolean;
  domChanged: boolean;
  valueChanged: boolean;
  intentMatch: boolean;
  elementStillExists: boolean;
  isNetworkError?: boolean;  // separate UI issues from network issues
}

// ── The Engine ──────────────────────────────────────────────────
export class VisionDecisionEngine {
  private config: VisionDecisionConfig;

  // Failure tracking
  private failureHistory: FailureRecord[] = [];
  private readonly failureWindowSize = 10;

  // Intent mismatch tracking (separate from failureScore — no double counting)
  private intentMismatchCount = 0;

  // DOM state tracking — uses similarity, not exact match
  private lastDOMFingerprint = '';
  private sameDOMCount = 0;

  // Stuck duration — total turns without meaningful progress
  private stuckSince = 0;
  private currentTurn = 0;

  // Cooldown
  private cooldownRemaining = 0;

  // Feedback loop — clamped to [-0.2, +0.2]
  private visionAdjustment = 0;
  private visionTotalAttempts = 0;
  private visionSuccessCount = 0;

  // Vision burst tracking
  private consecutiveVisionTurns = 0;

  // Progress tracking — granular (strong vs weak)
  private pendingProgressBoost = 0;

  // Last turn mode (for feedback)
  private lastTurnMode: VisionMode = 'dom';

  // External domain tolerance counter
  private externalDomainTurns = 0;

  constructor(config?: Partial<VisionDecisionConfig>) {
    this.config = { ...DEFAULT_CONFIG };
    if (config) {
      Object.assign(this.config, config);
      if (config.normalization) this.config.normalization = { ...DEFAULT_CONFIG.normalization, ...config.normalization };
      if (config.weights) this.config.weights = { ...DEFAULT_CONFIG.weights, ...config.weights };
      if (config.failureWeights) this.config.failureWeights = { ...DEFAULT_CONFIG.failureWeights, ...config.failureWeights };
      if (config.progressReduction) this.config.progressReduction = { ...DEFAULT_CONFIG.progressReduction, ...config.progressReduction };
    }
  }

  // ── Layer 1: Hard Rules ─────────────────────────────────────
  checkHardRules(
    state: VisionBrowserState,
    allowedDomains: string[],
    externalTrapDomains: string[],
  ): string | null {
    // Zero DOM elements — page is loading or canvas-only
    if (state.elementCount === 0) return 'zero_dom_elements';

    // Canvas detected — DOM can't see visual content
    if (state.hasCanvas) return 'canvas_detected';

    // External auth redirect (Google, Facebook, etc.)
    try {
      const hostname = new URL(state.url).hostname;
      if (externalTrapDomains.some(d => hostname.includes(d))) return 'external_auth_detected';
    } catch {}

    // URL on unknown domain — with tolerance (allow N turns before triggering)
    try {
      const hostname = new URL(state.url).hostname;
      const isAllowed = allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
      if (!isAllowed) {
        this.externalDomainTurns++;
        if (this.externalDomainTurns > this.config.externalDomainTolerance) {
          return 'url_unexpected_domain';
        }
        // Under tolerance — don't trigger yet (allows redirects, OAuth flows)
      } else {
        this.externalDomainTurns = 0; // reset when back on allowed domain
      }
    } catch {}

    return null;
  }

  // ── Layer 2: Failure Classification ─────────────────────────
  classifyFailure(result: VisionActionResult, errorMsg?: string): FailureType | null {
    // Network errors are NOT vision problems — don't classify as UI failure
    if (result.isNetworkError) return null;

    if (!result.success) {
      if (errorMsg?.includes('timed out') || errorMsg?.includes('Timeout')) {
        return 'TIMEOUT';
      }
      if (errorMsg?.includes('not found') || errorMsg?.includes('no element') || !result.elementStillExists) {
        return 'NO_ELEMENT';
      }
      return 'NO_ELEMENT';
    }

    // Action succeeded but...
    if (result.success && !result.effective) {
      if (!result.intentMatch) {
        return 'INTENT_MISMATCH';
      }
      if (!result.domChanged && !result.urlChanged && !result.valueChanged) {
        return 'NO_EFFECT';
      }
    }

    if (result.urlChanged && !result.intentMatch) {
      return 'WRONG_PAGE';
    }

    return null;
  }

  recordFailure(record: FailureRecord): void {
    this.failureHistory.push(record);
    if (this.failureHistory.length > this.failureWindowSize) {
      this.failureHistory.shift();
    }

    // Track intent mismatch separately (not in failureScore)
    if (record.type === 'INTENT_MISMATCH') {
      this.intentMismatchCount++;
    }
  }

  // ── Record successful action — decays failure history ────────
  recordSuccess(): void {
    // Remove the oldest failure on each success — gradual decay
    if (this.failureHistory.length > 0) {
      this.failureHistory.shift();
    }
    // Decay intent mismatch count
    this.intentMismatchCount = Math.max(0, this.intentMismatchCount - 1);
  }

  // ── Compute failure score WITH recency decay ──────────────
  private computeFailureScore(): number {
    const w = this.config.failureWeights;
    const decayTurns = this.config.failureDecayTurns;
    let score = 0;

    for (const f of this.failureHistory) {
      if (f.type === 'INTENT_MISMATCH') continue; // separate signal
      if (f.type === 'TIMEOUT') continue; // network issue, not vision-solvable

      const age = this.currentTurn - f.turn;
      const decay = age <= decayTurns ? 1.0 : 0.5; // recent = full weight, old = half
      score += (w[f.type] || 0) * decay;
    }

    return score;
  }

  // ── Update DOM tracking — uses similarity, not exact match ──
  updateDOMState(fingerprint: string): void {
    if (!this.lastDOMFingerprint) {
      this.lastDOMFingerprint = fingerprint;
      return;
    }

    const similarity = stringSimilarity(fingerprint, this.lastDOMFingerprint);

    if (similarity >= this.config.domSimilarityThreshold) {
      // DOM is "similar enough" — count as same
      this.sameDOMCount++;
    } else {
      // Meaningful change
      this.sameDOMCount = Math.max(0, this.sameDOMCount - 1); // gradual decrease, not hard reset
      this.lastDOMFingerprint = fingerprint;
    }
  }

  // ── Record progress — granular: strong vs weak ────────────
  recordProgress(type: ProgressType): void {
    const reduction = this.config.progressReduction[type];
    this.pendingProgressBoost = Math.max(this.pendingProgressBoost, reduction);

    if (type === 'strong') {
      // Strong progress resets stuck tracking
      this.stuckSince = this.currentTurn;
      this.intentMismatchCount = Math.max(0, this.intentMismatchCount - 1);
      this.sameDOMCount = 0;
    }
    // Weak progress — just the score reduction, no counter resets
  }

  // ── Set current turn (call at start of each turn) ──────────
  setCurrentTurn(turn: number): void {
    this.currentTurn = turn;
  }

  // ── Layer 3: Vision Score ───────────────────────────────────
  private computeVisionScore(state: VisionBrowserState, confidence: number | undefined): {
    score: number;
    signals: VisionDecision['signals'];
  } {
    const n = this.config.normalization;
    const w = this.config.weights;

    const failureScore = this.computeFailureScore();

    // Low elements: drop detection matters more than absolute count
    // previousElementCount == 0 means no prior data — don't compute drop
    const hasPreviousData = state.previousElementCount > 3; // need meaningful previous count
    const elementDrop = hasPreviousData
      ? Math.max(0, state.previousElementCount - state.elementCount)
      : 0;
    const lowElementSignal = state.elementCount < 3
      ? (hasPreviousData && elementDrop > 0 ? 1.0 : 0.5) // drop with prior data = definite, no prior = maybe
      : (hasPreviousData ? normalize(elementDrop, n.lowElements) : 0);

    // Confidence signal
    const confidenceSignal = confidence !== undefined
      ? (confidence < 0.3 ? 1.0 : confidence < 0.5 ? 0.6 : confidence < 0.7 ? 0.3 : 0)
      : 0;

    // Stuck duration — how long since last real progress
    const stuckDuration = this.currentTurn - this.stuckSince;

    const signals: VisionDecision['signals'] = {
      sameDOM: normalize(this.sameDOMCount, n.sameDOM),
      failureScore: normalize(failureScore, n.failureScore),
      lowElements: lowElementSignal,
      dupText: normalize(state.duplicateTextCount, n.duplicateText),
      lowConfidence: confidenceSignal,
      intentMismatch: normalize(this.intentMismatchCount, n.intentMismatch),
      stuckDuration: normalize(stuckDuration, n.stuckDuration),
      progressBoost: this.pendingProgressBoost,
    };

    const rawScore =
      signals.sameDOM * w.sameDOM +
      signals.failureScore * w.failureScore +
      signals.lowElements * w.lowElements +
      signals.dupText * w.dupText +
      signals.lowConfidence * w.lowConfidence +
      signals.intentMismatch * w.intentMismatch +
      signals.stuckDuration * w.stuckDuration +
      this.visionAdjustment -
      signals.progressBoost;

    // Consume progress boost
    this.pendingProgressBoost = 0;

    // Clamp to [0, 1] — no arbitrary cap
    const score = Math.max(0, Math.min(rawScore, 1.0));

    return { score, signals };
  }

  // ── Main Decision ──────────────────────────────────────────
  decide(
    state: VisionBrowserState,
    confidence: number | undefined,
    allowedDomains: string[],
    externalTrapDomains: string[],
  ): VisionDecision {
    const path: string[] = [];

    // Update DOM fingerprint tracking
    this.updateDOMState(state.domFingerprint);

    // Layer 1: Hard rules
    const hardRule = this.checkHardRules(state, allowedDomains, externalTrapDomains);
    if (hardRule) {
      path.push(`hard_rule: ${hardRule}`);
      this.consecutiveVisionTurns++;
      this.lastTurnMode = 'full-vision';
      const { signals } = this.computeVisionScore(state, confidence);
      return {
        mode: 'full-vision',
        reason: `Hard rule: ${hardRule}`,
        visionScore: 1.0,
        hardRule,
        cooldownRemaining: this.cooldownRemaining,
        decisionPath: path,
        signals,
        feedback: { adjustment: this.visionAdjustment, visionSuccessRate: this.getVisionSuccessRate() },
      };
    }
    path.push('no_hard_rule');

    // Cooldown check (breakable if failure is high)
    const failureScore = this.computeFailureScore();
    const normalizedFailure = normalize(failureScore, this.config.normalization.failureScore);

    if (this.cooldownRemaining > 0) {
      if (normalizedFailure < this.config.cooldownBreakThreshold) {
        this.cooldownRemaining--;
        this.consecutiveVisionTurns = 0;
        this.lastTurnMode = 'dom';
        path.push(`cooldown_active: ${this.cooldownRemaining + 1} remaining`);
        const { signals } = this.computeVisionScore(state, confidence);
        return {
          mode: 'dom',
          reason: `Cooldown active (${this.cooldownRemaining + 1} remaining)`,
          visionScore: 0,
          hardRule: null,
          cooldownRemaining: this.cooldownRemaining + 1,
          decisionPath: path,
          signals,
          feedback: { adjustment: this.visionAdjustment, visionSuccessRate: this.getVisionSuccessRate() },
        };
      }
      path.push(`cooldown_broken: failureScore ${normalizedFailure.toFixed(2)} >= ${this.config.cooldownBreakThreshold}`);
      this.cooldownRemaining = 0;
    } else {
      path.push('no_cooldown');
    }

    // Layer 3: Vision probability score
    const { score: visionScore, signals } = this.computeVisionScore(state, confidence);

    // Decision
    let mode: VisionMode;
    let reason: string;

    if (visionScore > this.config.fullVisionThreshold) {
      mode = 'full-vision';
      reason = `score ${visionScore.toFixed(2)} > ${this.config.fullVisionThreshold}`;
      path.push(`score_full_vision: ${visionScore.toFixed(2)}`);
      this.consecutiveVisionTurns++;
    } else if (visionScore > this.config.hybridThreshold) {
      mode = 'hybrid';
      reason = `score ${visionScore.toFixed(2)} > ${this.config.hybridThreshold}`;
      path.push(`score_hybrid: ${visionScore.toFixed(2)}`);
      this.consecutiveVisionTurns++;
    } else {
      mode = 'dom';
      reason = `score ${visionScore.toFixed(2)} below thresholds`;
      path.push(`score_dom: ${visionScore.toFixed(2)}`);
      this.consecutiveVisionTurns = 0;
    }

    // Max consecutive vision guard — prevents spiral
    if (this.consecutiveVisionTurns > this.config.maxConsecutiveVisionTurns && mode !== 'dom') {
      path.push(`max_vision_guard: ${this.consecutiveVisionTurns} > ${this.config.maxConsecutiveVisionTurns}`);
      mode = 'dom';
      reason = `Max consecutive vision (${this.config.maxConsecutiveVisionTurns}) — forcing DOM`;
      this.consecutiveVisionTurns = 0;
      this.startCooldown();
    }

    this.lastTurnMode = mode;

    return {
      mode,
      reason,
      visionScore,
      hardRule: null,
      cooldownRemaining: this.cooldownRemaining,
      decisionPath: path,
      signals,
      feedback: { adjustment: this.visionAdjustment, visionSuccessRate: this.getVisionSuccessRate() },
    };
  }

  // ── Feedback: record vision outcome ────────────────────────
  // Strictly defined: effective = next action succeeded OR DOM changed
  recordVisionOutcome(domChanged: boolean, nextActionSucceeded: boolean): void {
    this.visionTotalAttempts++;

    if (domChanged || nextActionSucceeded) {
      this.visionSuccessCount++;
      this.visionAdjustment = Math.min(
        this.visionAdjustment + this.config.adjustmentStep,
        this.config.maxAdjustment,
      );
    } else {
      this.visionAdjustment = Math.max(
        this.visionAdjustment - this.config.adjustmentStep,
        -this.config.maxAdjustment,
      );
    }
  }

  // ── Cooldown management ────────────────────────────────────
  startCooldown(): void {
    this.cooldownRemaining = this.config.cooldownTurns;
  }

  // ── Reset (after vision burst or major state change) ────────
  reset(): void {
    this.failureHistory = [];
    this.intentMismatchCount = 0;
    this.sameDOMCount = 0;
    this.lastDOMFingerprint = '';
    this.cooldownRemaining = 0;
    this.consecutiveVisionTurns = 0;
    this.pendingProgressBoost = 0;
    this.externalDomainTurns = 0;
    this.stuckSince = this.currentTurn;
    // Keep visionAdjustment — it's learned per session
  }

  // ── Getters for logging ────────────────────────────────────
  getLastTurnMode(): VisionMode { return this.lastTurnMode; }
  getVisionSuccessRate(): string {
    if (this.visionTotalAttempts === 0) return '0/0';
    return `${this.visionSuccessCount}/${this.visionTotalAttempts}`;
  }
  getVisionAdjustment(): number { return this.visionAdjustment; }
  getSameDOMCount(): number { return this.sameDOMCount; }
  getConsecutiveVisionTurns(): number { return this.consecutiveVisionTurns; }
  getStuckDuration(): number { return this.currentTurn - this.stuckSince; }
  getConfig(): VisionDecisionConfig { return { ...this.config }; }
}
