/**
 * Turso/SQLite repository layer — replaces all 7 Mongoose models.
 *
 * Every function uses `getDb()` from ./turso.js and returns plain objects.
 * Dates are stored as ISO-8601 strings; JSON columns are TEXT with
 * JSON.stringify on write / JSON.parse on read; booleans are INTEGER 0/1.
 */

import type { InValue, Row } from '@libsql/client';
import { getDb } from './turso.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe JSON.parse that returns `null` on failure. */
function jsonParse<T = unknown>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Convert a JS value to a SQLite-safe InValue. */
function toSql(v: unknown): InValue {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as InValue;
}

/** Build a parameterised IN-clause: returns `[sqlFragment, args]`. */
function inClause(arr: string[]): [string, InValue[]] {
  return [arr.map(() => '?').join(','), arr as InValue[]];
}

/**
 * Build SET clause + args from a Record.
 * Keys are assumed to already be snake_case column names.
 */
function setClause(updates: Record<string, unknown>): [string, InValue[]] {
  const cols: string[] = [];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(updates)) {
    cols.push(`${k} = ?`);
    args.push(toSql(v));
  }
  return [cols.join(', '), args];
}

// =========================================================================
// TEST RUNS
// =========================================================================

export interface TestRunRow {
  id: string;
  session_id: string;
  test_id: string;
  test_name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  turn_count: number;
  screenshot_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_verdict: string | null;
  error: string | null;
  page_state: string | null;
  last_heartbeat: string | null;
}

export function formatTestRun(row: Row) {
  return {
    id: row.id as string,
    suite_run_id: row.session_id as string,
    test_id: row.test_id as string,
    test_name: row.test_name as string,
    status: row.status as string,
    started_at: (row.started_at as string) ?? null,
    completed_at: (row.completed_at as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    turn_count: (row.turn_count as number) ?? 0,
    screenshot_count: (row.screenshot_count as number) ?? 0,
    input_tokens: (row.input_tokens as number) ?? 0,
    output_tokens: (row.output_tokens as number) ?? 0,
    reasoning_tokens: (row.reasoning_tokens as number) ?? 0,
    model_verdict: (row.model_verdict as string) ?? null,
    error: (row.error as string) ?? null,
  };
}

export async function createTestRun(
  id: string,
  sessionId: string,
  testId: string,
  testName: string,
) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO test_runs (id, session_id, test_id, test_name, status, started_at)
          VALUES (?, ?, ?, ?, 'queued', ?)`,
    args: [id, sessionId, testId, testName, new Date().toISOString()],
  });
}

export async function getTestRun(id: string) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT * FROM test_runs WHERE id = ?', args: [id] });
  if (rs.rows.length === 0) return null;
  return formatTestRun(rs.rows[0]);
}

export async function getTestRunsBySession(sessionId: string, sort: 'asc' | 'desc' = 'asc') {
  const db = getDb();
  const dir = sort === 'desc' ? 'DESC' : 'ASC';
  const rs = await db.execute({
    sql: `SELECT * FROM test_runs WHERE session_id = ? ORDER BY started_at ${dir}`,
    args: [sessionId],
  });
  return rs.rows.map(formatTestRun);
}

export async function getTestRunsBySessionAndStatus(sessionId: string, statuses: string[]) {
  if (statuses.length === 0) return [];
  const db = getDb();
  const [ph, sArgs] = inClause(statuses);
  const rs = await db.execute({
    sql: `SELECT * FROM test_runs WHERE session_id = ? AND status IN (${ph}) ORDER BY started_at`,
    args: [sessionId, ...sArgs],
  });
  return rs.rows.map(formatTestRun);
}

export async function findRunningTestRuns(statuses: string[], testIds?: string[]) {
  if (statuses.length === 0) return [];
  const db = getDb();
  const [ph, sArgs] = inClause(statuses);
  let sql = `SELECT * FROM test_runs WHERE status IN (${ph})`;
  const args: InValue[] = [...sArgs];
  if (testIds && testIds.length > 0) {
    const [ph2, tArgs] = inClause(testIds);
    sql += ` AND test_id IN (${ph2})`;
    args.push(...tArgs);
  }
  const rs = await db.execute({ sql, args });
  return rs.rows.map(formatTestRun);
}

export async function getLatestRunPerTest() {
  const db = getDb();
  const rs = await db.execute(`
    SELECT t.* FROM test_runs t
    INNER JOIN (
      SELECT test_id, MAX(started_at) AS max_started
      FROM test_runs GROUP BY test_id
    ) latest ON t.test_id = latest.test_id AND t.started_at = latest.max_started
  `);
  return rs.rows.map(formatTestRun);
}

export async function updateTestRun(id: string, updates: Record<string, unknown>) {
  if (Object.keys(updates).length === 0) return;
  const db = getDb();
  const [set, args] = setClause(updates);
  await db.execute({ sql: `UPDATE test_runs SET ${set} WHERE id = ?`, args: [...args, id] });
}

export async function deleteTestRuns(ids: string[]) {
  if (ids.length === 0) return;
  const db = getDb();
  const [ph, args] = inClause(ids);
  await db.execute({ sql: `DELETE FROM test_runs WHERE id IN (${ph})`, args });
}

export async function deleteTestRunsBySession(sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  const db = getDb();
  const [ph, args] = inClause(sessionIds);
  await db.execute({ sql: `DELETE FROM test_runs WHERE session_id IN (${ph})`, args });
}

export async function countTestRuns(where?: Record<string, unknown>) {
  const db = getDb();
  if (!where || Object.keys(where).length === 0) {
    const rs = await db.execute('SELECT COUNT(*) AS cnt FROM test_runs');
    return (rs.rows[0].cnt as number) ?? 0;
  }
  const cols: string[] = [];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(where)) {
    cols.push(`${k} = ?`);
    args.push(toSql(v));
  }
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM test_runs WHERE ${cols.join(' AND ')}`,
    args,
  });
  return (rs.rows[0].cnt as number) ?? 0;
}

