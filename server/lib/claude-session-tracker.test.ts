/**
 * @covers CCS-02, CCS-05
 *
 * CCS-02 (hook endpoint security and idempotency) is partial: the tracker side
 * is here, the localhost-only gate lives in the route. CCS-05 (the
 * `session:state` broadcast contract, including burst coalescing) is covered.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, appendFileSync, mkdirSync, utimesSync } from 'fs';
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
  for (const prefix of ['027-', '096-']) {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    const sql = readFileSync(join(migDir, file), 'utf-8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      db.run(stmt);
    }
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
    // Drain the parking hooks' coalesced broadcast BEFORE clearing, exactly as
    // the sibling test below does: ingestHook arms a 20ms timer, and clearing
    // the buffer with that flush still in flight lets it land afterwards and be
    // counted as a second event. Isolated it always wins the race; under the
    // full suite's load it doesn't.
    await rec.waitForBroadcast();
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

    // Nothing new → the sweep must consume nothing and move nothing. La fase è
    // `dormant`, non `starting`: un transcript già scritto dice che questa è
    // una riattaccata, non una nascita (vedi il test dedicato più sotto).
    expect(await trk.tailOnce(T0 + 1_000)).toBe(0);
    expect(trk.getSession('term-1')!.phase).toBe('dormant');

    // A line appended AFTER registration is consumed from the snapped offset.
    writeFileSync(file, history + taskNotifLine(T0 + 2_000));
    expect(await trk.tailOnce(T0 + 3_000)).toBe(1);
    const s = trk.getSession('term-1')!;
    expect(s.phase).toBe('running');
    expect(s.jsonlOffset).toBe(history.length + taskNotifLine(T0 + 2_000).length);
  });

  // ── La fase iniziale di una RIATTACCATA ────────────────────────────────────
  // `starting` è l'unica fase che il client non classifica né attiva né a
  // riposo, ed è la condizione che apre il fallback pty di useCompletionNotifier
  // — il ramo grezzo per le sessioni SENZA hook, che al primo frame di repaint
  // spara «Lavoro completato». Dare `starting` a una tab riattaccata dopo un
  // riavvio del server significa quel banner su lavoro chiuso da giorni, e
  // nessuno la tira fuori da lì (il reaper salta `starting` per i terminali,
  // l'offset è già a EOF). Il transcript è l'indizio: se ha già contenuto, non
  // è una nascita.
  it('registrare su un transcript già scritto parte da dormant, non da starting', () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'term-1.jsonl');
    writeFileSync(file, userLine(T0 - 60_000) + assistantLine(T0 - 50_000));
    utimesSync(file, (T0 - 50_000) / 1000, (T0 - 50_000) / 1000);

    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd: '/Users/x/proj', now: T0 });

    expect(trk.getSession('term-1')!.phase).toBe('dormant');
  });

  it('una sessione appena nata (transcript assente o vuoto) resta starting', () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });

    // Nessun file: Claude lo crea qualche istante dopo lo spawn.
    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd: '/Users/x/proj', now: T0 });
    expect(trk.getSession('term-1')!.phase).toBe('starting');

    // File creato ma ancora vuoto: stessa cosa — è la popolazione che il
    // fallback pty serve davvero (sessioni senza hook).
    writeFileSync(join(dir, 'term-2.jsonl'), '');
    trk.registerTerminalSession('term-2', { cwd: '/Users/x/proj', now: T0 });
    expect(trk.getSession('term-2')!.phase).toBe('starting');
  });

  // Il prezzo di `dormant` è che il pane non mostra lo spinner finché non
  // arriva un segnale vero — ed è già pagato: il primo frame pty non cosmetico
  // la riporta a `running` (reviveOnPtyActivity), che è la ragione per cui
  // quella funzione esiste.
  it('una riattaccata dormant torna running al primo frame pty', () => {
    const home = mkdtempSync(join(tmpdir(), 'tracker-home-'));
    const dir = join(home, '.claude', 'projects', '-Users-x-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'term-1.jsonl');
    writeFileSync(file, userLine(T0 - 60_000));
    utimesSync(file, (T0 - 60_000) / 1000, (T0 - 60_000) / 1000);

    const trk = makeTracker(freshDb(), makeRecorder(), { homeDir: home });
    trk.registerTerminalSession('term-1', { cwd: '/Users/x/proj', now: T0 });
    expect(trk.getSession('term-1')!.phase).toBe('dormant');

    expect(trk.notePtyActivity('term-1', T0 + 1_000)).toBe(true);
    expect(trk.getSession('term-1')!.phase).toBe('running');
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

describe('ClaudeSessionTracker — message import sweep (adopted sessions)', () => {
  let counter = 0;
  function tmpTranscript(): string {
    const dir = mkdtempSync(join(tmpdir(), 'import-sweep-'));
    return join(dir, `sess-${counter++}.jsonl`);
  }

  const jline = (o: object) => JSON.stringify(o);

  interface FakeSink {
    append: any[][];
    resolved: Array<{ id: string; result: string; isError: boolean }>;
    lastId: string | null;
    sink: NonNullable<Parameters<typeof createClaudeSessionTracker>[0]['importSink']>;
  }
  function makeSink(): FakeSink {
    const state: FakeSink = { append: [], resolved: [], lastId: null, sink: null as any };
    state.sink = {
      getLastMessageId: () => state.lastId,
      appendMessages: (_sk, msgs) => {
        state.append.push(msgs);
        if (msgs.length) state.lastId = msgs[msgs.length - 1]!.id; // mirror the DB tail
      },
      resolveToolResult: (_sk, toolUseId, result, isError) => state.resolved.push({ id: toolUseId, result, isError }),
      topicIdForSessionKey: () => 'topic-x',
    };
    return state;
  }

  /** Seed an ADOPTED session: import_offset non-null + jsonl_path set. */
  function seedAdopted(db: Database, sessionKey: string, csid: string, path: string, importOffset: number) {
    db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
    db.prepare(`
      INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at, jsonl_path, import_offset)
      VALUES (?, ?, ?, ?, 'dormant', ?, ?, ?)
    `).run(sessionKey, csid, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString(), path, importOffset);
  }

  it('appends a terminal turn that lands after adoption, advancing import_offset', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    fake.lastId = 'ADOPT-LAST'; // the last row the initial import wrote

    const path = tmpTranscript();
    const initial = jline({ type: 'user', message: { role: 'user', content: 'ciao' } }) + '\n';
    writeFileSync(path, initial);
    seedAdopted(db, 'topic-a', 'cli-a', path, Buffer.byteLength(initial, 'utf-8'));

    const tracker = makeTracker(db, rec, { importSink: fake.sink });

    // Nothing new yet.
    expect(await tracker.importOnce()).toBe(0);
    expect(fake.append).toEqual([]);

    // A new turn is typed in the TERMINAL — appended to the same file.
    const turn = [
      jline({ type: 'user', message: { role: 'user', content: 'domanda-dal-terminale' } }),
      jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'risposta-dal-terminale' }] } }),
    ].join('\n') + '\n';
    writeFileSync(path, initial + turn);

    expect(await tracker.importOnce()).toBe(1);
    expect(fake.append).toHaveLength(1);
    const appended = fake.append[0]!;
    expect(appended.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'domanda-dal-terminale'],
      ['assistant', 'risposta-dal-terminale'],
    ]);
    // first new message chains from the last already-saved row
    expect(appended[0].parentId).toBe('ADOPT-LAST');
    // import_offset advanced to EOF
    const row = db.prepare(`SELECT import_offset FROM claude_code_sessions WHERE session_key = 'topic-a'`).get() as any;
    expect(row.import_offset).toBe(Buffer.byteLength(initial + turn, 'utf-8'));
    // and the open chat was nudged with message:new for both turns
    const news = rec.events.filter((e: any) => e.type === 'message:new');
    expect(news.map((e: any) => e.content)).toEqual(['domanda-dal-terminale', 'risposta-dal-terminale']);

    // Idempotent: a second sweep with no growth does nothing.
    expect(await tracker.importOnce()).toBe(0);
    expect(fake.append).toHaveLength(1);
  });

  it('does NOT re-import while Topics drives the session, but advances the cursor', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();

    const path = tmpTranscript();
    const initial = jline({ type: 'user', message: { role: 'user', content: 'ciao' } }) + '\n';
    writeFileSync(path, initial);
    seedAdopted(db, 'topic-b', 'cli-b', path, Buffer.byteLength(initial, 'utf-8'));

    // Topics owns a live child for this session — its stream persists the turns.
    const tracker = makeTracker(db, rec, { importSink: fake.sink, isSessionLocallyDriven: () => true });

    const turn = jline({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'topics-authored' }] } }) + '\n';
    writeFileSync(path, initial + turn);

    expect(await tracker.importOnce()).toBe(0); // no import
    expect(fake.append).toEqual([]);
    // but the cursor moved past the Topics-authored bytes (no re-import later)
    const row = db.prepare(`SELECT import_offset FROM claude_code_sessions WHERE session_key = 'topic-b'`).get() as any;
    expect(row.import_offset).toBe(Buffer.byteLength(initial + turn, 'utf-8'));
  });

  it('resolves a tool_result whose tool_use arrived in an earlier sweep (cross-chunk)', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    fake.lastId = 'P0';

    const path = tmpTranscript();
    writeFileSync(path, ''); // empty transcript at adoption
    seedAdopted(db, 'topic-c', 'cli-c', path, 0);
    const tracker = makeTracker(db, rec, { importSink: fake.sink });

    // Sweep 1: the assistant fires a long tool; the result has NOT landed yet.
    const chunk1 = jline({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'eseguo' }, { type: 'tool_use', id: 'tX', name: 'Bash', input: { command: 'sleep' } }] },
    }) + '\n';
    writeFileSync(path, chunk1);
    expect(await tracker.importOnce()).toBe(1);
    expect(fake.append[0]![0].toolCalls[0]).toMatchObject({ id: 'tX', name: 'Bash' });
    expect(fake.append[0]![0].toolCalls[0].result).toBeUndefined();
    expect(fake.resolved).toEqual([]);

    // Sweep 2: only the tool_result. No new message; the earlier row is patched.
    const chunk2 = jline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tX', content: 'done' }] } }) + '\n';
    writeFileSync(path, chunk1 + chunk2);
    await tracker.importOnce();
    expect(fake.resolved).toEqual([{ id: 'tX', result: 'done', isError: false }]);
    // no second append (pure tool_result carrier)
    expect(fake.append).toHaveLength(1);
  });
});

