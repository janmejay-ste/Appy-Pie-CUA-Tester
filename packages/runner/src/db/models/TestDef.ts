import mongoose, { Schema } from 'mongoose';

export interface ITestDef {
  _id: string;
  name: string;
  url: string;
  instructions: string;
  expectedOutcome: string;
  category: 'smoke' | 'sanity' | 'regression' | 'e2e';
  tags: string[];
  requiresAuth: boolean;
  maxTurns: number;
  timeout: number;
  viewport: { width: number; height: number };
  page: string;
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TestDefSchema = new Schema({
  _id: { type: String },
  name: { type: String, required: true },
  url: { type: String, required: true },
  instructions: { type: String, required: true },
  expectedOutcome: { type: String, required: true },
  category: { type: String, default: 'sanity' },
  tags: { type: [String], default: [] },
  requiresAuth: { type: Boolean, default: false },
  maxTurns: { type: Number, default: 40 },
  timeout: { type: Number, default: 120000 },
  viewport: {
    type: { width: Number, height: Number },
    default: { width: 1440, height: 900 },
  },
  page: { type: String, default: '' },
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true, _id: false });

TestDefSchema.index({ isActive: 1, name: 1 });

// Output format matching what dashboard expects
TestDefSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    ret.id = ret._id;
    ret.expected_outcome = ret.expectedOutcome;
    ret.requires_auth = ret.requiresAuth;
    ret.max_turns = ret.maxTurns;
    // Keep fields dashboard already uses
    delete ret.__v;
    delete ret.expectedOutcome;
    delete ret.requiresAuth;
    delete ret.maxTurns;
    return ret;
  },
});

export const TestDef = mongoose.model<ITestDef>('TestDef', TestDefSchema);
