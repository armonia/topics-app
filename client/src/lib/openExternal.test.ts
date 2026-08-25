/**
 * @covers EXTERNAL-01
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { openExternalOnce } from './openExternal';

// openExternalOnce reads `window` and `Date.now()` at call time, so we stub
// both. Each test uses a DISTINCT url, which keeps the module-level de-dupe
// slot (lastUrl/lastAt) from leaking state between tests.

let opened: string[] = [];
let now = 0;
const realDateNow = Date.now;

beforeEach(() => {
  opened = [];
  now = 1_000_000;
  Date.now = () => now;
  (globalThis as unknown as { window: unknown }).window = {
    open: (u: string) => opened.push(u),
  };
});

afterEach(() => {
  Date.now = realDateNow;
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('opens once for a single call', () => {
  openExternalOnce('https://x.test/single');
  expect(opened).toEqual(['https://x.test/single']);
});

test('swallows a rapid repeat of the same url (double-click guard)', () => {
  openExternalOnce('https://x.test/dup');
  openExternalOnce('https://x.test/dup'); // same instant
  now += 200;
  openExternalOnce('https://x.test/dup'); // still inside the window
  expect(opened).toEqual(['https://x.test/dup']);
});

test('allows the same url again after the de-dupe window elapses', () => {
  openExternalOnce('https://x.test/again');
  now += 700; // > DEDUPE_MS (600)
  openExternalOnce('https://x.test/again');
  expect(opened).toEqual(['https://x.test/again', 'https://x.test/again']);
});

test('different urls are never deduped against each other', () => {
  openExternalOnce('https://x.test/a');
  openExternalOnce('https://x.test/b');
  expect(opened).toEqual(['https://x.test/a', 'https://x.test/b']);
});

test('ignores empty urls', () => {
  openExternalOnce('');
  expect(opened).toEqual([]);
});

test('routes through window.open (web / shell bridge fallback)', () => {
  openExternalOnce('https://x.test/web');
  expect(opened).toEqual(['https://x.test/web']);
});
