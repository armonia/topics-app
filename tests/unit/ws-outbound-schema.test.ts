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
    // After the Day-3 expansion the registry covers virtually all emitted
    // outbound types. These synthetic placeholders exercise the
    // passthrough path for types that may appear in a future deploy
    // before the schema lands.
    expect(validateOutbound({ type: 'future.unknown.event' }).ok).toBe(true);
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
      'agent:assigned',
      'agent:escalation',
      'agent:heartbeat',
      'agent:profile:created',
      'agent:profile:deleted',
      'agent:profile:updated',
      'agent:session:paused',
      'agent:session:resumed',
      'agent:status',
      'agent:task_claimed',
      'agent:task_completed',
      'agent:unassigned',
      'agents:sessions',
      'agents:spawned',
      'agents:stopped',
      'approval:approved',
      'approval:created',
      'approval:rejected',
      'board:archived_all',
      'board:memory_added',
      'browser:navigate',
      'chat:archived',
      'chat:created',
      'chat:deleted',
      'chat:updated',
      'claude-event',
      'clear',
      'connected',
      'cron:updated',
      'dashboard:updated',
      'drag:accepted',
      'drag:end',
      'drag:start',
      'error',
      'gateway:status',
      'git-status:updated',
      'machine:updated',
      'machine:upserted',
      'memory:updated',
      'message',
      'message:media',
      'message:new',
      'message:plan-status',
      'open-project',
      'pong',
      'project:created',
      'project:deleted',
      'project:updated',
      'provider:changed',
      'provider:current',
      'providers:snapshot',
      'scripts:output',
      'scripts:updated',
      'session:state',
      'stream:catchup',
      'stream:content_chunk',
      'stream:end',
      'stream:error',
      'stream:resumed',
      'stream:slow',
      'stream:start',
      'stream:thinking_chunk',
      'stream:thinking_end',
      'stream:thinking_start',
      'stream:tool_call',
      'stream:tool_detail',
      'stream:tool_result',
      'stream:tool_update',
      'stream:tool_user_input_required',
      'task:archived',
      'task:comment:added',
      'task:created',
      'task:deleted',
      'task:dependency:added',
      'task:dependency:removed',
      'task:moved',
      'task:unarchived',
      'task:unblocked',
      'task:updated',
      'terminal:sessions',
      'topic:archived',
      'topic:created',
      'topic:switch',
      'topic:switch:complete',
      'topic:updated',
      'topics:reordered',
      'typing',
      'ui-state:init',
      'ui-state:patch',
      'ui-state:updated',
      'unread:init',
      'unread:updated',
      'welcome',
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

  test('all 96 v3 outbound types are present', () => {
    expect(REGISTERED_OUTBOUND_TYPES.length).toBe(96);
  });
});

