import { getDb } from '../sqlite.js';

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
  pageState?: { url: string; title: string; lastActions: string[] } | null;
  lastHeartbeat?: Date | null;
}

interface TestRunRow {
  id: string; session_id: string; test_id: string; test_name: string; status: string;
  started_at: string | null; completed_at: string | null; duration_ms: number | null;
  turn_count: number; screenshot_count: number; input_tokens: number;
  output_tokens: number; reasoning_tokens: number; model_verdict: string | null;
  error: string | null; page_state: string | null; last_heartbeat: string | null;
}

function rowToDoc(r: TestRunRow): ITestRun & { toJSON: () => any } {
  const doc: ITestRun = {
    _id: r.id, sessionId: r.session_id, testId: r.test_id, testName: r.test_name,
    status: r.status as any, startedAt: r.started_at ? new Date(r.started_at) : null,
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    durationMs: r.duration_ms, turnCount: r.turn_count, screenshotCount: r.screenshot_count,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, reasoningTokens: r.reasoning_tokens,
    modelVerdict: r.model_verdict, error: r.error,
    pageState: r.page_state ? JSON.parse(r.page_state) : null,
    lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat) : null,
  };
  return {
    ...doc,
    toJSON() {
      return {
        id: doc._id, suite_run_id: doc.sessionId, test_id: doc.testId, test_name: doc.testName,
        status: doc.status,
        started_at: doc.startedAt instanceof Date ? doc.startedAt.toISOString() : doc.startedAt,
        completed_at: doc.completedAt instanceof Date ? doc.completedAt.toISOString() : doc.completedAt,
        duration_ms: doc.durationMs, turn_count: doc.turnCount, screenshot_count: doc.screenshotCount,
        input_tokens: doc.inputTokens, output_tokens: doc.outputTokens, reasoning_tokens: doc.reasoningTokens,
        model_verdict: doc.modelVerdict, error: doc.error, pageState: doc.pageState,
        lastHeartbeat: doc.lastHeartbeat,
      };
    },
  };
}

const COL_MAP: Record<string, string> = {
  sessionId: 'session_id', testId: 'test_id', testName: 'test_name',
  startedAt: 'started_at', completedAt: 'completed_at', durationMs: 'duration_ms',
  turnCount: 'turn_count', screenshotCount: 'screenshot_count',
  inputTokens: 'input_tokens', outputTokens: 'output_tokens', reasoningTokens: 'reasoning_tokens',
  modelVerdict: 'model_verdict', pageState: 'page_state', lastHeartbeat: 'last_heartbeat',
};

