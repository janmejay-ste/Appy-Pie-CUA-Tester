import { getDb } from '../sqlite.js';

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
  cuaMode?: 'dom' | 'vision';
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TestDefRow {
  id: string; name: string; url: string; instructions: string; expected_outcome: string;
  category: string; tags: string; requires_auth: number; max_turns: number; timeout: number;
  viewport: string; page: string; cua_mode: string | null; version: number;
  is_active: number; created_at: string | null; updated_at: string | null;
}

function rowToDoc(r: TestDefRow): ITestDef & { toJSON: () => any } {
  const doc: ITestDef = {
    _id: r.id, name: r.name, url: r.url, instructions: r.instructions,
    expectedOutcome: r.expected_outcome, category: (r.category || 'sanity') as any,
    tags: JSON.parse(r.tags || '[]'), requiresAuth: !!r.requires_auth,
    maxTurns: r.max_turns, timeout: r.timeout,
    viewport: JSON.parse(r.viewport || '{"width":1440,"height":900}'),
    page: r.page || '', cuaMode: r.cua_mode as any,
    version: r.version, isActive: !!r.is_active,
    createdAt: r.created_at ? new Date(r.created_at) : new Date(),
    updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
  };
  return {
    ...doc,
    toJSON() {
      return {
        id: doc._id, name: doc.name, url: doc.url, instructions: doc.instructions,
        expected_outcome: doc.expectedOutcome, category: doc.category,
        tags: doc.tags, requires_auth: doc.requiresAuth, max_turns: doc.maxTurns,
        timeout: doc.timeout, viewport: doc.viewport, page: doc.page,
        cuaMode: doc.cuaMode, version: doc.version, isActive: doc.isActive,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      };
    },
  };
}

export const TestDef = {
  create(data: Partial<ITestDef> & { _id: string; name: string; url: string; instructions: string; expectedOutcome: string }) {
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO test_defs (id, name, url, instructions, expected_outcome, category, tags, requires_auth, max_turns, timeout, viewport, page, cua_mode, version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data._id, data.name, data.url, data.instructions, data.expectedOutcome,
        data.category || 'sanity', JSON.stringify(data.tags || []),
        data.requiresAuth ? 1 : 0, data.maxTurns ?? 500, data.timeout ?? 120000,
        JSON.stringify(data.viewport || { width: 1440, height: 900 }),
        data.page || '', data.cuaMode ?? null, data.version ?? 1, 1, now, now);
    const r = getDb().prepare('SELECT * FROM test_defs WHERE id = ?').get(data._id) as TestDefRow;
    return rowToDoc(r);
  },

  findById(id: string) {
    const r = getDb().prepare('SELECT * FROM test_defs WHERE id = ?').get(id) as TestDefRow | undefined;
    return Promise.resolve(r ? rowToDoc(r) : null);
  },

  findOne(query: Record<string, any>) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query._id) { conds.push('id = ?'); params.push(query._id); }
    if (query.isActive !== undefined) { conds.push('is_active = ?'); params.push(query.isActive ? 1 : 0); }
    const sql = 'SELECT * FROM test_defs' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' LIMIT 1';
    const chain: any = {
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try {
          const r = getDb().prepare(sql).get(...params) as TestDefRow | undefined;
          resolve(r ? rowToDoc(r) : null);
        } catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.isActive !== undefined) { conds.push('is_active = ?'); params.push(query.isActive ? 1 : 0); }
    let sql = 'SELECT * FROM test_defs' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  updateOne(query: { _id: string }, update: Record<string, any>) {
    const sets = update.$set || {};
    const inc = update.$inc || {};
    const cols: string[] = [];
    const vals: any[] = [];
    const colMap: Record<string, string> = {
      expectedOutcome: 'expected_outcome', requiresAuth: 'requires_auth',
      maxTurns: 'max_turns', isActive: 'is_active', cuaMode: 'cua_mode',
      createdAt: 'created_at', updatedAt: 'updated_at',
    };
    for (const [k, v] of Object.entries(sets)) {
      const col = colMap[k] || k;
      if (k === 'tags' || k === 'viewport') { cols.push(`${col} = ?`); vals.push(JSON.stringify(v)); }
      else if (k === 'requiresAuth' || k === 'isActive') { cols.push(`${col} = ?`); vals.push(v ? 1 : 0); }
      else { cols.push(`${col} = ?`); vals.push(v instanceof Date ? v.toISOString() : v); }
    }
    for (const [k, v] of Object.entries(inc)) {
      const col = colMap[k] || k;
      cols.push(`${col} = ${col} + ?`);
      vals.push(v);
    }
    // Always update updated_at
    cols.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(query._id);
    getDb().prepare(`UPDATE test_defs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
    return Promise.resolve();
  },
};
