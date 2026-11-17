/**
 * The action layer of the loaders: the dwell rule, the chat frame mapping, the
 * rollups, the precedence of one subject, the Claude Code phase mapping and the
 * store's "publish only on change" contract.
 *
 * @covers STATUS-VISUAL-01k
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ACTION_DWELL_MS, __resetAgentActions, agentActionActions, backgroundAction, chatFrameAction,
  dwellSettle, dwellStep, rollupAction, subjectActionFrom, useAgentActionStore,
} from './agentActions';
import { actionForPhase } from './signals';

const D = ACTION_DWELL_MS;

describe('dwellStep / dwellSettle', () => {
  test('the first input shows at once', () => {
    const s = dwellStep(undefined, 'read', 1000);
    expect(s.changed).toBe(true);
    expect(s.state).toEqual({ shown: 'read', shownAt: 1000, latest: 'read' });
    expect(s.wakeAt).toBeNull();
  });

  test('a repeated input returns the same state, so it is free', () => {
    const first = dwellStep(undefined, 'write', 0).state;
    const again = dwellStep(first, 'write', 5);
    expect(again.state).toBe(first);
    expect(again.changed).toBe(false);
  });

  test('a change inside the dwell waits, and the LATEST input wins when it runs out', () => {
    let s = dwellStep(undefined, 'read', 0).state;
    const a = dwellStep(s, 'edit', 100);
    expect(a.changed).toBe(false);
    expect(a.wakeAt).toBe(D);
    s = a.state;
    s = dwellStep(s, 'run', 200).state; // a third action before the wake
    const early = dwellSettle(s, D - 1);
    expect(early.changed).toBe(false);
    expect(early.wakeAt).toBe(D);
    const settled = dwellSettle(s, D);
    expect(settled.changed).toBe(true);
    expect(settled.state.shown).toBe('run');
    expect(settled.state.shownAt).toBe(D);
  });

  test('a change after the dwell shows at once', () => {
    const s = dwellStep(undefined, 'read', 0).state;
    const b = dwellStep(s, 'edit', D);
    expect(b.changed).toBe(true);
    expect(b.state.shown).toBe('edit');
  });

  test('coming back to the shown action cancels the pending one', () => {
    let s = dwellStep(undefined, 'think', 0).state;
    s = dwellStep(s, 'read', 50).state;
    s = dwellStep(s, 'think', 80).state;
    const settled = dwellSettle(s, D);
    expect(settled.changed).toBe(false);
    expect(settled.state.shown).toBe('think');
  });
});

describe('chatFrameAction', () => {
  test('maps the stream frames', () => {
    expect(chatFrameAction({ type: 'stream:start' })).toBe('think');
    expect(chatFrameAction({ type: 'stream:thinking_start' })).toBe('think');
    expect(chatFrameAction({ type: 'stream:content_chunk' })).toBe('write');
    expect(chatFrameAction({ type: 'stream:tool_call', toolCall: { name: 'Bash' } })).toBe('run');
    expect(chatFrameAction({ type: 'stream:tool_call', toolCall: { name: 'mcp__exa__web_search_exa' } })).toBe('web');
    expect(chatFrameAction({ type: 'stream:tool_result' })).toBe('think');
    expect(chatFrameAction({ type: 'stream:tool_permission_required' })).toBe('wait');
    expect(chatFrameAction({ type: 'stream:tool_user_input_required' })).toBe('wait');
    expect(chatFrameAction({ type: 'stream:error' })).toBe('error');
    expect(chatFrameAction({ type: 'stream:end' })).toBe('clear');
  });

  test('a granted permission resumes the tool that asked', () => {
    expect(chatFrameAction({ type: 'stream:tool_permission_resolved' }, 'edit')).toBe('edit');
    expect(chatFrameAction({ type: 'stream:tool_permission_resolved' })).toBe('think');
  });

  test('frames that say nothing, and late frames of a closed turn, are ignored', () => {
    expect(chatFrameAction({ type: 'stream:usage' })).toBeNull();
    expect(chatFrameAction({ type: 'stream:alive' })).toBeNull();
    expect(chatFrameAction({ type: 'stream:tool_update' })).toBeNull();
    expect(chatFrameAction({ type: 'stream:tool_call', late: true, toolCall: { name: 'Bash' } })).toBeNull();
  });
});

describe('rollupAction', () => {
  test('the most recent change speaks', () => {
    expect(rollupAction([{ action: 'read', changedAt: 1 }, { action: 'edit', changedAt: 3 }, { action: 'run', changedAt: 2 }])).toBe('edit');
  });
  test('a waiting child makes the folder wait, unless the caller wants the latest move', () => {
    const kids = [{ action: 'wait' as const, changedAt: 1 }, { action: 'edit' as const, changedAt: 3 }];
    expect(rollupAction(kids)).toBe('wait');
    expect(rollupAction(kids, { waitWins: false })).toBe('edit');
  });
  test('an empty group has no action', () => {
    expect(rollupAction([])).toBeUndefined();
  });
});

describe('subjectActionFrom', () => {
  const base = { inProgress: true, turnOpen: true, waiting: false, tasks: [] };
  test('not working: no action', () => {
    expect(subjectActionFrom({ ...base, inProgress: false, live: 'edit' })).toBeUndefined();
  });
  test('waiting beats the live action', () => {
    expect(subjectActionFrom({ ...base, waiting: true, live: 'edit' })).toBe('wait');
  });
  test('a turn open: live, then the phase, then think', () => {
    expect(subjectActionFrom({ ...base, live: 'edit', fromPhase: 'read' })).toBe('edit');
    expect(subjectActionFrom({ ...base, fromPhase: 'read' })).toBe('read');
    expect(subjectActionFrom(base)).toBe('think');
  });
  test('only a job left running: the job', () => {
    expect(subjectActionFrom({ ...base, turnOpen: false, tasks: [{ kind: 'bash' }] })).toBe('run');
    expect(subjectActionFrom({ ...base, turnOpen: false, tasks: [{ kind: 'agent' }] })).toBe('delegate');
    expect(backgroundAction([{ kind: 'wake' }])).toBe('think');
  });
});

describe('actionForPhase (Claude Code hook phases)', () => {
  test('maps the phases', () => {
    expect(actionForPhase('tool-running', 'Edit')).toBe('edit');
    expect(actionForPhase('tool-running', 'mcp__topics__browser_act')).toBe('browse');
    expect(actionForPhase('tool-running', undefined)).toBe('tool');
    expect(actionForPhase('running', 'Edit')).toBe('think'); // the tool already returned
    expect(actionForPhase('watching', undefined)).toBe('run');
    expect(actionForPhase('awaiting-approval', 'Bash')).toBe('wait');
    expect(actionForPhase('awaiting-user', undefined)).toBe('wait');
    expect(actionForPhase('paused', undefined)).toBe('wait');
    expect(actionForPhase('error', undefined)).toBe('error');
    expect(actionForPhase('starting', undefined)).toBe('think');
  });
});

describe('the store publishes only when the shown action changes', () => {
  afterEach(() => __resetAgentActions());

  test('a burst of the same action is one publication', () => {
    let publications = 0;
    const unsub = useAgentActionStore.subscribe(() => { publications += 1; });
    for (let i = 0; i < 50; i++) agentActionActions.note('t1', 'write', 1000 + i);
    unsub();
    expect(publications).toBe(1);
    expect(useAgentActionStore.getState().actions.get('t1')).toEqual({ action: 'write', changedAt: 1000 });
  });

  test('clear removes the subject at once, and a second clear is a no-op', () => {
    agentActionActions.note('t2', 'read', 0);
    let publications = 0;
    const unsub = useAgentActionStore.subscribe(() => { publications += 1; });
    agentActionActions.clear('t2');
    agentActionActions.clear('t2');
    unsub();
    expect(publications).toBe(1);
    expect(useAgentActionStore.getState().actions.has('t2')).toBe(false);
  });

  test('a change inside the dwell lands when the dwell runs out', async () => {
    const t0 = Date.now();
    agentActionActions.note('t3', 'read', t0);
    agentActionActions.note('t3', 'edit', t0 + 10);
    expect(useAgentActionStore.getState().actions.get('t3')?.action).toBe('read');
    await new Promise((r) => setTimeout(r, D + 80));
    expect(useAgentActionStore.getState().actions.get('t3')?.action).toBe('edit');
  });
});
