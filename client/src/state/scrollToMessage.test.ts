/**
 * Tests for the palette→MessageList jump-target store (pure core: the
 * window event dispatch is guarded out under bun:test).
 *
 *   - register → peek returns the id without consuming it;
 *   - consume drops the target;
 *   - a later register for the same topic overwrites the earlier one;
 *   - targets expire after the TTL (stale hits can't hijack later visits).
  * @covers CHAT-SCROLL-01
 */
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import {
  requestScrollToMessage,
  peekScrollToMessage,
  consumeScrollToMessage,
  markScrollToMessageFired,
  _clearAllScrollTargets,
  SCROLL_TO_MESSAGE_EVENT,
} from './scrollToMessage';

describe('scrollToMessage target store', () => {
  beforeEach(() => {
    setSystemTime(); // real clock
    _clearAllScrollTargets();
  });

  test('peek returns a registered target without consuming it', () => {
    requestScrollToMessage('topic-1', 'msg-a');
    expect(peekScrollToMessage('topic-1')).toBe('msg-a');
    expect(peekScrollToMessage('topic-1')).toBe('msg-a'); // still there
    expect(peekScrollToMessage('topic-2')).toBeNull();
  });

  test('consume drops the target', () => {
    requestScrollToMessage('topic-1', 'msg-a');
    consumeScrollToMessage('topic-1');
    expect(peekScrollToMessage('topic-1')).toBeNull();
  });

  test('re-register overwrites the previous target for the topic', () => {
    requestScrollToMessage('topic-1', 'msg-a');
    requestScrollToMessage('topic-1', 'msg-b');
    expect(peekScrollToMessage('topic-1')).toBe('msg-b');
  });

  test('targets expire after the TTL', () => {
    setSystemTime(new Date('2026-07-11T12:00:00Z'));
    requestScrollToMessage('topic-1', 'msg-a');
    setSystemTime(new Date('2026-07-11T12:00:29Z'));
    expect(peekScrollToMessage('topic-1')).toBe('msg-a'); // 29s — still fresh
    setSystemTime(new Date('2026-07-11T12:00:31Z'));
    expect(peekScrollToMessage('topic-1')).toBeNull(); // 31s — expired
    // Expired entries are purged, not resurrected by a later peek.
    setSystemTime(new Date('2026-07-11T12:00:00Z'));
    expect(peekScrollToMessage('topic-1')).toBeNull();
  });

  test('a fired target survives the grace window, then purges', () => {
    setSystemTime(new Date('2026-07-11T12:00:00Z'));
    requestScrollToMessage('topic-1', 'msg-a');
    markScrollToMessageFired('topic-1');
    // Inside the grace: still peekable (keeps bottom-anchor guards active and
    // allows the post-reload re-jump).
    setSystemTime(new Date('2026-07-11T12:00:01.500Z'));
    expect(peekScrollToMessage('topic-1')).toBe('msg-a');
    // Past the grace: gone, without an explicit consume.
    setSystemTime(new Date('2026-07-11T12:00:02.100Z'));
    expect(peekScrollToMessage('topic-1')).toBeNull();
  });

  test('markFired keeps the FIRST fire time', () => {
    setSystemTime(new Date('2026-07-11T12:00:00Z'));
    requestScrollToMessage('topic-1', 'msg-a');
    markScrollToMessageFired('topic-1');
    setSystemTime(new Date('2026-07-11T12:00:01.900Z'));
    markScrollToMessageFired('topic-1'); // re-fire must NOT extend the grace
    setSystemTime(new Date('2026-07-11T12:00:02.100Z'));
    expect(peekScrollToMessage('topic-1')).toBeNull();
  });

  test('markFired on an unknown topic is a no-op', () => {
    markScrollToMessageFired('topic-ghost');
    expect(peekScrollToMessage('topic-ghost')).toBeNull();
  });
});

/**
 * La guardia attorno al dispatch: chiede la CAPACITÀ, non l'esistenza.
 *
 * Il file, da solo, non ha `window` e la guardia non scatta mai — cioè il caso
 * che qui conta non veniva provato da nessuno. Ma sette file in
 * `client/src/lib/*.test.ts` installano su globalThis una `window` FINTA e
 * parziale (e non sempre la tolgono), quindi in una stessa esecuzione di `bun
 * test` questo modulo poteva trovarsi un `window` senza `dispatchEvent`:
 * `typeof window !== 'undefined'` passava e la chiamata dopo lanciava. Il
 * risultato dipendeva da QUALI file giravano insieme — la suite intera verde,
 * `bun test ./client/src/lib ./client/src/state` rossa.
 *
 * Qui la `window` finta se la installa (e se la toglie) questo file, così la
 * copertura non dipende più dall'ordine.
 */
describe('scrollToMessage — la guardia sul dispatch', () => {
  const g = globalThis as { window?: unknown };

  beforeEach(() => {
    setSystemTime();
    _clearAllScrollTargets();
  });
  afterEach(() => {
    delete g.window; // MAI lasciare in giro la finta: è così che nasce il rosso a composizione.
  });

  test('con un window PARZIALE (niente dispatchEvent) registra lo stesso, senza lanciare', () => {
    g.window = { location: { href: 'https://x.test/' } };
    expect(() => requestScrollToMessage('topic-1', 'msg-a')).not.toThrow();
    expect(peekScrollToMessage('topic-1')).toBe('msg-a');
  });

  test('con un window che sa dispatchare, l’evento parte col topicId', () => {
    const seen: { type: string; topicId?: string }[] = [];
    g.window = {
      dispatchEvent: (e: CustomEvent<{ topicId?: string }>) => {
        seen.push({ type: e.type, topicId: e.detail?.topicId });
        return true;
      },
    };
    requestScrollToMessage('topic-1', 'msg-a');
    expect(seen).toEqual([{ type: SCROLL_TO_MESSAGE_EVENT, topicId: 'topic-1' }]);
    expect(peekScrollToMessage('topic-1')).toBe('msg-a');
  });
});