describe('ClaudeSessionTracker — seguire il FORK del transcript (sessione adottata)', () => {
  const jline = (o: object) => JSON.stringify(o);
  const user = (uuid: string, text: string) => jline({ type: 'user', uuid, message: { role: 'user', content: text } });
  const asst = (uuid: string, text: string) => jline({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });

  interface Sink {
    append: any[][];
    lastId: string | null;
    sink: NonNullable<Parameters<typeof createClaudeSessionTracker>[0]['importSink']>;
  }
  function makeSink(): Sink {
    const s: Sink = { append: [], lastId: 'ADOPT-LAST', sink: null as any };
    s.sink = {
      getLastMessageId: () => s.lastId,
      appendMessages: (_sk, msgs) => { s.append.push(msgs); if (msgs.length) s.lastId = msgs[msgs.length - 1]!.id; },
      resolveToolResult: () => {},
      topicIdForSessionKey: () => 'topic-x',
    };
    return s;
  }

  function seedAdopted(db: Database, sessionKey: string, csid: string, path: string, importOffset: number) {
    db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
    db.prepare(`
      INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at, jsonl_path, import_offset)
      VALUES (?, ?, ?, ?, 'dormant', ?, ?, ?)
    `).run(sessionKey, csid, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString(), path, importOffset);
  }

  /** Un file nella cartella `dir` con un mtime di `agoSec` secondi fa. */
  function write(dir: string, name: string, lines: string[], agoSec: number): string {
    const p = join(dir, name);
    writeFileSync(p, lines.join('\n') + '\n');
    const t = Date.now() / 1000 - agoSec;
    utimesSync(p, t, t);
    return p;
  }

  const HISTORY = [user('u1', 'domanda-di-ieri'), asst('a1', 'risposta-di-ieri')];

  /** Sessione adottata il cui transcript è FERMO da 60s (il fork è credibile). */
  function seedFrozenAdoption(db: Database, sessionKey: string) {
    const dir = mkdtempSync(join(tmpdir(), 'fork-sweep-'));
    const parent = write(dir, '11111111-1111-1111-1111-111111111111.jsonl', HISTORY, 60);
    seedAdopted(db, sessionKey, '11111111-1111-1111-1111-111111111111', parent, readFileSync(parent).length);
    return { dir, parent };
  }

  const row = (db: Database, key: string) =>
    db.prepare(`SELECT jsonl_path, jsonl_offset, import_offset, claude_session_id FROM claude_code_sessions WHERE session_key = ?`).get(key) as any;

  it('la chat riparte: il resume forka su un nuovo file e i turni continuano ad arrivare', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const { dir, parent } = seedFrozenAdoption(db, 'topic-fork');
    const tracker = makeTracker(db, rec, { importSink: fake.sink });

    // Il padre non cresce più: senza inseguire il fork, la chat è una foto.
    // Il figlio ricopia la storia (stessi uuid) e ci aggiunge il turno nuovo.
    const child = write(dir, '22222222-2222-2222-2222-222222222222.jsonl', [
      ...HISTORY,
      user('u2', 'domanda-DOPO-il-fork'),
      asst('a2', 'risposta-DOPO-il-fork'),
    ], 1);

    expect(await tracker.importOnce()).toBe(1);
    expect(fake.append).toHaveLength(1);
    expect(fake.append[0]!.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'domanda-DOPO-il-fork'],
      ['assistant', 'risposta-DOPO-il-fork'],
    ]);
    // il primo messaggio nuovo si aggancia all'ultima riga già salvata
    expect(fake.append[0]![0].parentId).toBe('ADOPT-LAST');

    // La riga ora segue il figlio, con ENTRAMBI i cursori a fine copia.
    const r = row(db, 'topic-fork');
    expect(r.jsonl_path).toBe(child);
    expect(r.claude_session_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(r.import_offset).toBe(readFileSync(child).length);
    expect(r.jsonl_offset).toBeGreaterThan(0);

    // Da qui in poi si taglia sul file nuovo, senza riscansioni.
    appendFileSync(child, asst('a3', 'ancora-dal-terminale') + '\n');
    expect(await tracker.importOnce()).toBe(1);
    expect(fake.append[1]!.map((m: any) => m.content)).toEqual(['ancora-dal-terminale']);
    expect(row(db, 'topic-fork').jsonl_path).toBe(child);
    // niente doppioni: la storia ricopiata non è stata reimportata
    expect(fake.append.flat().map((m: any) => m.content)).not.toContain('domanda-di-ieri');
  });

  it('non insegue nulla se il transcript è ancora CALDO (una pausa non è un fork)', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const dir = mkdtempSync(join(tmpdir(), 'fork-sweep-'));
    const parent = write(dir, '11111111-1111-1111-1111-111111111111.jsonl', HISTORY, 0); // scritto adesso
    seedAdopted(db, 'topic-warm', '11111111-1111-1111-1111-111111111111', parent, readFileSync(parent).length);
    write(dir, '22222222-2222-2222-2222-222222222222.jsonl', [...HISTORY, asst('a2', 'coda')], 0);

    const tracker = makeTracker(db, rec, { importSink: fake.sink });
    expect(await tracker.importOnce()).toBe(0);
    expect(row(db, 'topic-warm').jsonl_path).toBe(parent);
  });

  it('non insegue mentre è Topics a guidare la sessione', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const { dir, parent } = seedFrozenAdoption(db, 'topic-driven');
    write(dir, '22222222-2222-2222-2222-222222222222.jsonl', [...HISTORY, asst('a2', 'coda')], 1);

    const tracker = makeTracker(db, rec, { importSink: fake.sink, isSessionLocallyDriven: () => true });
    expect(await tracker.importOnce()).toBe(0);
    expect(row(db, 'topic-driven').jsonl_path).toBe(parent);
  });

  it('non ruba il transcript di un altro topic nella stessa cartella', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const { dir, parent } = seedFrozenAdoption(db, 'topic-mio');
    // Un altro topic adottato segue già questo file, che pure ricopia i miei uuid.
    const altrui = write(dir, '33333333-3333-3333-3333-333333333333.jsonl', [...HISTORY, asst('a2', 'coda')], 1);
    seedAdopted(db, 'topic-altrui', '33333333-3333-3333-3333-333333333333', altrui, readFileSync(altrui).length);

    const tracker = makeTracker(db, rec, { importSink: fake.sink });
    await tracker.importOnce();
    expect(row(db, 'topic-mio').jsonl_path).toBe(parent);
  });

  it('un transcript estraneo (nessun uuid in comune) non aggancia', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const { dir, parent } = seedFrozenAdoption(db, 'topic-solo');
    write(dir, '44444444-4444-4444-4444-444444444444.jsonl', [user('z1', 'sessione di un altro')], 1);

    const tracker = makeTracker(db, rec, { importSink: fake.sink });
    expect(await tracker.importOnce()).toBe(0);
    expect(row(db, 'topic-solo').jsonl_path).toBe(parent);
  });

  it('la scansione ha un freno: due sweep ravvicinati non rileggono la cartella', async () => {
    const db = freshDb();
    const rec = makeRecorder();
    const fake = makeSink();
    const { dir, parent } = seedFrozenAdoption(db, 'topic-cooldown');
    write(dir, '44444444-4444-4444-4444-444444444444.jsonl', [user('z1', 'estraneo')], 1);

    const tracker = makeTracker(db, rec, { importSink: fake.sink });
    await tracker.importOnce();               // scansione fatta, candidato scartato
    // il fork arriva ORA, ma il cooldown non è scaduto: si aspetta il prossimo giro
    write(dir, '55555555-5555-5555-5555-555555555555.jsonl', [...HISTORY, asst('a2', 'coda')], 1);
    expect(await tracker.importOnce()).toBe(0);
    expect(row(db, 'topic-cooldown').jsonl_path).toBe(parent);
    // passato il cooldown, lo insegue
    expect(await tracker.importOnce(Date.now() + 60_000)).toBe(1);
    expect(row(db, 'topic-cooldown').jsonl_path).toContain('55555555');
  });
});

