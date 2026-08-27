/**
 * useServiceWorkerUpdate — cleanup of the 'updatefound' listener on unmount.
 *
 * `navigator.serviceWorker.getRegistration()` hands back the SAME
 * ServiceWorkerRegistration object for the whole page lifetime. A component
 * that mounts this hook repeatedly (the version popover: opened and closed
 * many times over a session) without removing its 'updatefound' listener on
 * unmount piles up one listener per mount on that shared, page-lifetime
 * object — a leak that never shows up as an error, only as a Map/listener
 * count that keeps climbing.
 *
 * @covers LEAK-01
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useServiceWorkerUpdate } from './useServiceWorkerUpdate';

/** A ServiceWorkerRegistration stand-in that counts live 'updatefound' listeners. */
function fakeRegistration() {
  const listeners = new Set<EventListener>();
  return {
    waiting: null as unknown,
    installing: null as unknown,
    addEventListener(type: string, fn: EventListener) {
      if (type === 'updatefound') listeners.add(fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      if (type === 'updatefound') listeners.delete(fn);
    },
    liveListenerCount: () => listeners.size,
  };
}

/** Minimal in-memory Storage — this Bun test environment has no real DOM. */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
}

const nav = navigator as unknown as { serviceWorker?: unknown };
let savedServiceWorker: unknown;
let savedLocalStorage: unknown;

beforeEach(() => {
  savedServiceWorker = nav.serviceWorker;
  savedLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = fakeStorage();
});

afterEach(() => {
  nav.serviceWorker = savedServiceWorker;
  (globalThis as unknown as { localStorage?: unknown }).localStorage = savedLocalStorage;
});

function Consumer() {
  useServiceWorkerUpdate();
  return null;
}

describe('useServiceWorkerUpdate', () => {
  test('removes its updatefound listener on unmount instead of piling up', async () => {
    const reg = fakeRegistration();
    nav.serviceWorker = {
      getRegistration: () => Promise.resolve(reg),
      controller: null,
    };

    // Mount + unmount the hook three times in a row, as opening and closing
    // the version popover does. Each cycle must leave the registration with
    // zero listeners once its effect's async getRegistration() has settled.
    for (let i = 0; i < 3; i++) {
      const harness = mount(React.createElement(Consumer));
      // getRegistration() resolves as a microtask; let it settle before the
      // effect that calls reg.addEventListener runs.
      await Promise.resolve();
      await Promise.resolve();
      harness.unmount();
    }

    expect(reg.liveListenerCount()).toBe(0);
  });
});
