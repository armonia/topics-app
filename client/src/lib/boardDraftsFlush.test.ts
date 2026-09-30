/**
 * Board drafts leave the page with it.
 *
 * The composer draft and the per-task drafts are PUT to ui-state after an
 * 800 ms debounce. A reload or a closed window does not wait for that timer,
 * so the text typed since the last pause was lost. `flushBoardDrafts` (wired to
 * pagehide and to visibilitychange hidden) sends what is queued at once, with
 * `keepalive`, and leaves nothing armed to send it a second time.
 *
 * @covers KANBAN-02
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { boardDrafts } from './board';
import { flushBoardDrafts } from './boardDraftsIO';

type Call = { url: string; method: string; keepalive: boolean; body: string };

const REAL_FETCH = globalThis.fetch;
let calls: Call[];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      keepalive: init?.keepalive === true,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify({ value: null }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  flushBoardDrafts();
  globalThis.fetch = REAL_FETCH;
});

const puts = () => calls.filter((c) => c.method === 'PUT');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('flushBoardDrafts', () => {
  test('sends every queued draft now, with keepalive', () => {
    boardDrafts.putTaskDraft('task-flush-1', 'typed just before reload');
    boardDrafts.putComposer({ text: 'composer text', model: null, prio: null, planFirst: false });
    expect(puts()).toHaveLength(0); // still inside the debounce

    flushBoardDrafts();

    const sent = puts();
    expect(sent.map((c) => c.url).sort()).toEqual([
      '/api/ui-state/board-composer-draft',
      '/api/ui-state/board-task-drafts',
    ]);
    expect(sent.every((c) => c.keepalive)).toBe(true);
    expect(sent.find((c) => c.url.endsWith('board-task-drafts'))!.body).toContain('typed just before reload');
  });

  test('a flushed draft is not sent a second time when its timer would have fired', async () => {
    boardDrafts.putTaskDraft('task-flush-2', 'once');
    flushBoardDrafts();
    expect(puts()).toHaveLength(1);
    await wait(900);
    expect(puts()).toHaveLength(1);
  });

  test('with nothing queued it sends nothing', () => {
    flushBoardDrafts();
    expect(calls).toHaveLength(0);
  });

  test('without a flush the debounce still decides, and the PUT is a normal one', async () => {
    boardDrafts.putTaskDraft('task-flush-3', 'debounced');
    await wait(900);
    const sent = puts();
    expect(sent).toHaveLength(1);
    expect(sent[0].keepalive).toBe(false);
  });
});