export async function countTestRunsBySession(sessionId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT COUNT(*) AS cnt FROM test_runs WHERE session_id = ?',
    args: [sessionId],
  });
  return (rs.rows[0].cnt as number) ?? 0;
}

export async function getRecentCompletedRuns(since: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM test_runs
          WHERE completed_at >= ? AND status NOT IN ('queued','running')
          ORDER BY completed_at DESC`,
    args: [since.toISOString()],
  });
  return rs.rows.map(formatTestRun);
}

export async function getTestRunMetrics() {
  const db = getDb();
  const rs = await db.execute(
    'SELECT status, COUNT(*) AS cnt FROM test_runs GROUP BY status',
  );
  const metrics: Record<string, number> = {};
  for (const row of rs.rows) {
    metrics[row.status as string] = (row.cnt as number) ?? 0;
  }
  return metrics;
}

export async function getTokenMetrics() {
  const db = getDb();
  const rs = await db.execute(`
    SELECT
      COALESCE(SUM(input_tokens), 0)     AS total_input,
      COALESCE(SUM(output_tokens), 0)    AS total_output,
      COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning
    FROM test_runs
  `);
  const row = rs.rows[0];
  return {
    total_input: (row.total_input as number) ?? 0,
    total_output: (row.total_output as number) ?? 0,
    total_reasoning: (row.total_reasoning as number) ?? 0,
  };
}

export async function getLatencyMetrics(since: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT COALESCE(AVG(duration_ms), 0) AS avg_duration
          FROM test_runs
          WHERE completed_at >= ? AND duration_ms IS NOT NULL`,
    args: [since.toISOString()],
  });
  return { avg_duration: (rs.rows[0].avg_duration as number) ?? 0 };
}

export async function getPerTestMetrics(since: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT
            test_id,
            test_name,
            COUNT(*)                                                         AS total,
            SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END)              AS passed,
            SUM(CASE WHEN status IN ('failed','error','timeout') THEN 1 ELSE 0 END) AS failures,
            CASE WHEN COUNT(*) > 0
              THEN CAST(SUM(CASE WHEN status IN ('failed','error','timeout') THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
              ELSE 0 END                                                     AS failure_rate,
            COALESCE(AVG(input_tokens + output_tokens + reasoning_tokens), 0) AS avg_tokens,
            COALESCE(AVG(duration_ms), 0)                                    AS avg_duration
          FROM test_runs
          WHERE started_at >= ?
          GROUP BY test_id`,
    args: [since.toISOString()],
  });
  return rs.rows.map((r) => ({
    test_id: r.test_id as string,
    test_name: r.test_name as string,
    total: (r.total as number) ?? 0,
    passed: (r.passed as number) ?? 0,
    failures: (r.failures as number) ?? 0,
    failure_rate: (r.failure_rate as number) ?? 0,
    avg_tokens: (r.avg_tokens as number) ?? 0,
    avg_duration: (r.avg_duration as number) ?? 0,
  }));
}

export async function findStuckRuns(heartbeatBefore: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM test_runs
          WHERE status = 'running'
            AND (last_heartbeat IS NULL OR last_heartbeat < ?)`,
    args: [heartbeatBefore.toISOString()],
  });
  return rs.rows.map(formatTestRun);
}