/**
 * L'ATTESA SI SPEGNE QUANDO IL MONITOR CONSEGNA.
 *
 * `monitorArmed` è ciò che tiene una chat in `watching` attraverso lo `Stop` di
 * fine turno: senza, una sessione che sorveglia un build si legge come una che
 * ha smesso di rispondere. Ma una spia che non si spegne più è peggio di una
 * che non si accende: quando il risveglio arriva (`adottaTurniRisvegliati` in
 * server.ts) l'attesa è finita, e questo è il metodo che lo dice.
 *
 * Vive qui e non in `applyHook` perché non nasce da un hook: nasce dal server,
 * che ha appena visto la CLI riaprire da sola. È il sostituto vivo del vecchio
 * `MonitorClosed`, che questa CLI non manda più.
 */
describe('ClaudeSessionTracker — noteWatchDelivered', () => {
  it('spegne l\'attesa armata, e allora lo Stop riporta la chat a riposo', () => {
    const db = freshDb();
    const rec = makeRecorder();
    seedSession(db, 'topic-w', 'cli-w');
    const tracker = makeTracker(db, rec);

    // L'agente arma la sorveglianza e chiude il turno: la chat resta in ascolto.
    tracker.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'cli-w', tool_name: 'Monitor' }, T0 + 10);
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-w' }, T0 + 20);
    expect(tracker.getSessionByKey('topic-w')?.phase).toBe('watching');

    // Il Monitor consegna: l'attesa è chiusa.
    expect(tracker.noteWatchDelivered('topic-w', T0 + 30)).toBe(true);
    // `falsy` e non `false`: il flag non ha una colonna, quindi «spento» si
    // legge come assente. Le due cose sono la stessa affermazione — non c'è
    // nessuna attesa armata — e pretendere il booleano esatto legherebbe il
    // test alla forma dello stato invece che al fatto.
    expect(tracker.getSessionByKey('topic-w')?.monitorArmed).toBeFalsy();

    // E adesso lo `Stop` del turno risvegliato riporta a riposo, invece di
    // riaccendere `watching` su una sorveglianza che non c'è più.
    // Oltre la finestra di dedup (100ms qui): due `Stop` ravvicinati sono per
    // il tracker lo stesso evento ripetuto, e il secondo verrebbe scartato —
    // il che renderebbe questo test verde per il motivo sbagliato.
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: 'cli-w' }, T0 + 500);
    expect(tracker.getSessionByKey('topic-w')?.phase).toBe('awaiting-user');
  });

  it('senza attesa armata non fa niente, e non spende un rev', () => {
    // Idempotente per costruzione: il server lo chiama a ogni risveglio senza
    // sapere se c'era un Monitor dietro, e un rev speso a vuoto e' un broadcast
    // a tutti i client per una cosa che non e' cambiata.
    const db = freshDb();
    const rec = makeRecorder();
    seedSession(db, 'topic-x', 'cli-x');
    const tracker = makeTracker(db, rec);
    const prima = tracker.getSessionByKey('topic-x')?.rev;

    expect(tracker.noteWatchDelivered('topic-x', T0 + 10)).toBe(false);
    expect(tracker.getSessionByKey('topic-x')?.rev).toBe(prima!);
  });

  it('una chat che non esiste non e\' un errore', () => {
    const tracker = makeTracker(freshDb(), makeRecorder());
    expect(tracker.noteWatchDelivered('topic-mai-esistita', T0 + 10)).toBe(false);
  });
});
