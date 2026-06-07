import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createClaudeSessionTracker, type ClaudeSessionTracker } from './claude-session-tracker';

const T0 = 1_700_000_000_000;

function freshDb(): Database {
  const db = new Database(':memory:');
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
  const migDir = join(import.meta.dir, '..', 'db', 'migrations');
  const m027 = readdirSync(migDir).find((f) => f.startsWith('027-'))!;
  const sql = readFileSync(join(migDir, m027), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    db.run(stmt);
  }
  return db;
}

function seedSession(db: Database, sessionKey: string, claudeSessionId: string, jsonlPath?: string) {
  db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
  db.prepare(`
    INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at, jsonl_path)
    VALUES (?, ?, ?, ?, 'starting', ?, ?)
  `).run(sessionKey, claudeSessionId, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString(), jsonlPath ?? null);
}

interface Recorder {
  events: any[];
  broadcast: (msg: object) => void;
  waitForBroadcast(): Promise<void>;
}

function makeRecorder(): Recorder {
  const events: any[] = [];
  return {
    events,
    broadcast: (msg: object) => events.push(msg),
    waitForBroadcast: () => new Promise((r) => setTimeout(r, 80)),
  };
}

function makeTracker(db: Database, rec: Recorder, overrides: Partial<Parameters<typeof createClaudeSessionTracker>[0]> = {}): ClaudeSessionTracker {
  return createClaudeSessionTracker({
    db,
    broadcast: rec.broadcast,
    coalesceWindowMs: 20,
    dedupWindowMs: 100,
    rateLimitPerSec: 50,
    ...overrides,
  });
}

