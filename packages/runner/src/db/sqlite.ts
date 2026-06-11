import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, 'cua-tester.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('SQLite not initialized — call connectSQLite() first');
  return _db;
}

export async function connectSQLite(): Promise<void> {
  if (_db) return;

  // Ensure data directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('cache_size = -20000'); // 20MB cache

  createTables(_db);

  console.log('[db] Connected to SQLite at', DB_PATH);
}

function createTables(db: Database.Database) {
  db.exec(`
    -- Events (test execution log entries)
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events (test_run_id, sequence);

    -- Metric Snapshots (time-series)
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      queue_waiting INTEGER DEFAULT 0,
      queue_active INTEGER DEFAULT 0,
      queue_failed INTEGER DEFAULT 0,
      total_runs INTEGER DEFAULT 0,
      failure_rate REAL DEFAULT 0,
      avg_latency_ms REAL DEFAULT 0,
      total_tokens_used INTEGER DEFAULT 0,
      alerts TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metric_snapshots (timestamp);

    -- Sessions (suite runs)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      total INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      timeouts INTEGER DEFAULT 0
    );

    -- Settings (singleton)
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY DEFAULT 'global',
      max_concurrency INTEGER DEFAULT 2,
      max_turns_default INTEGER DEFAULT 500,
      max_tokens_per_session INTEGER DEFAULT 500000,
      default_timeout INTEGER DEFAULT 120000,
      default_headless INTEGER DEFAULT 1,
      allowed_domains TEXT DEFAULT '["appypieautomate.ai","connectcloud.appypie.com"]',
      cua_mode TEXT DEFAULT 'dom',
      updated_at TEXT
    );

    -- Steps (per-turn screenshots + actions)
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      page_url TEXT,
      page_title TEXT,
      action TEXT,
      result TEXT,
      validation TEXT,
      memory TEXT,
      next_goal TEXT,
      dom_fingerprint TEXT,
      confidence REAL,
      vision_used INTEGER DEFAULT 0,
      mode TEXT DEFAULT 'dom',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      api_latency_ms INTEGER DEFAULT 0,
      cumulative_input INTEGER DEFAULT 0,
      cumulative_output INTEGER DEFAULT 0,
      cumulative_reasoning INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_steps_run_turn ON steps (test_run_id, turn_number);

    -- Test Definitions
    CREATE TABLE IF NOT EXISTS test_defs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      instructions TEXT NOT NULL,
      expected_outcome TEXT NOT NULL,
      category TEXT DEFAULT 'sanity',
      tags TEXT DEFAULT '[]',
      requires_auth INTEGER DEFAULT 0,
      max_turns INTEGER DEFAULT 500,
      timeout INTEGER DEFAULT 120000,
      viewport TEXT DEFAULT '{"width":1440,"height":900}',
      page TEXT DEFAULT '',
      cua_mode TEXT,
      version INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_testdefs_active_name ON test_defs (is_active, name);

    -- Test Runs
    CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      test_name TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
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
      page_state TEXT,
      last_heartbeat TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_testruns_session ON test_runs (session_id);
    CREATE INDEX IF NOT EXISTS idx_testruns_test_started ON test_runs (test_id, started_at DESC);
  `);

  // Ensure default settings row exists
  db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES ('global')`).run();
}

// Cleanup old metric snapshots (replaces MongoDB TTL index)
export function cleanupOldMetrics(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('DELETE FROM metric_snapshots WHERE timestamp < ?').run(cutoff);
}
