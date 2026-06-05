import { describe, expect, test } from 'bun:test';
import { recommendSessionAction, selectAutopilotClosures, type BoardSession } from './agentBoard';

const s = (p: Partial<BoardSession> & { topicId: string }): BoardSession =>
  ({ name: p.topicId, state: 'idle', ...p });

describe('recommendSessionAction', () => {
  test('update → open (unsafe)', () => {
    expect(recommendSessionAction(s({ topicId: 'a', state: 'update', unread: 1 })))
      .toEqual({ action: 'open', reason: 'nuova risposta da leggere', safe: false });
  });
  test('streaming → none', () => {
    expect(recommendSessionAction(s({ topicId: 'a', state: 'streaming' })).action).toBe('none');
  });
  test('waiting → none', () => {
    expect(recommendSessionAction(s({ topicId: 'a', state: 'waiting' })).action).toBe('none');
  });
  test('idle, read → close (safe)', () => {
    const r = recommendSessionAction(s({ topicId: 'a', state: 'idle', unread: 0 }));
    expect(r.action).toBe('close');
    expect(r.safe).toBe(true);
  });
  test('idle with unread → open (unsafe)', () => {
    const r = recommendSessionAction(s({ topicId: 'a', state: 'idle', unread: 2 }));
    expect(r).toEqual({ action: 'open', reason: '2 non letti', safe: false });
  });
  test('empty → close (safe)', () => {
    expect(recommendSessionAction(s({ topicId: 'a', state: 'empty' })).safe).toBe(true);
  });
});

describe('selectAutopilotClosures', () => {
  const now = 1_000_000_000_000;
  const old = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
  const recent = new Date(now - 60 * 1000).toISOString();   // 1m ago

  test('auto-closes safe idle sessions older than threshold', () => {
    const out = selectAutopilotClosures([
      s({ topicId: 'old-idle', state: 'idle', lastAt: old }),
      s({ topicId: 'recent-idle', state: 'idle', lastAt: recent }),
    ], { now });
    expect(out.map((x) => x.topicId)).toEqual(['old-idle']);
  });

  test('never auto-closes update/streaming/waiting/unread', () => {
    const out = selectAutopilotClosures([
      s({ topicId: 'u', state: 'update', unread: 1, lastAt: old }),
      s({ topicId: 'st', state: 'streaming', lastAt: old }),
      s({ topicId: 'w', state: 'waiting', lastAt: old }),
      s({ topicId: 'idle-unread', state: 'idle', unread: 3, lastAt: old }),
    ], { now });
    expect(out).toEqual([]);
  });

  test('empty sessions are eligible immediately (no lastAt needed)', () => {
    const out = selectAutopilotClosures([s({ topicId: 'e', state: 'empty' })], { now });
    expect(out.map((x) => x.topicId)).toEqual(['e']);
  });

  test('idle with no lastAt is left alone (unknown age)', () => {
    const out = selectAutopilotClosures([s({ topicId: 'x', state: 'idle', lastAt: null })], { now });
    expect(out).toEqual([]);
  });

  test('respects custom minIdleMs', () => {
    const out = selectAutopilotClosures(
      [s({ topicId: 'r', state: 'idle', lastAt: recent })],
      { now, minIdleMs: 30 * 1000 }, // 30s threshold → 1m-old qualifies
    );
    expect(out.map((x) => x.topicId)).toEqual(['r']);
  });
});
