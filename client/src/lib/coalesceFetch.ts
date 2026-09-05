/**
 * coalescedFetch — one request in flight per URL, whoever asks.
 *
 * THE PROBLEM, measured on 2026-09-05 on a ⌘R of the desktop app with the
 * user's real state: 90 `/api/*` requests at boot, up to 53 in flight at once,
 * and a good share of them the SAME read asked by different components mounting
 * in the same frame — `claude-prefs-skip` five times (App, every project window,
 * the add-menu), `/api/terminal/sessions` five times (the App-level lifecycle
 * plus one per project window), `/api/system/status` twice, `/api/auth/orgs`
 * twice, `/api/all-boards/tasks` twice at 84 KB each. The browser has six
 * connections per host: every duplicate holds one of them, and the POST that
 * loads the visible chat's history waited behind them for 1.2 s.
 *
 * Each of those call sites already had a local "single-flight" of its own
 * (`inflight` in projectSharingStore, `inFlight` in paneUsage, the memoised
 * promise in useDevInstall). They cannot see each other, and that is the whole
 * bug: dedup that lives inside ONE module only dedups that module. This one
 * lives under all of them, keyed by method + URL.
 *
 * ## What it does
 *
 *  · IN FLIGHT: a second caller of the same key rides the same network request.
 *    Every caller receives its OWN `Response` (a body can only be read once), so
 *    the shared result is the downloaded bytes + status + headers, and each
 *    caller gets a fresh `Response` built from them.
 *  · TTL (optional, default 0): a caller arriving within `ttlMs` of the answer
 *    gets the same answer without a request. Meant for the boot reads where
 *    components mount a few hundred milliseconds apart (the WebSocket-open
 *    refetch of the roster lands ~700 ms after the mount fetch). Keep it SHORT:
 *    this is not a cache, it is a window in which "the same question" is still
 *    the same question.
 *  · ERRORS ARE NOT REMEMBERED: a failed request (network) or a status outside
 *    2xx releases the key at once. Callers already in flight all see it; the
 *    next caller asks the network again.
 *  · AN ANSWER BELONGS TO THE `fetch` THAT GAVE IT. The desktop shell swaps
 *    `window.fetch` for an origin-rewriting shim at boot (lib/shell/net.ts), and
 *    the unit tests swap it for a stub per case: an answer obtained through a
 *    different `fetch` than the current one is not reused.
 *
 * ## What it does NOT do
 *
 *  · The `init` of the FIRST caller is what goes on the wire. A later caller's
 *    `init` (a different `priority`, a `signal`) is ignored for the shared
 *    request — so do not route a fetch through here if its abort matters.
 *  · Reads only. The key is method + URL; a POST with a body is not a read and
 *    must not pass through here.
 */

/** What the network gave back, kept once and handed out as fresh Responses. */
interface Settled {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  at: number;
}

interface Entry {
  promise: Promise<Settled>;
  settled: Settled | null;
  ttlMs: number;
  /** The `fetch` this entry was obtained through (see the header). */
  via: unknown;
}

export interface CoalesceOptions {
  /** Reuse an answer younger than this (ms). 0 = only share the request in flight. */
  ttlMs?: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchCoalescerDeps {
  /** Defaults to the global `fetch`, looked up at CALL time (see `createFetchCoalescer`). */
  fetcher?: Fetcher;
  /** Injectable clock so a test can move time instead of sleeping. */
  now?: () => number;
  /** Whose answer this is: an entry is reusable only while this still returns the same value. */
  identity?: () => unknown;
}

/** Statuses whose Response MUST carry a null body (the constructor throws otherwise). */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function toResponse(s: Settled): Response {
  const body = s.body === null || NULL_BODY_STATUS.has(s.status) ? null : s.body;
  return new Response(body, { status: s.status, statusText: s.statusText, headers: s.headers });
}

export interface FetchCoalescer {
  fetch: (url: string, init?: RequestInit, options?: CoalesceOptions) => Promise<Response>;
}

/**
 * Build a coalescer. The default fetcher looks `fetch` up at call time and not
 * at module load: the desktop shell replaces `window.fetch` after the bundle has
 * loaded, and a reference captured too early would bypass the shim.
 */
export function createFetchCoalescer(deps: FetchCoalescerDeps = {}): FetchCoalescer {
  const fetcher: Fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const identity = deps.identity ?? (() => globalThis.fetch);
  const entries = new Map<string, Entry>();

  const keyOf = (url: string, init?: RequestInit): string =>
    `${(init?.method ?? 'GET').toUpperCase()} ${url}`;

  const start = (key: string, url: string, init: RequestInit | undefined, ttlMs: number): Entry => {
    const release = (): void => { if (entries.get(key) === entry) entries.delete(key); };
    const entry: Entry = {
      settled: null,
      ttlMs,
      via: identity(),
      promise: fetcher(url, init).then(
        async (res) => {
          // The bytes are read HERE, once: this is also what makes the in-flight
          // window cover the whole download and not just the headers.
          const body = NULL_BODY_STATUS.has(res.status) ? null : await res.arrayBuffer();
          const settled: Settled = {
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers.entries()],
            body,
            at: now(),
          };
          if (!res.ok || ttlMs <= 0) {
            // A refusal is not an answer worth handing to the next caller, and
            // without a TTL there is nothing to keep once the flight is over.
            release();
          } else {
            entry.settled = settled;
            setTimeout(release, ttlMs);
          }
          return settled;
        },
        (err: unknown) => {
          release();
          throw err;
        },
      ),
    };
    entries.set(key, entry);
    return entry;
  };

  return {
    fetch(url, init, options) {
      const ttlMs = options?.ttlMs ?? 0;
      const key = keyOf(url, init);
      const existing = entries.get(key);
      const reusable = existing !== undefined
        && existing.via === identity()
        && (existing.settled === null || now() - existing.settled.at <= existing.ttlMs);
      const entry = reusable ? existing : start(key, url, init, ttlMs);
      return entry.promise.then(toResponse);
    },
  };
}

const shared = createFetchCoalescer();

/**
 * The app-wide instance. Same signature as `fetch` plus the options; hands a
 * Response of its own to every caller.
 */
export const coalescedFetch: FetchCoalescer['fetch'] = (url, init, options) => shared.fetch(url, init, options);

/**
 * The TTL for the reads of BOOT: components that mount in the same second ask
 * the same question and get the same answer. Two seconds is the ceiling the
 * measurement asked for; it covers the mount→WebSocket-open gap (~700 ms here)
 * without turning a reconnect after a server restart into a stale read.
 */
export const BOOT_READ_TTL_MS = 2000;
