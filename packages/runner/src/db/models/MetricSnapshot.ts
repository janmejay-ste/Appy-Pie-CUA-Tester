import mongoose, { Schema } from 'mongoose';

export interface IMetricSnapshot {
  _id: string;
  timestamp: Date;
  queueWaiting: number;
  queueActive: number;
  queueFailed: number;
  totalRuns: number;
  failureRate: number;
  avgLatencyMs: number;
  totalTokensUsed: number;
  alerts: string[];
}

const MetricSnapshotSchema = new Schema({
  _id: { type: String },
  timestamp: { type: Date, required: true },
  queueWaiting: { type: Number, default: 0 },
  queueActive: { type: Number, default: 0 },
  queueFailed: { type: Number, default: 0 },
  totalRuns: { type: Number, default: 0 },
  failureRate: { type: Number, default: 0 },
  avgLatencyMs: { type: Number, default: 0 },
  totalTokensUsed: { type: Number, default: 0 },
  alerts: { type: [String], default: [] },
}, { timestamps: false, _id: false });

// Auto-delete snapshots older than 30 days
MetricSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const MetricSnapshot = mongoose.model<IMetricSnapshot>('MetricSnapshot', MetricSnapshotSchema);
