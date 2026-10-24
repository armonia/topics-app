/**
 * @covers USAGE-02
 *
 * The cost chip under a message splits the measured cost into "cache" and "the
 * rest" with the cache-read rate of THE MESSAGE'S MODEL: 0.05x on Opus 5.5, 0.1x
 * where the model is unknown. The bubble has to hand the model down on both of
 * its footers, the finished one and the one under a turn stopped on a question:
 * without it the waiting footer split at 0.1 while the finished footer of the
 * same turn split at 0.05.
 *
 * `renderToStaticMarkup` (no DOM in this repo): the split is read off the chip's
 * title, which is what a person reads on hover.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage, Topic } from '../../types';

const topic = { id: 't1', name: 'x', sessionKey: 'topic:x' } as Topic;
const noop = () => {};

/** A cache-heavy Opus 5.5 turn: 900k of its 1M prompt tokens read from the cache. */
const usage: Partial<ChatMessage> = {
  role: 'assistant', content: 'ok', model: 'claude-opus-5-5',
  usagePromptTokens: 1_000_000, cacheReadTokens: 900_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
  usageCompletionTokens: 1_000, costCents: 100, latencyMs: 4_000,
};

function markup(msg: Partial<ChatMessage>): string {
  const full = { id: 'msg-1', timestamp: '2026-10-24T10:00:00.000Z', ...msg } as ChatMessage;
  return renderToStaticMarkup(
    <MessageBubble
      msg={full} idx={1} topic={topic} copiedMsgId={null} isCompact={false} fontSize={14}
      isMobile={false} onReply={noop} onCopy={noop} onTogglePin={noop} onEdit={noop} isLast
    />,
  );
}

describe('the cost split uses the message model', () => {
  test('finished turn: Opus 5.5 reads at 0.05x', () => {
    const html = markup(usage);
    expect(html).toContain('×0,05');
    expect(html).toContain('Modello: claude-opus-5-5');
  });

  test('a turn stopped on a question: the waiting footer splits at the same rate', () => {
    const html = markup({
      ...usage,
      partial: true,
      toolCalls: [{ id: 'ask-1', name: 'AskUserQuestion', args: {}, status: 'waiting_for_input' }],
    } as Partial<ChatMessage>);
    expect(html).toContain('lavorato');
    expect(html).toContain('×0,05');
    expect(html).toContain('Modello: claude-opus-5-5');
  });

  test('without a model the split falls back to 0.1x', () => {
    const html = markup({ ...usage, model: undefined });
    expect(html).toContain('×0,1)');
  });
});
