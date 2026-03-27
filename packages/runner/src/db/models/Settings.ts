import mongoose, { Schema } from 'mongoose';

export interface ISettings {
  _id: string;
  maxConcurrency: number;
  maxTurnsDefault: number;
  maxTokensPerSession: number;
  defaultTimeout: number;
  defaultHeadless: boolean;
  allowedDomains: string[];
  cuaMode: 'dom' | 'vision';
  updatedAt: Date;
}

const SettingsSchema = new Schema({
  _id: { type: String, default: 'global' },
  maxConcurrency: { type: Number, default: 2 },
  maxTurnsDefault: { type: Number, default: 500 },
  maxTokensPerSession: { type: Number, default: 200000 },
  defaultTimeout: { type: Number, default: 120000 },
  defaultHeadless: { type: Boolean, default: true },
  allowedDomains: { type: [String], default: ['appypieautomate.ai', 'connectcloud.appypie.com'] },
  cuaMode: { type: String, enum: ['dom', 'vision'], default: 'dom' },
}, { timestamps: { createdAt: false, updatedAt: true }, _id: false });

SettingsSchema.set('toJSON', {
  transform: (_doc: any, ret: any) => {
    delete ret.__v;
    return ret;
  },
});

export const Settings = mongoose.model<ISettings>('Settings', SettingsSchema);

// Get or create default settings
export async function getSettings(): Promise<ISettings> {
  let settings = await Settings.findById('global');
  if (!settings) {
    settings = await Settings.create({ _id: 'global' });
  }
  return settings;
}
