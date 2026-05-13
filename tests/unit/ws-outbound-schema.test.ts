/**
 * Unit tests for the outbound WS message registry (v3 foundations WS-01
 * emit-side validation).
 *
 * Run with: `bun test tests/unit/ws-outbound-schema.test.ts`
 */
import { describe, expect, test } from 'bun:test';
import {
  validateOutbound,
  isRegisteredOutboundType,
  REGISTERED_OUTBOUND_TYPES,
} from '../../server/schemas/ws-outbound';

// ----- Registered types: round-trip valid payloads --------------------------

describe('validateOutbound — valid registered messages', () => {
  const validPayloads: Array<Record<string, unknown>> = [
    { type: 'connected', clientId: 'ws-abc' },
    { type: 'pong' },
    { type: 'dashboard:updated' },
    {
      type: 'unread:init',
      data: {
        'topic-1': { lastReadAt: '2026-05-13T00:00:00Z', unreadCount: 0 },
        'topic-2': { lastReadAt: '2026-05-13T01:00:00Z', unreadCount: 3 },
      },
    },
    { type: 'unread:updated', topicId: 'topic-1', unreadCount: 5 },
    { type: 'stream:end', sessionKey: 'sk-1', messageId: 'm-1' },
    { type: 'typing', topicId: 'topic-1', clientId: 'ws-1', text: 'hello' },
    { type: 'typing', topicId: 'topic-1', clientId: 'ws-1', text: '' },
    { type: 'drag:start', topicId: 'topic-1', sourceWindowId: 'win-1' },
    { type: 'drag:end', topicId: 'topic-1', sourceWindowId: 'win-1' },
    { type: 'drag:accepted', topicId: 'topic-1', targetWindowId: 'win-2' },
    {
      type: 'drag:accepted',
      topicId: 'topic-1',
      targetWindowId: 'win-2',
      sourceWindowId: 'win-1',
    },
    {
      type: 'topic:switch',
      fromTopicId: 'topic-1',
      toTopicId: 'topic-2',
      toSessionKey: 'sk-2',
    },
  ];

  for (const payload of validPayloads) {
    test(`validates ${payload.type as string}`, () => {
      expect(validateOutbound(payload).ok).toBe(true);
    });
  }
});

// ----- Registered types: rejection on bad payloads --------------------------

