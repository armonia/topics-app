/**
 * The record of open native views and of moves in flight (`nativeBrowserViews`).
 *
 * Two things are pinned here. The handoff's clock: a parked close runs only if
 * no pane takes the move within the safety timeout. And the single door: a
 * `browser_close` sent around this module leaves the id recorded, and a pane
 * reopened inside the close grace adopts a view the shell already destroyed
 * (an empty pane until «ricrea»), which is how the three close funnels behaved.
 *
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_VIEW_MOVE_TIMEOUT_MS,
  beginNativeViewMove,
  cancelNativeViewMove,
  closeNativeView,
  deferCloseToMove,
  forgetNativeView,
  isNativeViewOpened,
  noteNativeViewOpened,
  takeNativeViewMove,
} from './nativeBrowserViews';

describe('nativeBrowserViews: a move is a handoff with a safety timeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('a parked close waits for the timeout, then runs', () => {
    let closed = 0;
    beginNativeViewMove('m1');
    expect(deferCloseToMove('m1', () => { closed++; })).toBe(true);
    jest.advanceTimersByTime(NATIVE_VIEW_MOVE_TIMEOUT_MS - 1);
    expect(closed).toBe(0);
    jest.advanceTimersByTime(1);
    expect(closed).toBe(1);
    // Expired: a later mount is not a move any more.
    expect(takeNativeViewMove('m1')).toBe(false);
  });

  test('the arriving pane takes the move: the parked close never runs', () => {
    let closed = 0;
    beginNativeViewMove('m2');
    deferCloseToMove('m2', () => { closed++; });
    expect(takeNativeViewMove('m2')).toBe(true);
    jest.advanceTimersByTime(NATIVE_VIEW_MOVE_TIMEOUT_MS * 2);
    expect(closed).toBe(0);
  });

  test('without a move nothing is parked, and a refused move parks nothing', () => {
    expect(deferCloseToMove('m3', () => {})).toBe(false);
    beginNativeViewMove('m3');
    cancelNativeViewMove('m3');
    expect(deferCloseToMove('m3', () => {})).toBe(false);
  });

  test('a real close ends the move and the record together', async () => {
    let closed = 0;
    const sent: string[] = [];
    noteNativeViewOpened('m4');
    beginNativeViewMove('m4');
    deferCloseToMove('m4', () => { closed++; });
    await closeNativeView('m4', (cmd) => { sent.push(cmd); return Promise.resolve(); });
    expect(sent).toEqual(['browser_close']);
    expect(isNativeViewOpened('m4')).toBe(false);
    expect(takeNativeViewMove('m4')).toBe(false);
    jest.advanceTimersByTime(NATIVE_VIEW_MOVE_TIMEOUT_MS);
    expect(closed).toBe(0);
    forgetNativeView('m4');
  });
});

describe('nativeBrowserViews: every browser_close passes through here', () => {
  // A literal invoke of `browser_close` outside this module bypasses the
  // record, and the next reopen inside the grace adopts a dead view. The pane
  // teardown (`teardownNativeBrowserPane`) sends it from a list of commands and
  // forgets the view first: its behaviour is pinned in
  // `useTauriBrowser.move.test.ts`.
  const SRC = join(import.meta.dir, '..', '..');
  const DIRECT_CLOSE = /[iI]nvoke\(\s*['"]browser_close['"]/;

  test('no source file sends browser_close around closeNativeView', () => {
    const offenders: string[] = [];
    for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$/.test(file) || file === 'lib/shell/nativeBrowserViews.ts') continue;
      if (DIRECT_CLOSE.test(readFileSync(join(SRC, file), 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
