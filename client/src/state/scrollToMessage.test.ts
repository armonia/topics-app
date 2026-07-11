/**
 * Tests for the palette→MessageList jump-target store (pure core: the
 * window event dispatch is guarded out under bun:test).
 *
 *   - register → peek returns the id without consuming it;
 *   - consume drops the target;
 *   - a later register for the same topic overwrites the earlier one;
 *   - targets expire after the TTL (stale hits can't hijack later visits).
 */
import { describe, test, expect, beforeEach, setSystemTime } from 'bun:test';
import {
  requestScrollToMessage,
  peekScrollToMessage,
  consumeScrollToMessage,
  markScrollToMessageFired,
  _clearAllScrollTargets,
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
