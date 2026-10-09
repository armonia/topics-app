/**
 * A chat whose CLI snapshot empties the task map while its turn parks in
 * `watching`: the provider rewrites the whole map (`setBackgroundTasks`, or
 * the chat route's `turnEnded` with `background`), so no transcript line takes
 * the last task out and the parked turn would read "in progress" until the
 * person's next turn. The rest waits until the map stays empty with nothing
 * queued (`EMPTIED_QUIET_MS`), so a notice queued ms after the snapshot still
 * wakes the turn with no `awaiting-user` flash in between.
 * @covers ATTN-03
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import { configureAttentionStore, resetAttentionStore, setBackgroundTasks, turnEnded } from '../attention/store';
import { T0, freshDb, turn, BASH_BG, subjectOf, phaseOf, type Tool } from './claude-session-state.background-tasks.fixture';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

/** BASH_BG's notice, as the CLI words it, under the call that launched it in `turn`. */
const BASH_BG_END = '<task-notification>\n<task-id>b7kapz0ad</task-id>\n<tool-use-id>toolu_0</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 600 && make build" completed (exit code 0)</summary>\n</task-notification>';
/** The CLI's queue record of a notice, written when its task ends, whether a turn absorbs it or it is delivered. */
const enqueued = (content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b4', content });
/** The row that delivers a notice to a turn at rest, and wakes it. */
const delivered = (content: string, at: number) => JSON.stringify({ type: 'user', uuid: `u${at}`, timestamp: new Date(at).toISOString(), message: { role: 'user', content }, origin: { kind: 'task-notification' } });
/** The CLI's queue letting a notice go without delivering it: a turn absorbed it, or it was dropped. */
const removed = (content: string, at: number) => JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: new Date(at).toISOString(), sessionId: '00000000-0000-4000-8000-0000000000b4', content });

const MONITOR: Tool = { tool_name: 'Monitor', tool_input: { command: 'tail -f worker.log', description: 'detect stopped workers' },
  tool_response: { taskId: 'bmon0stop', timeoutMs: 900000, persistent: false } };

const iso = (at: number) => new Date(at).toISOString();
/** The Bash task as the provider lists it, keyed by the CLI's id. */
const bashMap = (at: number) => ({ b7kapz0ad: { kind: 'bash', label: 'sleep 600 && make build', startedAt: iso(at) } });
/** The wake task as the provider lists it, keyed the way the CLI names it. */
const wakeMap = (at: number) => ({ wake: { kind: 'wake', label: 'sleep 600 && make build', startedAt: iso(at) } });

