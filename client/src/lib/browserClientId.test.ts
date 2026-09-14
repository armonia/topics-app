/**
 * THE NAME OF A PANE HAS TO BE THE SAME NAME TOMORROW.
 *
 * Everything the viewport arbiter does rests on one assumption: that a pane
 * coming back on a new socket says the same `?client=` it said before. Every
 * other test in this family passes that name in by hand, which means every
 * other test ASSUMES exactly what this file has to prove. Break the storage
 * read here and they all stay green while the Mac becomes a stranger on every
 * reconnection, which is the original bug.
 *
 * @covers TOPIC-BROWSER-05
 */
import { test, expect, afterEach } from 'bun:test';
import { browserClientId } from './browserClientId';

/** A `sessionStorage` as the pane sees it: one per webview, nothing shared. */
function fakeStorage(): Storage {
  const cells = new Map<string, string>();
  return {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
    removeItem: (key: string) => { cells.delete(key); },
    clear: () => { cells.clear(); },
    key: (index: number) => [...cells.keys()][index] ?? null,
    get length() { return cells.size; },
  } as Storage;
}

// What this process had before we touched it. Restoring "nothing" means
// DELETING the property, not setting it to undefined: a shard runs many test
// files in one process, and a `sessionStorage` that exists with value undefined
// is not the same thing as a `sessionStorage` that does not exist. Left behind,
// it broke an unrelated file in the same shard.
const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

/** Install a storage for the pane. */
function withStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage, configurable: true, writable: true,
  });
}

/** Put the process back exactly as we found it. */
function restoreStorage(): void {
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
  else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

afterEach(restoreStorage);

test('the same webview gets the same name on every call', () => {
  withStorage(fakeStorage());

  const first = browserClientId();
  expect(first, "il nome della pane e' vuoto").toBeTruthy();

  // A reload of the same tab, and the flip from the native executor to
  // streaming, are both this: another call, same storage. The arbiter has to
  // see one client through all of them.
  expect(browserClientId()).toBe(first);
  expect(browserClientId()).toBe(first);
});

test('another webview gets another name', () => {
  withStorage(fakeStorage());
  const firstWindow = browserClientId();

  // A second window, a detached pane, a new tab: `sessionStorage` does not
  // cross them. Two screens, two clients, so the one that is only watching
  // cannot reflow the page under the other.
  withStorage(fakeStorage());
  expect(browserClientId()).not.toBe(firstWindow);
});

test('a webview with no storage still gets a name instead of an exception', () => {
  // A hardened webview, or a render with no window at all. The pane is then a
  // newcomer on every socket, which is the behaviour from before this id
  // existed. What it must not do is throw on the way to opening the socket.
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  expect(browserClientId()).toBeTruthy();

  const throwing = {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  } as unknown as Storage;
  withStorage(throwing);
  expect(browserClientId()).toBeTruthy();
});
