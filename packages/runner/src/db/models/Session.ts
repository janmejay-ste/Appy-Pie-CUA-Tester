import mongoose, { Schema } from 'mongoose';

export interface ISession {
  _id: string;
  startedAt: Date;
  completedAt: Date | null;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
}

const SessionSchema = new Schema({
  _id: { type: String },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  total: { type: Number, default: 0 },
  passed: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  errors: { type: Number, default: 0 },
  timeouts: { type: Number, default: 0 },
}, { timestamps: false, _id: false, suppressReservedKeysWarning: true });

SessionSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    ret.id = ret._id;
    ret.started_at = ret.startedAt?.toISOString?.() ?? ret.startedAt ?? null;
    ret.completed_at = ret.completedAt?.toISOString?.() ?? ret.completedAt ?? null;
    delete ret._id;
    delete ret.__v;
    delete ret.startedAt;
    delete ret.completedAt;
    return ret;
  },
});

export const Session = mongoose.model<ISession>('Session', SessionSchema);
