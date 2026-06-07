import { describe, expect, it } from 'bun:test';
import {
  applyHook,
  applyJsonlEvent,
  makeInitialState,
  parseJsonlLine,
  reapStaleSession,
  splitJsonlChunk,
  type ClaudeSessionState,
  type HookPayload,
} from './claude-session-state';

const T0 = 1_700_000_000_000;
const TICK = 1_000;

function freshState(overrides: Partial<ClaudeSessionState> = {}): ClaudeSessionState {
  return { ...makeInitialState('cli-abc', 'topic-1', T0), ...overrides };
}

function hook(name: string, extra: Partial<HookPayload> = {}): HookPayload {
  return { hook_event_name: name as any, session_id: 'cli-abc', ...extra };
}

describe('makeInitialState', () => {
  it('seeds a starting session with rev 0', () => {
    const s = makeInitialState('cli-x', 'topic-x', T0, '/tmp/x.jsonl');
    expect(s.phase).toBe('starting');
    expect(s.rev).toBe(0);
    expect(s.jsonlOffset).toBe(0);
    expect(s.jsonlPath).toBe('/tmp/x.jsonl');
    expect(s.createdAt).toBe(T0);
  });
});

describe('applyHook — phase transitions', () => {
  it('UserPromptSubmit moves starting → running and bumps rev', () => {
    const s0 = freshState();
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.phaseUpdatedAt).toBe(T0 + TICK);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('PreToolUse captures tool name and input', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool).toEqual({ name: 'Bash', input: { command: 'ls' }, startedAt: T0 + TICK });
    expect(s1.rev).toBe(2);
  });

  it('PostToolUse returns tool-running → running and clears tool', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 2, lastTool: { name: 'Bash', startedAt: T0 } });
    const s1 = applyHook(s0, hook('PostToolUse', { tool_name: 'Bash' }), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(3);
  });

  it('PostToolUse without prior PreToolUse defensively clears tool', () => {
    const s0 = freshState({ phase: 'running', rev: 1, lastTool: { name: 'Bash', startedAt: T0 } });
    const s1 = applyHook(s0, hook('PostToolUse'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(2);
  });

  it('Notification with permission_request enters awaiting-approval', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', {
      permission_request: { kind: 'edit', prompt: 'Approve write to foo.ts?' },
    }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval).toEqual({
      kind: 'edit',
      prompt: 'Approve write to foo.ts?',
      requestedAt: T0 + TICK,
    });
    expect(s1.rev).toBe(2);
  });

  it('Notification with permission-like title detects approval', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', { title: 'Permission required' }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.prompt).toBe('Permission required');
    // Without explicit kind or kind-hint in title, default is 'other'.
    expect(s1.pendingApproval?.kind).toBe('other');
  });

  it('Notification without approval signal updates last_hook_at only', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', { message: 'Reminder: long-running task' }), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('UserPromptSubmit clears pending approval', () => {
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 2,
      pendingApproval: { kind: 'edit', prompt: 'X', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.pendingApproval).toBeUndefined();
    expect(s1.rev).toBe(3);
  });

  it('UserPromptSubmit clears a stale error when resuming after a failure', () => {
    const s0 = freshState({
      phase: 'error',
      rev: 4,
      error: { code: 'pty-crashed', message: 'PTY exited with code 137', failedAt: T0 },
    });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.error).toBeUndefined();
    expect(s1.rev).toBe(5);
  });

  it('UserPromptSubmit with no prior error does not bump rev for the error field alone', () => {
    // error:undefined in the delta must be a no-op when there was no error —
    // otherwise every prompt would churn rev. rev still bumps for the phase
    // change (running already? then it must be a true no-op).
    const s0 = freshState({ phase: 'running', rev: 9 });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    // phase unchanged (running→running) AND no error to clear → identity no-op.
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(9);
  });

  it('Stop transitions to awaiting-user', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Stop'), T0 + TICK);
    expect(s1.phase).toBe('awaiting-user');
    expect(s1.rev).toBe(2);
  });

  it('SessionEnd transitions to completed and clears transient state', () => {
    const s0 = freshState({
      phase: 'tool-running',
      rev: 5,
      lastTool: { name: 'Bash', startedAt: T0 },
      pendingApproval: { kind: 'edit', prompt: 'X', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('SessionEnd'), T0 + TICK);
    expect(s1.phase).toBe('completed');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.pendingApproval).toBeUndefined();
    expect(s1.rev).toBe(6);
  });

  it('SubagentStop is recorded but does not move phase', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('SubagentStop'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('SessionStart on existing session resets transient fields', () => {
    const s0 = freshState({
      phase: 'error',
      rev: 7,
      lastTool: { name: 'X', startedAt: T0 },
      error: { code: 'pty-crashed', message: 'x', failedAt: T0 },
    });
    const s1 = applyHook(s0, hook('SessionStart', { transcript_path: '/tmp/new.jsonl' }), T0 + TICK);
    expect(s1.phase).toBe('starting');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.error).toBeUndefined();
    expect(s1.jsonlPath).toBe('/tmp/new.jsonl');
    expect(s1.rev).toBe(8);
  });

  it('unknown hook event is a no-op except for last_hook_at', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, { hook_event_name: 'NewExperimentalEvent' as any, session_id: 'cli-abc' }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('re-applying the same hook is idempotent on phase (rev still bumps because we treat it as new event)', () => {
    // Idempotency at the *hook delivery* layer is handled by the dedup window
    // in the service layer. The pure state derivation always advances on a
    // genuine state change. Here we verify that a no-op hook (Stop applied
    // when already awaiting-user) does NOT bump rev.
    const s0 = freshState({ phase: 'awaiting-user', rev: 4 });
    const s1 = applyHook(s0, hook('Stop'), T0 + TICK);
    // Stop → awaiting-user transition is a no-op when already awaiting-user,
    // because no structural field changed. We DO still update last_hook_at,
    // but the rev should not advance.
    expect(s1.phase).toBe('awaiting-user');
    expect(s1.rev).toBe(4);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });
});

describe('applyJsonlEvent — replay path', () => {
  it('user event moves to running', () => {
    const s0 = freshState({ phase: 'starting', rev: 0 });
    const s1 = applyJsonlEvent(s0, { type: 'user', raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
  });

  it('tool_use event captures tool name', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyJsonlEvent(s0, { type: 'tool_use', name: 'Read', input: { path: 'x' }, raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool?.name).toBe('Read');
  });

  it('assistant event after tool_use promotes back to running', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 2, lastTool: { name: 'Read', startedAt: T0 } });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
  });

  it('does not undo a terminal phase', () => {
    const s0 = freshState({ phase: 'completed', rev: 9 });
    const s1 = applyJsonlEvent(s0, { type: 'user', raw: {} }, T0 + TICK);
    expect(s1).toBe(s0);
  });
});

