/**
 * One tab sheet at a time, and a door that closes stays closed.
 *
 * @covers TABSHEET-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { closeTabSheet, openTabSheet, swallowNextOpen, useOpenTabSheet } from './tabSheet';

/**
 * The store has no plain getter, only the hook. Outside a render, the hook's one
 * call (`useSyncExternalStore`) is answered by a stand-in dispatcher that returns
 * the live snapshot, so the real store code runs and nothing is mocked.
 */
function useOpenSheetNow(key: string) {
  const internals = (React as unknown as Record<string, { H: unknown }>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = internals.H;
  internals.H = { useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() };
  try { return useOpenTabSheet(key); } finally { internals.H = prev; }
}

/** A document with only the two methods the store uses, and a way to press. */
function fakeHost() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => { listeners.get(type)?.delete(fn); },
    press: (type: string, e: Event = new Event(type)) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(e); },
  };
}

afterEach(() => {
  // Consumes a swallow left armed on 'a', then closes whatever is open.
  openTabSheet('a', 'commands');
  closeTabSheet();
});

describe('tab sheet store', () => {
  test('opening another tab closes this one', () => {
    openTabSheet('a', 'commands');
    openTabSheet('b', 'commands');
    expect(useOpenSheetNow('b')?.key).toBe('b');
    expect(useOpenSheetNow('a')).toBeNull();
  });

  test('closing names a key: another sheet is left alone', () => {
    openTabSheet('a', 'address');
    closeTabSheet('b');
    expect(useOpenSheetNow('a')?.key).toBe('a');
    closeTabSheet();
    expect(useOpenSheetNow('a')).toBeNull();
  });

  test('the request that follows the closing press is dropped, the next gesture re-arms', () => {
    const host = fakeHost();
    const firstPress = new Event('pointerdown');
    openTabSheet('a', 'commands');
    closeTabSheet('a');
    swallowNextOpen('a', host as unknown as Document, firstPress);
    // The same press, still being dispatched, does not disarm it.
    host.press('pointerdown', firstPress);
    openTabSheet('a', 'commands');
    expect(useOpenSheetNow('a')).toBeNull();
    // A press that produced no request (a drag) disarms it for the next one.
    swallowNextOpen('a', host as unknown as Document, firstPress);
    host.press('pointerdown');
    openTabSheet('a', 'commands');
    expect(useOpenSheetNow('a')?.key).toBe('a');
  });

  test('the swallow is for one key only', () => {
    swallowNextOpen('a', null);
    openTabSheet('b', 'commands');
    expect(useOpenSheetNow('b')?.key).toBe('b');
  });
});
