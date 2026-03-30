import mongoose, { Schema } from 'mongoose';

export interface IStep {
  _id: string;
  testRunId: string;
  turnNumber: number;
  filePath: string;
  capturedAt: Date;
  pageUrl: string | null;
  pageTitle: string | null;
  // Action data
  action?: {
    type: string;
    target?: string;
    value?: string;
  };
  result?: {
    success: boolean;
    error?: string;
    description?: string;
  };
  validation?: {
    urlChanged: boolean;
    domChanged: boolean;
    valueChanged: boolean;
    errorAppeared: boolean;
    errorMessage?: string;
  };
  // Agent state
  memory?: string;
  nextGoal?: string;
  domFingerprint?: string;
  confidence?: number;
  visionUsed?: boolean;
  mode?: 'dom' | 'vision' | 'vision-burst';
  // Token data
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  apiLatencyMs: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeReasoning: number;
}

const StepSchema = new Schema({
  _id: { type: String },
  testRunId: { type: String, required: true, index: true },
  turnNumber: { type: Number, required: true },
  filePath: { type: String, required: true },
  capturedAt: { type: Date, required: true },
  pageUrl: { type: String, default: null },
  pageTitle: { type: String, default: null },
  // Action data
  action: {
    type: { type: String },
    target: { type: String },
    value: { type: String },
  },
  result: {
    success: { type: Boolean },
    error: { type: String },
    description: { type: String },
  },
  validation: {
    urlChanged: { type: Boolean },
    domChanged: { type: Boolean },
    valueChanged: { type: Boolean },
    errorAppeared: { type: Boolean },
    errorMessage: { type: String },
  },
  // Agent state
  memory: { type: String },
  nextGoal: { type: String },
  domFingerprint: { type: String },
  confidence: { type: Number },
  visionUsed: { type: Boolean, default: false },
  mode: { type: String, enum: ['dom', 'vision', 'vision-burst'], default: 'dom' },
  // Token data
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  reasoningTokens: { type: Number, default: 0 },
  apiLatencyMs: { type: Number, default: 0 },
  cumulativeInput: { type: Number, default: 0 },
  cumulativeOutput: { type: Number, default: 0 },
  cumulativeReasoning: { type: Number, default: 0 },
}, { timestamps: false, _id: false });

StepSchema.index({ testRunId: 1, turnNumber: 1 });

export const Step = mongoose.model<IStep>('Step', StepSchema);

// Helper to convert Step to screenshot format (for backward compat)
export function stepToScreenshot(s: IStep) {
  return {
    id: s._id,
    test_run_id: s.testRunId,
    turn_number: s.turnNumber,
    file_path: s.filePath,
    captured_at: s.capturedAt instanceof Date ? s.capturedAt.toISOString() : s.capturedAt,
    page_url: s.pageUrl,
    page_title: s.pageTitle,
  };
}

// Helper to convert Step to turnToken format (for backward compat)
export function stepToTurnToken(s: IStep) {
  return {
    id: s._id,
    test_run_id: s.testRunId,
    turn_number: s.turnNumber,
    input_tokens: s.inputTokens,
    output_tokens: s.outputTokens,
    reasoning_tokens: s.reasoningTokens,
    api_latency_ms: s.apiLatencyMs,
    cumulative_input: s.cumulativeInput,
    cumulative_output: s.cumulativeOutput,
    cumulative_reasoning: s.cumulativeReasoning,
    mode: s.mode || 'dom',
    timestamp: s.capturedAt instanceof Date ? s.capturedAt.toISOString() : s.capturedAt,
  };
}