export async function findPreviousTimeoutRun(testId: string, excludeRunId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM test_runs
          WHERE test_id = ? AND status = 'timeout' AND id != ?
          ORDER BY completed_at DESC LIMIT 1`,
    args: [testId, excludeRunId],
  });
  if (rs.rows.length === 0) return null;
  return formatTestRun(rs.rows[0]);
}

export async function findFailedRunsSorted() {
  const db = getDb();
  const rs = await db.execute(
    `SELECT * FROM test_runs WHERE status IN ('failed','error') ORDER BY completed_at DESC`,
  );
  return rs.rows.map(formatTestRun);
}

export async function findOldCompletedRuns(sessionIds: string[], excludeStatuses: string[]) {
  if (sessionIds.length === 0) return [];
  const db = getDb();
  const [ph1, a1] = inClause(sessionIds);
  let sql = `SELECT * FROM test_runs WHERE session_id IN (${ph1})`;
  const args: InValue[] = [...a1];
  if (excludeStatuses.length > 0) {
    const [ph2, a2] = inClause(excludeStatuses);
    sql += ` AND status NOT IN (${ph2})`;
    args.push(...a2);
  }
  const rs = await db.execute({ sql, args });
  return rs.rows.map(formatTestRun);
}

// =========================================================================
// STEPS
// =========================================================================

export interface StepRow {
  id: string;
  test_run_id: string;
  turn_number: number;
  file_path: string;
  captured_at: string;
  page_url: string | null;
  page_title: string | null;
  action: string | null;
  result: string | null;
  validation: string | null;
  effective: number | null;
  retry_strategy: string | null;
  memory: string | null;
  next_goal: string | null;
  dom_fingerprint: string | null;
  confidence: number | null;
  vision_used: number;
  mode: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  api_latency_ms: number;
  cumulative_input: number;
  cumulative_output: number;
  cumulative_reasoning: number;
}

export function stepToScreenshot(row: Row) {
  return {
    id: row.id as string,
    test_run_id: row.test_run_id as string,
    turn_number: (row.turn_number as number) ?? 0,
    file_path: row.file_path as string,
    captured_at: (row.captured_at as string) ?? null,
    page_url: (row.page_url as string) ?? null,
    page_title: (row.page_title as string) ?? null,
  };
}

export function stepToTurnToken(row: Row) {
  return {
    id: row.id as string,
    test_run_id: row.test_run_id as string,
    turn_number: (row.turn_number as number) ?? 0,
    input_tokens: (row.input_tokens as number) ?? 0,
    output_tokens: (row.output_tokens as number) ?? 0,
    reasoning_tokens: (row.reasoning_tokens as number) ?? 0,
    api_latency_ms: (row.api_latency_ms as number) ?? 0,
    cumulative_input: (row.cumulative_input as number) ?? 0,
    cumulative_output: (row.cumulative_output as number) ?? 0,
    cumulative_reasoning: (row.cumulative_reasoning as number) ?? 0,
    mode: (row.mode as string) ?? 'dom',
    timestamp: (row.captured_at as string) ?? null,
  };
}

export function formatStep(row: Row) {
  return {
    id: row.id as string,
    test_run_id: row.test_run_id as string,
    turn_number: (row.turn_number as number) ?? 0,
    file_path: row.file_path as string,
    captured_at: (row.captured_at as string) ?? null,
    page_url: (row.page_url as string) ?? null,
    page_title: (row.page_title as string) ?? null,
    action: jsonParse(row.action),
    result: jsonParse(row.result),
    validation: jsonParse(row.validation),
    effective: row.effective != null ? Boolean(row.effective) : null,
    retry_strategy: (row.retry_strategy as string) ?? null,
    memory: (row.memory as string) ?? null,
    next_goal: (row.next_goal as string) ?? null,
    dom_fingerprint: (row.dom_fingerprint as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    vision_used: Boolean(row.vision_used),
    mode: (row.mode as string) ?? 'dom',
    input_tokens: (row.input_tokens as number) ?? 0,
    output_tokens: (row.output_tokens as number) ?? 0,
    reasoning_tokens: (row.reasoning_tokens as number) ?? 0,
    api_latency_ms: (row.api_latency_ms as number) ?? 0,
    cumulative_input: (row.cumulative_input as number) ?? 0,
    cumulative_output: (row.cumulative_output as number) ?? 0,
    cumulative_reasoning: (row.cumulative_reasoning as number) ?? 0,
  };
}

export async function createStep(data: {
  id: string;
  test_run_id: string;
  turn_number: number;
  file_path: string;
  captured_at: string | Date;
  page_url?: string | null;
  page_title?: string | null;
  action?: unknown;
  result?: unknown;
  validation?: unknown;
  effective?: boolean | null;
  retry_strategy?: string | null;
  memory?: string | null;
  next_goal?: string | null;
  dom_fingerprint?: string | null;
  confidence?: number | null;
  vision_used?: boolean;
  mode?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  api_latency_ms?: number;
  cumulative_input?: number;
  cumulative_output?: number;
  cumulative_reasoning?: number;
}) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO steps (
            id, test_run_id, turn_number, file_path, captured_at,
            page_url, page_title, action, result, validation,
            effective, retry_strategy, memory, next_goal, dom_fingerprint,
            confidence, vision_used, mode,
            input_tokens, output_tokens, reasoning_tokens, api_latency_ms,
            cumulative_input, cumulative_output, cumulative_reasoning
          ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?)`,
    args: [
      data.id,
      data.test_run_id,
      data.turn_number,
      data.file_path,
      data.captured_at instanceof Date ? data.captured_at.toISOString() : data.captured_at,
      data.page_url ?? null,
      data.page_title ?? null,
      data.action != null ? JSON.stringify(data.action) : null,
      data.result != null ? JSON.stringify(data.result) : null,
      data.validation != null ? JSON.stringify(data.validation) : null,
      data.effective != null ? (data.effective ? 1 : 0) : null,
      data.retry_strategy ?? null,
      data.memory ?? null,
      data.next_goal ?? null,
      data.dom_fingerprint ?? null,
      data.confidence ?? null,
      data.vision_used ? 1 : 0,
      data.mode ?? 'dom',
      data.input_tokens ?? 0,
      data.output_tokens ?? 0,
      data.reasoning_tokens ?? 0,
      data.api_latency_ms ?? 0,
      data.cumulative_input ?? 0,
      data.cumulative_output ?? 0,
      data.cumulative_reasoning ?? 0,
    ],
  });
}