describe('reapStaleSession', () => {
  it('demotes tool-running stuck for >10 min to running', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 3, phaseUpdatedAt: T0, lastTool: { name: 'X', startedAt: T0 } });
    const s1 = reapStaleSession(s0, T0 + 11 * 60 * 1000);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(4);
  });

  it('leaves recent tool-running alone', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 9 * 60 * 1000);
    expect(s1).toBe(s0);
  });

  it('demotes awaiting-approval >10min to paused but keeps pendingApproval', () => {
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 3,
      phaseUpdatedAt: T0,
      pendingApproval: { kind: 'plan', prompt: 'Approve plan?', requestedAt: T0 },
    });
    const s1 = reapStaleSession(s0, T0 + 11 * 60 * 1000);
    expect(s1.phase).toBe('paused');
    expect(s1.pendingApproval).toEqual(s0.pendingApproval);
  });

  it('errors out a starting session that never produced an event', () => {
    const s0 = freshState({ phase: 'starting', phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 6 * 60 * 1000);
    expect(s1.phase).toBe('error');
    expect(s1.error?.code).toBe('start-timeout');
  });
});

describe('parseJsonlLine', () => {
  it('parses an assistant text message as assistant', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(parseJsonlLine(line)).toEqual({ type: 'assistant', raw: JSON.parse(line) });
  });

  it('parses an assistant tool_use as tool_use with name + input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    const parsed = parseJsonlLine(line)!;
    expect(parsed.type).toBe('tool_use');
    if (parsed.type === 'tool_use') {
      expect(parsed.name).toBe('Bash');
      expect(parsed.input).toEqual({ command: 'ls' });
    }
  });

  it('parses a user tool_result block as tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'output' }] },
    });
    expect(parseJsonlLine(line)?.type).toBe('tool_result');
  });

  it('returns null on empty / whitespace lines', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
  });

  it('tolerates malformed JSON without throwing', () => {
    const ev = parseJsonlLine('{not json');
    expect(ev?.type).toBe('other');
  });

  it('falls back to "other" for unknown top-level types', () => {
    const line = JSON.stringify({ type: 'something-new', payload: {} });
    expect(parseJsonlLine(line)?.type).toBe('other');
  });
});

