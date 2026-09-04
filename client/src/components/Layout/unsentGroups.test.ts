/**
 * The banner's two pure decisions: which rows exist (one per chat, named after
 * the topic) and what the preview line says. Both used to be absent: the pill
 * only knew a global count.
 */
import { describe, expect, it } from 'bun:test';
import { groupUnsentBySession, previewLine, type UnsentMessage } from './unsentGroups';
import type { Topic } from '@/types';

const topic = (id: string, name: string, sessionKey: string) =>
  ({ id, name, sessionKey } as unknown as Topic);

const msg = (sessionKey: string, content: string): UnsentMessage => ({
  sessionKey,
  content,
  timestamp: '2026-09-04T10:00:00.000Z',
});

describe('groupUnsentBySession', () => {
  const topics = {
    a: topic('a', 'Prima chat', 'session-a'),
    b: topic('b', 'Seconda chat', 'session-b'),
  };

  it('makes one row per chat, named after the topic', () => {
    const groups = groupUnsentBySession(
      [msg('session-a', 'uno'), msg('session-b', 'due'), msg('session-a', 'tre')],
      topics,
    );
    expect(groups.map((g) => [g.name, g.topicId, g.items.length])).toEqual([
      ['Prima chat', 'a', 2],
      ['Seconda chat', 'b', 1],
    ]);
  });

  it('still lists a session whose topic is gone, without a name', () => {
    const groups = groupUnsentBySession([msg('session-z', 'orfano')], topics);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBeUndefined();
    expect(groups[0].topicId).toBeUndefined();
  });

  it('has no rows when nothing is unsent', () => {
    expect(groupUnsentBySession([], topics)).toEqual([]);
  });
});

describe('previewLine', () => {
  it('collapses whitespace to a single line', () => {
    expect(previewLine('due\n  righe')).toBe('due righe');
  });

  it('truncates past the limit', () => {
    expect(previewLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
