/**
 * One tab sheet at a time, and a door that closes stays closed.
 *
 * @covers TABSHEET-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetTabSheet, closeTabSheet, getOpenTabSheet, openTabSheet, swallowNextOpen, toggleTabSheet,
} from './tabSheet';

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

afterEach(() => __resetTabSheet());

describe('tab sheet store', () => {
  test('opening another tab closes this one', () => {
    openTabSheet('a', 'commands');
    openTabSheet('b', 'commands');
    expect(getOpenTabSheet()?.key).toBe('b');
  });

  test('a right click on the open tab closes it', () => {
    toggleTabSheet('a', 'commands');
    expect(getOpenTabSheet()?.key).toBe('a');
    toggleTabSheet('a', 'commands');
    expect(getOpenTabSheet()).toBeNull();
  });

  test('closing names a key: another sheet is left alone', () => {
    openTabSheet('a', 'address');
    closeTabSheet('b');
    expect(getOpenTabSheet()?.key).toBe('a');
    closeTabSheet();
    expect(getOpenTabSheet()).toBeNull();
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
    expect(getOpenTabSheet()).toBeNull();
    // A press that produced no request (a drag) disarms it for the next one.
    swallowNextOpen('a', host as unknown as Document, firstPress);
    host.press('pointerdown');
    openTabSheet('a', 'commands');
    expect(getOpenTabSheet()?.key).toBe('a');
  });

  test('the swallow is for one key only', () => {
    swallowNextOpen('a', null);
    openTabSheet('b', 'commands');
    expect(getOpenTabSheet()?.key).toBe('b');
  });
});