export async function getStepsByRun(testRunId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM steps WHERE test_run_id = ? ORDER BY turn_number ASC',
    args: [testRunId],
  });
  return rs.rows.map(formatStep);
}

export async function getLastStepForRun(testRunId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM steps WHERE test_run_id = ? ORDER BY turn_number DESC LIMIT 1',
    args: [testRunId],
  });
  if (rs.rows.length === 0) return null;
  return formatStep(rs.rows[0]);
}

export async function updateStepTokens(
  testRunId: string,
  turnNumber: number,
  tokenData: Record<string, unknown>,
) {
  if (Object.keys(tokenData).length === 0) return;
  const db = getDb();
  const [set, args] = setClause(tokenData);
  await db.execute({
    sql: `UPDATE steps SET ${set} WHERE test_run_id = ? AND turn_number = ?`,
    args: [...args, testRunId, turnNumber],
  });
}

export async function deleteStepsByRuns(runIds: string[]) {
  if (runIds.length === 0) return;
  const db = getDb();
  const [ph, args] = inClause(runIds);
  await db.execute({ sql: `DELETE FROM steps WHERE test_run_id IN (${ph})`, args });
}

// =========================================================================
// SESSIONS
// =========================================================================

export function formatSession(row: Row) {
  return {
    id: row.id as string,
    started_at: (row.started_at as string) ?? null,
    completed_at: (row.completed_at as string) ?? null,
    total: (row.total as number) ?? 0,
    passed: (row.passed as number) ?? 0,
    failed: (row.failed as number) ?? 0,
    errors: (row.errors as number) ?? 0,
    timeouts: (row.timeouts as number) ?? 0,
  };
}

