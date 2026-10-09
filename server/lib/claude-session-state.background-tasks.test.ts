/**
 * The phase machine parks a session in `watching` at `Stop` whenever a task
 * of its own is still in flight, whatever tool launched it, and counts those
 * tasks by id in the attention store, their one holder (MONITOR-04 modified,
 * ATTN-03; defects D2, A and bgwait-2).
 *
 * Today only `Monitor` arms the watch: a background Bash, a background Agent, a
 * Workflow or a one-shot cron end their turn at `awaiting-user` ("your turn",
 * blue fill, banner) while the session waits on its own work. And a terminal
 * whose Monitor has expired answers `watching` at every later `Stop`, because
 * nothing but a chat's wake adoption ever disarms it.
 *
 * The hooks carry `tool_response` as Claude Code 2.1.282 writes it
 * (`backgroundTaskId`, `agentId`, `taskId`, the cron's `id` and `recurring`),
 * copied from `tests/fixtures/claude-cli-2.1.282-*.ndjson`. A task that ends
 * while a turn runs reports in the CLI's queue records alone (2.1.292, the
 * notification absorbed mid-turn): they close it too, live and at a reattach.
 * @covers ATTN-03
 * @covers ATTN-12
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import { configureAttentionStore, resetAttentionStore, getAttention, countingTasks, finishBackgroundTasks, recomposeAttentionOnBoot, setBackgroundTasks, turnEnded, turnStarted } from '../attention/store';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

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
    const sql = readFileSync(join(migDir, file), 'utf-8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
  }
  return db;
}

/** The attention table alone: what a restart of the server keeps, where its memory is lost. */
function attentionTable(): Database {
  const db = new Database(':memory:');
  const sql = readFileSync(join(import.meta.dir, '..', 'db', 'migrations', '20261003214001-subject-attention.sql'), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
  return db;
}

function seedChat(db: Database, sessionKey: string, csid: string) {
  db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
  db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at)
    VALUES (?, ?, ?, ?, 'starting', ?)`).run(sessionKey, csid, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString());
}

type Tool = { tool_name: string; tool_input: Record<string, unknown>; tool_response?: unknown };

/** The hooks of one turn that runs these tools and ends, 200 ms apart (past the dedup window). */
function turn(tools: Tool[]) {
  const hooks: Array<Record<string, unknown>> = [{ hook_event_name: 'UserPromptSubmit' }];
  tools.forEach((t, i) => {
    hooks.push({ hook_event_name: 'PreToolUse', tool_use_id: `toolu_${i}`, tool_name: t.tool_name, tool_input: t.tool_input });
    hooks.push({ hook_event_name: 'PostToolUse', tool_use_id: `toolu_${i}`, ...t });
  });
  hooks.push({ hook_event_name: 'Stop' });
  return hooks;
}

const BASH_BG: Tool = { tool_name: 'Bash', tool_input: { command: 'sleep 600 && make build', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b7kapz0ad' } };
const AGENT_BG: Tool = { tool_name: 'Agent', tool_input: { description: 'verify render', prompt: '...', run_in_background: true },
  tool_response: { isAsync: true, status: 'async_launched', agentId: 'a4bb623e3ab5ee41a', description: 'verify render' } };
const FLOW_TOOL: Tool = { tool_name: 'Workflow', tool_input: { name: 'release' },
  tool_response: 'Workflow started in the background. Task ID: wf91a2b3c' };
const CRON_ONCE: Tool = { tool_name: 'CronCreate', tool_input: { cron: '57 9 25 9 *', prompt: 'check CI', recurring: false },
  tool_response: { id: 'afc60409', humanSchedule: '57 9 25 9 *', recurring: false, durable: false } };
const CRON_LOOP: Tool = { tool_name: 'CronCreate', tool_input: { cron: '*/5 * * * *', prompt: 'check CI' },
  tool_response: { id: 'c0ffee01', humanSchedule: '*/5 * * * *', recurring: true, durable: false } };
/** The background Bash of the recorded 2.1.292 session, and the queue records its end left in the transcript (sanitized). */
const BASH_ABSORBED: Tool = { tool_name: 'Bash', tool_input: { command: 'make gates', description: 'Run all hand gates sequentially', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b76lzwo0d' } };
const ABSORBED_LINES = readFileSync(join(import.meta.dir, '..', '..', 'tests', 'fixtures', 'claude-cli-2.1.292-absorbed-task-notification.transcript.jsonl'), 'utf8')
  .split('\n').filter(Boolean);
/** The call that launched it, as its notice names it (`<tool-use-id>`). */
const ABSORBED_CALL = 'toolu_0182HmRXHPENtS8FfLU8wmT4';
const MONITOR: Tool = { tool_name: 'Monitor', tool_input: { command: 'tail -f worker.log', description: 'detect stopped workers' },
  tool_response: { taskId: 'bmon0stop', timeoutMs: 900000, persistent: false } };
/** A Monitor's notice absorbed mid-turn, as the CLI's queue records it (2.1.292). */
const monitorNotice = (body: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(),
  sessionId: '00000000-0000-4000-8000-0000000000b2', content: `<task-notification>\n<task-id>bmon0stop</task-id>\n${body}\n</task-notification>` });
/** An Agent's end absorbed mid-turn that names no call: a few of them do not (4 in about 470 first notices). */
const AGENT_END_NO_CALL = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(T0 + 900).toISOString(),
  sessionId: '00000000-0000-4000-8000-0000000000b3', content: '<task-notification>\n<task-id>a4bb623e3ab5ee41a</task-id>\n<status>failed</status>\n<summary>Agent "verify render" failed</summary>\n</task-notification>' });
const BASH_FG: Tool = { tool_name: 'Bash', tool_input: { command: 'bun test' },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } };

const subjectOf = (s: { sessionKey: string | null; claudeSessionId: string }) =>
  s.sessionKey ? `topic:${s.sessionKey.slice('topic:'.length)}` : `terminal:${s.claudeSessionId}`;

function chatTracker(frames: any[]) {
  const db = freshDb();
  seedChat(db, 'topic:bg', 'cli-bg');
  const tracker = createClaudeSessionTracker({ db, broadcast: (m) => frames.push(m), coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf });
  return { tracker, sid: 'cli-bg', subject: 'topic:bg' };
}

function terminalTracker(frames: any[]) {
  const tracker = createClaudeSessionTracker({ db: freshDb(), broadcast: (m) => frames.push(m), coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf });
  tracker.registerTerminalSession('cli-term', { now: T0 });
  return { tracker, sid: 'cli-term', subject: 'terminal:cli-term' };
}

const KINDS = [
  { label: 'chat', make: chatTracker },
  { label: 'terminal', make: terminalTracker },
];

function phaseOf(tracker: ReturnType<typeof createClaudeSessionTracker>, sid: string) {
  return tracker.getSession(sid)?.phase;
}

describe('the phase at Stop counts every task in flight, by id, in the attention store', () => {
  beforeEach(() => { resetAttentionStore(); configureAttentionStore({ db: () => null, sendPush: () => {}, recordRow: () => null }); });

  for (const { label, make } of KINDS) {
    for (const [name, tool] of [['Bash run_in_background', BASH_BG], ['Agent run_in_background', AGENT_BG], ['Workflow', FLOW_TOOL], ['one-shot CronCreate', CRON_ONCE]] as const) {
      it(`${label}: a ${name} parks the session watching, with its task counted`, () => {
        const { tracker, sid, subject } = make([]);
        turn([tool]).forEach((h, i) => tracker.ingestHook({ ...h, session_id: sid } as never, T0 + 200 * (i + 1)));
        expect(phaseOf(tracker, sid)).toBe('watching');
        expect(countingTasks(subject)).toBe(1);
        expect(getAttention(subject).background.map((t) => t.id)).toHaveLength(1);
      });
    }

    it(`${label}: a recurring CronCreate sits in the map marked recurring, and Stop gives awaiting-user`, () => {
      const { tracker, sid, subject } = make([]);
      turn([CRON_LOOP]).forEach((h, i) => tracker.ingestHook({ ...h, session_id: sid } as never, T0 + 200 * (i + 1)));
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
      expect(countingTasks(subject)).toBe(0);
      expect(getAttention(subject).background).toEqual([expect.objectContaining({ id: 'c0ffee01', recurring: true })]);
    });

    it(`${label}: a foreground Bash does not enter the map, and Stop gives awaiting-user`, () => {
      const { tracker, sid, subject } = make([]);
      turn([BASH_FG]).forEach((h, i) => tracker.ingestHook({ ...h, session_id: sid } as never, T0 + 200 * (i + 1)));
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
      expect(getAttention(subject).background).toEqual([]);
    });

    it(`${label}: one of two tasks returns, the woken turn ends, and the session is still watching`, () => {
      const { tracker, sid, subject } = make([]);
      let t = T0;
      turn([BASH_BG, AGENT_BG]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(countingTasks(subject)).toBe(2);
      // The Bash reports in the transcript, and its wake runs and stops.
      tracker.ingestTranscriptLine(sid, JSON.stringify({ type: 'user', timestamp: new Date((t += 200)).toISOString(),
        message: { role: 'user', content: '<task-notification>\n<task-id>b7kapz0ad</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>' },
        origin: { kind: 'task-notification' } }), t);
      expect(countingTasks(subject)).toBe(1);
      tracker.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, (t += 200));
      expect(phaseOf(tracker, sid)).toBe('watching');
    });

    it(`${label}: a task whose notification is absorbed mid-turn leaves the map, and the Stop gives awaiting-user`, () => {
      const { tracker, sid, subject } = make([]);
      let t = T0;
      const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      expect(countingTasks(subject)).toBe(1);
      // The task ends while the turn still runs: no user line, only the queue's records.
      for (const line of ABSORBED_LINES) tracker.ingestTranscriptLine(sid, line, (t += 200));
      expect(countingTasks(subject)).toBe(0);
      hook({ hook_event_name: 'Stop' });
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
      expect(getAttention(subject).background).toEqual([]);
    });

    // Hooks are async and arrive late (`lib/hook-order.ts`): the tail can read the end first.
    it(`${label}: a notice read before the PostToolUse closes the task under its call's id, and the late hook does not bring it back`, () => {
      const { tracker, sid, subject } = make([]);
      let t = T0;
      const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: ABSORBED_CALL, ...BASH_ABSORBED });
      for (const line of ABSORBED_LINES) tracker.ingestTranscriptLine(sid, line, (t += 200));
      expect(countingTasks(subject)).toBe(0);
      hook({ hook_event_name: 'PostToolUse', tool_use_id: ABSORBED_CALL, ...BASH_ABSORBED });
      expect(countingTasks(subject)).toBe(0);
      hook({ hook_event_name: 'Stop' });
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
      expect(getAttention(subject).background).toEqual([]);
    });

    it(`${label}: a notice read before both of its hooks keeps the task out when they arrive`, () => {
      const { tracker, sid, subject } = make([]);
      let t = T0;
      const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      for (const line of ABSORBED_LINES) tracker.ingestTranscriptLine(sid, line, (t += 200));
      hook({ hook_event_name: 'PreToolUse', tool_use_id: ABSORBED_CALL, ...BASH_ABSORBED });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: ABSORBED_CALL, ...BASH_ABSORBED });
      expect(countingTasks(subject)).toBe(0);
      hook({ hook_event_name: 'Stop' });
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    });

    it(`${label}: a notice that names no call, then the Stop, then the late PostToolUse: the hook closes the task and the turn rests`, () => {
      const { tracker, sid, subject } = make([]);
      const hook = (h: Record<string, unknown>, firedAt: number, at = firedAt) =>
        tracker.ingestHook({ ...h, session_id: sid, fired_at: firedAt } as never, at);
      hook({ hook_event_name: 'UserPromptSubmit' }, T0 + 100);
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_a', ...AGENT_BG }, T0 + 300);
      tracker.ingestTranscriptLine(sid, AGENT_END_NO_CALL, T0 + 900);
      hook({ hook_event_name: 'Stop' }, T0 + 1500);
      expect(phaseOf(tracker, sid)).toBe('watching');
      // Fired before the Stop, read after it.
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_a', ...AGENT_BG }, T0 + 400, T0 + 2500);
      expect(countingTasks(subject)).toBe(0);
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    });
  }

  it('terminal: a Monitor event that says «stopped» is the watched program talking, and only the CLI\'s own notice ends the Monitor', () => {
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    turn([MONITOR]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
    expect(countingTasks(subject)).toBe(1);
    // Its description says «stopped» too, and every event's summary repeats it.
    tracker.ingestTranscriptLine(sid, monitorNotice('<summary>Monitor event: "detect stopped workers"</summary>\n<event>worker stopped, restarting</event>', (t += 200)), t);
    expect(countingTasks(subject)).toBe(1);
    tracker.ingestTranscriptLine(sid, monitorNotice('<summary>Monitor event: "detect stopped workers"</summary>\n<event>[Monitor timed out \u2014 re-arm if needed.]</event>', (t += 200)), t);
    expect(countingTasks(subject)).toBe(0);
  });

  it('terminal: a Monitor event read before its PostToolUse does not end it, and its end does', () => {
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
    hook({ hook_event_name: 'UserPromptSubmit' });
    hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_m', ...MONITOR });
    tracker.ingestTranscriptLine(sid, monitorNotice('<summary>Monitor event: "detect stopped workers"</summary>\n<event>worker 3 up</event>', (t += 200)), t);
    hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_m', ...MONITOR });
    expect(countingTasks(subject)).toBe(1);
    tracker.ingestTranscriptLine(sid, monitorNotice('<tool-use-id>toolu_m</tool-use-id>\n<status>completed</status>\n<summary>Monitor "detect stopped workers" stream ended</summary>', (t += 200)), t);
    expect(countingTasks(subject)).toBe(0);
    hook({ hook_event_name: 'Stop' });
    expect(phaseOf(tracker, sid)).toBe('awaiting-user');
  });

  // The CLI stops a Monitor itself (2.1.295): after 30 s of too much output, or at a TaskStop. No `<status>` follows.
  for (const { why, event } of [
    { why: 'too much output', event: '[Monitor stopped \u2014 too much output (412 events suppressed over 31s). Restart with a more selective source.]' },
    { why: 'a TaskStop', event: '[Monitor stopped]' },
  ]) {
    it(`terminal: a Monitor the CLI stopped for ${why} leaves the map, and the next Stop is awaiting-user`, () => {
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([MONITOR]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(phaseOf(tracker, sid)).toBe('watching');
      tracker.ingestTranscriptLine(sid, monitorNotice(`<summary>Monitor event: "detect stopped workers"</summary>\n<event>${event}</event>`, (t += 200)), t);
      expect(countingTasks(subject)).toBe(0);
      tracker.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, (t += 200));
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    });
  }

  it('terminal: a one-shot cron leaves at the next turn (its fire), and that turn finishes with one announce (ATTN-03)', () => {
    const frames: any[] = [];
    configureAttentionStore({ broadcast: (f) => { frames.push(f); } });
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    turn([CRON_ONCE]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
    expect(getAttention(subject).state).toBe('working');
    // The cron fires: Claude Code submits its prompt as a turn, which ends.
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', prompt: 'check CI', session_id: sid } as never, (t += 200));
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, (t += 200));
    expect(getAttention(subject)).toMatchObject({ state: 'finished', outcome: 'done', background: [] });
    expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    expect(frames.filter((f) => f.type === 'attention:updated' && f.announce)).toHaveLength(1);
  });

  it('terminal: a recurring cron stays in the map across the next turn', () => {
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    turn([CRON_LOOP]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: sid } as never, (t += 200));
    expect(getAttention(subject).background).toEqual([expect.objectContaining({ id: 'c0ffee01', recurring: true })]);
  });

  it('terminal: the expired Monitor of the recorded transcript leaves the set, and the next Stop is awaiting-user', () => {
    const expired = readFileSync(join(import.meta.dir, '..', '..', 'tests', 'fixtures', 'claude-cli-2.1.285-monitor-wakes.transcript.jsonl'), 'utf8').split('\n')[0];
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
    hook({ hook_event_name: 'UserPromptSubmit' });
    hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_m', tool_name: 'Monitor', tool_input: { command: 'tail -f log' } });
    hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_m', tool_name: 'Monitor', tool_input: { command: 'tail -f log' },
      tool_response: { taskId: 'but49bkqo', timeoutMs: 900000, persistent: false } });
    hook({ hook_event_name: 'Stop' });
    expect(phaseOf(tracker, sid)).toBe('watching');
    expect(countingTasks(subject)).toBe(1);
    // The Monitor's end opens the CLI's own turn: the transcript line says it expired.
    tracker.ingestTranscriptLine(sid, expired, Date.parse('2026-09-30T20:53:48.458Z'));
    expect(countingTasks(subject)).toBe(0);
    tracker.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, Date.parse('2026-09-30T20:54:00Z'));
    expect(phaseOf(tracker, sid)).toBe('awaiting-user');
  });
});