describe('ClaudeSessionTracker — ingestHook', () => {
  let db: Database;
  let rec: Recorder;
  let tracker: ClaudeSessionTracker;

  beforeEach(() => {
    db = freshDb();
    rec = makeRecorder();
    seedSession(db, 'topic-a', 'cli-1');
    tracker = makeTracker(db, rec);
  });

  it('returns unknown-session for a hook against an unknown claude_session_id', () => {
    const res = tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-unknown' }, T0 + 10);
    expect(res.kind).toBe('unknown-session');
    expect(rec.events.length).toBe(0);
  });

  it('persists state and schedules a broadcast on a real transition', async () => {
    const res = tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-1' }, T0 + 10);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.changed).toBe(true);
      expect(res.state.phase).toBe('running');
      expect(res.state.rev).toBe(1);
    }
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(1);
    expect(rec.events[0]).toEqual({
      type: 'session:state',
      sessionKey: 'topic-a',
      state: expect.objectContaining({ phase: 'running', rev: 1 }),
    });
  });

  it('coalesces a burst of transitions into a single broadcast carrying the latest state', async () => {
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-1' }, T0 + 10);
    tracker.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'cli-1', tool_name: 'Bash' }, T0 + 12);
    tracker.ingestHook({ hook_event_name: 'PostToolUse', session_id: 'cli-1', tool_name: 'Bash' }, T0 + 14);
    await rec.waitForBroadcast();

    expect(rec.events.length).toBe(1);
    expect(rec.events[0].state.phase).toBe('running');
    expect(rec.events[0].state.rev).toBe(3);
  });

  it('drops duplicate hooks within the dedup window', () => {
    const r1 = tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-1' }, T0 + 10);
    const r2 = tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-1' }, T0 + 50);
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('duplicate');
  });

  it('admits duplicates after the dedup window elapses', () => {
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-1' }, T0 + 10);
    const r2 = tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-1' }, T0 + 1000);
    // Same phase, but a fresh event — accepted by dedup. Pure layer ignores
    // it as no-op (rev unchanged) but tracker still reports ok.
    expect(r2.kind).toBe('ok');
  });

  it('rate-limits beyond the per-second budget', () => {
    const db2 = freshDb();
    seedSession(db2, 'topic-b', 'cli-rate');
    const rec2 = makeRecorder();
    const trk = makeTracker(db2, rec2, { rateLimitPerSec: 3 });
    expect(trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-rate' }, T0 + 1).kind).toBe('ok');
    expect(trk.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'cli-rate', tool_name: 'Bash' }, T0 + 2).kind).toBe('ok');
    expect(trk.ingestHook({ hook_event_name: 'PostToolUse', session_id: 'cli-rate' }, T0 + 3).kind).toBe('ok');
    expect(trk.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-rate' }, T0 + 4).kind).toBe('rate-limited');
  });

  it('admits another event in a fresh 1-second bucket', () => {
    const db2 = freshDb();
    seedSession(db2, 'topic-b', 'cli-rate');
    const rec2 = makeRecorder();
    const trk = makeTracker(db2, rec2, { rateLimitPerSec: 1 });
    expect(trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-rate' }, T0).kind).toBe('ok');
    expect(trk.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-rate' }, T0 + 10).kind).toBe('rate-limited');
    expect(trk.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-rate' }, T0 + 1100).kind).toBe('ok');
  });

  it('returns unknown-event for unknown hook_event_name', () => {
    const r = tracker.ingestHook({ hook_event_name: 'MagicNewEvent' as any, session_id: 'cli-1' }, T0);
    expect(r.kind).toBe('unknown-event');
  });
});

describe('ClaudeSessionTracker — reaper', () => {
  it('reapOnce demotes a stuck tool-running session', () => {
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    const rec = makeRecorder();
    // Manually force tool-running phase.
    db.prepare(`UPDATE claude_code_sessions SET phase='tool-running', phase_updated_at=?, rev=2 WHERE session_key='topic-a'`)
      .run(new Date(T0).toISOString());
    const trk = makeTracker(db, rec, {
      reaperConfig: { toolRunningTimeoutMs: 1000, awaitingApprovalTimeoutMs: 1000, startTimeoutMs: 1000 },
    });
    expect(trk.reapOnce(T0 + 2000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('running');
  });

  it('reapOnce is a no-op when nothing is stale', () => {
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    const trk = makeTracker(db, makeRecorder());
    expect(trk.reapOnce(T0 + 1)).toBe(0);
  });
});

describe('ClaudeSessionTracker — JSONL recovery', () => {
  it('replays a JSONL file from the persisted offset and updates phase', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tracker-jsonl-'));
    const jsonlPath = join(tmp, 'session.jsonl');
    const events = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    ].join('\n') + '\n';
    writeFileSync(jsonlPath, events);

    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1', jsonlPath);
    const rec = makeRecorder();
    const trk = makeTracker(db, rec);

    const updated = await trk.recoverFromJsonl(T0 + 10);
    expect(updated).toBe(1);

    const s = trk.getSession('cli-1')!;
    expect(s.phase).toBe('running'); // after tool_use → assistant promotes to running? wait — last event is tool_result
    // tool_result transitions tool-running → running. Before the tool_use we
    // were in 'starting'; the user line first moves us to 'running'. The
    // tool_use moves to 'tool-running'. The tool_result moves back to 'running'.
    expect(s.jsonlOffset).toBe(events.length);
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(1);
  });

  it('preserves a partial last line so it is consumed on the next call', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tracker-jsonl-'));
    const jsonlPath = join(tmp, 'session.jsonl');
    // First write: one complete event + a partial last line.
    const part1 = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n{"type":"asst';
    writeFileSync(jsonlPath, part1);

    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1', jsonlPath);
    const trk = makeTracker(db, makeRecorder());

    await trk.recoverFromJsonl(T0 + 10);
    let s = trk.getSession('cli-1')!;
    // Offset advanced only past the newline, not past the partial.
    const fullLineLen = part1.indexOf('\n') + 1;
    expect(s.jsonlOffset).toBe(fullLineLen);
    expect(s.phase).toBe('running');

    // Finalise the second event.
    const completion = 'istant","message":{"content":[{"type":"text","text":"ok"}]}}\n';
    writeFileSync(jsonlPath, part1 + completion);
    await trk.recoverFromJsonl(T0 + 20);
    s = trk.getSession('cli-1')!;
    expect(s.jsonlOffset).toBe(part1.length + completion.length);
  });
});

describe('ClaudeSessionTracker — unknown sessions', () => {
  it('drops hooks for a claude_session_id with no DB row as unknown-session', () => {
    const db = freshDb();
    const tracker = makeTracker(db, makeRecorder());
    const res = tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'no-such-session' }, T0 + 10);
    expect(res.kind).toBe('unknown-session');
  });
});
