/**
 * THE BARE PUT AT MOUNT, which rewrote the default onto the server.
 *
 * `useServerState`'s write effect runs on the FIRST render too:
 * `isFromServerRef` is false and nobody has consumed it yet, so every mount
 * scheduled a PUT of the local value (or of the default) `debounceMs` later.
 * There was no hydration gate and no compare-and-swap, and at boot the GET that
 * would have brought the real value answers AFTER: 90 requests over six
 * connections, with 1.2 s of waiting already measured in `coalesceFetch.ts`.
 * The default won, and the server broadcast it to every other client.
 *
 * The two keys that go through this hook are `theme` and `claude-prefs-skip`.
 * The second one defaults to `true`, which is terminals born with
 * `--dangerously-skip-permissions`: whoever had turned it off found it back on
 * everywhere, for having been quick.
 *
 * The gate (`hydratedRef`) is the one `useSidebarState` has carried since the
 * shared pins were lost the first time. With one difference, written down and
 * tested here: it is also raised when the GET FAILS, or the key would lose
 * every write for the rest of the session.
 *
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../test/reactHarness';
import { useServerState } from './useServerState';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
/** The hydrating GET, in flight: the test lands it when it wants to. */
let pendingGet: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
const realFetch = (globalThis as { fetch?: typeof fetch }).fetch;
const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installFakes(): void {
  const store: Record<string, string> = Object.create(null);
  const storage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  // The minimum stand-in: the hook subscribes to `storage` for cross-tab sync.
  // It MUST be removed in `afterEach`, and that is not fussiness - a fake
  // `window` left on the runtime has already produced, in this repository, a
  // red that changed target with the order of the files (`check:test-globals`).
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener: () => {}, removeEventListener: () => {} },
  });
  calls = [];
  pendingGet = null;
  (globalThis as { fetch: unknown }).fetch = ((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (method !== 'GET') return Promise.resolve(new Response('{}', { status: 200 }));
    return new Promise<Response>((resolve, reject) => {
      pendingGet = {
        resolve: (v) => resolve(new Response(JSON.stringify(v), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })),
        reject,
      };
    });
  }) as typeof fetch;
}

beforeEach(() => {
  jest.useFakeTimers();
  installFakes();
});

afterEach(() => {
  jest.useRealTimers();
  if (realFetch) (globalThis as { fetch: unknown }).fetch = realFetch;
  else delete (globalThis as { fetch?: unknown }).fetch;
  if (realLocalStorage) Object.defineProperty(globalThis, 'localStorage', realLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
  else delete (globalThis as { window?: unknown }).window;
});

const puts = (): Call[] => calls.filter((c) => c.method === 'PUT');

/**
 * The microtasks of the fetch chain. There are a good few, and the number is
 * not eyeballed: the coalescer reads the body (`arrayBuffer`), rebuilds a
 * `Response`, then the hook does `json()`, `then`, `catch` and `finally`. The
 * `finally` - where the recovery of an in-flight write lives - is the last
 * link, so it is the first to disappear if the loop is short.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

/** Mounts the hook on the real key the defect rewrote, with its default. */
function mountSkipPermissions() {
  const box: { value: boolean; set: (v: boolean) => void } = { value: true, set: () => {} };
  const Probe = (): null => {
    // The key carries the case's name, so two cases never share the
    // coalescer's window (which is keyed on method + URL).
    const [value, setValue] = useServerState<boolean>(keyForCase, true, {
      localStorageKey: 'claude-skip-permissions',
      debounceMs: 300,
    });
    useEffect(() => { box.value = value; box.set = setValue as (v: boolean) => void; });
    return null;
  };
  const h = mount(createElement(Probe));
  return { now: () => box.value, set: (v: boolean) => box.set(v), unmount: () => h.unmount() };
}

let keyForCase = 'claude-prefs-skip';

describe('useServerState: no PUT before the GET has answered', () => {
  test('the debounce expires with the GET still in flight: the default does NOT leave', async () => {
    keyForCase = 'claude-prefs-skip-a';
    const s = mountSkipPermissions();
    await settle();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);

    // The real boot: the answer arrives well past the 300 ms of the debounce.
    jest.advanceTimersByTime(1200);
    await settle();
    expect(puts(), 'without the gate there was a PUT of `true` here, the default').toEqual([]);

    // And when the server answers, it is ITS value that stays.
    pendingGet!.resolve({ value: false, payload_version: 2, server_seq: 7 });
    await settle();
    expect(s.now(), 'the server value wins, and was never overwritten').toBe(false);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(puts(), 'nor afterwards: hydrating is not a local change').toEqual([]);
    s.unmount();
  });

  test('after hydrating, a choice of the user reaches the server', async () => {
    keyForCase = 'claude-prefs-skip-b';
    const s = mountSkipPermissions();
    await settle();
    pendingGet!.resolve({ value: false, payload_version: 2, server_seq: 7 });
    await settle();

    s.set(true);
    await settle();
    jest.advanceTimersByTime(300);
    await settle();
    expect(puts().map((c) => c.body), 'the gate is open: it writes').toEqual([true]);
    s.unmount();
  });

  test('a choice made WHILE the GET was in flight is not lost', async () => {
    keyForCase = 'claude-prefs-skip-c';
    const s = mountSkipPermissions();
    await settle();

    // The user turns the switch off in the first milliseconds, before the
    // answer: the gate is shut, so no PUT leaves from there.
    s.set(false);
    await settle();
    jest.advanceTimersByTime(300);
    await settle();
    expect(puts()).toEqual([]);

    // The GET lands: it does not trample the choice (`localWritesRef`), and it
    // sends it on.
    pendingGet!.resolve({ value: true, payload_version: 2, server_seq: 7 });
    await settle();
    expect(s.now(), 'the user choice wins over the hydration').toBe(false);
    expect(puts().map((c) => c.body), 'and reaches the server instead of staying local').toEqual([false]);
    s.unmount();
  });

  test('a FAILED GET opens the gate all the same', async () => {
    keyForCase = 'claude-prefs-skip-d';
    const s = mountSkipPermissions();
    await settle();
    pendingGet!.reject(new Error('Load failed'));
    await settle();

    // If the `.catch` branch left the flag down, this key would write nothing
    // at all for the rest of the session: much worse than the defect the gate
    // closes.
    s.set(false);
    await settle();
    jest.advanceTimersByTime(300);
    await settle();
    expect(puts().map((c) => c.body)).toEqual([false]);
    s.unmount();
  });
});
