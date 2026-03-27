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

// ── CUA Loop Shared Types ──────────────────────────────────────
export interface TurnTokenUsage {
  turn: number;
  input: number;
  output: number;
  reasoning: number;
  apiLatencyMs: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeReasoning: number;
}

export interface StepActionMeta {
  action?: { type: string; target?: string; value?: string };
  result?: { success: boolean; error?: string | null; description?: string };
  validation?: {
    urlChanged: boolean; domChanged: boolean; valueChanged: boolean;
    errorAppeared: boolean; errorMessage?: string | null;
    elementStillExists: boolean; intentMatch: boolean;
  };
  effective?: boolean;
  retryStrategy?: string;
  memory?: string;
  nextGoal?: string;
  domFingerprint?: string;
  confidence?: number;
  visionUsed?: boolean;
}

export interface CUALoopCallbacks {
  onTurnStart: (turn: number) => void;
  onTurnComplete: (turn: number, apiLatencyMs: number, tokensSoFar?: { input: number; output: number; reasoning: number }) => void;
  onTurnTokens: (turnTokens: TurnTokenUsage) => void;
  onActionsExecuted: (turn: number, actions: ComputerAction[]) => void;
  onScreenshot: (turn: number, screenshot: ScreenshotRecord, actionMeta?: StepActionMeta) => void;
}

export interface PageState {
  url: string;
  title: string;
  lastActions: string[];
  storageStatePath?: string;
}

export interface CUALoopResult {
  verdict: 'PASS' | 'FAIL' | 'TIMEOUT' | 'UNKNOWN';
  modelMessage: string;
  turns: number;
  totalTokens: { input: number; output: number; reasoning: number };
  pageState?: PageState;
}

// ── DOM-First CUA Types ────────────────────────────────────────
export interface DOMElement {
  id: string;           // e1, e2...
  tag: string;          // button, input, a, select, textarea
  type?: string;        // text, password, checkbox, submit
  text?: string;        // visible text (max 80 chars)
  placeholder?: string;
  value?: string;       // current value for inputs
  href?: string;        // for links (max 100 chars)
  ariaLabel?: string;
  role?: string;
  disabled?: boolean;
  checked?: boolean;
  options?: string[];   // for select (max 10)
  rect: { x: number; y: number; width: number; height: number };
  selector: string;     // CSS selector for fallback
}

export interface DOMPageState {
  url: string;
  title: string;
  elements: DOMElement[];
  keyText: string;      // headings, labels, errors — NOT random innerText
  formState?: Record<string, string>;
  errors?: string[];    // visible validation errors
}

export interface ModelAction {
  action: 'click' | 'type' | 'scroll' | 'select' | 'wait' | 'navigate' | 'keypress' | 'done';
  target?: string;      // element ID (e1, e2...)
  value?: string;       // text to type, option to select, URL, key
  reason: string;       // why this action
  confidence: number;   // 0.0 - 1.0
  stepsCompleted?: string[];  // progress tracking
  verdict?: 'PASS' | 'FAIL'; // only when action is 'done'
  summary?: string;           // only when action is 'done'
  issuesFound?: string[];     // only when action is 'done'
}

export interface ActionResult {
  success: boolean;
  error?: string;
  description: string;  // human-readable description
}

export interface StructuredMemory {
  page: string;
  filled: string[];
  pending: string[];
  errors: string[];
}
