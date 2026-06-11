import { getDb } from '../sqlite.js';

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

interface SettingsRow {
  id: string; max_concurrency: number; max_turns_default: number;
  max_tokens_per_session: number; default_timeout: number; default_headless: number;
  allowed_domains: string; cua_mode: string; updated_at: string | null;
}

function rowToDoc(r: SettingsRow): ISettings {
  return {
    _id: r.id,
    maxConcurrency: r.max_concurrency,
    maxTurnsDefault: r.max_turns_default,
    maxTokensPerSession: r.max_tokens_per_session,
    defaultTimeout: r.default_timeout,
    defaultHeadless: !!r.default_headless,
    allowedDomains: JSON.parse(r.allowed_domains || '[]'),
    cuaMode: (r.cua_mode || 'dom') as 'dom' | 'vision',
    updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
  };
}

export const Settings = {
  findById(id: string) {
    const r = getDb().prepare('SELECT * FROM settings WHERE id = ?').get(id) as SettingsRow | undefined;
    return Promise.resolve(r ? rowToDoc(r) : null);
  },

  create(data: { _id: string }) {
    // Insert default settings — table schema has defaults
    getDb().prepare(`INSERT OR IGNORE INTO settings (id) VALUES (?)`).run(data._id);
    const r = getDb().prepare('SELECT * FROM settings WHERE id = ?').get(data._id) as SettingsRow;
    return Promise.resolve(rowToDoc(r));
  },

  updateOne(query: { _id: string }, update: Record<string, any>, options?: { upsert?: boolean }) {
    if (options?.upsert) {
      getDb().prepare(`INSERT OR IGNORE INTO settings (id) VALUES (?)`).run(query._id);
    }
    const sets = update.$set || update;
    const cols: string[] = [];
    const vals: any[] = [];
    const colMap: Record<string, string> = {
      maxConcurrency: 'max_concurrency', maxTurnsDefault: 'max_turns_default',
      maxTokensPerSession: 'max_tokens_per_session', defaultTimeout: 'default_timeout',
      defaultHeadless: 'default_headless', allowedDomains: 'allowed_domains',
      cuaMode: 'cua_mode',
    };
    for (const [k, v] of Object.entries(sets)) {
      const col = colMap[k] || k;
      cols.push(`${col} = ?`);
      if (k === 'allowedDomains') vals.push(JSON.stringify(v));
      else if (k === 'defaultHeadless') vals.push(v ? 1 : 0);
      else vals.push(v);
    }
    cols.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(query._id);
    getDb().prepare(`UPDATE settings SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
    return Promise.resolve();
  },
};

export async function getSettings(): Promise<ISettings> {
  let settings = await Settings.findById('global');
  if (!settings) {
    settings = await Settings.create({ _id: 'global' });
  }
  return settings!;
}
