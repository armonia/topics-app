/**
 * A cache written many times, a journal that never forgets.
 *
 * WHAT THIS PAYS FOR. On 2026-09-05 the WebKit localStorage journal of the
 * desktop app weighed **5.92 GB** (5.8 GB two days earlier: about 100 MB a
 * day). WebKit keeps `localstorage.sqlite3` in WAL mode and does NOT checkpoint
 * it while the webview session is alive, so the journal is not "how much you
 * store", it is "how many times you rewrote it". One `setItem` of a 1 MB blob
 * appends 1 MB of journal, every time, even when the 1 MB is byte for byte the
 * blob that is already there.
 *
 * `topics-cache` was exactly that shape: the whole topics map, stringified and
 * written on EVERY change of the topics state, with no delay and no comparison.
 * A burst of WebSocket updates on a workspace of a thousand topics is a burst of
 * megabytes into the journal, for a cache whose only job is to paint the first
 * frame of the next reload.
 *
 * THE TWO CUTS, and neither one is a heuristic:
 *
 *  1. COALESCE. Writes inside the debounce window become one write. Trailing
 *     only, no leading edge: unlike a re-read the user is watching (see
 *     `burstCoalescer`, which fires the first event immediately and for good
 *     reason), NOBODY reads this cache until the next boot. Being 2 seconds
 *     late costs nothing measurable and saves the whole burst. The window is
 *     FIXED from the first write of the burst, not restarted by each new one: a
 *     sliding window would never fire while an agent streams updates, which is
 *     precisely the hour that needs to be persisted.
 *  2. SKIP WHAT IS ALREADY THERE. Before writing we read the key back and drop
 *     the write when the bytes are identical. `getItem` copies at most one
 *     entry and touches no journal; `setItem` appends every page it dirties.
 *     The comparison goes through storage and not through a variable in memory
 *     ON PURPOSE: two windows share the key, so an in-memory "what I last
 *     wrote" is blind to what the other window did (same reason spelled out on
 *     `cacheMessages` in `hooks/useChat.ts`, which pays the same read).
 *
 * WHAT IS NOT LOST. The pending value is flushed on `pagehide` and when the
 * document goes hidden, so closing the window or switching away persists the
 * last state instead of dropping it. The worst case left is a hard kill inside
 * the window, which costs a cache up to `debounceMs` old for a cache the server
 * rebuilds on the next load anyway.
 *
 * `schedule`/`cancel`/`storage` are injectable so the test drives time instead
 * of sleeping.
 */

/** The slice of the Storage API this writer needs. */
export interface WriterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThrottledWriterOptions {
  /** The localStorage key this writer owns. One writer per key. */
  key: string;
  /** How long a burst coalesces. Default 2000 ms. */
  debounceMs?: number;
  /** Injectable for the tests. Defaults to `localStorage`. */
  storage?: WriterStorage;
  /** Injectable for the tests. Defaults to the global `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Injectable for the tests. Default: `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

/**
 * What is handed to the writer: the string, or a thunk that builds it.
 *
 * The thunk is the form that pays off on a big cache: serialising a 1 MB map is
 * the expensive half of the write, and inside a burst it would be paid once per
 * update for a string only the LAST one keeps. Deferred to the flush, a burst
 * of twenty-four updates costs one `JSON.stringify` instead of twenty-four.
 */
export type WriterValue = string | (() => string);

export interface ThrottledWriter {
  /** Records the value to persist. The last one before the flush wins. */
  write(value: WriterValue): void;
  /** Writes the pending value now, if it differs from what is stored. */
  flush(): void;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/** Every live writer, so one page-hide flushes all of them. */
const registry = new Set<ThrottledWriter>();
let hideHookInstalled = false;

function flushAll(): void {
  for (const writer of registry) writer.flush();
}

/**
 * One pair of listeners for every writer. Installed on the first writer and
 * never removed: writers here are module-level singletons that live as long as
 * the document does.
 */
function installHideHook(): void {
  if (hideHookInstalled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  hideHookInstalled = true;
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

function resolveStorage(explicit?: WriterStorage): WriterStorage | null {
  if (explicit) return explicit;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // storage denied (private mode, blocked origin)
  }
}

export function createThrottledLocalWriter(opts: ThrottledWriterOptions): ThrottledWriter {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const storage = resolveStorage(opts.storage);

  let pending: WriterValue | null = null;
  let timer: unknown = null;

  const writer: ThrottledWriter = {
    write(value: WriterValue): void {
      if (!storage) return;
      pending = value;
      if (timer !== null) return; // the burst rides the timer already armed
      timer = schedule(() => {
        timer = null;
        writer.flush();
      }, debounceMs);
    },

    flush(): void {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (pending === null || !storage) return;
      const source = pending;
      pending = null;
      try {
        const value = typeof source === 'function' ? source() : source;
        // The read that saves the write. See the header.
        if (storage.getItem(opts.key) === value) return;
        storage.setItem(opts.key, value);
      } catch {
        /* quota, denied storage, or a thunk that threw: the server is the
           source of truth for every key that goes through here */
      }
    },
  };

  if (!opts.storage) installHideHook();
  registry.add(writer);
  return writer;
}
