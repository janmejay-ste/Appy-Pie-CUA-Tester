// ── Test Account Config ─────────────────────────────────────────
export interface TestAccountConfig {
  email: string;
  password: string;
}

export interface AppConfig {
  defaultTestAccount: TestAccountConfig;
}

// ── Test Definition (loaded from YAML) ──────────────────────────
export interface TestDefinition {
  id: string;
  name: string;
  url: string;
  instructions: string;
  timeout: number;
  expected_outcome: string;
  viewport?: { width: number; height: number };
  tags?: string[];
  category?: 'smoke' | 'sanity' | 'regression' | 'e2e';
  max_turns?: number;
  requires_auth?: boolean;
  page?: string;
}

// ── Runtime Types ───────────────────────────────────────────────
export type TestStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'timeout';

export interface TestRun {
  id: string;
  suite_run_id: string;
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

export interface ScreenshotRecord {
  id: string;
  test_run_id: string;
  turn_number: number;
  file_path: string;
  captured_at: string;
  page_url: string | null;
  page_title: string | null;
}

export interface RunEvent {
  id: string;
  test_run_id: string;
  sequence: number;
  type: string;
  message: string;
  detail: string | null;
  timestamp: string;
}

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

// ── CUA API Types ───────────────────────────────────────────────
export interface ComputerAction {
  type: string;
  [key: string]: unknown;
}

export interface CUAResponseOutput {
  type: string;
  call_id?: string;
  actions?: ComputerAction[];
  pending_safety_checks?: Array<{ code?: string; message?: string }>;
  content?: Array<{ text?: string; type?: string }>;
  role?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface CUAResponse {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  output?: CUAResponseOutput[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  } | null;
}
