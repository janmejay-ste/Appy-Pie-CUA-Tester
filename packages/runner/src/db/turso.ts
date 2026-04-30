import { createClient, type Client } from '@libsql/client';
import { logger } from '../logger.js';

let client: Client;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
    const authToken = process.env.TURSO_AUTH_TOKEN;
    client = createClient({ url, authToken });
    logger.info({ url: url.startsWith('libsql') ? url : 'file:local.db' }, 'Turso client created');
  }
  return client;
}

export async function connectDb(): Promise<void> {
  const db = getDb();
  await runMigrations(db);
  logger.info('Turso database ready');
}

async function runMigrations(db: Client): Promise<void> {
  await db.executeMultiple(`
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
    CREATE INDEX IF NOT EXISTS idx_test_runs_test_id ON test_runs(test_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_test_runs_session_status ON test_runs(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_test_runs_session_id ON test_runs(session_id);

    -- Steps
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
      effective INTEGER,
      retry_strategy TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_steps_run_turn ON steps(test_run_id, turn_number);

    -- Sessions (Suite Runs)
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

    -- Events
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(test_run_id, sequence);

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
    CREATE INDEX IF NOT EXISTS idx_test_defs_active ON test_defs(is_active, name);

    -- Metric Snapshots
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
    CREATE INDEX IF NOT EXISTS idx_metric_snapshots_ts ON metric_snapshots(timestamp);

    -- Seed default settings if not exists
    INSERT OR IGNORE INTO settings (id) VALUES ('global');
  `);
}
