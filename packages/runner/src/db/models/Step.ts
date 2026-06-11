import { getDb } from '../sqlite.js';

export interface IStep {
  _id: string;
  testRunId: string;
  turnNumber: number;
  filePath: string;
  capturedAt: Date;
  pageUrl: string | null;
  pageTitle: string | null;
  action?: { type: string; target?: string; value?: string };
  result?: { success: boolean; error?: string; description?: string };
  validation?: { urlChanged: boolean; domChanged: boolean; valueChanged: boolean; errorAppeared: boolean; errorMessage?: string };
  memory?: string;
  nextGoal?: string;
  domFingerprint?: string;
  confidence?: number;
  visionUsed?: boolean;
  mode?: 'dom' | 'vision' | 'vision-burst';
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  apiLatencyMs: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeReasoning: number;
}

interface StepRow {
  id: string; test_run_id: string; turn_number: number; file_path: string;
  captured_at: string; page_url: string | null; page_title: string | null;
  action: string | null; result: string | null; validation: string | null;
  memory: string | null; next_goal: string | null; dom_fingerprint: string | null;
  confidence: number | null; vision_used: number; mode: string;
  input_tokens: number; output_tokens: number; reasoning_tokens: number;
  api_latency_ms: number; cumulative_input: number; cumulative_output: number; cumulative_reasoning: number;
}

function rowToDoc(r: StepRow): IStep {
  return {
    _id: r.id, testRunId: r.test_run_id, turnNumber: r.turn_number,
    filePath: r.file_path, capturedAt: new Date(r.captured_at),
    pageUrl: r.page_url, pageTitle: r.page_title,
    action: r.action ? JSON.parse(r.action) : undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
    validation: r.validation ? JSON.parse(r.validation) : undefined,
    memory: r.memory ?? undefined, nextGoal: r.next_goal ?? undefined,
    domFingerprint: r.dom_fingerprint ?? undefined,
    confidence: r.confidence ?? undefined,
    visionUsed: !!r.vision_used, mode: (r.mode || 'dom') as any,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, reasoningTokens: r.reasoning_tokens,
    apiLatencyMs: r.api_latency_ms, cumulativeInput: r.cumulative_input,
    cumulativeOutput: r.cumulative_output, cumulativeReasoning: r.cumulative_reasoning,
  };
}

