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
    expect(validateOutbound({ type: 'task:created', taskId: 't1' }).ok).toBe(true);
    expect(validateOutbound({ type: 'browser:navigate', url: 'x' }).ok).toBe(true);
    expect(validateOutbound({ type: 'totally-new-event' }).ok).toBe(true);
  });

  test('a type not in registry passes even with extra/missing fields', () => {
    // The registry is opt-in; unmodeled types accept any shape until they
    // get a schema. This is the WHOLE POINT of incremental migration —
    // adding a schema for `task:created` later will start rejecting bad
    // task payloads without breaking other types.
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
      'connected',
      'dashboard:updated',
      'drag:accepted',
      'drag:end',
      'drag:start',
      'pong',
      'stream:end',
      'topic:switch',
      'typing',
      'unread:init',
      'unread:updated',
    ]);
  });

  test('isRegisteredOutboundType matches the registry', () => {
    for (const t of REGISTERED_OUTBOUND_TYPES) {
      expect(isRegisteredOutboundType(t)).toBe(true);
    }
    expect(isRegisteredOutboundType('not-yet-modeled')).toBe(false);
  });
});
