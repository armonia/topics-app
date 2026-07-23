import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
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

describe('ClaudeSessionTracker — PTY / reaper / dormant', () => {
  it('notePtyCrash transitions to error', async () => {
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    const rec = makeRecorder();
    const trk = makeTracker(db, rec);
    expect(trk.notePtyCrash('cli-1', 137, T0 + 10)).toBe(true);
    const s = trk.getSession('cli-1')!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('pty-crashed');
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(1);
  });

  it('noteDormant moves active session to dormant', () => {
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    const trk = makeTracker(db, makeRecorder());
    expect(trk.noteDormant('cli-1', T0 + 10)).toBe(true);
    expect(trk.getSession('cli-1')!.phase).toBe('dormant');
  });

  it('reapOnce demotes a stuck tool-running session', () => {
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    const rec = makeRecorder();
    // Manually force tool-running phase.
    db.prepare(`UPDATE claude_code_sessions SET phase='tool-running', phase_updated_at=?, rev=2 WHERE session_key='topic-a'`)
      .run(new Date(T0).toISOString());
    const trk = makeTracker(db, rec, {
      reaperConfig: { toolRunningTimeoutMs: 1000, awaitingApprovalTimeoutMs: 1000, startTimeoutMs: 1000, runningTimeoutMs: 1000, abandonedTimeoutMs: 60_000 },
    });
    expect(trk.reapOnce(T0 + 2000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('running');
  });

  it('reapOnce consults ptyIdleMs for DB-backed sessions too — silent-PTY running demoted to dormant', () => {
    // Regression: the DB-backed sweep used to call reapStaleSession WITHOUT the
    // PTY-idle signal, so a topic session whose Stop hook was missed stayed
    // `running` forever (the "12–90h running corpses" bug).
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    db.prepare(`UPDATE claude_code_sessions SET phase='running', phase_updated_at=?, rev=2 WHERE session_key='topic-a'`)
      .run(new Date(T0).toISOString());
    const trk = makeTracker(db, makeRecorder(), {
      reaperConfig: { toolRunningTimeoutMs: 1000, awaitingApprovalTimeoutMs: 1000, startTimeoutMs: 1000, runningTimeoutMs: 1000, abandonedTimeoutMs: 60_000 },
      ptyIdleMs: () => 2000, // PTY known and silent past runningTimeoutMs
    });
    expect(trk.reapOnce(T0 + 5000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('dormant');
  });

  it('reapOnce demotes an abandoned DB-backed running session (no PTY signal, updatedAt frozen)', () => {
    // Headless dispatcher tasks (`claude --print`) have no PTY at all; when the
    // process dies without SessionEnd, updatedAt is the only tell.
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1');
    db.prepare(`UPDATE claude_code_sessions SET phase='running', phase_updated_at=?, rev=2 WHERE session_key='topic-a'`)
      .run(new Date(T0).toISOString());
    const trk = makeTracker(db, makeRecorder(), {
      reaperConfig: { toolRunningTimeoutMs: 1000, awaitingApprovalTimeoutMs: 1000, startTimeoutMs: 1000, runningTimeoutMs: 1000, abandonedTimeoutMs: 60_000 },
      // no ptyIdleMs override → null for every session
    });
    expect(trk.reapOnce(T0 + 61_000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('dormant');
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

describe('ClaudeSessionTracker — live JSONL tail (tailOnce)', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const userLine = (ms: number, text = 'hi') =>
    JSON.stringify({ type: 'user', timestamp: iso(ms), promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: text } }) + '\n';
  const taskNotifLine = (ms: number) =>
    JSON.stringify({ type: 'user', timestamp: iso(ms), promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>m1</task-id>' } }) + '\n';
  const assistantLine = (ms: number) =>
    JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n';
  const metaLine = (ms: number) =>
    JSON.stringify({ type: 'user', timestamp: iso(ms), isMeta: true, message: { role: 'user', content: 'A session-scoped Stop hook is now active' } }) + '\n';

  it('a Monitor task-notification wakes a parked terminal session (the core CCS-07 scenario)', async () => {
    // Terminal session registered with a cwd — the transcript path is DERIVED
    // (no SessionStart hook ever fires) under <home>/.claude/projects/<enc>/.
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const cwd = '/Users/x/proj';
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });

    const db = freshDb();
    const rec = makeRecorder();
    const trk = makeTracker(db, rec, { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd, now: T0 });

    // Park it via hooks: prompt → Stop (the turn the user finished hours ago).
    trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    trk.ingestHook({ hook_event_name: 'Stop', session_id: 'term-1' }, T0 + 20);
    expect(trk.getSession('term-1')!.phase).toBe('awaiting-user');

    // The Monitor fires: Claude appends the injected turn to the transcript.
    // No hook announces it — the tail is the only observer.
    writeFileSync(join(dir, 'term-1.jsonl'), taskNotifLine(T0 + 5_000));
    rec.events.length = 0;
    const updated = await trk.tailOnce(T0 + 6_000);
    expect(updated).toBe(1);
    const s = trk.getSession('term-1')!;
    expect(s.phase).toBe('running');
    expect(s.phaseUpdatedAt).toBe(T0 + 5_000); // event time, not read time
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(1);
    expect(rec.events[0].state.phase).toBe('running');
  });

  it('registration against an existing transcript snaps the offset (no history replay)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const cwd = '/Users/x/proj';
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });
    // Pre-existing history from before Topics started tracking (a --resume):
    // ends with a user line that would drive phase to running if replayed.
    const history = userLine(T0 - 60_000) + assistantLine(T0 - 50_000) + userLine(T0 - 40_000);
    const file = join(dir, 'term-1.jsonl');
    writeFileSync(file, history);
    // registerTerminalSession seeds phaseUpdatedAt from the transcript's mtime
    // (so a stale --resume doesn't jump to the top of the sidebar). This test
    // runs on a synthetic clock (T0), so the file's real wall-clock mtime would
    // sit far in the FUTURE relative to T0 and causally gate out the appended
    // line below. Pin mtime to T0 so the fake clock and the filesystem agree.
    utimesSync(file, T0 / 1000, T0 / 1000);

    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd, now: T0 });

    // Nothing new → the sweep must consume nothing and move nothing.
    expect(await trk.tailOnce(T0 + 1_000)).toBe(0);
    expect(trk.getSession('term-1')!.phase).toBe('starting');

    // A line appended AFTER registration is consumed from the snapped offset.
    writeFileSync(file, history + taskNotifLine(T0 + 2_000));
    expect(await trk.tailOnce(T0 + 3_000)).toBe(1);
    const s = trk.getSession('term-1')!;
    expect(s.phase).toBe('running');
    expect(s.jsonlOffset).toBe(history.length + taskNotifLine(T0 + 2_000).length);
  });

  it('a stale assistant line read after a fresher Stop hook is gated out (Stop-race)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'term-1.jsonl');
    writeFileSync(file, '');

    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd: '/Users/x/proj', now: T0 });

    // Turn runs; its last assistant line hits disk at T+1000…
    writeFileSync(file, assistantLine(T0 + 1_000));
    // …then the Stop hook lands FIRST (push beats pull) and parks the session.
    trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 900);
    trk.ingestHook({ hook_event_name: 'Stop', session_id: 'term-1' }, T0 + 2_000);
    expect(trk.getSession('term-1')!.phase).toBe('awaiting-user');

    // The tail now reads the T+1000 line: older than the Stop → no revival.
    await trk.tailOnce(T0 + 3_000);
    expect(trk.getSession('term-1')!.phase).toBe('awaiting-user');
  });

  it('meta lines are consumed (offset advances) without waking the session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'term-1.jsonl');
    writeFileSync(file, '');

    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd: '/Users/x/proj', now: T0 });
    trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    trk.ingestHook({ hook_event_name: 'Stop', session_id: 'term-1' }, T0 + 20);

    const meta = metaLine(T0 + 5_000);
    writeFileSync(file, meta);
    await trk.tailOnce(T0 + 6_000);
    const s = trk.getSession('term-1')!;
    expect(s.phase).toBe('awaiting-user'); // still parked
    expect(s.jsonlOffset).toBe(meta.length); // but the line was consumed
  });

  it('tails DB-backed topic sessions too, broadcasting only on rev change', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tracker-jsonl-'));
    const file = join(tmp, 'session.jsonl');
    writeFileSync(file, '');
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1', file);
    const rec = makeRecorder();
    const trk = makeTracker(db, rec);

    // Park the chat via hooks, then let the transcript wake it.
    trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-1' }, T0 + 10);
    trk.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-1' }, T0 + 20);
    await rec.waitForBroadcast();
    rec.events.length = 0;

    writeFileSync(file, userLine(T0 + 5_000, 'wake up'));
    expect(await trk.tailOnce(T0 + 6_000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('running');
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(1);

    // More assistant chunks while ALREADY running: offset moves, rev doesn't →
    // no broadcast spam (one line per chunk lands many times a second mid-turn).
    rec.events.length = 0;
    const prevOffset = trk.getSession('cli-1')!.jsonlOffset;
    writeFileSync(file, userLine(T0 + 5_000, 'wake up') + assistantLine(T0 + 7_000));
    expect(await trk.tailOnce(T0 + 8_000)).toBe(1);
    const s = trk.getSession('cli-1')!;
    expect(s.phase).toBe('running');
    expect(s.jsonlOffset).toBeGreaterThan(prevOffset);
    await rec.waitForBroadcast();
    expect(rec.events.length).toBe(0);
  });

  it('wakes a DORMANT DB session (reaper-demoted, PTY silent) when its transcript grows', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tracker-jsonl-'));
    const file = join(tmp, 'session.jsonl');
    writeFileSync(file, '');
    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1', file);
    const trk = makeTracker(db, makeRecorder());

    // running → (reaper would demote) → dormant; simulate via noteDormant.
    trk.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-1' }, T0 + 10);
    trk.noteDormant('cli-1', T0 + 20);
    expect(trk.getSession('cli-1')!.phase).toBe('dormant');

    writeFileSync(file, taskNotifLine(T0 + 5_000));
    expect(await trk.tailOnce(T0 + 6_000)).toBe(1);
    expect(trk.getSession('cli-1')!.phase).toBe('running');
  });

  it('SessionStart establishing a NEW jsonlPath snaps the offset to the file size', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tracker-jsonl-'));
    const file = join(tmp, 'session.jsonl');
    const history = userLine(T0 - 60_000);
    writeFileSync(file, history);

    const db = freshDb();
    seedSession(db, 'topic-a', 'cli-1'); // no jsonl_path yet
    const trk = makeTracker(db, makeRecorder());

    trk.ingestHook({ hook_event_name: 'SessionStart', session_id: 'cli-1', transcript_path: file }, T0 + 10);
    const s = trk.getSession('cli-1')!;
    expect(s.jsonlPath).toBe(file);
    expect(s.jsonlOffset).toBe(history.length); // history skipped

    // A SessionStart RE-FIRE with the same path must NOT reset the offset.
    writeFileSync(file, history + assistantLine(T0 + 1_000));
    trk.ingestHook({ hook_event_name: 'SessionStart', session_id: 'cli-1', transcript_path: file }, T0 + 2_000);
    expect(trk.getSession('cli-1')!.jsonlOffset).toBe(history.length);
  });
});