/**
 * A terminal's turn interrupted with Esc gets no `Stop` (Claude Code fires none
 * on a user interrupt): the reaper's demotion of the silent turn is the only
 * thing that ends it. The attention state must end it too, or the terminal
 * reads «working» on its tab, its project and the agents' menu until the next
 * prompt (ATTN-12).
 */
describe('a terminal turn put to rest without a Stop is over for the attention state', () => {
  beforeEach(() => { resetAttentionStore(); configureAttentionStore({ db: () => null, sendPush: () => {}, recordRow: () => null }); });

  it('terminal: prompt, Esc (no Stop), the reaper demotes the turn: idle, nothing lit', () => {
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: sid } as never, (t += 200));
    expect(getAttention(subject).state).toBe('working');
    // Esc: no Stop. Hours later the reaper finds the turn silent.
    expect(tracker.reapOnce(t + 2 * 60 * 60 * 1000)).toBe(1);
    expect(phaseOf(tracker, sid)).toBe('dormant');
    expect(getAttention(subject)).toMatchObject({ state: 'idle', lit: false });
  });

  it('terminal: the same demotion with a job still in flight keeps the terminal at work on the job', () => {
    const { tracker, sid, subject } = terminalTracker([]);
    let t = T0;
    const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
    hook({ hook_event_name: 'UserPromptSubmit' });
    hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_0', ...BASH_BG });
    hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_0', ...BASH_BG });
    tracker.reapOnce(t + 2 * 60 * 60 * 1000);
    expect(phaseOf(tracker, sid)).toBe('dormant');
    expect(getAttention(subject)).toMatchObject({ state: 'working', background: [expect.objectContaining({ id: 'b7kapz0ad' })] });
  });
});

