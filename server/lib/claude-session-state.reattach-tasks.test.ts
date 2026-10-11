/**
 * A reattached terminal rereads from its transcript the task notices written
 * while the server was down: what ended before the restart heals in silence,
 * what ends live is announced once.
 * @covers ATTN-03
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import { resetAttentionStore, getAttention, countingTasks, finishBackgroundTasks, recomposeAttentionOnBoot, setBackgroundTasks, turnEnded, turnStarted } from '../attention/store';
import { T0, freshDb, turn, BASH_BG, AGENT_BG, CRON_ONCE, CRON_LOOP, BASH_ABSORBED, ABSORBED_LINES, ABSORBED_AT, AGENT_END_NO_CALL, AGENT_END_NO_CALL_LET_GO, subjectOf, terminalTracker, phaseOf, durableAttention } from './claude-session-state.background-tasks.fixture';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

/** A queue record of the CLI for a notice: `enqueue` when its task ends, `remove` when the queue lets it go undelivered. */
const queueRecord = (operation: 'enqueue' | 'remove', content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation, timestamp: new Date(at).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b2', content });
/** A notice queued and let go: a turn absorbed it, or the queue dropped it. Its task ends with the `remove`. */
const letGo = (content: string, at: number) => [queueRecord('enqueue', content, at), queueRecord('remove', content, at + 5)].join('\n');
/** The notice of AGENT_BG, launched by the call `toolu_1`. */
const AGENT_BG_NOTICE = '<task-notification>\n<task-id>a4bb623e3ab5ee41a</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "verify render" completed</summary>\n</task-notification>';
/** The notice of BASH_BG, launched by the call `toolu_n0`. */
const BASH_BG_NOTICE = '<task-notification>\n<task-id>b7kapz0ad</task-id>\n<tool-use-id>toolu_n0</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 600 && make build" completed (exit code 0)</summary>\n</task-notification>';
/** The lines the CLI writes when AGENT_BG ends and its notice is let go. */
const agentBgEnd = (at: number) => letGo(AGENT_BG_NOTICE, at);
/** The lines the CLI writes when BASH_BG ends and its notice is let go. */
const bashBgEnd = (at: number) => letGo(BASH_BG_NOTICE, at);
/** The lines the CLI writes when a task ends and its notice is let go: its id, and its call's when the notice names it. */
const taskEnd = (taskId: string, call: string | null, at: number) =>
  letGo(`<task-notification>\n<task-id>${taskId}</task-id>\n${call ? `<tool-use-id>${call}</tool-use-id>\n` : ''}<status>completed</status>\n<summary>done</summary>\n</task-notification>`, at);
// The same NOCALL Agent end as a user delivery row, what the live tail reads after the reattach.
const USER_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: JSON.parse(AGENT_END_NO_CALL).content }, timestamp: new Date(T0 + 5_000).toISOString() });

/**
 * A server restart reattaches a terminal without replaying its history: the
 * offset snaps to the end of the transcript. A task whose notification was
 * written meanwhile, or skipped by an older parser, still has to leave the map,
 * or the terminal reads «working» until its PTY exits (ATTN-03).
 */
