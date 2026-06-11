import { getDb } from '../sqlite.js';

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

interface SessionRow {
  id: string; started_at: string; completed_at: string | null;
  total: number; passed: number; failed: number; errors: number; timeouts: number;
}

function rowToDoc(r: SessionRow): ISession & { toJSON: () => any } {
  const doc: ISession = {
    _id: r.id, startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    total: r.total, passed: r.passed, failed: r.failed, errors: r.errors, timeouts: r.timeouts,
  };
  return {
    ...doc,
    toJSON() {
      return {
        id: doc._id,
        started_at: doc.startedAt instanceof Date ? doc.startedAt.toISOString() : doc.startedAt,
        completed_at: doc.completedAt instanceof Date ? doc.completedAt.toISOString() : doc.completedAt,
        total: doc.total, passed: doc.passed, failed: doc.failed, errors: doc.errors, timeouts: doc.timeouts,
      };
    },
  };
}

export const Session = {
  create(data: { _id: string; startedAt: Date; total?: number }) {
    const ts = data.startedAt instanceof Date ? data.startedAt.toISOString() : String(data.startedAt);
    getDb().prepare(`INSERT INTO sessions (id, started_at, total) VALUES (?, ?, ?)`).run(data._id, ts, data.total ?? 0);
    return rowToDoc({ id: data._id, started_at: ts, completed_at: null, total: data.total ?? 0, passed: 0, failed: 0, errors: 0, timeouts: 0 });
  },

  findById(id: string) {
    const r = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    const result = r ? rowToDoc(r) : null;
    const p = Promise.resolve(result) as any;
    p.lean = () => p;
    return p;
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.completedAt) {
      if (query.completedAt.$ne !== undefined && query.completedAt.$lt) {
        conds.push('completed_at IS NOT NULL');
        conds.push('completed_at < ?');
        params.push(query.completedAt.$lt instanceof Date ? query.completedAt.$lt.toISOString() : query.completedAt.$lt);
      }
    }
    let sql = 'SELECT * FROM sessions' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    let limitVal = 0;
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k === 'startedAt' ? 'started_at' : k} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      limit(n: number) { limitVal = n; return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy + (limitVal ? ` LIMIT ${limitVal}` : '')).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  countDocuments(query: Record<string, any> = {}) {
    if (!Object.keys(query).length) return Promise.resolve((getDb().prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c);
    return Promise.resolve(0);
  },

  updateOne(query: { _id: string }, update: Record<string, any>) {
    const sets = update.$set || update;
    const cols: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(sets)) {
      const col = k === 'completedAt' ? 'completed_at' : k;
      cols.push(`${col} = ?`);
      vals.push(v instanceof Date ? v.toISOString() : v);
    }
    if (!cols.length) return Promise.resolve();
    vals.push(query._id);
    getDb().prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
    return Promise.resolve();
  },

  deleteOne(query: { _id: string }) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(query._id);
    return Promise.resolve();
  },

  deleteMany(query: Record<string, any> = {}) {
    if (!Object.keys(query).length) return Promise.resolve({ deletedCount: getDb().prepare('DELETE FROM sessions').run().changes });
    return Promise.resolve({ deletedCount: 0 });
  },
};
