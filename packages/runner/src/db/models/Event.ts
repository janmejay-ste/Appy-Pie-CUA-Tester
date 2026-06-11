import { getDb } from '../sqlite.js';

export interface IEvent {
  _id: string;
  testRunId: string;
  sequence: number;
  type: string;
  message: string;
  detail: string | null;
  timestamp: Date;
}

interface EventRow {
  id: string; test_run_id: string; sequence: number; type: string;
  message: string; detail: string | null; timestamp: string;
}

function rowToDoc(r: EventRow): IEvent & { toJSON: () => any } {
  const doc: IEvent = {
    _id: r.id, testRunId: r.test_run_id, sequence: r.sequence, type: r.type,
    message: r.message, detail: r.detail, timestamp: new Date(r.timestamp),
  };
  return {
    ...doc,
    toJSON() {
      return {
        id: doc._id, test_run_id: doc.testRunId, sequence: doc.sequence,
        type: doc.type, message: doc.message, detail: doc.detail,
        timestamp: doc.timestamp instanceof Date ? doc.timestamp.toISOString() : doc.timestamp,
      };
    },
  };
}

export const Event = {
  create(data: { _id: string; testRunId: string; sequence: number; type: string; message: string; detail: string | null; timestamp: Date }) {
    const ts = data.timestamp instanceof Date ? data.timestamp.toISOString() : String(data.timestamp);
    getDb().prepare(`INSERT INTO events (id, test_run_id, sequence, type, message, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data._id, data.testRunId, data.sequence, data.type, data.message, data.detail, ts);
    return rowToDoc({ id: data._id, test_run_id: data.testRunId, sequence: data.sequence, type: data.type, message: data.message, detail: data.detail, timestamp: ts });
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.testRunId) { conds.push('test_run_id = ?'); params.push(query.testRunId); }
    let sql = 'SELECT * FROM events' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    let limitVal = 0;
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k === 'sequence' ? 'sequence' : 'timestamp'} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      limit(n: number) { limitVal = n; return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy + (limitVal ? ` LIMIT ${limitVal}` : '')).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  deleteMany(query: Record<string, any> = {}) {
    if (!Object.keys(query).length) return Promise.resolve({ deletedCount: getDb().prepare('DELETE FROM events').run().changes });
    if (query.testRunId?.$in) {
      const ids = query.testRunId.$in as string[];
      if (!ids.length) return Promise.resolve({ deletedCount: 0 });
      const ph = ids.map(() => '?').join(',');
      return Promise.resolve({ deletedCount: getDb().prepare(`DELETE FROM events WHERE test_run_id IN (${ph})`).run(...ids).changes });
    }
    return Promise.resolve({ deletedCount: 0 });
  },
};
