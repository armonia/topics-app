/**
 * A Stop hook that lands after the tail already read the row opening the next
 * turn: the Stop fired before that row, so it is stale news and must not end
 * the woken turn. Covers the notice the CLI delivers 0.8 to 5.7 s after Stop.
 *
 * @covers ATTN-03
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import * as store from '../attention/store';

const { configureAttentionStore, resetAttentionStore, getAttention } = store;
const T0 = 1_700_000_000_000;
const subjectOf = (s: { sessionKey: string | null; claudeSessionId: string }) =>
  s.sessionKey ? `topic:${s.sessionKey.slice('topic:'.length)}` : `terminal:${s.claudeSessionId}`;
const BASH_BG = { tool_name: 'Bash', tool_input: { command: 'sleep 600 && make build', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b7kapz0ad' } };
function freshDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE)`);
  const migDir = join(import.meta.dir, '..', 'db', 'migrations');
  for (const prefix of ['027-', '096-']) {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    const sql = readFileSync(join(migDir, file), 'utf-8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
  }
  return db;
}
function attentionTable(): Database {
  const db = new Database(':memory:');
  const f = readdirSync(join(import.meta.dir, '..', 'db', 'migrations')).find((x) => x.includes('subject-attention'))!;
  const sql = readFileSync(join(import.meta.dir, '..', 'db', 'migrations', f), 'utf-8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const s of sql.split(';').map((x) => x.trim()).filter(Boolean)) db.run(s);
  return db;
}

afterAll(() => resetAttentionStore());
const pushes: any[] = [];
const rows: any[] = [];
let table: Database;
// A short grace, as the probe used: with none the delivery sweep itself
// announces the parked turn's end, so the woken Stop is never the one
// announce. No sleep is needed: every armed grace is cleared synchronously
// by the turn the same sweep opens, and the timers are unref'd.
const configure = () => configureAttentionStore({ db: () => table, sendPush: (p: any) => { pushes.push(p); }, recordRow: (r: any) => { rows.push(r); return null; }, graceMs: 20 } as any);
beforeEach(() => { pushes.length = 0; rows.length = 0; table = attentionTable(); resetAttentionStore(); configure(); });
const body = (taskId: string, inner: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n${inner}\n</task-notification>`;
const BASH_END = body('b7kapz0ad', '<tool-use-id>toolu_0</tool-use-id>\n<status>completed</status>\n<summary>done</summary>');
const q = (op: string, content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: op, timestamp: new Date(at).toISOString(), sessionId: 's', content });
const userRow = (content: string, at: number) => JSON.stringify({ type: 'user', uuid: `u${at}`, timestamp: new Date(at).toISOString(), message: { role: 'user', content } });
const assistant = (at: number) => JSON.stringify({ type: 'assistant', uuid: `a${at}`, timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
const snap = (s: string) => ({ e: getAttention(s).epoch, p: pushes.length, r: rows.length });
const diff = (s: string, c0: { e: number; p: number; r: number }) =>
  [getAttention(s).epoch - c0.e, pushes.length - c0.p, rows.length - c0.r];

function world(kind: 'terminal' | 'chat') {
  const home = mkdtempSync(join(tmpdir(), 'late-stop-'));
  const cwd = '/work/project';
  const sid = kind === 'terminal' ? 'cli-term' : 'cli-bg';
  const path = deriveTranscriptPath(home, cwd, sid);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '');
  const db = freshDb();
  if (kind === 'chat') {
    db.prepare(`INSERT INTO topics VALUES (?)`).run('topic:bg');
    db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at) VALUES (?, ?, ?, ?, 'starting', ?)`)
      .run('topic:bg', sid, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString());
  }
  const tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home } as any);
  const w = { home, path, sid, subject: kind === 'terminal' ? 'terminal:cli-term' : 'topic:bg', tracker,
    hook: (h: Record<string, unknown>, arrival: number, firedAt?: number) => w.tracker.ingestHook({ ...h, session_id: sid, fired_at: String(firedAt ?? arrival) } as never, arrival),
    phase: () => w.tracker.getSession(sid)?.phase,
    add: (...lines: string[]) => appendFileSync(path, lines.join('\n') + '\n'),
    done: () => rmSync(home, { recursive: true, force: true }) };
  if (kind === 'terminal') w.tracker.registerTerminalSession(sid, { cwd, now: T0 });
  else w.hook({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: path }, T0);
  return w;
}
/** A turn that launches the background Bash and is still answering when it ends (its enqueue at T0+5000). */
function openTurn(w: ReturnType<typeof world>) {
  w.hook({ hook_event_name: 'UserPromptSubmit' }, T0 + 200);
  w.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_0', ...BASH_BG }, T0 + 400);
  w.hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_0', ...BASH_BG }, T0 + 600);
}

