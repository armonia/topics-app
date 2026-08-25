/**
 * Unit tests for the inbound chat/topic WS message schema (v3 foundations
 * WS-01 extension covering `/ws` main channel).
 *
 * Run with: `bun test tests/unit/chat-ws-inbound-schema.test.ts`
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import {
  chatWsInboundSchema,
  parseChatWsInbound,
  type ChatWsInbound,
} from '../../server/schemas/chat-ws-inbound';

describe('chatWsInboundSchema — valid messages', () => {
  const valid: ChatWsInbound[] = [
    { type: 'focus', topicId: 'topic-123' },
    { type: 'focus', topicId: null }, // blur
    { type: 'typing', topicId: 'topic-1' },
    { type: 'typing', topicId: 'topic-1', text: 'hello' },
    { type: 'typing', topicId: 'topic-1', text: '' },
    { type: 'ping' },
    { type: 'subscribe', topicIds: [] },
    { type: 'subscribe', topicIds: ['topic-1', 'topic-2'] },
    { type: 'drag:start', topicId: 'topic-1', windowId: 'win-1' },
    { type: 'drag:end', topicId: 'topic-1', windowId: 'win-1' },
    { type: 'drag:drop', topicId: 'topic-1', windowId: 'win-1' },
    { type: 'drag:drop', topicId: 'topic-1', windowId: 'win-1', sourceWindowId: 'win-2' },
  ];

  for (const msg of valid) {
    test(`parses ${msg.type}`, () => {
      const back = JSON.parse(JSON.stringify(msg));
      const r = parseChatWsInbound(back);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toEqual(msg);
    });
  }
});

describe('parseChatWsInbound — malformed', () => {
  test('rejects null / primitives / arrays', () => {
    expect(parseChatWsInbound(null).ok).toBe(false);
    expect(parseChatWsInbound(42).ok).toBe(false);
    expect(parseChatWsInbound('focus').ok).toBe(false);
    expect(parseChatWsInbound([]).ok).toBe(false);
  });

  test('rejects unknown type', () => {
    const r = parseChatWsInbound({ type: 'reload', topicId: 't' });
    expect(r.ok).toBe(false);
  });

  test('rejects focus without topicId', () => {
    const r = parseChatWsInbound({ type: 'focus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topicId');
  });

  test('rejects typing without topicId', () => {
    const r = parseChatWsInbound({ type: 'typing' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topicId');
  });

  test('rejects drag:start without windowId', () => {
    const r = parseChatWsInbound({ type: 'drag:start', topicId: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('windowId');
  });

  test('rejects wrong type on typing.text', () => {
    const r = parseChatWsInbound({ type: 'typing', topicId: 't', text: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('text');
  });

  test('rejects wrong type on focus.topicId (not string|null)', () => {
    const r = parseChatWsInbound({ type: 'focus', topicId: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topicId');
  });
});

describe('schema completeness', () => {
  // presence:announce landed in 724284d3 (cross-window presence protocol),
  // taking the union from 8 → 9 variants.
  test('exactly 9 variants (6 chat/topic + hello WS-02 + subscribe P6 + presence:announce)', () => {
    expect(chatWsInboundSchema.options.length).toBe(9);
  });

  test('variants cover the documented client emit sites', () => {
    const literals = chatWsInboundSchema.options.map((opt) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape: any = (opt as any).shape;
      return shape.type.value;
    });
    // presence:announce is emitted from client/src/hooks/usePanelLifecycle.ts
    // (window declares its open-set/focus/detach state; server re-broadcasts
    // the full window list as presence:windows).
    expect(new Set(literals)).toEqual(
      new Set([
        'focus',
        'typing',
        'ping',
        'subscribe',
        'drag:start',
        'drag:end',
        'drag:drop',
        'hello',
        'presence:announce',
      ]),
    );
  });
});

describe('hello variant (WS-02 handshake)', () => {
  test('parses a valid hello', () => {
    const r = parseChatWsInbound({
      type: 'hello',
      clientVersion: '0.0.0-dev',
      protocolVersion: 1,
      capabilities: ['tool-detail-v1'],
    });
    expect(r.ok).toBe(true);
  });

  test('rejects hello missing protocolVersion', () => {
    const r = parseChatWsInbound({
      type: 'hello',
      clientVersion: 'x',
      capabilities: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('protocolVersion');
  });
});
