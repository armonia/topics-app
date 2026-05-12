/**
 * Integration test for the v3 foundations AGENT-01 FSM adoption inside
 * `server/agent-heartbeat.ts`. Verifies the heartbeat checker:
 *   - Marks `active` sessions with stale heartbeats as `stale` (existing
 *     behavior, preserved).
 *   - Does NOT overwrite terminal `completed` / `error` rows even when
 *     they would otherwise match the staleness query (race-condition
 *     defense: the conditional UPDATE `WHERE id = ? AND status = ?`
 *     guarantees the row didn't change underneath the FSM guard).
 *
 * Run with: `bun test tests/unit/agent-heartbeat-fsm.test.ts`
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { startHeartbeatChecker } from '../../server/agent-heartbeat';

function freshDb(): Database {
  const db = new Database(':memory:');
  // Minimum schema for agent_sessions per server/db/migrations/001-initial.sql
  // — built one statement at a time to keep the test pure.
  db.prepare(`
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'busy', 'paused', 'offline')),
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `).run();
  db.prepare(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      session_key TEXT NOT NULL,
      topic_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'error', 'stale')),
      task_id TEXT,
      started_at TEXT NOT NULL DEFAULT '',
      last_heartbeat TEXT,
      completed_at TEXT,
      total_tokens INTEGER DEFAULT 0,
      error_message TEXT
    )
  `).run();
  return db;
}

function insertSession(
  db: Database,
  row: {
    id: string;
    status: 'active' | 'paused' | 'completed' | 'error' | 'stale';
    last_heartbeat: string | null;
    started_at?: string;
  },
): void {
  db.prepare(`
    INSERT INTO agent_sessions (id, session_key, status, started_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, `sk-${row.id}`, row.status, row.started_at ?? '2026-05-12T00:00:00Z', row.last_heartbeat);
}

function getStatus(db: Database, id: string): string {
  const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(id) as { status: string } | null;
  return row?.status ?? '<missing>';
}

// startHeartbeatChecker registers a setInterval. Stub it out for the
// duration of the call so we run a single deterministic tick.
function runCheckerOnce(db: Database): void {
  const realInterval = globalThis.setInterval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.setInterval = ((..._args: unknown[]) => 0 as any) as typeof globalThis.setInterval;
  try {
    startHeartbeatChecker(db, () => { /* broadcast no-op for the test */ });
  } finally {
    globalThis.setInterval = realInterval;
  }
}

describe('agent-heartbeat × AGENT-FSM adoption', () => {
  test('marks stale-heartbeat active session as stale', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-1',
      status: 'active',
      last_heartbeat: '2020-01-01T00:00:00Z', // very old → stale
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-1')).toBe('stale');
    db.close();
  });

  test('marks never-heartbeat old active session as stale', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-2',
      status: 'active',
      last_heartbeat: null,
      started_at: '2020-01-01T00:00:00Z',
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-2')).toBe('stale');
    db.close();
  });

  test('does NOT touch a paused session with stale heartbeat', () => {
    // The SELECT filters by status='active', so paused stays put even with
    // stale heartbeats — the heartbeat checker is explicitly active-only.
    const db = freshDb();
    insertSession(db, {
      id: 's-3',
      status: 'paused',
      last_heartbeat: '2020-01-01T00:00:00Z',
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-3')).toBe('paused');
    db.close();
  });

  test('does NOT touch terminal states (completed)', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-4',
      status: 'completed',
      last_heartbeat: '2020-01-01T00:00:00Z',
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-4')).toBe('completed');
    db.close();
  });

  test('does NOT touch terminal states (error)', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-5',
      status: 'error',
      last_heartbeat: '2020-01-01T00:00:00Z',
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-5')).toBe('error');
    db.close();
  });

  test('does NOT re-stale an already-stale session', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-6',
      status: 'stale',
      last_heartbeat: '2020-01-01T00:00:00Z',
    });

    runCheckerOnce(db);

    // SELECT filters by status='active', so stale rows are skipped.
    expect(getStatus(db, 's-6')).toBe('stale');
    db.close();
  });

  test('fresh active session with recent heartbeat is left alone', () => {
    const db = freshDb();
    insertSession(db, {
      id: 's-7',
      status: 'active',
      last_heartbeat: new Date().toISOString(),
    });

    runCheckerOnce(db);

    expect(getStatus(db, 's-7')).toBe('active');
    db.close();
  });
});
