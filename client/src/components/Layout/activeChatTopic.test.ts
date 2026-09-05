/**
 * Who the strip above the tab bar speaks for.
 *
 * The strip moved out of the transcript and into the chrome, so it no longer
 * inherits its topic from the component it was nested in: it has to read the
 * active tab. The two answers that matter are the negative ones - a terminal
 * or a browser tab has no topic, and a draft chat has no topic id yet - since
 * both would otherwise leave the previous chat's files on screen.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect } from 'bun:test';
import { activeChatTopicId } from './activeChatTopic';
import type { Pane } from '../../state/pane/types';

const chat: Pane = { id: 'p1', type: 'chat', topicId: 't1' };
const draft: Pane = { id: 'p2', type: 'chat' };
const terminal: Pane = { id: 'p3', type: 'terminal' };

describe('activeChatTopicId', () => {
  test('the active chat tab names its topic', () => {
    expect(activeChatTopicId([chat, terminal], 'p1')).toBe('t1');
  });

  test('a non-chat tab in front means the strip says nothing', () => {
    expect(activeChatTopicId([chat, terminal], 'p3')).toBeUndefined();
  });

  test('a draft chat has no topic yet', () => {
    expect(activeChatTopicId([draft], 'p2')).toBeUndefined();
  });

  test('no active tab, and an id that matches no tab, are both silence', () => {
    expect(activeChatTopicId([chat], null)).toBeUndefined();
    expect(activeChatTopicId([chat], 'gone')).toBeUndefined();
  });
});