export async function createSession(id: string, total: number) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO sessions (id, started_at, total) VALUES (?, ?, ?)`,
    args: [id, new Date().toISOString(), total],
  });
}

export async function getSession(id: string) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT * FROM sessions WHERE id = ?', args: [id] });
  if (rs.rows.length === 0) return null;
  return formatSession(rs.rows[0]);
}

export async function listSessions(limit: number) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?',
    args: [limit],
  });
  return rs.rows.map(formatSession);
}

export async function updateSession(id: string, updates: Record<string, unknown>) {
  if (Object.keys(updates).length === 0) return;
  const db = getDb();
  const [set, args] = setClause(updates);
  await db.execute({ sql: `UPDATE sessions SET ${set} WHERE id = ?`, args: [...args, id] });
}

export async function deleteSession(id: string) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [id] });
}

export async function deleteSessions(ids: string[]) {
  if (ids.length === 0) return;
  const db = getDb();
  const [ph, args] = inClause(ids);
  await db.execute({ sql: `DELETE FROM sessions WHERE id IN (${ph})`, args });
}

export async function countSessions() {
  const db = getDb();
  const rs = await db.execute('SELECT COUNT(*) AS cnt FROM sessions');
  return (rs.rows[0].cnt as number) ?? 0;
}

export async function findOldCompletedSessions(before: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM sessions
          WHERE completed_at IS NOT NULL AND completed_at < ?`,
    args: [before.toISOString()],
  });
  return rs.rows.map(formatSession);
}

// =========================================================================
// EVENTS
// =========================================================================

export function formatEvent(row: Row) {
  return {
    id: row.id as string,
    test_run_id: row.test_run_id as string,
    type: row.type as string,
    message: row.message as string,
    detail: (row.detail as string) ?? null,
    timestamp: (row.timestamp as string) ?? null,
    sequence: (row.sequence as number) ?? 0,
  };
}

export async function createEvent(data: {
  id: string;
  test_run_id: string;
  type: string;
  message: string;
  detail?: string | null;
  timestamp: string | Date;
  sequence: number;
}) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO events (id, test_run_id, type, message, detail, timestamp, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      data.id,
      data.test_run_id,
      data.type,
      data.message,
      data.detail ?? null,
      data.timestamp instanceof Date ? data.timestamp.toISOString() : data.timestamp,
      data.sequence,
    ],
  });
}

export async function getEventsByRun(testRunId: string, afterSequence?: number) {
  const db = getDb();
  if (afterSequence != null) {
    const rs = await db.execute({
      sql: `SELECT * FROM events WHERE test_run_id = ? AND sequence > ? ORDER BY sequence ASC`,
      args: [testRunId, afterSequence],
    });
    return rs.rows.map(formatEvent);
  }
  const rs = await db.execute({
    sql: 'SELECT * FROM events WHERE test_run_id = ? ORDER BY sequence ASC',
    args: [testRunId],
  });
  return rs.rows.map(formatEvent);
}

export async function deleteEventsByRuns(runIds: string[]) {
  if (runIds.length === 0) return;
  const db = getDb();
  const [ph, args] = inClause(runIds);
  await db.execute({ sql: `DELETE FROM events WHERE test_run_id IN (${ph})`, args });
}

export async function deleteAllEvents() {
  const db = getDb();
  await db.execute('DELETE FROM events');
}

// =========================================================================
// SETTINGS
// =========================================================================

export function formatSettings(row: Row) {
  return {
    _id: row.id as string,
    maxConcurrency: (row.max_concurrency as number) ?? 2,
    maxTurnsDefault: (row.max_turns_default as number) ?? 500,
    maxTokensPerSession: (row.max_tokens_per_session as number) ?? 500000,
    defaultTimeout: (row.default_timeout as number) ?? 120000,
    defaultHeadless: Boolean(row.default_headless ?? 1),
    allowedDomains: jsonParse<string[]>(row.allowed_domains) ?? [
      'appypieautomate.ai',
      'connectcloud.appypie.com',
    ],
    cuaMode: (row.cua_mode as string) ?? 'dom',
  };
}

export async function getSettings() {
  const db = getDb();
  const rs = await db.execute("SELECT * FROM settings WHERE id = 'global'");
  if (rs.rows.length === 0) {
    // Seed default row (migrations should have done this, but be safe)
    await db.execute("INSERT OR IGNORE INTO settings (id) VALUES ('global')");
    const rs2 = await db.execute("SELECT * FROM settings WHERE id = 'global'");
    return formatSettings(rs2.rows[0]);
  }
  return formatSettings(rs.rows[0]);
}

