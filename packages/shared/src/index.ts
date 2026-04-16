// ── Shared API Types ────────────────────────────────────────────
// Single source of truth for types used by both runner and dashboard.
// Runner's Mongoose toJSON transforms produce these shapes.
// Dashboard consumes them directly from API responses.

// ── Test Definition (from YAML or DB) ────────────────────────────

/**
 * Declarative hard-verification rule. Optional per test. When provided,
 * the CUA loop runs these after the model emits a "done" verdict to
 * independently confirm what the model claimed. See
 * packages/runner/src/validation/validator.ts for the matcher.
 */
export interface TestValidationRule {
  type: 'url' | 'text' | 'element' | 'not_text';
  value: string;
  label?: string;
}

export interface TestDefinition {
  id: string;
  _id?: string;
  name: string;
  url: string;
  instructions?: string;
  expected_outcome?: string;
  expectedOutcome?: string;
  tags?: string[];
  category?: 'smoke' | 'sanity' | 'regression' | 'e2e';
  timeout: number;
  requires_auth?: boolean;
  requiresAuth?: boolean;
  max_turns?: number;
  maxTurns?: number;
  page?: string;
  version?: number;
  isActive?: boolean;
  cuaMode?: 'dom' | 'vision';
  viewport?: { width: number; height: number };
  /** Optional hard-verification rules. Loop runs them after the model's verdict. */
  validation?: TestValidationRule[];
}

// ── Test Run (API response shape after toJSON transform) ─────────
export type TestStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'timeout' | 'aborted';

export interface TestRun {
  id: string;
  suite_run_id?: string;
  test_id: string;
  test_name: string;
  status: TestStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  screenshot_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_verdict: string | null;
  error: string | null;
}

// ── Suite Run (Session) ──────────────────────────────────────────
export interface SuiteRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
}

// ── Screenshot Record ────────────────────────────────────────────
export interface Screenshot {
  id: string;
  test_run_id?: string;
  turn_number: number;
  file_path: string;
  captured_at: string;
  page_url: string | null;
  page_title: string | null;
}

// ── Run Event ────────────────────────────────────────────────────
export interface RunEvent {
  id: string;
  test_run_id?: string;
  type: string;
  message: string;
  detail?: string | null;
  timestamp: string;
  sequence: number;
}

// ── Turn Token Usage ─────────────────────────────────────────────
export interface TurnToken {
  id?: string;
  turn_number: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  api_latency_ms: number;
  cumulative_input: number;
  cumulative_output: number;
  cumulative_reasoning: number;
  mode?: 'dom' | 'vision' | 'vision-burst';
  timestamp?: string;
}

// ── Run Detail (full response with nested data) ──────────────────
export interface RunDetail extends TestRun {
  screenshots: Screenshot[];
  events: RunEvent[];
  turnTokens: TurnToken[];
}

// ── System Settings ──────────────────────────────────────────────
export interface SystemSettings {
  _id?: string;
  maxConcurrency: number;
  maxTurnsDefault: number;
  maxTokensPerSession: number;
  defaultTimeout: number;
  defaultHeadless: boolean;
  allowedDomains: string[];
  cuaMode?: 'dom' | 'vision';
}

// ── Test Account ─────────────────────────────────────────────────
export interface TestAccount {
  email: string;
  password: string;
  passwordMasked?: string;
}

// ── Dashboard UI Types ───────────────────────────────────────────
export type TabId = 'overview' | 'results' | 'failures' | 'logs' | 'tests' | 'config';
