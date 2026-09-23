/**
 * @covers LINK-TAB-01
 *
 * The link router: what opens a tab inside Topics, what leaves for the system
 * browser, and what a link is NEVER allowed to do (nothing at all).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  openLink,
  isExternalLinkGesture,
  OPEN_TAB_EVENT,
  resetOpenLinkDedupeForTest,
  type OpenTabDetail,
} from './openLink';
import { registerTopicWindowDoor } from './topicWindowDoor';

let opened: string[] = [];
let claim = true;
let seen: OpenTabDetail[] = [];
let now = 0;
const realDateNow = Date.now;
// Pinned at import: `bun test` runs every file in one process, and a file that
// stubs `CustomEvent` without putting it back turns the dispatch below into
// "Argument 1 ('event') to EventTarget.dispatchEvent must be an instance of
// Event". Seen only in CI, where the file order differs from a local run.
let customEventBefore: unknown;

beforeEach(() => {
  customEventBefore = globalThis.CustomEvent;
  if (!(new (globalThis.CustomEvent)('probe') instanceof Event)) {
    (globalThis as { CustomEvent: unknown }).CustomEvent = class extends Event {
      detail: unknown;
      constructor(type: string, init?: CustomEventInit) { super(type, init); this.detail = init?.detail; }
    };
  }
  opened = [];
  seen = [];
  claim = true;
  now = 2_000_000;
  Date.now = () => now;
  const bus = new EventTarget();
  bus.addEventListener(OPEN_TAB_EVENT, (e) => {
    seen.push((e as CustomEvent<OpenTabDetail>).detail);
    if (claim) e.preventDefault();
  });
  (globalThis as unknown as { window: unknown }).window = {
    open: (u: string) => opened.push(u),
    location: { origin: 'https://app.test' },
    dispatchEvent: (e: Event) => bus.dispatchEvent(e),
  };
  resetOpenLinkDedupeForTest();
});

afterEach(() => {
  (globalThis as { CustomEvent: unknown }).CustomEvent = customEventBefore;
  Date.now = realDateNow;
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('a plain click asks for a tab inside Topics, not the system browser', () => {
  openLink('https://x.test/page', { topicId: 't1' });
  expect(seen.map((d) => d.url)).toEqual(['https://x.test/page']);
  expect(seen[0]!.topicId).toBe('t1');
  expect(opened).toEqual([]);
});

/**
 * @covers TOPIC-BROWSER-04
 * The chat of a topic wide enough for a window takes its own links, and the
 * layout never hears about them: the event that would have tiled a pane is not
 * dispatched at all.
 */
test('a link in a topic chat lands in that topic window instead of the layout', () => {
  const taken: string[] = [];
  const stop = registerTopicWindowDoor('t1', (s) => { taken.push(s.url); return true; });
  try {
    openLink('https://x.test/in-window', { topicId: 't1' });
    expect(taken).toEqual(['https://x.test/in-window']);
    expect(seen).toEqual([]);
    expect(opened).toEqual([]);
  } finally {
    stop();
  }
});

test('a link clicked inside a browser pane keeps going to that strip', () => {
  const stop = registerTopicWindowDoor('t1', () => true);
  try {
    openLink('https://x.test/from-pane', { topicId: 't1', nearPaneId: 'browser:a' });
    expect(seen.map((d) => d.nearPaneId)).toEqual(['browser:a']);
  } finally {
    stop();
  }
});

test('every click gets its OWN browser context (a tab, never a hijack)', () => {
  openLink('https://x.test/one');
  openLink('https://x.test/two');
  expect(seen).toHaveLength(2);
  expect(seen[0]!.contextId).not.toBe(seen[1]!.contextId);
});

test('nobody claims the event: the link goes out rather than doing nothing', () => {
  claim = false;
  openLink('https://x.test/unclaimed');
  expect(opened).toEqual(['https://x.test/unclaimed']);
});

test('an explicit external gesture skips the tab entirely', () => {
  openLink('https://x.test/ext', { external: true });
  expect(seen).toEqual([]);
  expect(opened).toEqual(['https://x.test/ext']);
});

test('non-web schemes are the OS handler business, gesture or not', () => {
  openLink('mailto:someone@x.test');
  openLink('vscode://file/tmp/a.ts');
  expect(seen).toEqual([]);
  expect(opened).toEqual(['mailto:someone@x.test', 'vscode://file/tmp/a.ts']);
});

test('a relative url is absolute before it is routed', () => {
  openLink('/api/media?path=x');
  expect(seen.map((d) => d.url)).toEqual(['https://app.test/api/media?path=x']);
});

test('a double click on the same link opens one tab', () => {
  openLink('https://x.test/dup');
  now += 200;
  openLink('https://x.test/dup');
  expect(seen).toHaveLength(1);
  now += 700;
  openLink('https://x.test/dup');
  expect(seen).toHaveLength(2);
});

test('empty url is a no-op', () => {
  openLink('');
  expect(seen).toEqual([]);
  expect(opened).toEqual([]);
});

test('the external gesture is Cmd, Ctrl or the middle button', () => {
  expect(isExternalLinkGesture({ metaKey: true })).toBe(true);
  expect(isExternalLinkGesture({ ctrlKey: true })).toBe(true);
  expect(isExternalLinkGesture({ button: 1 })).toBe(true);
  expect(isExternalLinkGesture({ button: 0 })).toBe(false);
  expect(isExternalLinkGesture({})).toBe(false);
});
