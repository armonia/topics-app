/**
 * The hooks, transcript lines and trackers shared by the background-tasks and
 * reattach-tasks tests: one holder for what both files read, so the two suites
 * stay on the same recorded CLI.
 */
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { configureAttentionStore, recomposeAttentionOnBoot, resetAttentionStore } from '../attention/store';

export const T0 = 1_700_000_000_000;

export function freshDb(): Database {
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

export type Tool = { tool_name: string; tool_input: Record<string, unknown>; tool_response?: unknown };

/** The hooks of one turn that runs these tools and ends, 200 ms apart (past the dedup window). */
export function turn(tools: Tool[]) {
  const hooks: Array<Record<string, unknown>> = [{ hook_event_name: 'UserPromptSubmit' }];
  tools.forEach((t, i) => {
    hooks.push({ hook_event_name: 'PreToolUse', tool_use_id: `toolu_${i}`, tool_name: t.tool_name, tool_input: t.tool_input });
    hooks.push({ hook_event_name: 'PostToolUse', tool_use_id: `toolu_${i}`, ...t });
  });
  hooks.push({ hook_event_name: 'Stop' });
  return hooks;
}

export const BASH_BG: Tool = { tool_name: 'Bash', tool_input: { command: 'sleep 600 && make build', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b7kapz0ad' } };
export const AGENT_BG: Tool = { tool_name: 'Agent', tool_input: { description: 'verify render', prompt: '...', run_in_background: true },
  tool_response: { isAsync: true, status: 'async_launched', agentId: 'a4bb623e3ab5ee41a', description: 'verify render' } };
export const CRON_ONCE: Tool = { tool_name: 'CronCreate', tool_input: { cron: '57 9 25 9 *', prompt: 'check CI', recurring: false },
  tool_response: { id: 'afc60409', humanSchedule: '57 9 25 9 *', recurring: false, durable: false } };
export const CRON_LOOP: Tool = { tool_name: 'CronCreate', tool_input: { cron: '*/5 * * * *', prompt: 'check CI' },
  tool_response: { id: 'c0ffee01', humanSchedule: '*/5 * * * *', recurring: true, durable: false } };
/** The background Bash of the recorded 2.1.292 session, and the queue records its end left in the transcript (sanitized). */
export const BASH_ABSORBED: Tool = { tool_name: 'Bash', tool_input: { command: 'make gates', description: 'Run all hand gates sequentially', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b76lzwo0d' } };
export const ABSORBED_LINES = readFileSync(join(import.meta.dir, '..', '..', 'tests', 'fixtures', 'claude-cli-2.1.292-absorbed-task-notification.transcript.jsonl'), 'utf8')
  .split('\n').filter(Boolean);
/** When the CLI wrote that end: the turn that absorbed it was running, and stopped later (9.8 s at the least, measured on 361 absorbed ends). */
export const ABSORBED_AT = Date.parse(JSON.parse(ABSORBED_LINES[0]).timestamp);
/** An Agent's end that names no call, as the CLI queues it: a few of them do not (4 in about 470 first notices). */
export const AGENT_END_NO_CALL = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(T0 + 900).toISOString(),
  sessionId: '00000000-0000-4000-8000-0000000000b3', content: '<task-notification>\n<task-id>a4bb623e3ab5ee41a</task-id>\n<status>failed</status>\n<summary>Agent "verify render" failed</summary>\n</task-notification>' });
/** The same notice let go by the queue, absorbed by the turn that ran when it came: the Agent's task ends here. */
export const AGENT_END_NO_CALL_LET_GO = JSON.stringify({ ...JSON.parse(AGENT_END_NO_CALL), operation: 'remove', timestamp: new Date(T0 + 905).toISOString() });

export const subjectOf = (s: { sessionKey: string | null; claudeSessionId: string }) =>
  s.sessionKey ? `topic:${s.sessionKey.slice('topic:'.length)}` : `terminal:${s.claudeSessionId}`;

export function terminalTracker(frames: unknown[]) {
  const tracker = createClaudeSessionTracker({ db: freshDb(), broadcast: (m) => frames.push(m), coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf });
  tracker.registerTerminalSession('cli-term', { now: T0 });
  return { tracker, sid: 'cli-term', subject: 'terminal:cli-term' };
}

export function phaseOf(tracker: ReturnType<typeof createClaudeSessionTracker>, sid: string) {
  return tracker.getSession(sid)?.phase;
}

/** The attention table alone: what a restart of the server keeps, where its memory is lost. */
function attentionTable(): Database {
  const db = new Database(':memory:');
  const sql = readFileSync(join(import.meta.dir, '..', 'db', 'migrations', '20261003214001-subject-attention.sql'), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
  return db;
}

/**
 * The attention store of a server that restarts: the table stays, the memory
 * does not. It counts its pushes and rows, with a grace above zero as in
 * production (the one the live path arms would announce once it ran out).
 * `reset` before each test.
 */
export function durableAttention() {
  const pushes: unknown[] = [];
  const rows: unknown[] = [];
  let table = attentionTable();
  const configure = () => configureAttentionStore({ db: () => table, sendPush: (p) => { pushes.push(p); }, recordRow: (r) => { rows.push(r); return null; }, graceMs: 20 });
  return {
    pushes,
    rows,
    table: () => table,
    reset: () => {
      pushes.length = 0;
      rows.length = 0;
      table = attentionTable();
      resetAttentionStore();
      configure();
    },
    /** A restart of the server: nothing in memory survives, the table does. */
    restart: () => {
      resetAttentionStore();
      configure();
    },
    /** The start recomposition, after the surviving turns are adopted: the reattach comes first. */
    boot: () => {
      recomposeAttentionOnBoot({ liveProcess: () => true });
    },
  };
}
