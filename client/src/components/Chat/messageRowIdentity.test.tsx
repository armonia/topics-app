/**
 * @covers CHAT-02
 *
 * A chat row carries its own identity (`data-message-id`), independent of the
 * position Virtuoso stamps on it (`data-item-index`). The virtual-scroll e2e
 * (CROSS-04) reads positions off this attribute because the absolute index
 * stopped equalling the message position when the list adopted `firstItemIndex`
 * (CHAT-HIST-01, 05aec7f11): without it the test has no stable coordinate.
 *
 * `renderToStaticMarkup` (no DOM in this repo): the assertion is on the markup,
 * which is what the E2E locators read.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage, Topic } from '../../types';

const topic = { id: 't1', name: 'x', sessionKey: 'topic:x' } as Topic;
const noop = () => {};

function markup(msg: Partial<ChatMessage>): string {
  const full = {
    id: 'msg-7', role: 'user', content: 'hello',
    timestamp: '2026-10-12T10:00:00.000Z', ...msg,
  } as ChatMessage;
  return renderToStaticMarkup(
    <MessageBubble
      msg={full} idx={7} topic={topic} copiedMsgId={null} isCompact={false} fontSize={14}
      isMobile={false} onReply={noop} onCopy={noop} onTogglePin={noop} onEdit={noop}
    />,
  );
}

describe('message row identity', () => {
  test('a plain bubble stamps its own message id', () => {
    const html = markup({});
    expect(html).toContain('data-testid="chat-message"');
    expect(html).toContain('data-message-id="msg-7"');
  });

  test('the stamped id follows the message, not the position', () => {
    const html = markup({ id: 'msg-1199' });
    expect(html).toContain('data-message-id="msg-1199"');
  });
});
