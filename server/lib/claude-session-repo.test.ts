/**
 * The persistence side of a canonical Claude Code session: load by session_key
 * or by claude_session_id, round-trip the full state, list the active phases,
 * and survive malformed stored JSON.
 *
 * @covers CCS-01
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createClaudeSessionRepo } from './claude-session-repo';
import { makeInitialState } from './claude-session-state';

const T0 = 1_700_000_000_000;

function freshDb(): Database {
  const db = new Database(':memory:');
  // Minimal schema for the FK: topics(session_key).
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
  db.run(`
    CREATE TABLE claude_code_sessions (
      session_key TEXT PRIMARY KEY,
      claude_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
    )
  `);
  // Apply the migrations that shape claude_code_sessions (027 tracker columns,
  // 096 import_offset) statement-by-statement.
  const migDir = join(import.meta.dir, '..', 'db', 'migrations');
  const apply = (prefix: string) => {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    // Strip line comments so the simple `;` splitter works, then run each
    // statement individually. These migrations only have trivial DDL.
    const sql = readFileSync(join(migDir, file), 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      db.run(stmt);
    }
  };
  apply('027-');
  apply('096-');
  return db;
}

describe('claude-session-repo', () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    db.prepare(`INSERT INTO topics (session_key) VALUES (?)`).run('topic-a');
    db.prepare(`
      INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('topic-a', 'cli-1', new Date(T0).toISOString(), new Date(T0).toISOString());
  });

  it('loads a row by session_key with sensible defaults', () => {
    const repo = createClaudeSessionRepo(db);
    const s = repo.loadBySessionKey('topic-a');
    expect(s).not.toBeNull();
    expect(s!.phase).toBe('dormant');
    expect(s!.rev).toBe(0);
    expect(s!.jsonlOffset).toBe(0);
    expect(s!.sessionKey).toBe('topic-a');
  });

  it('loads a row by claude_session_id', () => {
    const repo = createClaudeSessionRepo(db);
    const s = repo.loadByClaudeSessionId('cli-1');
    expect(s?.sessionKey).toBe('topic-a');
  });

  it('round-trips full state through update + load', () => {
    const repo = createClaudeSessionRepo(db);
    const next = {
      ...makeInitialState('cli-1', 'topic-a', T0),
      phase: 'tool-running' as const,
      phaseUpdatedAt: T0 + 100,
      jsonlPath: '/tmp/x.jsonl',
      jsonlOffset: 1234,
      lastTool: { name: 'Bash', input: { command: 'ls' }, startedAt: T0 + 50 },
      pendingApproval: undefined,
      lastHookAt: T0 + 100,
      rev: 5,
      updatedAt: T0 + 100,
    };
    expect(repo.update(next)).toBe(true);
    const loaded = repo.loadBySessionKey('topic-a')!;
    expect(loaded.phase).toBe('tool-running');
    expect(loaded.rev).toBe(5);
    expect(loaded.lastTool).toEqual({ name: 'Bash', input: { command: 'ls' }, startedAt: T0 + 50 });
    expect(loaded.jsonlOffset).toBe(1234);
    expect(loaded.jsonlPath).toBe('/tmp/x.jsonl');
  });

  it('update returns false when no row matches', () => {
    const repo = createClaudeSessionRepo(db);
    const orphan = { ...makeInitialState('cli-other', 'topic-missing', T0), rev: 1 };
    expect(repo.update(orphan)).toBe(false);
  });

  it('listActive returns rows in active phases', () => {
    const repo = createClaudeSessionRepo(db);
    db.prepare(`INSERT INTO topics VALUES (?)`).run('topic-b');
    db.prepare(`
      INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('topic-b', 'cli-2', new Date(T0).toISOString(), new Date(T0).toISOString(), 'running', new Date(T0).toISOString());

    const active = repo.listActive();
    expect(active.map((s) => s.sessionKey).sort()).toEqual(['topic-b']);
  });

  it('survives malformed JSON in storage by treating fields as undefined', () => {
    db.prepare(`UPDATE claude_code_sessions SET pending_approval_json = 'not-json' WHERE session_key = ?`).run('topic-a');
    const repo = createClaudeSessionRepo(db);
    const s = repo.loadBySessionKey('topic-a')!;
    expect(s.pendingApproval).toBeUndefined();
  });
});
