/**
 * Client-side WS inbound validation tests (v3 foundations WS-01 client wrap-up).
 *
 * Run with: `bun test tests/unit/ws-inbound-client-schema.test.ts`
 */
import { describe, expect, test } from 'bun:test';
import {
  validateInbound,
  isRegisteredInboundType,
  REGISTERED_INBOUND_TYPES,
} from '../../client/src/schemas/ws-inbound';

describe('validateInbound — registered messages', () => {
  const valid: Array<Record<string, unknown>> = [
    { type: 'connected', clientId: 'ws-1' },
    { type: 'pong' },
    { type: 'error', message: 'boom' },
    {
      type: 'welcome',
      serverVersion: '1.0', protocolVersion: 1,
      capabilities: [], serverTime: 0, clientId: 'ws-1',
    },
    { type: 'dashboard:updated' },
    {
      type: 'unread:init',
      data: { 't1': { lastReadAt: '2026', unreadCount: 0 } },
    },
    { type: 'unread:updated', topicId: 't-1', unreadCount: 3 },
    { type: 'stream:end', sessionKey: 'sk', messageId: 'm-1' },
    { type: 'stream:catchup', sessionKey: 'sk', messageId: 'm-1' },
    { type: 'stream:start', sessionKey: 'sk', messageId: 'm-1' },
    { type: 'stream:content_chunk', sessionKey: 'sk', content: 'hi' },
    { type: 'stream:error', sessionKey: 'sk', error: 'boom' },
    { type: 'typing', topicId: 't-1', clientId: 'ws-1', text: 'hi' },
    { type: 'topic:created', topic: { id: 't-1' } },
    { type: 'topic:updated', topic: { id: 't-1' } },
    { type: 'topic:archived', topic: { id: 't-1' } },
    {
      type: 'topic:switch',
      fromTopicId: 't-1', toTopicId: 't-2', toSessionKey: 'sk-2',
    },
    { type: 'ui-state:init', data: { keys: {} } },
    { type: 'ui-state:updated', key: 'w', value: {} },
    {
      type: 'message:new', sessionKey: 'sk', role: 'assistant',
      messageId: 'm-1', content: 'hello',
    },
  ];

  for (const msg of valid) {
    test(`accepts ${msg.type}`, () => {
      expect(validateInbound(msg).ok).toBe(true);
    });
  }
});

describe('validateInbound — malformed', () => {
  test('rejects connected without clientId', () => {
    const r = validateInbound({ type: 'connected' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('clientId');
      expect(r.type).toBe('connected');
    }
  });

  test('rejects unread:updated with non-number unreadCount', () => {
    const r = validateInbound({ type: 'unread:updated', topicId: 't', unreadCount: 'many' });
    expect(r.ok).toBe(false);
  });

  test('rejects stream:content_chunk with non-string content', () => {
    const r = validateInbound({ type: 'stream:content_chunk', sessionKey: 'sk', content: 42 });
    expect(r.ok).toBe(false);
  });

  test('rejects topic:created without topic.id', () => {
    const r = validateInbound({ type: 'topic:created', topic: { name: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topic.id');
  });

  test('rejects welcome with non-integer protocolVersion', () => {
    const r = validateInbound({
      type: 'welcome', serverVersion: '1', protocolVersion: 1.5,
      capabilities: [], serverTime: 0, clientId: 'x',
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateInbound — unmodeled passthrough', () => {
  test('returns ok for types not in the registry', () => {
    expect(validateInbound({ type: 'task:created', task: {} }).ok).toBe(true);
    expect(validateInbound({ type: 'agents:spawned' }).ok).toBe(true);
    expect(validateInbound({ type: 'totally-new-event' }).ok).toBe(true);
  });

  test('accepts arbitrary extra fields on registered passthrough types', () => {
    expect(validateInbound({
      type: 'pong', extra: 'something', moreExtras: { nested: 1 },
    }).ok).toBe(true);
  });
});

describe('validateInbound — structural rejects', () => {
  test('rejects non-object', () => {
    expect(validateInbound(null).ok).toBe(false);
    expect(validateInbound(42).ok).toBe(false);
    expect(validateInbound('x').ok).toBe(false);
  });

  test('rejects missing type', () => {
    const r = validateInbound({ data: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('type');
  });
});

describe('client inbound registry contract', () => {
  test('REGISTERED_INBOUND_TYPES is the locked subset', () => {
    // presence:windows joined the client inbound registry in 724284d3
    // (cross-window presence protocol) — the server's full window-list
    // snapshot the client projects into "open elsewhere" affordances.
    // ui:bundle-updated joined in 258e9cce (dev bundle hot-delivery) — the
    // server's "built client changed on disk" signal that reloads windows.
    // ui-state:patch joined in ad7e1c3f (sync refactor) — the incremental
    // key-level ui_state delta the client applies without a full re-init.
    expect(REGISTERED_INBOUND_TYPES).toEqual([
      'connected',
      'dashboard:updated',
      'error',
      'message:new',
      'pong',
      'presence:windows',
      'stream:catchup',
      'stream:content_chunk',
      'stream:end',
      'stream:error',
      'stream:start',
      'topic:archived',
      'topic:created',
      'topic:switch',
      'topic:updated',
      'typing',
      'ui-state:init',
      'ui-state:patch',
      'ui-state:updated',
      'ui:bundle-updated',
      'unread:init',
      'unread:updated',
      'welcome',
    ]);
  });

  test('isRegisteredInboundType matches the registry', () => {
    for (const t of REGISTERED_INBOUND_TYPES) {
      expect(isRegisteredInboundType(t)).toBe(true);
    }
    expect(isRegisteredInboundType('agent:status')).toBe(false);
  });
});
