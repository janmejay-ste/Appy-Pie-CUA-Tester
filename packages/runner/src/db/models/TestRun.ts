import mongoose, { Schema } from 'mongoose';

export interface ITestRun {
  _id: string;
  sessionId: string;
  testId: string;
  testName: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'timeout';
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  turnCount: number;
  screenshotCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  modelVerdict: string | null;
  error: string | null;
}

const TestRunSchema = new Schema({
  _id: { type: String },
  sessionId: { type: String, required: true, index: true },
  testId: { type: String, required: true },
  testName: { type: String, required: true },
  status: { type: String, default: 'queued' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  turnCount: { type: Number, default: 0 },
  screenshotCount: { type: Number, default: 0 },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  reasoningTokens: { type: Number, default: 0 },
  modelVerdict: { type: String, default: null },
  error: { type: String, default: null },
  pageState: {
    type: { url: String, title: String, lastActions: [String] },
    default: null,
  },
  lastHeartbeat: { type: Date, default: null },
}, { timestamps: false, _id: false });

TestRunSchema.index({ testId: 1, startedAt: -1 });

TestRunSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    ret.id = ret._id;
    ret.suite_run_id = ret.sessionId;
    ret.test_id = ret.testId;
    ret.test_name = ret.testName;
    ret.started_at = ret.startedAt?.toISOString?.() ?? ret.startedAt ?? null;
    ret.completed_at = ret.completedAt?.toISOString?.() ?? ret.completedAt ?? null;
    ret.duration_ms = ret.durationMs;
    ret.turn_count = ret.turnCount;
    ret.screenshot_count = ret.screenshotCount;
    ret.input_tokens = ret.inputTokens;
    ret.output_tokens = ret.outputTokens;
    ret.reasoning_tokens = ret.reasoningTokens;
    ret.model_verdict = ret.modelVerdict;
    delete ret._id; delete ret.__v;
    delete ret.sessionId; delete ret.testId; delete ret.testName;
    delete ret.startedAt; delete ret.completedAt; delete ret.durationMs;
    delete ret.turnCount; delete ret.screenshotCount;
    delete ret.inputTokens; delete ret.outputTokens; delete ret.reasoningTokens;
    delete ret.modelVerdict;
    return ret;
  },
});

export const TestRun = mongoose.model<ITestRun>('TestRun', TestRunSchema);
