import { describe, it, expect, beforeEach } from 'vitest';
import {
  VisionDecisionEngine,
  type VisionBrowserState,
  type VisionDecisionConfig,
} from '../src/vision-decision.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeState(overrides: Partial<VisionBrowserState> = {}): VisionBrowserState {
  return {
    elementCount: 15,
    previousElementCount: 15,
    hasCanvas: false,
    duplicateTextCount: 0,
    domFingerprint: 'fp-default',
    url: 'https://app.appypieautomate.ai/dashboard',
    ...overrides,
  };
}

const ALLOWED_DOMAINS = ['appypieautomate.ai', 'appypie.com'];
const EXTERNAL_TRAP_DOMAINS = ['accounts.google.com', 'facebook.com'];

// ── Tests ──────────────────────────────────────────────────────────

describe('VisionDecisionEngine', () => {
  let engine: VisionDecisionEngine;

  beforeEach(() => {
    engine = new VisionDecisionEngine();
  });

  // ── Hard Rules ─────────────────────────────────────────────────

  describe('Hard Rules', () => {
    it('should trigger full-vision when element count is zero', () => {
      engine.setCurrentTurn(1);
      const state = makeState({ elementCount: 0 });
      const decision = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.mode).toBe('full-vision');
      expect(decision.hardRule).toBe('zero_dom_elements');
      expect(decision.visionScore).toBe(1.0);
    });

    it('should trigger full-vision when canvas is detected', () => {
      engine.setCurrentTurn(1);
      const state = makeState({ hasCanvas: true });
      const decision = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.mode).toBe('full-vision');
      expect(decision.hardRule).toBe('canvas_detected');
      expect(decision.visionScore).toBe(1.0);
    });

    it('should trigger full-vision on external auth redirect', () => {
      engine.setCurrentTurn(1);
      const state = makeState({ url: 'https://accounts.google.com/signin' });
      const decision = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.mode).toBe('full-vision');
      expect(decision.hardRule).toBe('external_auth_detected');
    });

    it('should tolerate unknown domain for a few turns before triggering', () => {
      engine.setCurrentTurn(1);
      const state = makeState({ url: 'https://unknown-site.com/page' });

      // First call: within tolerance (default tolerance = 2)
      const d1 = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(d1.hardRule).toBeNull();

      // Second call: still within tolerance
      engine.setCurrentTurn(2);
      const d2 = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(d2.hardRule).toBeNull();

      // Third call: exceeds tolerance
      engine.setCurrentTurn(3);
      const d3 = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(d3.hardRule).toBe('url_unexpected_domain');
      expect(d3.mode).toBe('full-vision');
    });
  });

  // ── Score Calculation ──────────────────────────────────────────

  describe('Score Calculation', () => {
    it('should recommend vision when failure score is high', () => {
      engine.setCurrentTurn(1);

      // Record many failures to saturate the failure score signal
      engine.recordFailure({ type: 'NO_ELEMENT', turn: 1 });
      engine.recordFailure({ type: 'NO_ELEMENT', turn: 1 });
      engine.recordFailure({ type: 'WRONG_PAGE', turn: 1 });
      engine.recordFailure({ type: 'NO_EFFECT', turn: 1 });
      engine.recordFailure({ type: 'NO_EFFECT', turn: 1 });

      // Also push same-DOM signal by repeating the fingerprint
      const state = makeState({ domFingerprint: 'stuck-fp' });
      engine.decide(state, 0.3, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      // Second decide with same fingerprint + more failures
      engine.setCurrentTurn(2);
      engine.recordFailure({ type: 'WRONG_PAGE', turn: 2 });
      engine.recordFailure({ type: 'NO_ELEMENT', turn: 2 });
      const decision = engine.decide(state, 0.2, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      // failureScore saturates to 1.0 * 0.40 = 0.40, lowConfidence=1.0*0.10=0.10,
      // sameDOM grows, stuckDuration grows => combined should exceed hybrid threshold (0.55)
      expect(decision.visionScore).toBeGreaterThan(0.55);
      expect(['hybrid', 'full-vision']).toContain(decision.mode);
    });

    it('should reduce score when progress is detected', () => {
      engine.setCurrentTurn(1);

      // Build up some failure pressure
      engine.recordFailure({ type: 'NO_ELEMENT', turn: 1 });
      engine.recordFailure({ type: 'NO_EFFECT', turn: 1 });

      const state = makeState();

      // Measure score without progress
      const d1 = engine.decide(state, 0.5, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      const scoreWithoutProgress = d1.visionScore;

      // Reset engine, same failures, but add progress
      const engine2 = new VisionDecisionEngine();
      engine2.setCurrentTurn(1);
      engine2.recordFailure({ type: 'NO_ELEMENT', turn: 1 });
      engine2.recordFailure({ type: 'NO_EFFECT', turn: 1 });
      engine2.recordProgress('strong');

      const d2 = engine2.decide(makeState(), 0.5, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      // Progress should reduce the score
      expect(d2.visionScore).toBeLessThan(scoreWithoutProgress);
      expect(d2.signals.progressBoost).toBeGreaterThan(0);
    });

    it('should factor in low confidence signal', () => {
      engine.setCurrentTurn(1);
      const state = makeState();

      // High confidence
      const highConf = engine.decide(state, 0.9, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      // Low confidence (new engine to avoid state carry-over)
      const engine2 = new VisionDecisionEngine();
      engine2.setCurrentTurn(1);
      const lowConf = engine2.decide(makeState(), 0.2, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(lowConf.signals.lowConfidence).toBeGreaterThan(highConf.signals.lowConfidence);
      expect(lowConf.visionScore).toBeGreaterThanOrEqual(highConf.visionScore);
    });

    it('should increase sameDOM signal when DOM fingerprint stays the same', () => {
      const state = makeState({ domFingerprint: 'same-fp' });

      // First turn: establishes fingerprint
      engine.setCurrentTurn(1);
      engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      // Subsequent turns: same fingerprint
      engine.setCurrentTurn(2);
      engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      engine.setCurrentTurn(3);
      const d3 = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(d3.signals.sameDOM).toBeGreaterThan(0);
    });

    it('should track stuck duration signal when no progress occurs', () => {
      engine.setCurrentTurn(0);
      const state = makeState();

      // Advance several turns without recording progress
      engine.setCurrentTurn(5);
      const decision = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.signals.stuckDuration).toBeGreaterThan(0);
    });
  });

  // ── Cooldown ───────────────────────────────────────────────────

  describe('Cooldown', () => {
    it('should force DOM mode during cooldown after max consecutive vision turns', () => {
      // Configure for easy triggering: low thresholds, small max vision turns
      const engine = new VisionDecisionEngine({
        maxConsecutiveVisionTurns: 2,
        fullVisionThreshold: 0.1, // very low so score always triggers vision
        hybridThreshold: 0.05,
      });

      const state = makeState({ domFingerprint: 'fp-stuck' });

      // Turn 1: triggers vision
      engine.setCurrentTurn(1);
      const d1 = engine.decide(state, 0.1, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      // First call sets fingerprint, so sameDOM = 0. But low confidence = 1.0 with weight 0.10 = 0.10
      // Plus stuckDuration: 1/8 * 0.10 = 0.0125 => ~0.1125 > 0.1 threshold
      expect(['hybrid', 'full-vision']).toContain(d1.mode);

      // Turn 2: still vision
      engine.setCurrentTurn(2);
      const d2 = engine.decide(state, 0.1, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(['hybrid', 'full-vision']).toContain(d2.mode);

      // Turn 3: should hit max consecutive and be forced to DOM + cooldown starts
      engine.setCurrentTurn(3);
      const d3 = engine.decide(state, 0.1, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(d3.mode).toBe('dom');
      expect(d3.cooldownRemaining).toBeGreaterThan(0);
    });

    it('should decrement cooldown on each DOM turn', () => {
      const engine = new VisionDecisionEngine();
      engine.setCurrentTurn(1);

      // Manually start cooldown
      engine.startCooldown();

      const state = makeState();
      const d1 = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      expect(d1.mode).toBe('dom');
      expect(d1.reason).toContain('Cooldown');

      // Second turn: cooldown should decrement
      engine.setCurrentTurn(2);
      const d2 = engine.decide(makeState({ domFingerprint: 'fp-2' }), 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);
      // After default cooldownTurns=2, first call uses one, second call uses the other
      // The cooldownRemaining in the result should be less
      expect(d2.cooldownRemaining).toBeLessThanOrEqual(d1.cooldownRemaining);
    });
  });

  // ── Normal Operation ───────────────────────────────────────────

  describe('Normal Operation', () => {
    it('should stay in DOM mode when all signals are quiet', () => {
      engine.setCurrentTurn(1);
      const state = makeState();
      const decision = engine.decide(state, 0.9, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.mode).toBe('dom');
      expect(decision.hardRule).toBeNull();
      expect(decision.visionScore).toBeLessThan(0.55);
    });

    it('should return meaningful decision path for debugging', () => {
      engine.setCurrentTurn(1);
      const state = makeState();
      const decision = engine.decide(state, 0.9, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.decisionPath.length).toBeGreaterThan(0);
      expect(decision.decisionPath).toContain('no_hard_rule');
    });

    it('should track vision success rate in feedback', () => {
      engine.setCurrentTurn(1);

      // Record some vision outcomes
      engine.recordVisionOutcome(true, true);
      engine.recordVisionOutcome(false, false);
      engine.recordVisionOutcome(true, false);

      const state = makeState();
      const decision = engine.decide(state, 0.8, ALLOWED_DOMAINS, EXTERNAL_TRAP_DOMAINS);

      expect(decision.feedback.visionSuccessRate).toBe('2/3');
    });
  });

  // ── Feedback Loop ──────────────────────────────────────────────

  describe('Feedback Loop', () => {
    it('should increase vision adjustment on successful vision outcome', () => {
      engine.recordVisionOutcome(true, true);
      expect(engine.getVisionAdjustment()).toBeGreaterThan(0);
    });

    it('should decrease vision adjustment on failed vision outcome', () => {
      engine.recordVisionOutcome(false, false);
      expect(engine.getVisionAdjustment()).toBeLessThan(0);
    });

    it('should clamp adjustment to max bounds', () => {
      // Record many successes
      for (let i = 0; i < 20; i++) {
        engine.recordVisionOutcome(true, true);
      }
      expect(engine.getVisionAdjustment()).toBeLessThanOrEqual(0.20);

      // Record many failures
      for (let i = 0; i < 40; i++) {
        engine.recordVisionOutcome(false, false);
      }
      expect(engine.getVisionAdjustment()).toBeGreaterThanOrEqual(-0.20);
    });
  });

  // ── Failure Classification ─────────────────────────────────────

  describe('Failure Classification', () => {
    it('should classify timeout errors correctly', () => {
      const result = engine.classifyFailure(
        { success: false, effective: false, urlChanged: false, domChanged: false, valueChanged: false, intentMatch: false, elementStillExists: true },
        'Action timed out',
      );
      expect(result).toBe('TIMEOUT');
    });

    it('should classify missing element correctly', () => {
      const result = engine.classifyFailure(
        { success: false, effective: false, urlChanged: false, domChanged: false, valueChanged: false, intentMatch: false, elementStillExists: false },
        'Element not found',
      );
      expect(result).toBe('NO_ELEMENT');
    });

    it('should classify intent mismatch when action succeeds but is not effective', () => {
      const result = engine.classifyFailure(
        { success: true, effective: false, urlChanged: false, domChanged: false, valueChanged: false, intentMatch: false, elementStillExists: true },
      );
      expect(result).toBe('INTENT_MISMATCH');
    });

    it('should classify no-effect when action succeeds but nothing changes and intent matches', () => {
      const result = engine.classifyFailure(
        { success: true, effective: false, urlChanged: false, domChanged: false, valueChanged: false, intentMatch: true, elementStillExists: true },
      );
      expect(result).toBe('NO_EFFECT');
    });

    it('should not classify network errors as vision failures', () => {
      const result = engine.classifyFailure(
        { success: false, effective: false, urlChanged: false, domChanged: false, valueChanged: false, intentMatch: false, elementStillExists: false, isNetworkError: true },
        'net::ERR_CONNECTION_RESET',
      );
      expect(result).toBeNull();
    });

    it('should classify wrong page when URL changes without intent match', () => {
      const result = engine.classifyFailure(
        { success: true, effective: true, urlChanged: true, domChanged: true, valueChanged: false, intentMatch: false, elementStillExists: false },
      );
      expect(result).toBe('WRONG_PAGE');
    });
  });

  // ── Reset ──────────────────────────────────────────────────────

  describe('Reset', () => {
    it('should clear transient state but keep learned vision adjustment', () => {
      engine.setCurrentTurn(5);
      engine.recordFailure({ type: 'NO_ELEMENT', turn: 5 });
      engine.recordVisionOutcome(true, true);
      const adjustmentBefore = engine.getVisionAdjustment();

      engine.reset();

      expect(engine.getSameDOMCount()).toBe(0);
      expect(engine.getConsecutiveVisionTurns()).toBe(0);
      // Vision adjustment should be preserved across resets
      expect(engine.getVisionAdjustment()).toBe(adjustmentBefore);
    });
  });
});
