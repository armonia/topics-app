/**
 * Durability of the cross-device tombstone sync (`tombstones-terminal` /
 * `tombstones-browser` ui_state keys).
 *
 * Sibling contract test to `projectLayoutSync.durability.test.ts` — same
 * anti-resurrection concern (a tab closed on one device must stay closed on
 * another), same echo/staleness guards. ONE deliberate divergence from that
 * sibling: `tombstoneSync.ts` has no pagehide/beacon teardown flush (it never
 * wired one — see its module header, which only documents WS-reconnect
 * retry). So instead of a pagehide test, "durability after an outage" is
 * exercised via the WS `'open'` lifecycle event, which is the retry path
 * `tombstoneSync.ts` actually implements.
 *
 * These lock:
 *   - a PUT that fails (server down) is RETAINED as un-acked, not swallowed;
 *   - a WS reconnect (`dispatchLifecycle('open')`) retries the un-acked set;
 *   - a successful PUT clears the un-acked entry (no perpetual re-send);
 *   - the last-synced-JSON guard skips a redundant publish of unchanged
 *     content (no PUT storm from a no-op tombstone write);
 *   - our own write echoing back (`sourceClientId` match) is skipped, not
 *     re-applied through `importTombstones`;
 *   - the per-key `server_seq` gate drops a stale/duplicate remote frame but
 *     accepts a newer one, and the merge is UNION-only (add, never remove) —
 *     the anti-resurrection invariant this whole module exists for.
 *
 * @covers TAB-SYNC-01, TAB-SYNC-02
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

type StorageArea = Record<string, string>;
function installFakeWindow(): void {
  const store: StorageArea = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
  (globalThis as unknown as { document: unknown }).document = { visibilityState: "visible" };
}

installFakeWindow();

const closedTabRecord = await import("./closedTabRecord");
const { addTerminalTombstone, clearTerminalTombstone, addBrowserTombstone, getTerminalTombstones, getBrowserTombstones } =
  closedTabRecord;

const wsFrameBus = await import("../../../lib/wsFrameBus");
const { dispatchFrame, dispatchLifecycle } = wsFrameBus;

const { getTabId } = await import("../middleware/syncCrossTab");

const mod = await import("./tombstoneSync");
const { initTombstoneSync } = mod as typeof import("./tombstoneSync");
const { __getUnackedTombstoneSyncKeys, __resetTombstoneSyncForTests } = mod as typeof import("./tombstoneSync") & {
  __getUnackedTombstoneSyncKeys: () => string[];
  __resetTombstoneSyncForTests: () => void;
};

// The REAL globals, captured ONCE at module load — see the sibling test's
// comment on why capturing inside installFetch would poison the whole
// bun-test process (a re-capture of a stub as "original" survives afterEach).
const REAL_FETCH: unknown = (globalThis as unknown as { fetch?: unknown }).fetch;

let fetchCalls: { url: string }[];
let fetchOk: boolean;
function installFetch(ok: boolean): void {
  fetchOk = ok;
  fetchCalls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string): Promise<Response> => {
    fetchCalls.push({ url: String(url) });
    if (!fetchOk) throw new Error("network down");
    return {
      ok: true,
      json: async () => ({ server_seq: fetchCalls.length }),
    } as unknown as Response;
  };
}

// Wiring is idempotent (guarded by the module's `wired` flag) and side-effect
// free beyond registering handlers on the in-memory wsFrameBus — safe to do
// once for the whole file. Immediately cancel the eager initial-seed publish
// (initTombstoneSync() self-seeds both kinds on call) so it doesn't fire an
// unmocked fetch mid-test-setup.
initTombstoneSync();
__resetTombstoneSyncForTests();

const TERMINAL_KEY = "tombstones-terminal";
const BROWSER_KEY = "tombstones-browser";

// The sync is debounced 500 ms; wait past it (+ margin for the first retry
// attempt, same margin the sibling projectLayoutSync test uses).
const settle = () => new Promise((r) => setTimeout(r, 650));

beforeEach(() => {
  __resetTombstoneSyncForTests();
  localStorage.clear();
});

afterEach(() => {
  __resetTombstoneSyncForTests();
  localStorage.clear();
  if (REAL_FETCH === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
  else (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
});

describe("tombstone sync PUT durability", () => {
  test("a successful publish PUTs to the kind's ui_state key and clears the un-acked entry", async () => {
    installFetch(true);
    addTerminalTombstone("terminal:fe2a97aa");
    await settle();
    expect(fetchCalls.some((c) => c.url.includes(encodeURIComponent(TERMINAL_KEY)))).toBe(true);
    expect(__getUnackedTombstoneSyncKeys()).not.toContain(TERMINAL_KEY);
  });

  test("a failing PUT (server down) is RETAINED as un-acked, not swallowed", async () => {
    installFetch(false);
    addBrowserTombstone("ctx:a6d64304");
    await settle();
    expect(__getUnackedTombstoneSyncKeys()).toContain(BROWSER_KEY);
  });

  test("a WS reconnect retries the un-acked set and clears it once the server is back", async () => {
    installFetch(false);
    addBrowserTombstone("ctx:2c9911");
    await settle();
    expect(__getUnackedTombstoneSyncKeys()).toContain(BROWSER_KEY);

    installFetch(true);
    dispatchLifecycle("open");
    await settle();
    expect(__getUnackedTombstoneSyncKeys()).not.toContain(BROWSER_KEY);
    expect(fetchCalls.some((c) => c.url.includes(encodeURIComponent(BROWSER_KEY)))).toBe(true);
  });

  test("the last-synced-JSON guard skips a redundant publish of unchanged content", async () => {
    installFetch(true);
    addTerminalTombstone("terminal:dupcheck");
    await settle();
    const callsAfterFirst = fetchCalls.length;

    // No-op write: clearing an id that isn't in the set rewrites the same
    // list, so the serialized payload is byte-identical to what was just
    // synced. publish() must skip this before ever arming a debounce timer.
    clearTerminalTombstone("does-not-exist");
    await settle();

    expect(fetchCalls.length).toBe(callsAfterFirst);
    expect(__getUnackedTombstoneSyncKeys()).not.toContain(TERMINAL_KEY);
  });
});

describe("tombstone sync remote-frame guards", () => {
  test("a remote frame echoing our own write (sourceClientId match) is skipped, not re-applied", async () => {
    installFetch(true);
    addTerminalTombstone("terminal:echo-owner");
    await settle();
    expect(getTerminalTombstones().has("terminal:echo-owner")).toBe(true);

    // A real server would echo back our own state; attach a bogus id here so
    // a passing test can only mean the echo path returned early (never
    // called importTombstones), not that it happened to import the same data.
    dispatchFrame({
      type: "ui-state:updated",
      key: TERMINAL_KEY,
      value: { entries: [{ id: "should-not-appear", ts: Date.now() }] },
      server_seq: 999,
      sourceClientId: getTabId(),
    });

    expect(getTerminalTombstones().has("should-not-appear")).toBe(false);
  });

  test("per-key server_seq gate drops a stale/duplicate remote frame but accepts a newer one (union-only merge)", () => {
    dispatchFrame({
      type: "ui-state:updated",
      key: BROWSER_KEY,
      value: { entries: [{ id: "peer-a", ts: Date.now() }] },
      server_seq: 5,
      sourceClientId: "other-tab",
    });
    expect(getBrowserTombstones().has("peer-a")).toBe(true);

    // Same (non-increasing) seq — must be dropped, even though it names a
    // brand-new id. A stale-seq frame can never introduce new state.
    dispatchFrame({
      type: "ui-state:updated",
      key: BROWSER_KEY,
      value: { entries: [{ id: "peer-b", ts: Date.now() }] },
      server_seq: 5,
      sourceClientId: "other-tab",
    });
    expect(getBrowserTombstones().has("peer-b")).toBe(false);

    // A genuinely newer seq applies — and MERGES (peer-a survives), proving
    // the receive side is additive-union, never a replace.
    dispatchFrame({
      type: "ui-state:updated",
      key: BROWSER_KEY,
      value: { entries: [{ id: "peer-b", ts: Date.now() }] },
      server_seq: 6,
      sourceClientId: "other-tab",
    });
    expect(getBrowserTombstones().has("peer-a")).toBe(true);
    expect(getBrowserTombstones().has("peer-b")).toBe(true);
  });
});