/**
 * A server restart reattaches a terminal without replaying its history: the
 * offset snaps to the end of the transcript. A task whose notification was
 * written meanwhile, or skipped by an older parser, still has to leave the map,
 * or the terminal reads «working» until its PTY exits (ATTN-03).
 */
describe('a reattached terminal drops the tasks its transcript already reports finished', () => {
  // A grace above zero, as in production: the one the live path arms would announce once it ran out.
  const pushes: unknown[] = [];
  const rows: unknown[] = [];
  let table: Database;
  const configure = () => configureAttentionStore({ db: () => table, sendPush: (p) => { pushes.push(p); }, recordRow: (r) => { rows.push(r); return null; }, graceMs: 20 });
  /** A restart of the server: nothing in memory survives, the table does. */
  const restart = () => {
    resetAttentionStore();
    configure();
  };
  /** The start recomposition, after the surviving turns are adopted: the reattach comes first. */
  const boot = () => {
    recomposeAttentionOnBoot({ liveProcess: () => true });
  };
  beforeEach(() => {
    pushes.length = 0;
    rows.length = 0;
    table = attentionTable();
    resetAttentionStore();
    configure();
  });

  it('terminal: the notification sits in the transcript, the reattach takes its task out, replays no phase and announces nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(phaseOf(tracker, sid)).toBe('watching');
      // Its end lands in the transcript while no server reads the file.
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      // The restart: the store keeps its table and none of its memory, a new tracker reattaches the terminal.
      restart();
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(countingTasks(subject)).toBe(0);
      boot();
      // A turn that closed before the restart: the restart recomposes it, it does not announce it,
      // not even once a grace has run out.
      await new Promise((r) => setTimeout(r, 100));
      expect({ epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length }).toEqual(before);
      expect(getAttention(subject)).toMatchObject({ background: [] });
      expect(getAttention(subject).state).not.toBe('working');
      expect(phaseOf(after, sid)).toBe('dormant');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('terminal: a task still in flight after the late read is announced once when it ends live', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-rest-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED, AGENT_BG]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(countingTasks(subject)).toBe(2);
      // The Bash ends while no server reads the file; the Agent still runs.
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(countingTasks(subject)).toBe(1);
      boot();
      expect(getAttention(subject).state).toBe('working');
      // Minutes later the Agent ends: the CLI writes its notice and the live tail reads it.
      const agentEnd = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(T0 + 60_000).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b2',
        content: '<task-notification>\n<task-id>a4bb623e3ab5ee41a</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "verify render" completed</summary>\n</task-notification>' });
      appendFileSync(path, agentEnd + '\n');
      await after.tailOnce((t += 60_000));
      expect(countingTasks(subject)).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('terminal: a live turn that ends while the catch-up still reads is announced once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-live-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(phaseOf(tracker, sid)).toBe('watching');
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      restart();
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      // A live turn of the still-running CLI, synchronously: the catch-up awaits the file open,
      // so the Stop deterministically sees the stale task still in the map.
      after.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: sid } as never, (t += 200));
      expect(countingTasks(subject)).toBeGreaterThan(0);
      after.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, (t += 200));
      expect(countingTasks(subject)).toBeGreaterThan(0);
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(countingTasks(subject)).toBe(0);
      // The start recomposition lands inside the grace: the live turn still announces once.
      boot();
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject)).toMatchObject({ state: 'finished', background: [] });
      expect(getAttention(subject).epoch - before.epoch).toBe(1);
      expect(pushes.length - before.pushes).toBe(1);
      expect(rows.length - before.rows).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('terminal: a live turn opened during the read and closed without an outcome does not announce the turn of before', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-null-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      expect(phaseOf(tracker, sid)).toBe('watching');
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      restart();
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      // The live turn opens while the catch-up still reads: the stale task is still counted.
      after.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: sid } as never, (t += 200));
      expect(countingTasks(subject)).toBeGreaterThan(0);
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(countingTasks(subject)).toBe(0);
      boot();
      // The live turn closes with nothing to announce: the turn of before stays without an epoch.
      turnEnded(subject, { outcome: null });
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject)).toMatchObject({ state: 'finished', background: [] });
      expect({ epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length }).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a turn closed live before the start recomposed is still announced when a late read frees it', async () => {
    // The start's recomposition waits for the surviving turns to be adopted, and hooks arrive meanwhile.
    const subject = 'terminal:boot-window';
    setBackgroundTasks(subject, { b1: { kind: 'bash', label: 'make gates', startedAt: new Date(T0).toISOString() } });
    turnStarted(subject);
    turnEnded(subject, { turnId: 'live-1', outcome: 'done' });
    expect(getAttention(subject).state).toBe('working');
    recomposeAttentionOnBoot({ liveProcess: () => true });
    const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
    finishBackgroundTasks(subject, ['b1'], { late: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(getAttention(subject).state).toBe('finished');
    expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
  });
});
