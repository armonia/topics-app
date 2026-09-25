/**
 * The background notice is a service line on every surface: it is not the
 * chat's last word, it raises no banner, and a card's session draws it instead
 * of an empty «session details» row (second review of 25/09).
 * @covers MONITOR-02
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { backgroundNoticeOf, lastConversationMessage } from './machineRow';
import { BackgroundNoticeLine } from './BackgroundNoticeLine';
import { taskSessionSegments } from '../Board/taskSessionPresentation';
import { decideMessageBanner } from '../../lib/notify/messageBanner';
import type { ChatMessage } from '../../types';

const text = 'Background work closed with a turn that was stuck: sleep 600.';
const notice = {
  id: 'n1', role: 'assistant', content: '', timestamp: '2026-09-25T10:00:00.000Z',
  blocks: [{ kind: 'background-notice', event: 'closed', tasks: ['sleep 600'], why: 'stuck-turn', text }],
} as unknown as ChatMessage;
const person = { id: 'u1', role: 'user', content: 'continua', timestamp: '2026-09-25T09:59:00.000Z' } as ChatMessage;

describe('the background notice as a service line', () => {
  test('the chat\'s last word is the message before it, so an unanswered message still shows as one', () => {
    expect(lastConversationMessage([person, notice])).toBe(person);
    expect(lastConversationMessage([notice])).toBeUndefined();
  });

  test('it raises no OS banner', () => {
    const base = {
      topicId: 't', role: 'assistant' as const, visibilityState: 'hidden' as const, notificationsEnabled: true, isOwnStream: false,
      body: text, topicName: 'chat', muted: false, agentWorking: false, lastFiredAt: undefined, now: Date.now(),
    };
    expect(decideMessageBanner(base)).not.toBeNull();
    expect(decideMessageBanner({ ...base, backgroundNotice: !!backgroundNoticeOf(notice.blocks) })).toBeNull();
  });

  test('a card\'s session keeps it in view, not folded into an empty details row', () => {
    expect(taskSessionSegments(notice).map((s) => s.folded)).toEqual([false]);
  });

  test('the line names the closed work and why', () => {
    const html = renderToStaticMarkup(<BackgroundNoticeLine notice={backgroundNoticeOf(notice.blocks)!} />);
    expect(html).toContain('data-background-notice="closed:stuck-turn"');
    expect(html).toContain('sleep 600');
  });
});
