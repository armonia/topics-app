/**
 * Which chats count as "on screen", the fact that decides whether an unsent
 * message is shown in its chat's strip or in the band. The count matters: the
 * same chat open in two visible panes must stay claimed until BOTH strips go,
 * or closing one pane would list the other's message twice.
 *
 * @covers CHAT-QUEUE-06
 */
import { describe, expect, it } from 'bun:test';
import { claimOnScreen, groupBySession, onScreenSessions } from './unsentMessages';

describe('claimOnScreen', () => {
  it('holds a session until every claim on it is released', () => {
    const releaseA = claimOnScreen('s1');
    const releaseB = claimOnScreen('s1');
    expect(onScreenSessions().has('s1')).toBe(true);
    releaseA();
    expect(onScreenSessions().has('s1')).toBe(true);
    // Releasing twice is a no-op, not a second decrement.
    releaseA();
    expect(onScreenSessions().has('s1')).toBe(true);
    releaseB();
    expect(onScreenSessions().has('s1')).toBe(false);
  });
});

describe('groupBySession', () => {
  it('keeps first-seen order of sessions and queue order inside each', () => {
    const grouped = groupBySession([
      { sessionKey: 'b', content: '1' },
      { sessionKey: 'a', content: '2' },
      { sessionKey: 'b', content: '3' },
    ]);
    expect([...grouped.keys()]).toEqual(['b', 'a']);
    expect(grouped.get('b')?.map((m) => m.content)).toEqual(['1', '3']);
  });
});