export const Step = {
  create(data: Partial<IStep> & { _id: string; testRunId: string; turnNumber: number; filePath: string; capturedAt: Date }) {
    const ts = data.capturedAt instanceof Date ? data.capturedAt.toISOString() : String(data.capturedAt);
    getDb().prepare(`INSERT INTO steps (id, test_run_id, turn_number, file_path, captured_at, page_url, page_title, action, result, validation, memory, next_goal, dom_fingerprint, confidence, vision_used, mode, input_tokens, output_tokens, reasoning_tokens, api_latency_ms, cumulative_input, cumulative_output, cumulative_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data._id, data.testRunId, data.turnNumber, data.filePath, ts,
        data.pageUrl ?? null, data.pageTitle ?? null,
        data.action ? JSON.stringify(data.action) : null,
        data.result ? JSON.stringify(data.result) : null,
        data.validation ? JSON.stringify(data.validation) : null,
        data.memory ?? null, data.nextGoal ?? null, data.domFingerprint ?? null,
        data.confidence ?? null, data.visionUsed ? 1 : 0, data.mode || 'dom',
        data.inputTokens ?? 0, data.outputTokens ?? 0, data.reasoningTokens ?? 0,
        data.apiLatencyMs ?? 0, data.cumulativeInput ?? 0, data.cumulativeOutput ?? 0, data.cumulativeReasoning ?? 0);
    return rowToDoc({ id: data._id, test_run_id: data.testRunId, turn_number: data.turnNumber, file_path: data.filePath, captured_at: ts, page_url: data.pageUrl ?? null, page_title: data.pageTitle ?? null, action: data.action ? JSON.stringify(data.action) : null, result: data.result ? JSON.stringify(data.result) : null, validation: data.validation ? JSON.stringify(data.validation) : null, memory: data.memory ?? null, next_goal: data.nextGoal ?? null, dom_fingerprint: data.domFingerprint ?? null, confidence: data.confidence ?? null, vision_used: data.visionUsed ? 1 : 0, mode: data.mode || 'dom', input_tokens: data.inputTokens ?? 0, output_tokens: data.outputTokens ?? 0, reasoning_tokens: data.reasoningTokens ?? 0, api_latency_ms: data.apiLatencyMs ?? 0, cumulative_input: data.cumulativeInput ?? 0, cumulative_output: data.cumulativeOutput ?? 0, cumulative_reasoning: data.cumulativeReasoning ?? 0 });
  },

  findOne(query: Record<string, any>) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.testRunId) { conds.push('test_run_id = ?'); params.push(query.testRunId); }
    let sql = 'SELECT * FROM steps' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k === 'turnNumber' ? 'turn_number' : k} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try {
          const r = getDb().prepare(sql + orderBy + ' LIMIT 1').get(...params) as StepRow | undefined;
          resolve(r ? rowToDoc(r) : null);
        } catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  find(query: Record<string, any> = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (query.testRunId) { conds.push('test_run_id = ?'); params.push(query.testRunId); }
    let sql = 'SELECT * FROM steps' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '');
    let orderBy = '';
    const chain: any = {
      sort(s: Record<string, number>) { orderBy = ' ORDER BY ' + Object.entries(s).map(([k, v]) => `${k === 'turnNumber' ? 'turn_number' : k} ${v === -1 ? 'DESC' : 'ASC'}`).join(', '); return chain; },
      lean() { return chain; },
      then(resolve: Function, reject?: Function) {
        try { resolve(getDb().prepare(sql + orderBy).all(...params).map((r: any) => rowToDoc(r))); }
        catch (e) { reject?.(e); }
      },
    };
    return chain;
  },

  updateOne(query: Record<string, any>, update: Record<string, any>) {
    const sets = update.$set || update;
    const cols: string[] = [];
    const vals: any[] = [];
    const colMap: Record<string, string> = {
      inputTokens: 'input_tokens', outputTokens: 'output_tokens', reasoningTokens: 'reasoning_tokens',
      apiLatencyMs: 'api_latency_ms', cumulativeInput: 'cumulative_input',
      cumulativeOutput: 'cumulative_output', cumulativeReasoning: 'cumulative_reasoning',
      visionUsed: 'vision_used',
    };
    for (const [k, v] of Object.entries(sets)) {
      const col = colMap[k] || k;
      cols.push(`${col} = ?`);
      vals.push(k === 'visionUsed' ? (v ? 1 : 0) : v);
    }
    if (!cols.length) return Promise.resolve();
    const conds: string[] = [];
    if (query.testRunId) { conds.push('test_run_id = ?'); vals.push(query.testRunId); }
    if (query.turnNumber !== undefined) { conds.push('turn_number = ?'); vals.push(query.turnNumber); }
    if (query._id) { conds.push('id = ?'); vals.push(query._id); }
    getDb().prepare(`UPDATE steps SET ${cols.join(', ')} WHERE ${conds.join(' AND ')}`).run(...vals);
    return Promise.resolve();
  },

  deleteMany(query: Record<string, any> = {}) {
    if (!Object.keys(query).length) return Promise.resolve({ deletedCount: getDb().prepare('DELETE FROM steps').run().changes });
    if (query.testRunId?.$in) {
      const ids = query.testRunId.$in as string[];
      if (!ids.length) return Promise.resolve({ deletedCount: 0 });
      const ph = ids.map(() => '?').join(',');
      return Promise.resolve({ deletedCount: getDb().prepare(`DELETE FROM steps WHERE test_run_id IN (${ph})`).run(...ids).changes });
    }
    return Promise.resolve({ deletedCount: 0 });
  },
};

export function stepToScreenshot(s: IStep) {
  return {
    id: s._id, test_run_id: s.testRunId, turn_number: s.turnNumber,
    file_path: s.filePath,
    captured_at: s.capturedAt instanceof Date ? s.capturedAt.toISOString() : s.capturedAt,
    page_url: s.pageUrl, page_title: s.pageTitle,
  };
}

export function stepToTurnToken(s: IStep) {
  return {
    id: s._id, test_run_id: s.testRunId, turn_number: s.turnNumber,
    input_tokens: s.inputTokens, output_tokens: s.outputTokens,
    reasoning_tokens: s.reasoningTokens, api_latency_ms: s.apiLatencyMs,
    cumulative_input: s.cumulativeInput, cumulative_output: s.cumulativeOutput,
    cumulative_reasoning: s.cumulativeReasoning, mode: s.mode || 'dom',
    timestamp: s.capturedAt instanceof Date ? s.capturedAt.toISOString() : s.capturedAt,
  };
}
