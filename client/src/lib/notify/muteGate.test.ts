/**
 * Whether a topic is muted — the one gate that decides the interruption and
 * never the count.
 *
 * @covers MUTE-01
 */
import { describe, it, expect } from 'bun:test';
import { isTopicMuted } from './muteGate';
import type { Topic } from '../../types';

function topic(over: Partial<Topic> = {}): Topic {
  return {
    id: 't1', name: 'T', slug: 't', parentId: null, links: [],
    sessionKey: 'topic:t1', color: '#fff', icon: '', createdAt: '', updatedAt: '',
    archived: false, ...over,
  };
}

describe('isTopicMuted', () => {
  it('not muted by default', () => {
    expect(isTopicMuted(topic(), [])).toBe(false);
  });

  it('per-topic mute silences it', () => {
    expect(isTopicMuted(topic({ muted: true }), [])).toBe(true);
  });

  it('per-project mute silences every topic in that project', () => {
    const t = topic({ projectPath: '/work/app' });
    expect(isTopicMuted(t, ['/work/app'])).toBe(true);
    expect(isTopicMuted(t, ['/work/elsewhere'])).toBe(false);
  });

  it('a topic with no projectPath ignores project mutes', () => {
    expect(isTopicMuted(topic(), ['/work/app'])).toBe(false);
  });

  it('either source is enough (topic muted even if project is not)', () => {
    expect(isTopicMuted(topic({ muted: true, projectPath: '/x' }), ['/y'])).toBe(true);
  });

  it('fails open: unknown topic / missing list are not muted', () => {
    expect(isTopicMuted(undefined, ['/work/app'])).toBe(false);
    expect(isTopicMuted(null, undefined)).toBe(false);
    expect(isTopicMuted(topic({ projectPath: '/work/app' }), undefined)).toBe(false);
  });
});
