/**
 * @covers DISPENV-01
 *
 * THE BOARD'S ENVELOPE IS NOT A BUBBLE YOU WROTE.
 *
 * The kickoff, the resume and the nudge reach the transcript as `user` rows
 * (the only role a provider answers). Drawn as bubbles they put three hundred
 * lines of instructions in the person's mouth, on the right, with an "edit"
 * button on hover - and 411 kickoffs plus 1,033 resumes sat there on the live
 * DB. The row now carries a `dispatched-envelope` block, and this proves the
 * two halves of the rule: the reader picks it out of the blocks, and the
 * renderer draws a service line instead of the bubble.
 *
 * `renderToStaticMarkup` (no DOM in this repo): the assertion is on the markup,
 * which is what the E2E locators read.
 *
 * @covers CHAT-USERROW-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isDispatchedEnvelope } from './dispatchedEnvelope';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage, Topic } from '../../types';

describe('isDispatchedEnvelope', () => {
  test('reads the mark, and only that one', () => {
    expect(isDispatchedEnvelope([{ kind: 'dispatched-envelope' }])).toBe(true);
    expect(isDispatchedEnvelope([{ kind: 'text', text: 'ciao' }])).toBe(false);
    expect(isDispatchedEnvelope([])).toBe(false);
    expect(isDispatchedEnvelope(undefined)).toBe(false);
    expect(isDispatchedEnvelope(null)).toBe(false);
  });

  test('it survives beside another mark: the goal loop can send an envelope too', () => {
    expect(isDispatchedEnvelope([{ kind: 'goal-nudge', attempt: 2 }, { kind: 'dispatched-envelope' }])).toBe(true);
  });
});

const topic = { id: 't1', name: 'x', sessionKey: 'topic:x' } as Topic;
const noop = () => {};

function markup(msg: Partial<ChatMessage>): string {
  const full = {
    id: 'm1', role: 'user', content: 'You are the exclusive owner of task 4a554ee3 on this Kanban board.',
    timestamp: '2026-09-04T10:00:00.000Z', ...msg,
  } as ChatMessage;
  return renderToStaticMarkup(
    <MessageBubble
      msg={full} idx={0} topic={topic} copiedMsgId={null} isCompact={false} fontSize={14}
      isMobile={false} onReply={noop} onCopy={noop} onTogglePin={noop} onEdit={noop}
    />,
  );
}

describe('the envelope row', () => {
  test('a marked row is a service line, not a user bubble', () => {
    const html = markup({ blocks: [{ kind: 'dispatched-envelope' }] });
    expect(html).toContain('data-testid="dispatch-envelope-row"');
    // The bubble, and with it the whole hover toolbar, is not rendered at all.
    expect(html).not.toContain('data-testid="chat-message"');
    expect(html).not.toContain('data-role="user"');
  });

  test('collapsed, but openable: the resume quotes the human inside it', () => {
    const html = markup({ blocks: [{ kind: 'dispatched-envelope' }] });
    expect(html).toContain('data-testid="dispatch-envelope-toggle"');
    // Folded by default: the text is not in the markup until you ask for it.
    expect(html).not.toContain('exclusive owner');
  });

  test('the same text WITHOUT the mark is still a bubble', () => {
    // The half that makes the mark mean something: an unmarked row is the
    // person speaking, and nothing about this change touches it.
    const html = markup({});
    expect(html).toContain('data-testid="chat-message"');
    expect(html).not.toContain('data-testid="dispatch-envelope-row"');
  });
});