describe('validateOutbound — malformed registered messages', () => {
  test('rejects connected without clientId', () => {
    const r = validateOutbound({ type: 'connected' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('clientId');
  });

  test('rejects unread:updated with wrong type for unreadCount', () => {
    const r = validateOutbound({ type: 'unread:updated', topicId: 't', unreadCount: 'many' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unreadCount');
  });

  test('rejects stream:end missing sessionKey', () => {
    const r = validateOutbound({ type: 'stream:end', messageId: 'm-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sessionKey');
  });

  test('rejects typing missing clientId', () => {
    const r = validateOutbound({ type: 'typing', topicId: 't', text: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('clientId');
  });

  test('rejects topic:switch missing toSessionKey', () => {
    const r = validateOutbound({ type: 'topic:switch', fromTopicId: 'a', toTopicId: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('toSessionKey');
  });

  test('rejects unread:init with wrong nested shape', () => {
    const r = validateOutbound({
      type: 'unread:init',
      data: { 'topic-1': { lastReadAt: 0, unreadCount: 'oops' } },
    });
    expect(r.ok).toBe(false);
  });
});

// ----- Unmodeled types: passthrough -----------------------------------------

describe('validateOutbound — unmodeled types passthrough', () => {
  test('returns ok for types not in the registry', () => {
    // browser:navigate is intentionally NOT in the v3 outbound registry —
    // browser CDP events live on the dedicated /ws/browser channel.
    expect(validateOutbound({ type: 'browser:navigate', url: 'x' }).ok).toBe(true);
    expect(validateOutbound({ type: 'totally-new-event' }).ok).toBe(true);
  });

  test('a type not in registry passes even with extra/missing fields', () => {
    // The registry is opt-in; unmodeled types accept any shape until they
    // get a schema. Promote a type by adding to OUTBOUND_SCHEMAS — adding
    // a schema will start rejecting bad payloads without breaking other
    // types.
    expect(validateOutbound({ type: 'random-event', a: 1, b: 'x' }).ok).toBe(true);
  });
});

// ----- Hard-rejects: structural issues --------------------------------------

describe('validateOutbound — structural rejects', () => {
  test('rejects non-object', () => {
    expect(validateOutbound(null).ok).toBe(false);
    expect(validateOutbound(undefined).ok).toBe(false);
    expect(validateOutbound(42).ok).toBe(false);
    expect(validateOutbound('hello').ok).toBe(false);
  });

  test('rejects missing type field', () => {
    const r = validateOutbound({ data: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });

  test('rejects non-string type', () => {
    const r = validateOutbound({ type: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });
});

// ----- Registry contract guard ---------------------------------------------

describe('outbound registry contract', () => {
  test('REGISTERED_OUTBOUND_TYPES is the locked v3 v1 set', () => {
    // Adding a type to OUTBOUND_SCHEMAS requires updating this assertion.
    // That's intentional — it forces the PR author to acknowledge that
    // the outbound surface grew (and to document it in WS-PROTOCOL.md).
    expect(REGISTERED_OUTBOUND_TYPES).toEqual([
      'board:archived_all',
      'board:memory_added',
      'connected',
      'dashboard:updated',
      'drag:accepted',
      'drag:end',
      'drag:start',
      'error',
      'pong',
      'project:created',
      'project:deleted',
      'project:updated',
      'providers:snapshot',
      'stream:catchup',
      'stream:end',
      'task:archived',
      'task:comment:added',
      'task:created',
      'task:deleted',
      'task:dependency:added',
      'task:dependency:removed',
      'task:moved',
      'task:unarchived',
      'task:updated',
      'topic:archived',
      'topic:created',
      'topic:switch',
      'topic:switch:complete',
      'topic:updated',
      'typing',
      'ui-state:patch',
      'ui-state:updated',
      'unread:init',
      'unread:updated',
      'worktree:deleted',
      'worktree:new',
      'worktree:updated',
    ]);
  });

  test('isRegisteredOutboundType matches the registry', () => {
    for (const t of REGISTERED_OUTBOUND_TYPES) {
      expect(isRegisteredOutboundType(t)).toBe(true);
    }
    expect(isRegisteredOutboundType('not-yet-modeled')).toBe(false);
  });

  test('all 37 v3 outbound types are present', () => {
    expect(REGISTERED_OUTBOUND_TYPES.length).toBe(37);
  });
});

// ----- New schema coverage (clusters added 2026-05-13) ---------------------

describe('validateOutbound — task / board cluster', () => {
  test('task:created accepts task with id + extra fields', () => {
    expect(validateOutbound({
      type: 'task:created',
      projectId: 'p-1',
      task: { id: 't-1', text: 'do X', status: 'todo', extra: 'ok' },
    }).ok).toBe(true);
  });

  test('task:deleted requires taskId', () => {
    expect(validateOutbound({ type: 'task:deleted', projectId: 'p-1', taskId: 't-1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'task:deleted', projectId: 'p-1' }).ok).toBe(false);
  });

  test('task:created rejects task without id', () => {
    const r = validateOutbound({
      type: 'task:created',
      projectId: 'p-1',
      task: { text: 'no id' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('task.id');
  });

  test('task:moved accepts standard payload', () => {
    expect(validateOutbound({
      type: 'task:moved',
      projectId: 'p-1',
      task: { id: 't-1', kanban_order: 5 },
    }).ok).toBe(true);
  });

  test('task:comment:added accepts comment with id', () => {
    expect(validateOutbound({
      type: 'task:comment:added',
      projectId: 'p-1',
      taskId: 't-1',
      comment: { id: 'c-1', text: 'hello' },
    }).ok).toBe(true);
  });

  test('task:dependency:added requires both projectId + taskId', () => {
    expect(validateOutbound({
      type: 'task:dependency:added',
      projectId: 'p-1',
      taskId: 't-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'task:dependency:added', projectId: 'p-1' }).ok).toBe(false);
  });

  test('board:archived_all accepts projectId-only payload', () => {
    expect(validateOutbound({ type: 'board:archived_all', projectId: 'p-1' }).ok).toBe(true);
  });

  test('board:memory_added accepts memory with id', () => {
    expect(validateOutbound({
      type: 'board:memory_added',
      projectId: 'p-1',
      memory: { id: 'm-1', content: 'note' },
    }).ok).toBe(true);
  });
});

describe('validateOutbound — topic cluster', () => {
  test('topic:created with id-bearing topic', () => {
    expect(validateOutbound({
      type: 'topic:created',
      topic: { id: 'topic-1', sessionKey: 'topic:abc', color: '#5865f2' },
    }).ok).toBe(true);
  });

  test('topic:updated with topic', () => {
    expect(validateOutbound({
      type: 'topic:updated',
      topic: { id: 'topic-1', sessionKey: 'topic:abc' },
    }).ok).toBe(true);
  });

  test('topic:archived requires topic.id', () => {
    expect(validateOutbound({
      type: 'topic:archived',
      topic: { color: '#fff' },
    }).ok).toBe(false);
  });

  test('topic:switch:complete passthrough', () => {
    expect(validateOutbound({ type: 'topic:switch:complete', anyField: 1 }).ok).toBe(true);
  });
});

describe('validateOutbound — worktree cluster', () => {
  test('worktree:new + payload_version', () => {
    expect(validateOutbound({
      type: 'worktree:new',
      worktree: { id: 'wt-1', name: 'foo', branch: 'feat' },
      payload_version: 1,
    }).ok).toBe(true);
  });

  test('worktree:updated tolerates payload_version absent', () => {
    expect(validateOutbound({
      type: 'worktree:updated',
      worktree: { id: 'wt-1', status: 'ready' },
    }).ok).toBe(true);
  });

  test('worktree:deleted accepts minimal payload', () => {
    expect(validateOutbound({
      type: 'worktree:deleted',
      worktree: { id: 'wt-1' },
    }).ok).toBe(true);
  });
});

describe('validateOutbound — ui-state cluster', () => {
  test('ui-state:updated with all canonical fields', () => {
    expect(validateOutbound({
      type: 'ui-state:updated',
      key: 'window-1',
      value: { panes: [] },
      payload_version: 2,
      server_seq: 42,
      sourceClientId: 'ws-abc',
    }).ok).toBe(true);
  });

  test('ui-state:patch with entries array', () => {
    expect(validateOutbound({
      type: 'ui-state:patch',
      sourceClientId: 'ws-abc',
      entries: [{ key: 'k', op: 'set', value: 1 }],
    }).ok).toBe(true);
  });

  test('ui-state:updated rejects missing key', () => {
    expect(validateOutbound({ type: 'ui-state:updated', value: 1 }).ok).toBe(false);
  });
});

describe('validateOutbound — project + provider + error', () => {
  test('project:created with payload_version', () => {
    expect(validateOutbound({
      type: 'project:created',
      project: { id: 'p-1', name: 'Demo' },
      payload_version: 1,
    }).ok).toBe(true);
  });

  test('providers:snapshot with arbitrary snapshot shape', () => {
    expect(validateOutbound({
      type: 'providers:snapshot',
      snapshot: { current: 'claude', list: ['claude', 'openai'] },
    }).ok).toBe(true);
  });

  test('error envelope requires message', () => {
    expect(validateOutbound({ type: 'error', message: 'failed' }).ok).toBe(true);
    expect(validateOutbound({ type: 'error' }).ok).toBe(false);
  });

  test('stream:catchup minimal payload', () => {
    expect(validateOutbound({
      type: 'stream:catchup',
      sessionKey: 'sk-1',
      messageId: 'm-1',
    }).ok).toBe(true);
  });
});
