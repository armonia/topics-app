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

let opened: string[] = [];
let claim = true;
let seen: OpenTabDetail[] = [];
let now = 0;
const realDateNow = Date.now;

beforeEach(() => {
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
  Date.now = realDateNow;
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('a plain click asks for a tab inside Topics, not the system browser', () => {
  openLink('https://x.test/page', { topicId: 't1' });
  expect(seen.map((d) => d.url)).toEqual(['https://x.test/page']);
  expect(seen[0]!.topicId).toBe('t1');
  expect(opened).toEqual([]);
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
