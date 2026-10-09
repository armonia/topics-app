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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import { configureAttentionStore, resetAttentionStore, getAttention, countingTasks } from '../attention/store';
import { T0, freshDb, turn, BASH_BG, AGENT_BG, CRON_ONCE, CRON_LOOP, BASH_ABSORBED, ABSORBED_LINES, ABSORBED_AT, AGENT_END_NO_CALL, subjectOf, terminalTracker, phaseOf, type Tool } from './claude-session-state.background-tasks.fixture';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

function seedChat(db: Database, sessionKey: string, csid: string) {
  db.prepare(`INSERT INTO topics VALUES (?)`).run(sessionKey);
  db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at)
    VALUES (?, ?, ?, ?, 'starting', ?)`).run(sessionKey, csid, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString());
}

const FLOW_TOOL: Tool = { tool_name: 'Workflow', tool_input: { name: 'release' },
  tool_response: 'Workflow started in the background. Task ID: wf91a2b3c' };
/** The call that launched it, as its notice names it (`<tool-use-id>`). */
const ABSORBED_CALL = 'toolu_0182HmRXHPENtS8FfLU8wmT4';
const MONITOR: Tool = { tool_name: 'Monitor', tool_input: { command: 'tail -f worker.log', description: 'detect stopped workers' },
  tool_response: { taskId: 'bmon0stop', timeoutMs: 900000, persistent: false } };
/** A Monitor's notice absorbed mid-turn, as the CLI's queue records it (2.1.292). */
const monitorNotice = (body: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(),
  sessionId: '00000000-0000-4000-8000-0000000000b2', content: `<task-notification>\n<task-id>bmon0stop</task-id>\n${body}\n</task-notification>` });
const BASH_FG: Tool = { tool_name: 'Bash', tool_input: { command: 'bun test' },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } };

function chatTracker(frames: any[]) {
  const db = freshDb();
  seedChat(db, 'topic:bg', 'cli-bg');
  const tracker = createClaudeSessionTracker({ db, broadcast: (m) => frames.push(m), coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf });
  return { tracker, sid: 'cli-bg', subject: 'topic:bg' };
}

const KINDS = [
  { label: 'chat', make: chatTracker },
  { label: 'terminal', make: terminalTracker },
];

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

    // The tail reads at its own pace: the records of a notice absorbed near the end of the turn can reach it after
    // the `Stop`, which parked the turn `watching` on a task already over. Nothing will wake that turn.
    it(`${label}: a notice absorbed mid-turn that the tail reads after the Stop lets the turn rest`, () => {
      const { tracker, sid, subject } = make([]);
      let t = ABSORBED_AT - 1_000;
      const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      t = ABSORBED_AT + 9_800;
      hook({ hook_event_name: 'Stop' });
      expect(phaseOf(tracker, sid)).toBe('watching');
      for (const line of ABSORBED_LINES) tracker.ingestTranscriptLine(sid, line, (t += 200));
      expect(countingTasks(subject)).toBe(0);
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
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

  // The same late records read by the live tail itself, `tailOnce`, rather than line by line.
  it('terminal: the live tail that reads an absorbed notice after the Stop lets the turn rest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-tail-settle-'));
    try {
      const cwd = '/work/project', sid = 'cli-tail', subject = 'terminal:cli-tail';
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      const tracker = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      let t = ABSORBED_AT - 1_000;
      tracker.registerTerminalSession(sid, { cwd, now: t });
      const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_0', ...BASH_ABSORBED });
      t = ABSORBED_AT + 9_800;
      hook({ hook_event_name: 'Stop' });
      expect(phaseOf(tracker, sid)).toBe('watching');
      appendFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      await tracker.tailOnce((t += 200));
      expect(countingTasks(subject)).toBe(0);
      expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/** BASH_BG's notice, as the CLI words it, under the call that launched it in `turn`. */
const BASH_BG_END = '<task-notification>\n<task-id>b7kapz0ad</task-id>\n<tool-use-id>toolu_0</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 600 && make build" completed (exit code 0)</summary>\n</task-notification>';
/** The CLI's queue record of a notice, written when its task ends, whether a turn absorbs it or it is delivered. */
const enqueued = (content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b4', content });
/** The row that delivers a notice to a turn at rest, and wakes it. */
const delivered = (content: string, at: number) => JSON.stringify({ type: 'user', uuid: `u${at}`, timestamp: new Date(at).toISOString(), message: { role: 'user', content }, origin: { kind: 'task-notification' } });

/** AGENT_BG's notice, under the call that launched it second in `turn`. */
const AGENT_BG_END = '<task-notification>\n<task-id>a4bb623e3ab5ee41a</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "verify render" completed</summary>\n</task-notification>';
/** The CLI's queue letting a notice go without delivering it: a turn absorbed it, or it was dropped. */
const removed = (content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: new Date(at).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b4', content });

/** A chat or a terminal whose transcript, under `home`, the live tail follows. */
function tailed(kind: 'chat' | 'terminal', home: string) {
  const sid = `cli-${kind}`, cwd = '/work/project', path = deriveTranscriptPath(home, cwd, sid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  const db = freshDb();
  if (kind === 'chat') seedChat(db, 'topic:bg', sid);
  const tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
  if (kind === 'terminal') tracker.registerTerminalSession(sid, { cwd, now: T0 });
  else tracker.ingestHook({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: path, session_id: sid } as never, T0);
  let t = T0;
  const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
  return { tracker, sid, subject: kind === 'chat' ? 'topic:bg' : `terminal:${sid}`, hook, now: () => t, write: (...lines: string[]) => appendFileSync(path, lines.join('\n') + '\n') };
}

/**
 * A turn parked `watching` rests on the ends the tail reads after its `Stop`
 * once none of them can wake it: each written before the `Stop` (absorbed, or
 * queued while the turn still answered), or let go by the CLI's queue
 * (`remove`). An end written after it and still queued is the report the turn
 * waits for, and the CLI's row that delivers it wakes the turn: until then it
 * stays `watching` (MONITOR-04). Measured on 200 transcripts: the delivery row
 * comes 32 ms after its enqueue at the median, so one sweep in eight reads the
 * two apart; 27 of 464 delivered notices were queued before the `Stop`; 766
 * ends were let go while the session rested, 242 of them while an earlier one
 * still waited to be delivered; 11 of 1203 were neither, and a minute later
 * they no longer hold the turn (`NOTICE_WAKE_MS`).
 */
describe('a parked turn rests on the ends the tail reads late once none of them can wake it', () => {
  beforeEach(() => { resetAttentionStore(); configureAttentionStore({ db: () => null, sendPush: () => {}, recordRow: () => null }); });
  const withHome = async (body: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), 'bg-tail-late-end-'));
    try { await body(home); } finally { rmSync(home, { recursive: true, force: true }); }
  };

  for (const kind of ['chat', 'terminal'] as const) {
    // Two of 453 delivery rows are stamped before their own enqueue: still after the Stop.
    for (const row of ['32 ms after it', 'stamped before it'] as const) {
      it(`${kind}: a notice delivered after the Stop, its enqueue and its delivery row read in two sweeps, wakes the turn from watching (row ${row})`, () => withHome(async (home) => {
        const { tracker, sid, hook, now, write } = tailed(kind, home);
        turn([BASH_BG]).forEach((h) => hook(h));
        const stop = now(), seen = [phaseOf(tracker, sid)];
        write(enqueued(BASH_BG_END, stop + 300));
        await tracker.tailOnce(stop + 305);
        seen.push(phaseOf(tracker, sid));
        write(delivered(BASH_BG_END, row === '32 ms after it' ? stop + 332 : stop + 200));
        await tracker.tailOnce(stop + 1_805);
        seen.push(phaseOf(tracker, sid));
        expect(seen).toEqual(['watching', 'watching', 'running']);
      }));
    }

    // Queued while the turn still answered, the notice is delivered once it stops: the turn rests from its Stop, as
    // when the tail reads the enqueue first, and the delivery row wakes it although it is stamped before the sweep.
    it(`${kind}: a notice queued before the Stop and delivered after it lets the turn rest, and its delivery row wakes it`, () => withHome(async (home) => {
      const { tracker, sid, hook, now, write } = tailed(kind, home);
      turn([BASH_BG]).slice(0, -1).forEach((h) => hook(h));
      const queued = now() + 100;
      hook({ hook_event_name: 'Stop' });
      const stop = now(), seen = [phaseOf(tracker, sid)];
      write(enqueued(BASH_BG_END, queued));
      await tracker.tailOnce(stop + 1_000);
      seen.push(phaseOf(tracker, sid));
      write(delivered(BASH_BG_END, stop + 300));
      await tracker.tailOnce(stop + 2_500);
      seen.push(phaseOf(tracker, sid));
      expect(seen).toEqual(['watching', 'awaiting-user', 'running']);
    }));

    // At rest the CLI can let a notice go instead of delivering it: then nothing will wake the turn.
    it(`${kind}: a notice the CLI lets go after the Stop lets the turn rest`, () => withHome(async (home) => {
      const { tracker, sid, hook, now, write } = tailed(kind, home);
      turn([BASH_BG]).forEach((h) => hook(h));
      const stop = now(), seen = [phaseOf(tracker, sid)];
      write(enqueued(BASH_BG_END, stop + 300));
      await tracker.tailOnce(stop + 305);
      seen.push(phaseOf(tracker, sid));
      write(removed(BASH_BG_END, stop + 4_000));
      await tracker.tailOnce(stop + 4_005);
      seen.push(phaseOf(tracker, sid));
      expect(seen).toEqual(['watching', 'watching', 'awaiting-user']);
    }));

    // Neither delivered nor let go (11 of 1203 at rest): after a minute (MONITOR-04) it wakes nothing, and the reaper
    // lets the turn rest while the tail has nothing more to read.
    it(`${kind}: a notice the CLI neither delivers nor lets go stops holding the turn after a minute`, () => withHome(async (home) => {
      const { tracker, sid, hook, now, write } = tailed(kind, home);
      turn([BASH_BG]).forEach((h) => hook(h));
      const stop = now(), seen = [phaseOf(tracker, sid)];
      write(enqueued(BASH_BG_END, stop + 300));
      await tracker.tailOnce(stop + 305);
      tracker.reapOnce(stop + 300 + 59_999);
      seen.push(phaseOf(tracker, sid));
      tracker.reapOnce(stop + 300 + 60_000);
      seen.push(phaseOf(tracker, sid));
      expect(seen).toEqual(['watching', 'watching', 'awaiting-user']);
    }));

    // Two ends after the Stop, and the CLI lets the second go while the first still waits to be delivered.
    it(`${kind}: a notice let go while an earlier one still waits keeps the turn watching until that one wakes it`, () => withHome(async (home) => {
      const { tracker, sid, hook, now, write } = tailed(kind, home);
      turn([BASH_BG, AGENT_BG]).forEach((h) => hook(h));
      const stop = now(), seen = [phaseOf(tracker, sid)];
      write(enqueued(AGENT_BG_END, stop + 300), enqueued(BASH_BG_END, stop + 900), removed(BASH_BG_END, stop + 950));
      await tracker.tailOnce(stop + 1_000);
      seen.push(phaseOf(tracker, sid));
      write(delivered(AGENT_BG_END, stop + 1_200));
      await tracker.tailOnce(stop + 2_500);
      seen.push(phaseOf(tracker, sid));
      expect(seen).toEqual(['watching', 'watching', 'running']);
    }));
  }

  // A hook that lands while the sweep reads overtakes its commit: the next sweep reads the same lines again, their
  // task already out of the map.
  it('terminal: an end read by a sweep a hook overtook lets the turn rest at the next sweep', () => withHome(async (home) => {
    const { tracker, sid, subject, hook, now, write } = tailed('terminal', home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => hook(h));
    write(enqueued(BASH_BG_END, now() + 100));
    hook({ hook_event_name: 'Stop' });
    const stop = now();
    const sweep = tracker.tailOnce(stop + 1_000);
    tracker.ingestHook({ hook_event_name: 'SubagentStop', session_id: sid } as never, stop + 900);
    await sweep;
    expect(countingTasks(subject)).toBe(0);
    expect(phaseOf(tracker, sid)).toBe('watching');
    await tracker.tailOnce(stop + 2_500);
    expect(phaseOf(tracker, sid)).toBe('awaiting-user');
  }));

  // A Monitor delivered to a parked chat leaves the map before its wake writes anything (`noteWatchDelivered`), and no
  // transcript line took the last task out: the turn waits for the wake, whatever the tail reads meanwhile, also after
  // a turn that rested on an end read late.
  it('chat: a Monitor delivered to the parked turn leaves it watching for the wake, whatever the tail reads meanwhile', () => withHome(async (home) => {
    const { tracker, sid, subject, hook, now, write } = tailed('chat', home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => hook(h));
    write(enqueued(BASH_BG_END, now() + 100));
    hook({ hook_event_name: 'Stop' });
    await tracker.tailOnce(now() + 1_000);
    expect(phaseOf(tracker, sid)).toBe('awaiting-user');
    // The next turn parks on an Agent and a Monitor; the Agent's end, absorbed, reaches the tail after the Stop.
    hook({ hook_event_name: 'UserPromptSubmit' });
    for (const [call, tool] of [['toolu_1', AGENT_BG], ['toolu_m', MONITOR]] as const) {
      hook({ hook_event_name: 'PreToolUse', tool_use_id: call, tool_name: tool.tool_name, tool_input: tool.tool_input });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: call, ...tool });
    }
    write(enqueued(AGENT_BG_END, now() + 100));
    hook({ hook_event_name: 'Stop' });
    const stop = now();
    await tracker.tailOnce(stop + 1_000);
    expect(phaseOf(tracker, sid)).toBe('watching');
    tracker.noteWatchDelivered('topic:bg', stop + 1_500);
    expect(countingTasks(subject)).toBe(0);
    write(JSON.stringify({ type: 'assistant', uuid: 'a-last', timestamp: new Date(stop - 50).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Watching the workers.' }] } }));
    await tracker.tailOnce(stop + 2_500);
    expect(phaseOf(tracker, sid)).toBe('watching');
  }));
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