describe('a reattached terminal drops the tasks its transcript already reports finished', () => {
  const { pushes, rows, table, reset, restart, boot } = durableAttention();
  beforeEach(reset);

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
      appendFileSync(path, agentBgEnd(T0 + 60_000) + '\n');
      await after.tailOnce((t += 60_000));
      expect(countingTasks(subject)).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T1 closes on its Bash; T2 launches another and is put to rest by Esc (no Stop, no outcome), all before
  // the restart. T1's Bash ends while the server is down, T2's after it: without a restart T2's end
  // announces the work of before, once. `rekeyed`: T2's PostToolUse reaches only the restarted server.
  for (const variant of ['start recomposition before its end', 'start recomposition after its end', 'rekeyed'] as const) {
    it(`terminal: a task of a turn put to rest before the restart, still in flight after the late read, is announced once when it ends live (${variant})`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-rested-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = T0;
        const hook = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
        turn([BASH_ABSORBED]).forEach((h) => hook(h));
        hook({ hook_event_name: 'UserPromptSubmit' });
        hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
        if (variant !== 'rekeyed') hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
        tracker.reapOnce((t += 2 * 60 * 60 * 1000));
        expect(countingTasks(subject)).toBe(2);
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        if (variant === 'rekeyed') after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG, session_id: sid } as never, (t += 200));
        const deadline = Date.now() + 3_000;
        while (getAttention(subject).background.some((x: { id: string }) => x.id === 'b76lzwo0d') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        expect(getAttention(subject).background.map((x: { id: string }) => x.id)).toEqual(['b7kapz0ad']);
        if (variant !== 'start recomposition after its end') boot();
        expect(getAttention(subject).state).toBe('working');
        appendFileSync(path, bashBgEnd(t + 60_000) + '\n');
        await after.tailOnce((t += 60_000));
        if (variant === 'start recomposition after its end') boot();
        expect(countingTasks(subject)).toBe(0);
        await new Promise((r) => setTimeout(r, 100));
        expect(getAttention(subject).state).toBe('finished');
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // T1 leaves a Bash, which ends while the server is down, and an Agent, whose end the live tail reads while
  // the catch-up still reads: that end waits for the catch-up, whose lines come first in the file. The work of
  // before ended live, and the Agent's end, let in after the Bash's, announces it.
  it('terminal: a task of before the restart that ends live while the catch-up reads: the turn is announced once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-race-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED, AGENT_BG]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const end = agentBgEnd(t + 500);
      appendFileSync(path, end + '\n');
      t += 500;
      for (const line of end.split('\n')) after.ingestTranscriptLine(sid, line, t);
      expect(getAttention(subject).background.map((x: { id: string }) => x.id).sort()).toEqual(['a4bb623e3ab5ee41a', 'b76lzwo0d']);
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T1 leaves a Bash, which ends while the server is down, and a one-shot cron that the next prompt fires; then
  // that prompt's turn is put to rest by Esc. Without a restart the turn of before is announced once.
  for (const order of ['before', 'after'] as const) {
    it(`terminal: a one-shot cron of before the restart, fired by a prompt ${order} the late read: the turn is announced once`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-cron-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = T0;
        turn([BASH_ABSORBED, CRON_ONCE]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        const prompt = () => after.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: sid } as never, (t += 200));
        if (order === 'before') prompt();
        const deadline = Date.now() + 3_000;
        while (getAttention(subject).background.some((x: { id: string }) => x.id === 'b76lzwo0d') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        if (order === 'after') prompt();
        boot();
        after.reapOnce(t + 2 * 60 * 60 * 1000);
        await new Promise((r) => setTimeout(r, 100));
        expect(getAttention(subject).state).toBe('finished');
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // T1 leaves a Bash, which ends while the server is down, and a recurring cron, which never held the turn. A live
  // turn deletes the cron while the catch-up reads, then Esc: without a restart nothing more is announced.
  it('terminal: a recurring cron of before the restart, deleted live while the catch-up reads, leaves the turn of before unannounced', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-loop-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED, CRON_LOOP]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_d0', tool_name: 'CronDelete', tool_input: { id: 'c0ffee01' }, tool_response: {} });
      expect(getAttention(subject).background.map((x: { id: string }) => x.id)).toEqual(['b76lzwo0d']);
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      // Esc: no Stop, the reaper puts the turn to rest.
      after.reapOnce(t + 2 * 60 * 60 * 1000);
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 0, pushes: 0, rows: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A live turn after the restart launches a Bash, and the tail reads its end before its PostToolUse, with the start
  // recomposition in between. The late hook must not put the finished task back: the terminal stayed «working».
  it('terminal: a task whose end is read before its PostToolUse, with the start recomposition between, does not come back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-bootfin-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES[0] + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', tool_name: BASH_BG.tool_name, tool_input: BASH_BG.tool_input });
      appendFileSync(path, bashBgEnd(t + 100) + '\n');
      await after.tailOnce((t += 200));
      boot();
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
      hook({ hook_event_name: 'Stop' });
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).background).toEqual([]);
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The same with a task of before the restart, still under its call's id: the late read takes its end, the start
  // recomposition runs, then the PostToolUse reaches the restarted server.
  it('terminal: a task of before the restart whose end the late read took does not come back with a PostToolUse after the start recomposition', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-bootfin-restored-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      const first = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      first({ hook_event_name: 'UserPromptSubmit' });
      first({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', tool_name: BASH_BG.tool_name, tool_input: BASH_BG.tool_input });
      first({ hook_event_name: 'Stop' });
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, [ABSORBED_LINES[0], bashBgEnd(t + 100)].join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG, session_id: sid } as never, (t += 200));
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).background).toEqual([]);
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 0, pushes: 0, rows: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T1 leaves a Bash and an Agent still under its call's id (its PostToolUse reaches only the restarted server); both
  // end while the server is down, the Agent with a notice that names no call. Healed in silence, in either order of
  // the PostToolUse and the late read.
  for (const order of ['before', 'after'] as const) {
    it(`terminal: an Agent of before the restart whose end names no call heals in silence, its PostToolUse ${order} the late read`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-nocall-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = T0;
        const first = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
        turn([BASH_ABSORBED]).slice(0, -1).forEach((h) => first(h));
        first({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1', tool_name: AGENT_BG.tool_name, tool_input: AGENT_BG.tool_input });
        first({ hook_event_name: 'Stop' });
        expect(countingTasks(subject)).toBe(2);
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        // The Agent's end first: once the Bash is out, the late read has read both.
        writeFileSync(path, [AGENT_END_NO_CALL, AGENT_END_NO_CALL_LET_GO, ...ABSORBED_LINES].join('\n') + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        const post = () => after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...AGENT_BG, session_id: sid } as never, (t += 200));
        if (order === 'before') post();
        const deadline = Date.now() + 3_000;
        while (getAttention(subject).background.some((x: { id: string }) => x.id === 'b76lzwo0d') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        if (order === 'after') post();
        boot();
        await new Promise((r) => setTimeout(r, 100));
        expect(getAttention(subject).background).toEqual([]);
        expect(getAttention(subject).state).toBe('finished');
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 0, pushes: 0, rows: 0 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // The same Agent, its end naming no call read live while the catch-up reads, its PostToolUse after: the end waits
  // for the catch-up, the work of before ended live, and the Agent's end, let in after the Bash's, announces it once.
  it('terminal: an Agent of before the restart whose end names no call, read live before its PostToolUse, is announced once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-nocall-live-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      const first = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      turn([BASH_ABSORBED]).slice(0, -1).forEach((h) => first(h));
      first({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1', tool_name: AGENT_BG.tool_name, tool_input: AGENT_BG.tool_input });
      first({ hook_event_name: 'Stop' });
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      appendFileSync(path, [AGENT_END_NO_CALL, AGENT_END_NO_CALL_LET_GO].join('\n') + '\n');
      t += 500;
      for (const line of [AGENT_END_NO_CALL, AGENT_END_NO_CALL_LET_GO]) after.ingestTranscriptLine(sid, line, t);
      after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...AGENT_BG, session_id: sid } as never, (t += 200));
      expect(getAttention(subject).background.map((x: { id: string }) => x.id).sort()).toEqual(['a4bb623e3ab5ee41a', 'b76lzwo0d']);
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // `boot-first`: the start recomposition runs while the catch-up still reads, and rereads a table that
  // already holds the live turn's task.
  for (const order of ['before', 'after', 'boot-first'] as const) {
    const when = order === 'boot-first' ? 'and the start recomposition before' : order;
    it(`terminal: a live turn's own task, its hooks ${when} the late read, does not announce the turn of before when it ends`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-own-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = T0;
        turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
        // A live turn opens while the catch-up reads, and launches a Bash of its own.
        const launch = () => {
          hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
          hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
        };
        hook({ hook_event_name: 'UserPromptSubmit' });
        if (order !== 'after') launch();
        if (order === 'boot-first') boot();
        const deadline = Date.now() + 3_000;
        while (getAttention(subject).background.some((x: { id: string }) => x.id === 'b76lzwo0d') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        if (order === 'after') launch();
        if (order !== 'boot-first') boot();
        expect(countingTasks(subject)).toBe(1);
        // Esc: no Stop, the reaper puts the turn to rest. Later its Bash ends, read live.
        after.reapOnce(t + 2 * 60 * 60 * 1000);
        appendFileSync(path, bashBgEnd(T0 + 3 * 60 * 60 * 1000) + '\n');
        await after.tailOnce((t += 3 * 60 * 60 * 1000));
        expect(countingTasks(subject)).toBe(0);
        await new Promise((r) => setTimeout(r, 100));
        // The turn that closed before the restart stays unannounced in either order, as it would without a restart.
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 0, pushes: 0, rows: 0 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

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

  // T1 launches an Agent that runs on across the restart. A live turn then launches a Bash whose end is read
  // before its PostToolUse, while the catch-up reads a long history: the late ends must not push the live one
  // out of what the subject remembers, or the hook puts the Bash back and the terminal stays working.
  it('terminal: a catch-up through a long history keeps the end of a live task read before its PostToolUse', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-evict-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([AGENT_BG]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      // 40 old ends: 80 ids, more than the 64 remembered.
      writeFileSync(path, Array.from({ length: 40 }, (_, i) => taskEnd(`hist${i}`, `toolu_h${i}`, T0 - 1_000_000 + i)).join('\n') + '\n');
      restart();
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
      const end = bashBgEnd(t + 100);
      appendFileSync(path, end + '\n');
      t += 100;
      for (const line of end.split('\n')) after.ingestTranscriptLine(sid, line, t);
      // The catch-up reads the whole history behind the live read: let it land before the hook does.
      await new Promise((r) => setTimeout(r, 150));
      boot();
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
      hook({ hook_event_name: 'Stop' });
      // Minutes later the Agent ends, read live: announced once, as without a restart.
      const agentEnd = taskEnd('a4bb623e3ab5ee41a', 'toolu_0', t + 60_000);
      appendFileSync(path, agentEnd + '\n');
      t += 60_000;
      for (const line of agentEnd.split('\n')) after.ingestTranscriptLine(sid, line, t);
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect(getAttention(subject).background).toEqual([]);
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // No row yet: the end is read before any hook, the start recomposition keeps it, then the late hooks land.
  it('terminal: a terminal with no row yet keeps an end read before its hooks through the start recomposition', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-rowless-'));
    try {
      const cwd = '/work/project';
      const sid = 'cli-term';
      const subject = 'terminal:cli-term';
      let t = T0;
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES[0] + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const end = taskEnd('b7kapz0ad', 'toolu_c0', t + 100);
      appendFileSync(path, end + '\n');
      t += 100;
      for (const line of end.split('\n')) after.ingestTranscriptLine(sid, line, t);
      const rowBefore = !!table().query('SELECT 1 FROM subject_attention WHERE subject = ?').get(subject);
      expect(rowBefore).toBe(false);
      boot();
      // The prompt and the PreToolUse were lost while the server was down: only the PostToolUse lands, then the Stop.
      after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_c0', ...BASH_BG, session_id: sid } as never, (t += 200));
      after.ingestHook({ hook_event_name: 'Stop', session_id: sid } as never, (t += 200));
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect(getAttention(subject).background).toEqual([]);
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The same NOCALL end read late and live, in either order, with the Agent's PostToolUse before the restart, between
  // it and the late read, or after both reads: the late mark sticks, the heal stays silent. A delivery row read live
  // while the catch-up reads waits for it, the task already under the Agent's id.
  for (const post of ['before the restart', 'before the late read', 'after both reads'] as const) for (const order of ['late then live', 'live then late'] as const) {
    it(`terminal: an end read late stays of before the restart when its delivery row is read live (${order}, PostToolUse ${post})`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-flip-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = T0;
        const first = (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200));
        turn([BASH_ABSORBED]).slice(0, -1).forEach((h) => first(h));
        first({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1', tool_name: AGENT_BG.tool_name, tool_input: AGENT_BG.tool_input });
        if (post === 'before the restart') first({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...AGENT_BG });
        first({ hook_event_name: 'Stop' });
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, [AGENT_END_NO_CALL, ...ABSORBED_LINES].join('\n') + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        const postToolUse = () => after.ingestHook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...AGENT_BG, session_id: sid } as never, (t += 200));
        if (post === 'before the late read') postToolUse();
        const live = () => { appendFileSync(path, USER_LINE + '\n'); after.ingestTranscriptLine(sid, USER_LINE, (t += 200)); };
        if (order === 'live then late') live();
        const deadline = Date.now() + 3_000;
        while (getAttention(subject).background.some((x: { id: string }) => x.id === 'b76lzwo0d') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        boot();
        if (order === 'late then live') live();
        if (post === 'after both reads') postToolUse();
        await new Promise((r) => setTimeout(r, 100));
        expect(getAttention(subject).state).toBe('finished');
        expect(getAttention(subject).background).toEqual([]);
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 0, pushes: 0, rows: 0 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // After the reattach a live turn stops while the catch-up still reads, with its own Bash (its end absorbed, read by
  // the tail meanwhile and held) or with no task: the Stop parks it `watching` on work the read is about to close, the
  // Bash of before ended while the server was down. Once the read is done nothing is in flight and nothing will wake
  // the turn: it rests, and its end is announced once, as without the restart.
  for (const own of ['its own Bash', 'no task'] as const) {
    it(`terminal: a live turn that stops while the catch-up reads, with ${own}, rests when the read is done`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-settle-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = ABSORBED_AT - 60_000;
        turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
        restart();
        t = ABSORBED_AT + 600_000;
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
        after.registerTerminalSession(sid, { cwd, now: (t += 200) });
        const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
        hook({ hook_event_name: 'UserPromptSubmit' });
        if (own === 'its own Bash') {
          hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
          hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
          const end = bashBgEnd(t + 100);
          appendFileSync(path, end + '\n');
          t += 100;
      for (const line of end.split('\n')) after.ingestTranscriptLine(sid, line, t);
        }
        hook({ hook_event_name: 'Stop' });
        expect(phaseOf(after, sid)).toBe('watching');
        const deadline = Date.now() + 3_000;
        while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        boot();
        await new Promise((r) => setTimeout(r, 100));
        expect(phaseOf(after, sid)).toBe('awaiting-user');
        expect(getAttention(subject).state).toBe('finished');
        expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // The same live turn whose own Bash ends after its Stop, read by the tail while the catch-up reads and held: that end
  // is the report the turn waits for. The read done, the turn is still `watching`, and the row that delivers it wakes it.
  it('terminal: a live turn whose own Bash ends after its Stop while the catch-up reads stays watching for the delivery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-wait-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = ABSORBED_AT - 60_000;
      turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      t = ABSORBED_AT + 600_000;
      // The release reads the tracker's clock: the test's, for the delivery to be still on its way.
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home, now: () => t });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const hook = (h: Record<string, unknown>) => after.ingestHook({ ...h, session_id: sid } as never, (t += 200));
      hook({ hook_event_name: 'UserPromptSubmit' });
      hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
      hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_n0', ...BASH_BG });
      hook({ hook_event_name: 'Stop' });
      const end = queueRecord('enqueue', BASH_BG_NOTICE, t + 100);
      appendFileSync(path, end + '\n');
      after.ingestTranscriptLine(sid, end, (t += 100));
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      await new Promise((r) => setTimeout(r, 100));
      expect(phaseOf(after, sid)).toBe('watching');
      const row = JSON.stringify({ type: 'user', uuid: 'u-wake', timestamp: new Date(t + 32).toISOString(), message: { role: 'user', content: BASH_BG_NOTICE } });
      appendFileSync(path, row + '\n');
      after.ingestTranscriptLine(sid, row, (t += 100));
      expect(phaseOf(after, sid)).toBe('running');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The terminal registered again while the first catch-up still reads (a second reconcile, the phase at rest) starts
  // a read of its own over the line the tail holds. That line stays live: the turn of before is announced once.
  it('terminal: a second reattach while the catch-up reads leaves the end the tail holds live', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-twice-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = T0;
      turn([BASH_ABSORBED, AGENT_BG]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES.join('\n') + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const end = agentBgEnd(t + 500);
      appendFileSync(path, end + '\n');
      t += 500;
      for (const line of end.split('\n')) after.ingestTranscriptLine(sid, line, t);
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      const deadline = Date.now() + 3_000;
      while (countingTasks(subject) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      boot();
      await new Promise((r) => setTimeout(r, 100));
      expect(getAttention(subject).state).toBe('finished');
      expect({ epoch: getAttention(subject).epoch - before.epoch, pushes: pushes.length - before.pushes, rows: rows.length - before.rows }).toEqual({ epoch: 1, pushes: 1, rows: 1 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
