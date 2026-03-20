import mongoose, { Schema } from 'mongoose';

export interface IEvent {
  _id: string;
  testRunId: string;
  sequence: number;
  type: string;
  message: string;
  detail: string | null;
  timestamp: Date;
}

const EventSchema = new Schema({
  _id: { type: String },
  testRunId: { type: String, required: true, index: true },
  sequence: { type: Number, required: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  detail: { type: String, default: null },
  timestamp: { type: Date, required: true },
}, { timestamps: false, _id: false });

EventSchema.index({ testRunId: 1, sequence: 1 });

EventSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    ret.id = ret._id;
    ret.test_run_id = ret.testRunId;
    ret.timestamp = ret.timestamp?.toISOString?.() ?? ret.timestamp ?? null;
    delete ret._id; delete ret.__v;
    delete ret.testRunId;
    return ret;
  },
});

export const Event = mongoose.model<IEvent>('Event', EventSchema);
