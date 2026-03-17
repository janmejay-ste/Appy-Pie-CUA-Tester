import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'; // types from sql.js.d.ts
import path from 'path';
import fs from 'fs';

const DB_PATH = path.resolve(process.cwd(), 'data', 'test-results.db');

let sqlJsDb: SqlJsDatabase | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Save helpers ──────────────────────────────────────────────
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (sqlJsDb) {
    try {
      const data = sqlJsDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('[db] Error saving database:', err);
    }
  }
}

// Save on exit
process.on('exit', saveNow);
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

// ── better-sqlite3 compatibility wrapper ──────────────────────
class PreparedStatement {
  constructor(private db: SqlJsDatabase, private sql: string) {}

  run(...params: any[]) {
    this.db.run(this.sql, params);
    scheduleSave();
  }

  all(...params: any[]): any[] {
    const stmt = this.db.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  get(...params: any[]): any | undefined {
    const stmt = this.db.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    let row: any = undefined;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }
}

class DbWrapper {
  constructor(private db: SqlJsDatabase) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql);
  }

  exec(sql: string) {
    this.db.exec(sql);
    scheduleSave();
  }

  pragma(_str: string) {
    // sql.js doesn't support WAL mode — silently ignore
  }
}

let wrapper: DbWrapper | null = null;

// ── Public API ────────────────────────────────────────────────
export async function initDb(): Promise<void> {
  if (wrapper) return;

  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlJsDb = new SQL.Database(fileBuffer);
    console.log('[db] Loaded existing database from', DB_PATH);
  } else {
    sqlJsDb = new SQL.Database();
    console.log('[db] Created new database at', DB_PATH);
  }

  wrapper = new DbWrapper(sqlJsDb);
  migrate(wrapper);
}

export function getDb(): DbWrapper {
  if (!wrapper) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return wrapper;
}

// ── Schema ────────────────────────────────────────────────────
function migrate(db: DbWrapper) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suite_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      total INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      timeouts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      suite_run_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      test_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      turn_count INTEGER DEFAULT 0,
      screenshot_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      model_verdict TEXT,
      error TEXT,
      FOREIGN KEY (suite_run_id) REFERENCES suite_runs(id)
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      page_url TEXT,
      page_title TEXT,
      FOREIGN KEY (test_run_id) REFERENCES test_runs(id)
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (test_run_id) REFERENCES test_runs(id)
    );

    CREATE TABLE IF NOT EXISTS turn_tokens (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      api_latency_ms INTEGER DEFAULT 0,
      cumulative_input INTEGER DEFAULT 0,
      cumulative_output INTEGER DEFAULT 0,
      cumulative_reasoning INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (test_run_id) REFERENCES test_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_test_runs_suite ON test_runs(suite_run_id);
    CREATE INDEX IF NOT EXISTS idx_screenshots_run ON screenshots(test_run_id);
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(test_run_id);
    CREATE INDEX IF NOT EXISTS idx_turn_tokens_run ON turn_tokens(test_run_id);
  `);
}
