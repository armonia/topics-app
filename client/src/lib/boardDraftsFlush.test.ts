/**
 * Board drafts leave the page with it.
 *
 * The composer draft and the per-task drafts are PUT to ui-state after an
 * 800 ms debounce. A reload or a closed window does not wait for that timer,
 * so the text typed since the last pause was lost. `flushBoardDrafts` (wired to
 * pagehide and to visibilitychange hidden) sends what is queued at once, with
 * `keepalive`, and leaves nothing armed to send it a second time.
 *
 * WebKit refuses a keepalive request once the bodies of the keepalive requests
 * in flight pass 64 KiB, counted in BYTES: a draft past that budget must go out
 * as a plain PUT, not as a keepalive fetch the engine rejects.
 *
 * @covers KANBAN-02
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { boardDrafts } from './board';
import { flushBoardDrafts, uiPutDebounced } from './boardDraftsIO';

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

describe('the keepalive budget is counted in bytes, over the requests in flight', () => {
  test('a draft short in characters but long in UTF-8 bytes is not sent keepalive', () => {
    // 40,000 characters, 80,000 bytes: under the budget by .length, over it by bytes.
    uiPutDebounced('budget-test-accents', { text: '\u00e9'.repeat(40_000) });
    flushBoardDrafts();
    const sent = puts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.length).toBeLessThan(60_000);
    expect(sent[0].keepalive).toBe(false);
  });

  test('two drafts that each fit but not together: the second one goes out plain', async () => {
    const release: Array<() => void> = [];
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        keepalive: init?.keepalive === true,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Promise<Response>((resolve) => release.push(() => resolve(new Response('{}'))));
    }) as typeof fetch;

    uiPutDebounced('budget-test-a', { text: 'a'.repeat(40_000) });
    uiPutDebounced('budget-test-b', { text: 'b'.repeat(40_000) });
    flushBoardDrafts();
    expect(puts().map((c) => c.keepalive)).toEqual([true, false]);

    // Once the first request settles its bytes are free again.
    for (const r of release) r();
    await wait(0);
    uiPutDebounced('budget-test-c', { text: 'c'.repeat(40_000) });
    flushBoardDrafts();
    expect(puts()[2].keepalive).toBe(true);
    for (const r of release) r();
  });
});

describe('the page-exit wiring', () => {
  type Listener = () => void;
  const REAL_WINDOW = (globalThis as { window?: unknown }).window;
  const REAL_DOCUMENT = (globalThis as { document?: unknown }).document;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = REAL_WINDOW;
    (globalThis as { document?: unknown }).document = REAL_DOCUMENT;
  });

  // A fresh copy of the module, loaded against a window and a document whose
  // listeners the test can fire: the copy above was loaded without a DOM.
  async function loadWired() {
    const onWindow = new Map<string, Listener>();
    const onDocument = new Map<string, Listener>();
    const doc = { visibilityState: 'visible', addEventListener: (n: string, h: Listener) => onDocument.set(n, h) };
    (globalThis as { window?: unknown }).window = { addEventListener: (n: string, h: Listener) => onWindow.set(n, h) };
    (globalThis as { document?: unknown }).document = doc;
    const io = await import(`./boardDraftsIO?wiring=${Math.random()}`) as typeof import('./boardDraftsIO');
    return { io, onWindow, onDocument, doc };
  }

  test('pagehide sends the queued draft at once, with keepalive', async () => {
    const { io, onWindow } = await loadWired();
    io.uiPutDebounced('wiring-pagehide', { text: 'typed before the tab closed' });
    expect(puts()).toHaveLength(0);
    onWindow.get('pagehide')?.();
    expect(puts().map((c) => [c.url, c.keepalive])).toEqual([['/api/ui-state/wiring-pagehide', true]]);
  });

  test('visibilitychange to hidden sends it too, and visible does not', async () => {
    const { io, onDocument, doc } = await loadWired();
    io.uiPutDebounced('wiring-hidden', { text: 'typed before switching app' });
    onDocument.get('visibilitychange')?.();
    expect(puts()).toHaveLength(0);
    doc.visibilityState = 'hidden';
    onDocument.get('visibilitychange')?.();
    expect(puts().map((c) => [c.url, c.keepalive])).toEqual([['/api/ui-state/wiring-hidden', true]]);
  });
});
