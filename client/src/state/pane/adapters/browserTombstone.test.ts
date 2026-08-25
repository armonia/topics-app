import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Browser-context tombstone contract. A browser pane closed INSIDE a project
 * window is suppressed on the next mount by this tombstone (the project's
 * `panes` useState seed consults getBrowserTombstones()), so it can't resurrect
 * from the persisted `nonChatPanes` snapshot after a reload. Mirrors the
 * terminal-session tombstone the project terminal-sync effect already relies on.
 *
 * @covers CD-CLOSE-01, CD-CLOSE-02
 */

// Minimal window + localStorage polyfill installed BEFORE importing the module,
// so its load-time `beforeunload` hook and lazy `localStorage` reads bind to the
// stub (Bun test has no DOM). Same shape as syncCrossTab.test.ts.
const fakeLocalStorage = Object.create(null) as Record<string, string>;
const fakeStorageApi = {
  getItem: (k: string) => (k in fakeLocalStorage ? fakeLocalStorage[k] : null),
  setItem: (k: string, v: string) => { fakeLocalStorage[k] = v; },
  removeItem: (k: string) => { delete fakeLocalStorage[k]; },
  clear: () => { for (const k of Object.keys(fakeLocalStorage)) delete fakeLocalStorage[k]; },
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: fakeStorageApi,
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { localStorage: unknown }).localStorage = fakeStorageApi;

const {
  addBrowserTombstone,
  clearBrowserTombstone,
  getBrowserTombstones,
} = await import("./closedTabRecord");

beforeEach(() => {
  fakeStorageApi.clear();
});

describe("browser tombstone", () => {
  test("add then read reports the context id as tombstoned", () => {
    addBrowserTombstone("proj-ctx-1");
    expect(getBrowserTombstones().has("proj-ctx-1")).toBe(true);
  });

  test("clear retracts the tombstone (reopen path)", () => {
    addBrowserTombstone("proj-ctx-1");
    clearBrowserTombstone("proj-ctx-1");
    expect(getBrowserTombstones().has("proj-ctx-1")).toBe(false);
  });

  test("add is idempotent — a context is tombstoned at most once", () => {
    addBrowserTombstone("proj-ctx-1");
    addBrowserTombstone("proj-ctx-1");
    const raw = fakeStorageApi.getItem("browser-context-tombstones");
    expect(JSON.parse(raw!)).toHaveLength(1);
  });

  test("distinct contexts are tracked independently", () => {
    addBrowserTombstone("a");
    addBrowserTombstone("b");
    const set = getBrowserTombstones();
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    clearBrowserTombstone("a");
    expect(getBrowserTombstones().has("a")).toBe(false);
    expect(getBrowserTombstones().has("b")).toBe(true);
  });

  test("an expired (older than the 5-min TTL) entry is not reported", () => {
    // Write a stale entry directly, bypassing the add helper's fresh timestamp.
    fakeStorageApi.setItem(
      "browser-context-tombstones",
      JSON.stringify([{ contextId: "stale", ts: Date.now() - 6 * 60 * 1000 }]),
    );
    expect(getBrowserTombstones().has("stale")).toBe(false);
  });
});