/** A chat under `home` whose clock the test holds: hooks arrive at it, and the store rewrite lands on it. */
function setupChat(home: string) {
  const sid = 'cli-chat', cwd = '/work/project';
  const path = deriveTranscriptPath(home, cwd, sid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  const db = freshDb();
  db.prepare('INSERT INTO topics VALUES (?)').run('topic:bg');
  db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at)
    VALUES (?, ?, ?, ?, 'starting', ?)`).run('topic:bg', sid, iso(T0), iso(T0), iso(T0));
  let clock = T0;
  const tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100,
    rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home, now: () => clock });
  tracker.ingestHook({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: path, session_id: sid } as never, T0);
  return {
    tracker, sid, subject: 'topic:bg',
    hook: (h: Record<string, unknown>) => tracker.ingestHook({ ...h, session_id: sid } as never, (clock += 200)),
    write: (...lines: string[]) => appendFileSync(path, lines.join('\n') + '\n'),
    // Set the clock to the moment a store rewrite or a sweep represents, then act.
    at: (t: number) => { clock = t; },
    now: () => clock,
  };
}

const withHome = async (body: (home: string) => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), 'chat-snapshot-'));
  try { await body(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

describe('a chat snapshot that empties the map rests the parked turn once quiet', () => {
  beforeEach(() => { resetAttentionStore(); configureAttentionStore({ db: () => null, sendPush: () => {}, recordRow: () => null, graceMs: 0 }); });

  it('lets go at rest: the snapshot empties the map, the queued notice is let go, and the turn rests once quiet, dated at the Stop', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const S = c.now(), seen = [phaseOf(c.tracker, c.sid)];
    const E = S + 5_000;
    c.at(E); setBackgroundTasks(c.subject, {});
    c.write(enqueued(BASH_BG_END, E + 5), removed(BASH_BG_END, E + 25));
    c.at(E + 1_000); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(E + 4_900); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(E + 5_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'watching', 'watching', 'awaiting-user']);
    expect(c.tracker.getSession(c.sid)?.phaseUpdatedAt).toBe(S);
  }));

  it('no fate at rest: a notice still queued holds the turn past the quiet wait, until its minute runs out', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const S = c.now(), seen = [phaseOf(c.tracker, c.sid)];
    const E = S + 5_000;
    c.at(E); setBackgroundTasks(c.subject, {});
    c.write(enqueued(BASH_BG_END, E + 5));
    c.at(E + 1_000); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(E + 30_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(E + 5 + 60_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'watching', 'watching', 'awaiting-user']);
    expect(c.tracker.getSession(c.sid)?.phaseUpdatedAt).toBe(S);
  }));

  it('delivered at rest, no flash: a notice delivered right after the snapshot wakes the turn with no rest in between', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const seen = [phaseOf(c.tracker, c.sid)];
    const E = c.now() + 5_000;
    c.at(E); setBackgroundTasks(c.subject, {});
    c.at(E + 100); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.write(enqueued(BASH_BG_END, E + 5), delivered(BASH_BG_END, E + 36));
    c.at(E + 1_500); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'watching', 'running']);
  }));

  it('delivered late: a notice queued at the snapshot and delivered half a minute later still wakes the turn', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const seen = [phaseOf(c.tracker, c.sid)];
    const E = c.now() + 5_000;
    c.at(E); setBackgroundTasks(c.subject, {});
    c.write(enqueued(BASH_BG_END, E + 5));
    c.at(E + 1_000); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(E + 30_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.write(delivered(BASH_BG_END, E + 40_000));
    c.at(E + 40_500); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'watching', 'watching', 'running']);
  }));

  it('absorbed mid-turn, wake listed at the Stop: the wake holds the turn, and its snapshot rests it once quiet, dated at the Stop', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    const seen = [phaseOf(c.tracker, c.sid)];
    const E = c.now() + 1_000;
    c.at(E); setBackgroundTasks(c.subject, bashMap(E));
    c.at(E); setBackgroundTasks(c.subject, wakeMap(E));
    c.write(enqueued(BASH_BG_END, E), removed(BASH_BG_END, E + 3_000));
    c.at(E + 3_500); await c.tracker.tailOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.hook({ hook_event_name: 'Stop' });
    const S = c.now(); seen.push(phaseOf(c.tracker, c.sid));
    c.at(S); turnEnded(c.subject, { turnId: 'm1', outcome: 'done', background: wakeMap(E) }); seen.push(phaseOf(c.tracker, c.sid));
    const W = S + 2_000;
    c.at(W); setBackgroundTasks(c.subject, {});
    c.at(W + 4_900); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(W + 5_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['running', 'running', 'watching', 'watching', 'watching', 'awaiting-user']);
    expect(c.tracker.getSession(c.sid)?.phaseUpdatedAt).toBe(S);
  }));

  it('the next turn end rewrites a stale task out after its Stop: the turn rests once quiet, dated at that second Stop', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const seen = [phaseOf(c.tracker, c.sid)];
    c.hook({ hook_event_name: 'UserPromptSubmit' }); seen.push(phaseOf(c.tracker, c.sid));
    c.hook({ hook_event_name: 'Stop' });
    const S2 = c.now(); seen.push(phaseOf(c.tracker, c.sid));
    const P = S2 + 1_000;
    c.at(P); turnEnded(c.subject, { turnId: 'm2', outcome: 'done', background: {} });
    c.at(P + 5_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'running', 'watching', 'awaiting-user']);
    expect(c.tracker.getSession(c.sid)?.phaseUpdatedAt).toBe(S2);
  }));

  it('the next turn end rewrites a stale task out before its Stop: the Stop finds nothing in flight and rests at once', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    c.hook({ hook_event_name: 'Stop' });
    const seen = [phaseOf(c.tracker, c.sid)];
    c.hook({ hook_event_name: 'UserPromptSubmit' }); seen.push(phaseOf(c.tracker, c.sid));
    const P = c.now() + 1_000;
    c.at(P); turnEnded(c.subject, { turnId: 'm2', outcome: 'done', background: {} });
    c.hook({ hook_event_name: 'Stop' }); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'running', 'awaiting-user']);
  }));

  it('a turn that parks again forgets an earlier emptying: the delivered Monitor leaves no signal, and the turn keeps watching', () => withHome(async (home) => {
    const c = setupChat(home);
    turn([BASH_BG]).slice(0, -1).forEach((h) => c.hook(h));
    const X = c.now() + 1_000;
    c.at(X); setBackgroundTasks(c.subject, bashMap(X));
    c.at(X); setBackgroundTasks(c.subject, {});
    c.hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_m', ...MONITOR });
    c.hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_m', ...MONITOR });
    c.hook({ hook_event_name: 'Stop' });
    const seen = [phaseOf(c.tracker, c.sid)];
    c.tracker.noteWatchDelivered('topic:bg', c.now()); seen.push(phaseOf(c.tracker, c.sid));
    c.at(X + 60_000); c.tracker.reapOnce(c.now()); seen.push(phaseOf(c.tracker, c.sid));
    expect(seen).toEqual(['watching', 'watching', 'watching']);
  }));
});
