/**
 * The WS bridge's routing for the per-topic browser window.
 *
 * `topic:archived` is two events on the wire: the server sends it with
 * `archived: true` when it has just deleted the `topic-browser:<topicId>` row,
 * and with `archived: false` to unarchive a topic, from a bulk unarchive and
 * when it repairs a coordinator. Only the first may forget the window. Nothing
 * tested the handler before, so dropping the whole branch, or the condition,
 * stayed green.
 *
 * The store is reached through `import()` (it is kept out of the entry chunk),
 * so every routed frame returns the promise of its application and the tests
 * await it instead of guessing a delay.
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { WSMessage } from '../types';
import { routeTaskBrowserFrame } from './useTaskBrowserTabsSync';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  applyRemoteTopicWindow,
  getTopicWindow,
  subscribeTopicWindows,
  topicBrowserWindow,
  __resetTopicWindows,
} from '../state/topicBrowserWindow';

const REAL_FETCH = globalThis.fetch;
let puts: { key: string; body: { minPos?: unknown; tabs?: { contextId: string }[] } }[];

beforeEach(() => {
  puts = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'PUT') {
      puts.push({ key: decodeURIComponent(String(url).replace('/api/ui-state/', '')), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    }
    return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  __resetTopicWindows();
});

let seq = 0;
const uniqueId = (tag: string) => `topic-bridge-${tag}-${seq++}`;

/** Past the store's 800 ms write debounce. */
const pastTheDebounce = () => new Promise((r) => setTimeout(r, 1000));

const savedWindow = {
  mode: 'min',
  tabs: [
    { contextId: 'a', url: 'https://a.test', title: 'A' },
    { contextId: 'b', url: 'https://b.test', title: 'B' },
  ],
  activeContextId: 'b',
};

const archivedFrame = (topicId: string, archived: boolean) =>
  ({ type: 'topic:archived', topic: { id: topicId, archived, provider: 'codex' } }) as unknown as WSMessage;

describe('topic:archived reaches the topic window only when the topic IS archived', () => {
  test('archived: the queued PUT is cancelled and the cache is forgotten', async () => {
    const tid = uniqueId('archived');
    topicBrowserWindow.open(tid, { contextId: 'a', url: 'https://a.test' });
    await routeTaskBrowserFrame(archivedFrame(tid, true));
    await pastTheDebounce();
    expect(puts).toHaveLength(0);
    expect(getTopicWindow(tid)).toEqual(EMPTY_TOPIC_BROWSER_WINDOW);
  });

  test('NOT archived (unarchive, coordinator repair): a queued move still lands, sheets intact', async () => {
    const tid = uniqueId('move-kept');
    applyRemoteTopicWindow(tid, savedWindow);
    topicBrowserWindow.move(tid, { right: 40, bottom: 60 });
    await routeTaskBrowserFrame(archivedFrame(tid, false));
    await pastTheDebounce();
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe(`topic-browser:${tid}`);
    expect(puts[0].body.minPos).toEqual({ right: 40, bottom: 60 });
    expect(puts[0].body.tabs?.map((t) => t.contextId)).toEqual(['a', 'b']);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['a', 'b']);
  });

  test('NOT archived, nothing queued: the saved window is not touched and nobody is notified', async () => {
    const tid = uniqueId('untouched');
    applyRemoteTopicWindow(tid, savedWindow);
    let notified = 0;
    const unsub = subscribeTopicWindows(() => { notified++; });
    await routeTaskBrowserFrame(archivedFrame(tid, false));
    unsub();
    expect(notified).toBe(0);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['a', 'b']);
  });
});

describe('a topic-browser frame goes to the lazily loaded store', () => {
  test('ui-state:updated on a topic-browser key is applied to that topic window', async () => {
    const tid = uniqueId('updated');
    const frame = {
      type: 'ui-state:updated',
      key: `topic-browser:${tid}`,
      value: savedWindow,
      sourceClientId: 'another-client',
    } as unknown as WSMessage;
    await routeTaskBrowserFrame(frame);
    expect(getTopicWindow(tid).tabs.map((t) => t.contextId)).toEqual(['a', 'b']);
  });
});
