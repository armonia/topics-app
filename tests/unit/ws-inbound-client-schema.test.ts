/**
 * Validazione WS lato client — ora sopra il registro CONDIVISO.
 *
 * Questi test avevano un tempo un secondo scopo: bloccare il sottoinsieme di
 * tipi che il mirror del client ridefiniva a mano. Il mirror non c'è più
 * (`client/src/schemas/ws-inbound.ts` inoltra a `shared/ws-outbound.ts`),
 * quindi ora bloccano la cosa che conta davvero: che il client stia usando
 * QUELLO registro e non una copia — se qualcuno ne reintroduce una, il primo
 * test qui sotto diventa rosso.
 *
 * Run with: `bun test tests/unit/ws-inbound-client-schema.test.ts`
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import {
  validateInbound,
  isRegisteredInboundType,
  REGISTERED_INBOUND_TYPES,
} from '../../client/src/schemas/ws-inbound';
import {
  validateOutbound,
  REGISTERED_OUTBOUND_TYPES,
} from '../../shared/ws-outbound';

describe('client inbound = registro condiviso (niente mirror)', () => {
  test('REGISTERED_INBOUND_TYPES è LO STESSO array, non una copia uguale', () => {
    // Identità referenziale di proposito: `toEqual` passerebbe anche con due
    // liste gemelle scritte a mano, che è esattamente il difetto rimosso.
    expect(REGISTERED_INBOUND_TYPES).toBe(REGISTERED_OUTBOUND_TYPES);
  });

  test('il client conosce tutti i tipi che il server sa mandare', () => {
    for (const t of REGISTERED_OUTBOUND_TYPES) {
      expect(isRegisteredInboundType(t)).toBe(true);
    }
    expect(isRegisteredInboundType('not-yet-modeled')).toBe(false);
  });

  test('validateInbound e validateOutbound danno lo stesso verdetto', () => {
    const frames: unknown[] = [
      { type: 'connected', clientId: 'ws-1' },
      { type: 'connected' },
      { type: 'agent:status', agentId: 'a-1', status: 'idle' },
      { type: 'agent:status' },
      { type: 'totally-new-event' },
      null,
    ];
    for (const f of frames) {
      expect(validateInbound(f).ok).toBe(validateOutbound(f).ok);
    }
  });
});

describe('validateInbound — frame che il client legge a mano', () => {
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
      fromTopicId: 't-1', fromSessionKey: 'sk-1',
      toTopicId: 't-2', toSessionKey: 'sk-2',
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

  // LA deriva che il mirror nascondeva: il server manda SEMPRE `fromSessionKey`
  // (è ciò che permette al client di capire se lo switch l'ha guidato lui), ma
  // la copia lato client non lo chiedeva. Due contratti, uno più lasco: esatto
  // il motivo per cui adesso ce n'è uno solo.
  test('rejects topic:switch senza fromSessionKey (il mirror lo accettava)', () => {
    const r = validateInbound({
      type: 'topic:switch', fromTopicId: 't-1', toTopicId: 't-2', toSessionKey: 'sk-2',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('fromSessionKey');
  });
});

describe('validateInbound — unmodeled passthrough', () => {
  test('returns ok for types not in the registry', () => {
    expect(validateInbound({ type: 'totally-new-event' }).ok).toBe(true);
    expect(validateInbound({ type: 'future.unknown.event', a: 1 }).ok).toBe(true);
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
