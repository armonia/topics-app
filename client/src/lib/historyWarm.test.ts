/**
 * A history read started ahead of its caller (`chatApi.warmHistory`, fired by
 * the palette in the Enter task) is adopted by the `getHistory` that the chat
 * pane issues once it mounts: one request, started earlier, not two.
 *
 * @covers CMD-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chatApi } from './api';
import { HISTORY_FIRST_PAGE } from '../../../shared/history-paging';

const REAL_FETCH = globalThis.fetch;
let requests: { url: string; body: string }[];
let streaming: boolean;

beforeEach(() => {
  requests = [];
  streaming = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify({ messages: [], isStreaming: streaming, n: requests.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const historyRequests = () => requests.filter((r) => r.url.includes('/history/'));

describe('chatApi.warmHistory', () => {
  test('the pane read adopts the warm read: one request, sent at warm time', async () => {
    chatApi.warmHistory('topic:warm-1');
    expect(historyRequests()).toHaveLength(1); // left synchronously, in the caller's task
    const r = await chatApi.getHistory('topic:warm-1', { limit: HISTORY_FIRST_PAGE });
    expect(historyRequests()).toHaveLength(1);
    expect((r as unknown as { n: number }).n).toBe(1);
  });

  test('it is adopted once: the next read goes to the server again', async () => {
    chatApi.warmHistory('topic:warm-2');
    await chatApi.getHistory('topic:warm-2', { limit: HISTORY_FIRST_PAGE });
    await chatApi.getHistory('topic:warm-2', { limit: HISTORY_FIRST_PAGE });
    expect(historyRequests()).toHaveLength(2);
  });

  test('a read with different arguments is not served by it', async () => {
    chatApi.warmHistory('topic:warm-3');
    await chatApi.getHistory('topic:warm-3', { limit: 5 });
    expect(historyRequests()).toHaveLength(2);
  });

  test('a warm answer taken while a turn was running is not adopted', async () => {
    streaming = true;
    chatApi.warmHistory('topic:warm-4');
    await chatApi.getHistory('topic:warm-4', { limit: HISTORY_FIRST_PAGE });
    expect(historyRequests()).toHaveLength(2);
  });

  test('two warms in a row send one request', () => {
    chatApi.warmHistory('topic:warm-5');
    chatApi.warmHistory('topic:warm-5');
    expect(historyRequests()).toHaveLength(1);
  });
});