describe('validateOutbound — final 100% coverage cluster', () => {
  test('chat:* legacy events require chat.id', () => {
    expect(validateOutbound({
      type: 'chat:created', chat: { id: 'c-1', title: 'old' },
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'chat:updated', chat: { id: 'c-1' } }).ok).toBe(true);
    expect(validateOutbound({ type: 'chat:archived', chat: { id: 'c-1' } }).ok).toBe(true);
    expect(validateOutbound({ type: 'chat:deleted', chatId: 'c-1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'chat:deleted' }).ok).toBe(false);
  });

  test('provider:current/changed minimal payload', () => {
    expect(validateOutbound({ type: 'provider:current' }).ok).toBe(true);
    expect(validateOutbound({ type: 'provider:changed', name: 'claude' }).ok).toBe(true);
  });

  test('git-status:updated minimal payload (passthrough)', () => {
    expect(validateOutbound({ type: 'git-status:updated' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'git-status:updated', projectId: 'p-1', dirty: true,
    }).ok).toBe(true);
  });
});

// ----- Day-3 additions: agent + approval + stream + message + misc --------

describe('validateOutbound — agent cluster', () => {
  test('agent:profile:created accepts profile.id', () => {
    expect(validateOutbound({
      type: 'agent:profile:created',
      profile: { id: 'a-1', name: 'agent-1', role: 'worker' },
    }).ok).toBe(true);
  });

  test('agent:assigned requires assignment.agentId+topicId', () => {
    expect(validateOutbound({
      type: 'agent:assigned',
      assignment: { agentId: 'a-1', topicId: 't-1', role: 'worker' },
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'agent:assigned',
      assignment: { agentId: 'a-1' }, // missing topicId
    }).ok).toBe(false);
  });

  test('agent:status with optional previousStatus', () => {
    expect(validateOutbound({
      type: 'agent:status', agentId: 'a-1', status: 'available',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'agent:status', agentId: 'a-1', status: 'available', previousStatus: 'offline',
    }).ok).toBe(true);
  });

  test('agent:heartbeat requires timestamp string', () => {
    expect(validateOutbound({
      type: 'agent:heartbeat', agentId: 'a-1', timestamp: '2026-05-13T00:00:00Z',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'agent:heartbeat', agentId: 'a-1', timestamp: 12345,
    }).ok).toBe(false);
  });

  test('agent:session:paused requires sessionKey', () => {
    expect(validateOutbound({ type: 'agent:session:paused', sessionKey: 'sk-1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'agent:session:paused' }).ok).toBe(false);
  });

  test('agent:task_claimed requires agentId+taskId+projectId', () => {
    expect(validateOutbound({
      type: 'agent:task_claimed', agentId: 'a-1', taskId: 't-1', projectId: 'p-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'agent:task_claimed', agentId: 'a-1' }).ok).toBe(false);
  });

  test('agents:spawned requires topicId + sessionKey', () => {
    expect(validateOutbound({
      type: 'agents:spawned', topicId: 't-1', sessionKey: 'sk-1', label: 'task',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'agents:spawned', topicId: 't-1', sessionKey: 'sk-1',
    }).ok).toBe(true); // label optional
  });

  test('agents:sessions requires sessions array', () => {
    expect(validateOutbound({ type: 'agents:sessions', sessions: [] }).ok).toBe(true);
    expect(validateOutbound({ type: 'agents:sessions' }).ok).toBe(false);
  });
});

describe('validateOutbound — approval cluster', () => {
  test('approval:created requires projectId + approval.id', () => {
    expect(validateOutbound({
      type: 'approval:created', projectId: 'p-1',
      approval: { id: 'app-1', status: 'pending' },
    }).ok).toBe(true);
  });

  test('approval:approved/rejected require approvalId', () => {
    expect(validateOutbound({ type: 'approval:approved', approvalId: 'app-1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'approval:rejected', approvalId: 'app-1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'approval:approved' }).ok).toBe(false);
  });
});

describe('validateOutbound — stream cluster', () => {
  test('stream:start requires sessionKey + messageId', () => {
    expect(validateOutbound({
      type: 'stream:start', sessionKey: 'sk', messageId: 'm-1',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:start', sessionKey: 'sk', messageId: 'm-1', topicId: 't-1',
    }).ok).toBe(true);
  });

  test('stream:content_chunk requires content string', () => {
    expect(validateOutbound({
      type: 'stream:content_chunk', sessionKey: 'sk', content: 'hi',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:content_chunk', sessionKey: 'sk', content: 42,
    }).ok).toBe(false);
  });

  test('stream:error requires error string', () => {
    expect(validateOutbound({
      type: 'stream:error', sessionKey: 'sk', error: 'boom',
    }).ok).toBe(true);
  });

  test('stream:tool_call requires toolCall.id', () => {
    expect(validateOutbound({
      type: 'stream:tool_call', sessionKey: 'sk',
      toolCall: { id: 'tc-1', name: 'Bash', args: {} },
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'stream:tool_call', sessionKey: 'sk',
      toolCall: { name: 'Bash' }, // missing id
    }).ok).toBe(false);
  });

  test('stream:thinking_start/end accepts minimal payload', () => {
    expect(validateOutbound({ type: 'stream:thinking_start', sessionKey: 'sk' }).ok).toBe(true);
    expect(validateOutbound({ type: 'stream:thinking_end', sessionKey: 'sk' }).ok).toBe(true);
  });

  test('stream:tool_user_input_required accepts minimal payload', () => {
    expect(validateOutbound({
      type: 'stream:tool_user_input_required', sessionKey: 'sk',
    }).ok).toBe(true);
  });
});

describe('validateOutbound — message cluster', () => {
  test('message (legacy) requires message.id', () => {
    expect(validateOutbound({
      type: 'message', sessionKey: 'sk',
      message: { id: 'm-1', role: 'assistant', content: 'hi' },
    }).ok).toBe(true);
  });

  test('message:new requires sessionKey, role, messageId, content', () => {
    expect(validateOutbound({
      type: 'message:new', sessionKey: 'sk', topicId: 't-1', role: 'assistant',
      messageId: 'm-1', content: 'hello',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'message:new', sessionKey: 'sk', role: 'user', messageId: 'm-1',
      content: 'hi', // topicId optional, preview optional
    }).ok).toBe(true);
  });

  test('message:plan-status requires topicId+messageId+planStatus', () => {
    expect(validateOutbound({
      type: 'message:plan-status', topicId: 't-1', messageId: 'm-1',
      planStatus: 'approved',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'message:plan-status', topicId: 't-1',
    }).ok).toBe(false);
  });

  test('message:media accepts arbitrary media field', () => {
    expect(validateOutbound({
      type: 'message:media', sessionKey: 'sk', media: ['url1', 'url2'],
    }).ok).toBe(true);
  });
});

describe('validateOutbound — misc domain (browser/cron/machine/memory/open-project/etc)', () => {
  test('browser:navigate requires topicId + url', () => {
    expect(validateOutbound({
      type: 'browser:navigate', topicId: 't-1', url: 'https://x',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'browser:navigate', topicId: 't-1' }).ok).toBe(false);
  });

  test('clear is minimal', () => {
    expect(validateOutbound({ type: 'clear' }).ok).toBe(true);
  });

  test('cron:updated requires jobs array', () => {
    expect(validateOutbound({ type: 'cron:updated', jobs: [] }).ok).toBe(true);
    expect(validateOutbound({ type: 'cron:updated' }).ok).toBe(false);
  });

  test('machine:upserted/updated require machine.id', () => {
    expect(validateOutbound({
      type: 'machine:upserted', machine: { id: 'm-1', name: 'mbp' },
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'machine:updated', machine: { id: 'm-1', last_seen: '2026' },
    }).ok).toBe(true);
  });

  test('memory:updated requires scope', () => {
    expect(validateOutbound({ type: 'memory:updated', scope: 'global' }).ok).toBe(true);
    expect(validateOutbound({
      type: 'memory:updated', scope: 'topic', topicId: 't-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'memory:updated' }).ok).toBe(false);
  });

  test('open-project requires projectPath', () => {
    expect(validateOutbound({ type: 'open-project', projectPath: '/Users/me/proj' }).ok).toBe(true);
    expect(validateOutbound({ type: 'open-project' }).ok).toBe(false);
  });

  test('topics:reordered requires order array of strings', () => {
    expect(validateOutbound({
      type: 'topics:reordered', order: ['t-1', 't-2'],
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'topics:reordered', order: [1, 2],
    }).ok).toBe(false);
  });

  test('task:unblocked requires projectId + taskId', () => {
    expect(validateOutbound({
      type: 'task:unblocked', projectId: 'p-1', taskId: 't-1',
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'task:unblocked' }).ok).toBe(false);
  });

  test('ui-state:init accepts data + optional meta', () => {
    expect(validateOutbound({
      type: 'ui-state:init', data: { keys: {} }, meta: { server_seq: 1 },
    }).ok).toBe(true);
    expect(validateOutbound({ type: 'ui-state:init', data: {} }).ok).toBe(true);
  });

  test('welcome (outbound echo) requires all fields', () => {
    expect(validateOutbound({
      type: 'welcome',
      serverVersion: '1.0.0', protocolVersion: 1,
      capabilities: ['ws-validation-v1'], serverTime: 1700000000000,
      clientId: 'ws-abc',
    }).ok).toBe(true);
    expect(validateOutbound({
      type: 'welcome', serverVersion: '1.0', protocolVersion: 1.5,
      capabilities: [], serverTime: 0, clientId: '',
    }).ok).toBe(false); // protocolVersion must be integer
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
