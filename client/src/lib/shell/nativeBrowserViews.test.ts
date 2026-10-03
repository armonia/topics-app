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
  beginNativeViewMovesToAnotherWindow,
  beginNativeViewOpen,
  cancelNativeViewMove,
  closeNativeView,
  deferCloseToMove,
  dropNativeViewOpen,
  forgetNativeView,
  isNativeViewOpened,
  settleNativeViewOpen,
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
    settleNativeViewOpen(beginNativeViewOpen('m4'), () => Promise.resolve());
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

describe('nativeBrowserViews: a page another window is about to take', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('a pop-out marks every open view as moving, and only those', () => {
    let closed = 0;
    settleNativeViewOpen(beginNativeViewOpen('w1'), () => Promise.resolve());
    beginNativeViewMovesToAnotherWindow();
    expect(deferCloseToMove('w1', () => { closed++; })).toBe(true);
    expect(deferCloseToMove('w-never-opened', () => {})).toBe(false);
    // Nobody took it in time: the parked close runs, as any move's does.
    jest.advanceTimersByTime(NATIVE_VIEW_MOVE_TIMEOUT_MS);
    expect(closed).toBe(1);
    forgetNativeView('w1');
  });

  test('a release close names its window, a real close does not', async () => {
    const args: Array<Record<string, unknown> | undefined> = [];
    const invoke = (_cmd: string, a?: Record<string, unknown>) => { args.push(a); return Promise.resolve(); };
    await closeNativeView('w2', invoke, 'main');
    await closeNativeView('w3', invoke);
    expect(args).toEqual([{ id: 'w2', hostWindow: 'main' }, { id: 'w3' }]);
  });
});

describe('nativeBrowserViews: a close wins over an open it overtakes', () => {
  /** Every command sent, in order, by whoever this record asked. */
  let sent: string[] = [];
  const invoke = (cmd: string, args?: Record<string, unknown>) => { sent.push(`${cmd} ${String(args?.id)}`); return Promise.resolve(); };
  beforeEach(() => { sent = []; });

  test('an open that answers after a close of its id is not recorded, and its view is closed', async () => {
    const open = beginNativeViewOpen('o1');
    await closeNativeView('o1', invoke);
    expect(settleNativeViewOpen(open, invoke)).toBe(false);
    expect(isNativeViewOpened('o1'), 'the record took back a view the close had taken out').toBe(false);
    expect(sent, 'the view the late open produced was left alive').toEqual(['browser_close o1', 'browser_close o1']);
  });

  test('an open with no close in between is recorded, and nothing is closed', () => {
    expect(settleNativeViewOpen(beginNativeViewOpen('o2'), invoke)).toBe(true);
    expect(isNativeViewOpened('o2')).toBe(true);
    expect(sent).toEqual([]);
    forgetNativeView('o2');
  });

  test('a newer open of the same id owns the label: the lost one closes nothing', async () => {
    const lost = beginNativeViewOpen('o3');
    await closeNativeView('o3', invoke);
    const later = beginNativeViewOpen('o3');
    sent = [];
    expect(settleNativeViewOpen(lost, invoke)).toBe(false);
    expect(sent, 'the lost open closed the view a newer open is getting').toEqual([]);
    expect(settleNativeViewOpen(later, invoke)).toBe(true);
    expect(isNativeViewOpened('o3')).toBe(true);
    forgetNativeView('o3');
  });

  test('a newer open that FAILED owns nothing: the lost one still closes its view', async () => {
    const lost = beginNativeViewOpen('o4');
    await closeNativeView('o4', invoke);
    dropNativeViewOpen(beginNativeViewOpen('o4'));
    sent = [];
    expect(settleNativeViewOpen(lost, invoke)).toBe(false);
    expect(sent, 'a failed open shielded a view nobody owns').toEqual(['browser_close o4']);
  });
});

describe('nativeBrowserViews: every browser_close passes through here', () => {
  // A literal invoke of `browser_close` outside this module bypasses the
  // record, and the next reopen inside the grace adopts a dead view. The pane
  // teardown (`teardownNativeBrowserPane`) sends it from a list of commands and
  // forgets the view first: its behaviour is pinned in
  // `useTauriBrowser.move.test.ts`.
  const SRC = join(import.meta.dir, '..', '..');
  // The type argument is optional in the pattern: `tauriInvoke<void>('browser_close', …)`
  // is the same call, and a pattern that wanted `(` right after `invoke` let it through.
  const DIRECT_CLOSE = /[iI]nvoke(?:<[^>]*>)?\(\s*['"]browser_close['"]/;

  test('the pattern sees the call with and without a type argument', () => {
    expect(DIRECT_CLOSE.test(`tauriInvoke('browser_close', { id })`)).toBe(true);
    expect(DIRECT_CLOSE.test(`tauriInvoke<void>('browser_close', { id })`)).toBe(true);
    expect(DIRECT_CLOSE.test(`invoke<unknown>( "browser_close", { id })`)).toBe(true);
    expect(DIRECT_CLOSE.test(`tauriInvoke<void>('browser_close_all', {})`)).toBe(false);
  });

  test('no source file sends browser_close around closeNativeView', () => {
    const offenders: string[] = [];
    for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$/.test(file) || file === 'lib/shell/nativeBrowserViews.ts') continue;
      if (DIRECT_CLOSE.test(readFileSync(join(SRC, file), 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