describe('a Stop that lands after the tail read the woken turn', () => {
  // S = Stop fired; D = delivery written S+800; W = the woken turn's first answer, D+1500.
  const forms = ['stop in time', 'stop after the delivery sweep', 'stop after the sweep of delivery and first answer'] as const;
  for (const kind of ['terminal', 'chat'] as const) for (const form of forms) for (const queueRead of ['enqueue read before Stop', 'enqueue read with delivery'] as const) {
    it(`${kind} ${form} ${queueRead}`, async () => {
      const w = world(kind);
      try {
        openTurn(w);
        const E = T0 + 5_000, S = T0 + 7_000, D = S + 800, W = D + 1_500, S2 = W + 2_000;
        const c0 = snap(w.subject);
        const seq: string[] = [];
        w.add(q('enqueue', BASH_END, E), assistant(S - 500));
        if (queueRead === 'enqueue read before Stop') { await w.tracker.tailOnce(E + 600); seq.push(`tail(enqueue) ${w.phase()}`); }
        const stop = () => { w.hook({ hook_event_name: 'Stop' }, form === 'stop in time' ? S + 30 : form === 'stop after the delivery sweep' ? D + 400 : W + 300, S); seq.push(`Stop ${w.phase()}`); };
        if (form === 'stop in time') stop();
        w.add(userRow(BASH_END, D));
        if (form === 'stop after the sweep of delivery and first answer') w.add(assistant(W));
        await w.tracker.tailOnce(form === 'stop after the sweep of delivery and first answer' ? W + 100 : D + 200);
        seq.push(`tail(delivery${form.endsWith('first answer') ? '+answer' : ''}) ${w.phase()}`);
        if (form !== 'stop in time') stop();
        if (form !== 'stop after the sweep of delivery and first answer') { w.add(assistant(W)); await w.tracker.tailOnce(W + 200); seq.push(`tail(answer) ${w.phase()}`); }
        w.add(assistant(W + 1_000)); await w.tracker.tailOnce(W + 1_600); seq.push(`tail(answer 2) ${w.phase()}`);
        const mid = diff(w.subject, c0);
        w.hook({ hook_event_name: 'Stop' }, S2 + 30, S2); seq.push(`woken Stop ${w.phase()}`);
        const after = diff(w.subject, c0);
        const phaseOfEntry = (s: string) => s.slice(s.lastIndexOf(' ') + 1);
        expect(seq.slice(0, -1).map(phaseOfEntry).filter((p) => p === 'awaiting-user')).toEqual([]);
        expect(phaseOfEntry(seq.find((s) => s.startsWith('tail(delivery'))!)).toEqual('running');
        expect(phaseOfEntry(seq[seq.length - 1])).toEqual('awaiting-user');
        if (kind === 'terminal') {
          expect(mid).toEqual([0, 0, 0]);
          expect(after).toEqual([1, 1, 1]);
        }
      } finally { w.done(); }
    });
  }
});

describe('a one-shot cron armed in the turn before the one the transcript opens', () => {
  // ATTN-03: the first turn after the one that armed it takes it. With the Stop late the phase never leaves work, so
  // only the row that opens the turn can open it in the store; left armed, the cron would hold the turn for ever.
  const CRON = { tool_name: 'CronCreate', tool_input: { cron: '57 9 25 9 *', prompt: 'check the build', recurring: false },
    tool_response: { id: 'afc60409', recurring: false, humanSchedule: 'at 09:57' } };
  const openers = ['delivered notice', 'queued prompt, its UserPromptSubmit fired 3 ms before the row', 'queued prompt, its UserPromptSubmit fired 20 ms after the row'] as const;
  for (const opener of openers) for (const stop of ['in time', 'late'] as const) {
    it(`${opener}, Stop ${stop}`, async () => {
      const w = world('terminal');
      try {
        const notice = opener === 'delivered notice';
        if (notice) openTurn(w); else w.hook({ hook_event_name: 'UserPromptSubmit' }, T0 + 200);
        w.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_c', ...CRON }, T0 + 800);
        w.hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_c', ...CRON }, T0 + 1_000);
        const E = T0 + 5_000, S = T0 + 7_000, D = S + 800, W = D + 1_500, S2 = W + 2_000;
        const c0 = snap(w.subject);
        const seq: string[] = [];
        w.add(...(notice ? [q('enqueue', BASH_END, E)] : []), assistant(S - 500)); await w.tracker.tailOnce(E + 600);
        if (stop === 'in time') w.hook({ hook_event_name: 'Stop' }, S + 30, S);
        w.add(userRow(notice ? BASH_END : 'and then the tests', D)); await w.tracker.tailOnce(D + 200); seq.push(`opened ${w.phase()}`);
        if (stop === 'late') w.hook({ hook_event_name: 'Stop' }, D + 400, S);
        if (!notice) w.hook({ hook_event_name: 'UserPromptSubmit' }, D + 450, opener.includes('3 ms before') ? D - 3 : D + 20);
        w.add(assistant(W)); await w.tracker.tailOnce(W + 200); seq.push(`answer ${w.phase()}`);
        const mid = diff(w.subject, c0);
        w.hook({ hook_event_name: 'Stop' }, S2 + 30, S2); seq.push(`Stop ${w.phase()} with ${store.countingTasks(w.subject)} tasks`);
        expect(seq).toEqual(['opened running', 'answer running', 'Stop awaiting-user with 0 tasks']);
        expect([mid, diff(w.subject, c0)]).toEqual([[0, 0, 0], [1, 1, 1]]);
      } finally { w.done(); }
    });
  }

  it('a prompt row the tail reads after its own turn armed the cron leaves the cron to that turn', async () => {
    const w = world('terminal');
    try {
      w.hook({ hook_event_name: 'UserPromptSubmit' }, T0 + 200);
      w.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_c', ...CRON }, T0 + 800);
      w.hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_c', ...CRON }, T0 + 1_000);
      w.add(userRow('check the build at 09:57', T0 + 190), assistant(T0 + 700)); await w.tracker.tailOnce(T0 + 1_500);
      w.hook({ hook_event_name: 'Stop' }, T0 + 3_030, T0 + 3_000);
      expect([w.phase(), store.countingTasks(w.subject)]).toEqual(['watching', 1]);
    } finally { w.done(); }
  });
});