export async function updateSettings(updates: Record<string, unknown>) {
  if (Object.keys(updates).length === 0) return;
  const db = getDb();

  // Map camelCase keys the caller might use to snake_case column names
  const keyMap: Record<string, string> = {
    maxConcurrency: 'max_concurrency',
    maxTurnsDefault: 'max_turns_default',
    maxTokensPerSession: 'max_tokens_per_session',
    defaultTimeout: 'default_timeout',
    defaultHeadless: 'default_headless',
    allowedDomains: 'allowed_domains',
    cuaMode: 'cua_mode',
  };

  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    const col = keyMap[k] ?? k;
    if (col === 'allowed_domains' && Array.isArray(v)) {
      mapped[col] = JSON.stringify(v);
    } else if (col === 'default_headless' && typeof v === 'boolean') {
      mapped[col] = v ? 1 : 0;
    } else {
      mapped[col] = v;
    }
  }
  mapped['updated_at'] = new Date().toISOString();

  const [set, args] = setClause(mapped);
  await db.execute({ sql: `UPDATE settings SET ${set} WHERE id = 'global'`, args });
}

// =========================================================================
// TEST DEFS
// =========================================================================

export function formatTestDef(row: Row) {
  return {
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    instructions: row.instructions as string,
    expected_outcome: row.expected_outcome as string,
    category: (row.category as string) ?? 'sanity',
    tags: jsonParse<string[]>(row.tags) ?? [],
    requires_auth: Boolean(row.requires_auth),
    max_turns: (row.max_turns as number) ?? 500,
    timeout: (row.timeout as number) ?? 120000,
    viewport: jsonParse<{ width: number; height: number }>(row.viewport) ?? {
      width: 1440,
      height: 900,
    },
    page: (row.page as string) ?? '',
    cuaMode: (row.cua_mode as string) ?? undefined,
    version: (row.version as number) ?? 1,
    isActive: Boolean(row.is_active),
  };
}

export async function listActiveTestDefs(sort: 'asc' | 'desc' = 'asc') {
  const db = getDb();
  const dir = sort === 'desc' ? 'DESC' : 'ASC';
  const rs = await db.execute(`SELECT * FROM test_defs WHERE is_active = 1 ORDER BY name ${dir}`);
  return rs.rows.map(formatTestDef);
}

export async function getTestDef(id: string) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT * FROM test_defs WHERE id = ?', args: [id] });
  if (rs.rows.length === 0) return null;
  return formatTestDef(rs.rows[0]);
}

export async function getActiveTestDef(id: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM test_defs WHERE id = ? AND is_active = 1',
    args: [id],
  });
  if (rs.rows.length === 0) return null;
  return formatTestDef(rs.rows[0]);
}

export async function createTestDef(data: {
  id: string;
  name: string;
  url: string;
  instructions: string;
  expected_outcome: string;
  category?: string;
  tags?: string[];
  requires_auth?: boolean;
  max_turns?: number;
  timeout?: number;
  viewport?: { width: number; height: number };
  page?: string;
  cua_mode?: string | null;
  version?: number;
  is_active?: boolean;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO test_defs (
            id, name, url, instructions, expected_outcome,
            category, tags, requires_auth, max_turns, timeout,
            viewport, page, cua_mode, version, is_active,
            created_at, updated_at
          ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?)`,
    args: [
      data.id,
      data.name,
      data.url,
      data.instructions,
      data.expected_outcome,
      data.category ?? 'sanity',
      JSON.stringify(data.tags ?? []),
      data.requires_auth ? 1 : 0,
      data.max_turns ?? 500,
      data.timeout ?? 120000,
      JSON.stringify(data.viewport ?? { width: 1440, height: 900 }),
      data.page ?? '',
      data.cua_mode ?? null,
      data.version ?? 1,
      data.is_active !== false ? 1 : 0,
      now,
      now,
    ],
  });
}

export async function updateTestDef(id: string, updates: Record<string, unknown>) {
  if (Object.keys(updates).length === 0) return;
  const db = getDb();

  // Normalise known JSON/boolean columns
  const normalised: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'tags' && Array.isArray(v)) {
      normalised[k] = JSON.stringify(v);
    } else if (k === 'viewport' && typeof v === 'object' && v !== null) {
      normalised[k] = JSON.stringify(v);
    } else if (k === 'requires_auth' && typeof v === 'boolean') {
      normalised[k] = v ? 1 : 0;
    } else if (k === 'is_active' && typeof v === 'boolean') {
      normalised[k] = v ? 1 : 0;
    } else {
      normalised[k] = v;
    }
  }
  normalised['updated_at'] = new Date().toISOString();

  const [set, args] = setClause(normalised);
  await db.execute({ sql: `UPDATE test_defs SET ${set} WHERE id = ?`, args: [...args, id] });
}

export async function incrementTestDefVersion(id: string, updates: Record<string, unknown>) {
  const db = getDb();
  const normalised: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'tags' && Array.isArray(v)) {
      normalised[k] = JSON.stringify(v);
    } else if (k === 'viewport' && typeof v === 'object' && v !== null) {
      normalised[k] = JSON.stringify(v);
    } else if (k === 'requires_auth' && typeof v === 'boolean') {
      normalised[k] = v ? 1 : 0;
    } else if (k === 'is_active' && typeof v === 'boolean') {
      normalised[k] = v ? 1 : 0;
    } else {
      normalised[k] = v;
    }
  }
  normalised['updated_at'] = new Date().toISOString();

  const cols: string[] = ['version = version + 1'];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(normalised)) {
    cols.push(`${k} = ?`);
    args.push(toSql(v));
  }
  await db.execute({
    sql: `UPDATE test_defs SET ${cols.join(', ')} WHERE id = ?`,
    args: [...args, id],
  });
}

export async function softDeleteTestDef(id: string) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE test_defs SET is_active = 0, updated_at = ? WHERE id = ?`,
    args: [new Date().toISOString(), id],
  });
}