describe('ClaudeSessionTracker — terminal (topic-less) sessions', () => {
  let db: Database;
  let rec: Recorder;
  let tracker: ClaudeSessionTracker;

  beforeEach(() => {
    db = freshDb();
    rec = makeRecorder();
    tracker = makeTracker(db, rec);
  });

  it('hooks for an unregistered terminal session are dropped as unknown', () => {
    const res = tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    expect(res.kind).toBe('unknown-session');
  });

  it('registers a terminal session so its hooks resolve and advance phase in-memory', async () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    const start = tracker.getSession('term-1')!;
    expect(start.sessionKey).toBeNull();
    expect(start.phase).toBe('starting');

    const res = tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.state.phase).toBe('running');
      expect(res.state.lastHookAt).toBe(T0 + 10);
    }
    // Not persisted to the DB (no row possible).
    expect(db.prepare('SELECT COUNT(*) c FROM claude_code_sessions').get() as any).toEqual({ c: 0 });
  });

  it('broadcasts session:state with sessionKey null + claudeSessionId in the state', async () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'term-1', tool_name: 'Bash' }, T0 + 10);
    await rec.waitForBroadcast();
    const last = rec.events.at(-1);
    expect(last.type).toBe('session:state');
    expect(last.sessionKey).toBeNull();
    expect(last.state.claudeSessionId).toBe('term-1');
    expect(last.state.phase).toBe('tool-running');
  });

  it('tracks the full turn lifecycle: running → tool-running → running → awaiting-user', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    expect(tracker.getSession('term-1')!.phase).toBe('running');
    tracker.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'term-1', tool_name: 'Edit' }, T0 + 20);
    expect(tracker.getSession('term-1')!.phase).toBe('tool-running');
    tracker.ingestHook({ hook_event_name: 'PostToolUse', session_id: 'term-1' }, T0 + 30);
    expect(tracker.getSession('term-1')!.phase).toBe('running');
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'term-1' }, T0 + 40);
    expect(tracker.getSession('term-1')!.phase).toBe('awaiting-user');
  });

  it('includes terminal sessions in listSessions', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.registerTerminalSession('term-2', { now: T0 });
    const ids = tracker.listSessions().map((s) => s.claudeSessionId).sort();
    expect(ids).toEqual(['term-1', 'term-2']);
  });

  it('noteDormant and notePtyCrash work for in-memory terminal sessions', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    expect(tracker.noteDormant('term-1', T0 + 20)).toBe(true);
    expect(tracker.getSession('term-1')!.phase).toBe('dormant');

    tracker.registerTerminalSession('term-2', { now: T0 });
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-2' }, T0 + 10);
    expect(tracker.notePtyCrash('term-2', 1, T0 + 20)).toBe(true);
    expect(tracker.getSession('term-2')!.phase).toBe('error');
  });

  it('dropTerminalSession forgets the in-memory session', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    expect(tracker.getSession('term-1')).not.toBeNull();
    tracker.dropTerminalSession('term-1');
    expect(tracker.getSession('term-1')).toBeNull();
  });

  it('reaper sweeps stale in-memory tool-running back to running', () => {
    const trk = makeTracker(db, rec, { reaperConfig: { toolRunningTimeoutMs: 100, awaitingApprovalTimeoutMs: 100, startTimeoutMs: 100, runningTimeoutMs: 100, abandonedTimeoutMs: 60_000 } });
    trk.registerTerminalSession('term-1', { now: T0 });
    trk.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'term-1', tool_name: 'Bash' }, T0 + 10);
    expect(trk.getSession('term-1')!.phase).toBe('tool-running');
    const changed = trk.reapOnce(T0 + 10 + 200);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(trk.getSession('term-1')!.phase).toBe('running');
  });

  it('re-registering a dormant terminal session revives it to starting', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.noteDormant('term-1', T0 + 10);
    expect(tracker.getSession('term-1')!.phase).toBe('dormant');
    tracker.registerTerminalSession('term-1', { now: T0 + 20 });
    expect(tracker.getSession('term-1')!.phase).toBe('starting');
  });

  it('does not clobber a live terminal session on duplicate register', () => {
    tracker.registerTerminalSession('term-1', { now: T0 });
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'term-1' }, T0 + 10);
    expect(tracker.getSession('term-1')!.phase).toBe('running');
    tracker.registerTerminalSession('term-1', { now: T0 + 20 }); // should be a no-op
    expect(tracker.getSession('term-1')!.phase).toBe('running');
  });
});