describe('splitJsonlChunk', () => {
  it('splits complete lines and preserves the partial last line', () => {
    const { lines, remainder } = splitJsonlChunk('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(remainder).toBe('{"c":');
  });

  it('returns no lines when there is no newline', () => {
    const { lines, remainder } = splitJsonlChunk('{"partial');
    expect(lines).toEqual([]);
    expect(remainder).toBe('{"partial');
  });

  it('handles trailing newline as empty remainder', () => {
    const { lines, remainder } = splitJsonlChunk('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(remainder).toBe('');
  });

  it('ignores blank lines between events', () => {
    const { lines } = splitJsonlChunk('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('end-to-end scenario', () => {
  it('full session lifecycle hits the expected phases and rev sequence', () => {
    let s = makeInitialState('cli-1', 'topic-1', T0);
    expect(s.phase).toBe('starting');
    expect(s.rev).toBe(0);

    s = applyHook(s, hook('SessionStart', { transcript_path: '/tmp/x.jsonl' }), T0 + 10);
    expect(s.phase).toBe('starting');
    expect(s.jsonlPath).toBe('/tmp/x.jsonl');
    expect(s.rev).toBe(1); // SessionStart updated jsonlPath → rev bumped

    s = applyHook(s, hook('UserPromptSubmit'), T0 + 100);
    expect(s.phase).toBe('running');
    expect(s.rev).toBe(2);

    s = applyHook(s, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + 200);
    expect(s.phase).toBe('tool-running');
    expect(s.rev).toBe(3);

    s = applyHook(s, hook('PostToolUse', { tool_name: 'Bash' }), T0 + 300);
    expect(s.phase).toBe('running');
    expect(s.rev).toBe(4);

    s = applyHook(s, hook('Notification', { permission_request: { kind: 'edit', prompt: 'OK?' } }), T0 + 400);
    expect(s.phase).toBe('awaiting-approval');
    expect(s.pendingApproval?.kind).toBe('edit');
    expect(s.rev).toBe(5);

    s = applyHook(s, hook('UserPromptSubmit'), T0 + 500);
    expect(s.phase).toBe('running');
    expect(s.pendingApproval).toBeUndefined();
    expect(s.rev).toBe(6);

    s = applyHook(s, hook('Stop'), T0 + 600);
    expect(s.phase).toBe('awaiting-user');
    expect(s.rev).toBe(7);

    s = applyHook(s, hook('SessionEnd'), T0 + 700);
    expect(s.phase).toBe('completed');
    expect(s.rev).toBe(8);
  });
});