function mapCol(k: string) { return COL_MAP[k] || k; }
function mapVal(k: string, v: any) {
  if (v instanceof Date) return v.toISOString();
  if (k === 'pageState' && v && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export const TestRun = {
  create(data: Partial<ITestRun> & { _id: string; sessionId: string; testId: string; testName: string }) {
    getDb().prepare(`INSERT INTO test_runs (id, session_id, test_id, test_name, status, started_at, completed_at, duration_ms, turn_count, screenshot_count, input_tokens, output_tokens, reasoning_tokens, model_verdict, error, page_state, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data._id, data.sessionId, data.testId, data.testName,
        data.status || 'queued',
        data.startedAt instanceof Date ? data.startedAt.toISOString() : data.startedAt ?? null,
        data.completedAt instanceof Date ? data.completedAt.toISOString() : data.completedAt ?? null,
        data.durationMs ?? null, data.turnCount ?? 0, data.screenshotCount ?? 0,
        data.inputTokens ?? 0, data.outputTokens ?? 0, data.reasoningTokens ?? 0,
        data.modelVerdict ?? null, data.error ?? null,
        data.pageState ? JSON.stringify(data.pageState) : null,
        data.lastHeartbeat instanceof Date ? data.lastHeartbeat.toISOString() : null);
    const r = getDb().prepare('SELECT * FROM test_runs WHERE id = ?').get(data._id) as TestRunRow;
    return rowToDoc(r);
  },

  findById(id: string) {
    const r = getDb().prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as TestRunRow | undefined;
    const result = r ? rowToDoc(r) : null;
    // Return chainable for .lean() compat
    const p = Promise.resolve(result) as any;
    p.lean = () => p;
    return p;
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];

    if (query._id?.$ne) { conds.push('id != ?'); params.push(query._id.$ne); }
    if (query.sessionId) {
      if (typeof query.sessionId === 'string') { conds.push('session_id = ?'); params.push(query.sessionId); }
      else if (query.sessionId.$in) { const ids = query.sessionId.$in; conds.push(`session_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    }
    if (query.testId) { conds.push('test_id = ?'); params.push(query.testId); }
    if (query.status) {
      if (typeof query.status === 'string') { conds.push('status = ?'); params.push(query.status); }
      else if (query.status.$in) { const s = query.status.$in; conds.push(`status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
      else if (query.status.$nin) { const s = query.status.$nin; conds.push(`status NOT IN (${s.map(() => '?').join(',')})`); params.push(...s); }
    }
    if (query.completedAt?.$gte) {
      conds.push('completed_at >= ?');
      params.push(query.completedAt.$gte instanceof Date ? query.completedAt.$gte.toISOString() : query.completedAt.$gte);
    }
    if (query.lastHeartbeat !== undefined) {
      if (query.lastHeartbeat === null) { conds.push('last_heartbeat IS NULL'); }
      else if (query.lastHeartbeat.$lt) { conds.push('last_heartbeat < ?'); params.push(query.lastHeartbeat.$lt instanceof Date ? query.lastHeartbeat.$lt.toISOString() : query.lastHeartbeat.$lt); }
    }
    // Handle $or for recovery queries
    if (query.$or) {
      const orParts: string[] = [];
      for (const cond of query.$or) {
        if (cond.lastHeartbeat === null) orParts.push('last_heartbeat IS NULL');
        else if (cond.lastHeartbeat?.$lt) {
          orParts.push('last_heartbeat < ?');
          params.push(cond.lastHeartbeat.$lt instanceof Date ? cond.lastHeartbeat.$lt.toISOString() : cond.lastHeartbeat.$lt);
        }
      }
      if (orParts.length) conds.push(`(${orParts.join(' OR ')})`);
    }

    let sql = 'SELECT * FROM test_runs' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    let limitVal = 0;
    const chain: any = {
      sort(s: Record<string, number>) {
        orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${mapCol(k)} ${v === -1 ? 'DESC' : 'ASC'}`).join(', ');
        return chain;
      },
      limit(n: number) { limitVal = n; return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy + (limitVal ? ` LIMIT ${limitVal}` : '')).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  updateOne(query: { _id: string }, update: Record<string, any>) {
    const sets = update.$set || {};
    const cols: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(sets)) {
      cols.push(`${mapCol(k)} = ?`);
      vals.push(mapVal(k, v));
    }
    if (!cols.length) return Promise.resolve();
    vals.push(query._id);
    getDb().prepare(`UPDATE test_runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
    return Promise.resolve();
  },

  countDocuments(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.sessionId) { conds.push('session_id = ?'); params.push(query.sessionId); }
    if (!Object.keys(query).length) return Promise.resolve((getDb().prepare('SELECT COUNT(*) as c FROM test_runs').get() as any).c);
    const sql = 'SELECT COUNT(*) as c FROM test_runs' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    return Promise.resolve((getDb().prepare(sql).get(...params) as any).c);
  },

  deleteMany(query: Record<string, any> = {}) {
    if (!Object.keys(query).length) return Promise.resolve({ deletedCount: getDb().prepare('DELETE FROM test_runs').run().changes });
    if (query._id?.$in) {
      const ids = query._id.$in as string[];
      if (!ids.length) return Promise.resolve({ deletedCount: 0 });
      const ph = ids.map(() => '?').join(',');
      return Promise.resolve({ deletedCount: getDb().prepare(`DELETE FROM test_runs WHERE id IN (${ph})`).run(...ids).changes });
    }
    return Promise.resolve({ deletedCount: 0 });
  },

  aggregate(pipeline: any[]) {
    // Only supports the specific aggregation patterns used in this app
    return Promise.resolve(_aggregate(pipeline));
  },
};

function _aggregate(pipeline: any[]): any[] {
  const db = getDb();

  // Pattern 1: Group by status count — [{$group: {_id: '$status', count: {$sum: 1}}}]
  const groupStage = pipeline.find(s => s.$group);
  if (groupStage && groupStage.$group._id === '$status') {
    return db.prepare('SELECT status as _id, COUNT(*) as count FROM test_runs GROUP BY status').all();
  }

  // Pattern 2: Token totals — [{$group: {_id: null, totalInput: {$sum: '$inputTokens'}, ...}}]
  if (groupStage && groupStage.$group._id === null && groupStage.$group.totalInput) {
    const r = db.prepare('SELECT SUM(input_tokens) as totalInput, SUM(output_tokens) as totalOutput, SUM(reasoning_tokens) as totalReasoning FROM test_runs').get() as any;
    return [{ _id: null, totalInput: r.totalInput || 0, totalOutput: r.totalOutput || 0, totalReasoning: r.totalReasoning || 0 }];
  }

  // Pattern 3: Latency stats — [{$match: {durationMs: {$ne: null}}}, {$group: {_id: null, avgMs, maxMs, minMs}}]
  const matchStage = pipeline.find(s => s.$match);
  if (matchStage?.['$match']?.durationMs && groupStage?.$group?.avgMs) {
    const r = db.prepare('SELECT AVG(duration_ms) as avgMs, MAX(duration_ms) as maxMs, MIN(duration_ms) as minMs FROM test_runs WHERE duration_ms IS NOT NULL').get() as any;
    return [{ _id: null, avgMs: r.avgMs || 0, maxMs: r.maxMs || 0, minMs: r.minMs || 0 }];
  }

  // Pattern 4: Per-test metrics — complex grouping with conditional counts
  if (groupStage && groupStage.$group._id === '$testId') {
    const rows = db.prepare(`
      SELECT test_id as _id, test_name,
        COUNT(*) as runs,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status IN ('failed', 'error') THEN 1 ELSE 0 END) as failed,
        AVG(duration_ms) as avgDuration,
        SUM(input_tokens) + SUM(output_tokens) as totalTokens,
        MAX(started_at) as lastRun
      FROM test_runs GROUP BY test_id, test_name
    `).all() as any[];
    return rows.map(r => ({
      _id: r._id, testName: r.test_name, runs: r.runs, passed: r.passed, failed: r.failed,
      avgDuration: Math.round(r.avgDuration || 0), totalTokens: r.totalTokens || 0,
      failureRate: r.runs > 0 ? Math.round((r.failed / r.runs) * 100) : 0,
      lastRun: r.lastRun,
    }));
  }

  // Pattern 5: Latest run per test — [{$sort}, {$group: {_id: '$testId', doc: {$first: '$$ROOT'}}}, ...]
  if (pipeline.some(s => s.$replaceRoot)) {
    const rows = db.prepare(`
      SELECT t.* FROM test_runs t
      INNER JOIN (SELECT test_id, MAX(started_at) as max_started FROM test_runs GROUP BY test_id) g
      ON t.test_id = g.test_id AND t.started_at = g.max_started
      ORDER BY t.started_at DESC
    `).all() as TestRunRow[];
    return rows.map(r => rowToDoc(r));
  }

  return [];
}
