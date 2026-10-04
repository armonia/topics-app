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
 * copied from `tests/fixtures/claude-cli-2.1.282-*.ndjson`.
 * @covers ATTN-03
 * @covers ATTN-12
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { configureAttentionStore, resetAttentionStore, getAttention, countingTasks } from '../attention/store';

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
