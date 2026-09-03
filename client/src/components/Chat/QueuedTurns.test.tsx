/**
 * AN IDLE QUEUE HAS A SEND BUTTON.
 *
 * The send-now button was rendered only while a turn was in flight (`busy`), on the
 * theory that it exists to cut a running turn short. But a queue can be idle
 * for reasons that are not a choice: the turn it waited for ended while this
 * window was not listening (reload, relaunch, socket lost for a second). Then
 * the dashed bubbles sat there with no control that could fire them, and the
 * user had to copy the text, delete the bubble and retype it.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo): the assertion is
 * on the markup, which is what the E2E locator `queue-send-now` looks for.
 *
 * @covers CHAT-QUEUE-04
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueuedTurns } from './QueuedTurns';
import type { QueuedTurn } from '../../state/chatQueue';

const turns: QueuedTurn[] = [{ id: 'q1', content: 'e poi i test', queuedAt: '2026-09-03T15:00:00.000Z' }];
const noop = () => {};

describe('the send-now control of the queue', () => {
  test('is there while a turn runs, and promises to stop it', () => {
    const html = renderToStaticMarkup(<QueuedTurns turns={turns} isMobile={false} onSendNow={noop} busy />);
    expect(html).toContain('data-testid="queue-send-now"');
    expect(html).toContain('data-queue-busy="true"');
  });

  test('is STILL there when nothing runs: the stranded queue needs a way out', () => {
    const html = renderToStaticMarkup(<QueuedTurns turns={turns} isMobile={false} onSendNow={noop} busy={false} />);
    // Before the fix this markup had no button at all.
    expect(html).toContain('data-testid="queue-send-now"');
    expect(html).toContain('data-queue-busy="false"');
  });

  test('is absent without a handler, and with an empty queue', () => {
    expect(renderToStaticMarkup(<QueuedTurns turns={turns} isMobile={false} />)).not.toContain('queue-send-now');
    expect(renderToStaticMarkup(<QueuedTurns turns={[]} isMobile={false} onSendNow={noop} />)).toBe('');
  });
});