// =========================================================================
// METRIC SNAPSHOTS
// =========================================================================

export async function createMetricSnapshot(data: {
  id: string;
  timestamp: string | Date;
  queue_waiting?: number;
  queue_active?: number;
  queue_failed?: number;
  total_runs?: number;
  failure_rate?: number;
  avg_latency_ms?: number;
  total_tokens_used?: number;
  alerts?: string[];
}) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO metric_snapshots (
            id, timestamp, queue_waiting, queue_active, queue_failed,
            total_runs, failure_rate, avg_latency_ms, total_tokens_used, alerts
          ) VALUES (?,?,?,?,?, ?,?,?,?,?)`,
    args: [
      data.id,
      data.timestamp instanceof Date ? data.timestamp.toISOString() : data.timestamp,
      data.queue_waiting ?? 0,
      data.queue_active ?? 0,
      data.queue_failed ?? 0,
      data.total_runs ?? 0,
      data.failure_rate ?? 0,
      data.avg_latency_ms ?? 0,
      data.total_tokens_used ?? 0,
      JSON.stringify(data.alerts ?? []),
    ],
  });
}

export function formatMetricSnapshot(row: Row) {
  return {
    id: row.id as string,
    timestamp: (row.timestamp as string) ?? null,
    queue_waiting: (row.queue_waiting as number) ?? 0,
    queue_active: (row.queue_active as number) ?? 0,
    queue_failed: (row.queue_failed as number) ?? 0,
    total_runs: (row.total_runs as number) ?? 0,
    failure_rate: (row.failure_rate as number) ?? 0,
    avg_latency_ms: (row.avg_latency_ms as number) ?? 0,
    total_tokens_used: (row.total_tokens_used as number) ?? 0,
    alerts: jsonParse<string[]>(row.alerts) ?? [],
  };
}

export async function getMetricsSince(since: Date) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM metric_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC',
    args: [since.toISOString()],
  });
  return rs.rows.map(formatMetricSnapshot);
}

export async function deleteOldMetrics(before: Date) {
  const db = getDb();
  await db.execute({
    sql: 'DELETE FROM metric_snapshots WHERE timestamp < ?',
    args: [before.toISOString()],
  });
}

// =========================================================================
// Convenience re-exports so consumers can get row-level helpers from steps
// (matching the old models/Step.ts exports)
// =========================================================================

export async function getStepScreenshotsByRun(testRunId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM steps WHERE test_run_id = ? ORDER BY turn_number ASC',
    args: [testRunId],
  });
  return rs.rows.map(stepToScreenshot);
}

export async function getStepTurnTokensByRun(testRunId: string) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM steps WHERE test_run_id = ? ORDER BY turn_number ASC',
    args: [testRunId],
  });
  return rs.rows.map(stepToTurnToken);
}
