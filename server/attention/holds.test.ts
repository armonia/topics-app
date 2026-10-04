/**
 * A person in the middle is `needs-you`, whichever door the wait comes from
 * (ATTN-04, defects D6 and D8).
 *
 * Today a headless chat asks every question through
 * `mcp__topics__ask_user_question` (the built-in AskUserQuestion is disallowed
 * there), and the phase machine reads it as `tool-running`: working, no amber,
 * no waiting push. The ask and permission bridges tell only the dispatcher. The
 * plan panel the chat route opens at the end of a plan-mode turn is announced
 * as "Claude ha finito di rispondere".
 *
 * And a board agent asking in the middle of its turn lights its TOPIC, which no
 * one opens, instead of its card.
 * @covers ATTN-04
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createClaudeSessionTracker } from '../lib/claude-session-tracker';
import { beginAsk, endAsk } from '../lib/ask-user-bridge';
import { beginPermission, endPermission } from '../lib/permission-bridge';
import { resetHumanHoldListeners } from '../lib/human-hold-events';
import { configureAttentionStore, getAttention, resetAttentionStore, turnEnded, turnStarted } from './store';
import { configureAttentionWire, planApprovalOpened, wireHumanHolds } from './wire';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

const T0 = 1_700_000_000_000;

function freshDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const migDir = join(import.meta.dir, '..', 'db', 'migrations');
  for (const prefix of ['027-', '096-']) {
    const file = readdirSync(migDir).find((f) => f.startsWith(prefix))!;
    const sql = readFileSync(join(migDir, file), 'utf-8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
  }
  return db;
}

const rows: Array<{ kind: string; groupKey?: string | null }> = [];
let unwire: (() => void) | null = null;

beforeEach(() => {
  resetAttentionStore();
  resetHumanHoldListeners();
  rows.length = 0;
  configureAttentionStore({
    db: () => null,
    recordRow: (input) => { rows.push({ kind: input.kind, groupKey: input.groupKey }); return null; },
    sendPush: () => {},
  });
  configureAttentionWire({
    subjectForSessionKey: (sk) => (sk.startsWith('topic:') ? `topic:${sk.slice(6)}` : null),
    cardForSession: () => null,
  });
  unwire = wireHumanHolds();
});
afterEach(() => { unwire?.(); unwire = null; });

describe('a question, a permission or a plan is needs-you', () => {
  it('the PreToolUse of mcp__topics__ask_user_question is a question, not tool-running', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO topics VALUES ('topic:asks')`).run();
    db.prepare(`INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at) VALUES ('topic:asks', 'cli-ask', 'x', 'x', 'starting', 'x')`).run();
    const tracker = createClaudeSessionTracker({ db, broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50,
      attentionSubject: (s) => (s.sessionKey ? `topic:${s.sessionKey.slice(6)}` : null) });
    tracker.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'cli-ask' } as never, T0 + 200);
    tracker.ingestHook({ hook_event_name: 'PreToolUse', session_id: 'cli-ask', tool_name: 'mcp__topics__ask_user_question',
      tool_input: { questions: [{ question: 'Procedo col merge?', options: [{ label: 'Si' }, { label: 'No' }] }] } } as never, T0 + 400);
    expect(tracker.getSession('cli-ask')?.phase).toBe('awaiting-approval');
    const a = getAttention('topic:asks');
    expect(a.state).toBe('needs-you');
    expect(a.reason).toBe('question');
    expect(a.detail).toBe('Procedo col merge?');
  });

  it('the ask bridge opening a wait is needs-you(question), and the answer puts it back to work', () => {
    turnStarted('topic:bridge');
    beginAsk('topic:bridge');
    expect(getAttention('topic:bridge')).toMatchObject({ state: 'needs-you', reason: 'question', lit: true });
    endAsk('topic:bridge');
    expect(getAttention('topic:bridge').state).toBe('working');
  });

  it('the permission bridge is needs-you(permission)', () => {
    turnStarted('topic:perm');
    beginPermission('topic:perm', 'toolu_bash');
    expect(getAttention('topic:perm')).toMatchObject({ state: 'needs-you', reason: 'permission' });
    endPermission('topic:perm', 'toolu_bash');
    expect(getAttention('topic:perm').state).toBe('working');
  });

  it('the plan panel is needs-you(plan), and no chat-message row is written', () => {
    turnStarted('topic:plan');
    planApprovalOpened('topic:plan', 'toolu_plan', 'Il piano: tre passi');
    turnEnded('topic:plan', { turnId: 'm-plan', outcome: 'done' });
    const a = getAttention('topic:plan');
    expect(a).toMatchObject({ state: 'needs-you', reason: 'plan', epoch: 1 });
    expect(rows.map((r) => r.kind)).not.toContain('chat-message');
    expect(rows).toHaveLength(1);
  });
});

describe('a board agent asking in the middle of its turn', () => {
  it('lights its card task:<id>, not its topic, and the answer switches it off', () => {
    configureAttentionWire({
      subjectForSessionKey: (sk) => `topic:${sk.slice(6)}`,
      cardForSession: (sk) => (sk === 'topic:agent' ? 'card-7' : null),
    });
    turnStarted('topic:agent', { dispatched: true });
    beginPermission('topic:agent', 'toolu_rm');
    expect(getAttention('task:card-7')).toMatchObject({ state: 'needs-you', reason: 'permission', lit: true });
    expect(getAttention('topic:agent').state).toBe('idle');
    endPermission('topic:agent', 'toolu_rm');
    expect(getAttention('task:card-7').lit).toBe(false);
    expect(getAttention('task:card-7').state).toBe('idle');
  });
});
