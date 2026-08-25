/**
 * Tests for the browser-spawner registry.
 *
 * The store is module-level singleton state, so each test needs to reset it
 * via clearBrowserSpawner. We can't re-import to get a clean instance because
 * sessionStorage is checked once at module load.
  * @covers BROWSER-STATE-02
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";

// Minimal sessionStorage shim — the module reads on import and writes on every
// mutation. A plain Record-backed implementation is sufficient.
function installFakeStorage(): void {
  const store: Record<string, string> = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = storageApi;
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: storageApi };
}

installFakeStorage();

// Clean up the globals this file installs at module-load. `bun test` runs every
// file in one process, so a partial `window`/`sessionStorage` left on
// `globalThis` leaks into other test files loaded later (load order is
// filesystem-dependent — passed on macOS, broke CI Linux). In particular a stub
// `window` WITHOUT `addEventListener` made modules that register listeners at
// import throw (closedTabRecord.ts). Mirrors the cleanup the sibling DOM-stub
// tests (bootstrap/syncServer/openExternal/browserNavUrl) already do.
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
});

const {
  setBrowserSpawner,
  getBrowserSpawner,
  getSpawnedBrowser,
  clearBrowserSpawner,
  subscribeBrowserSpawner,
  resolveTerminalBrowserContext,
} = await import("./browserSpawner");

function reset(): void {
  // Wipe by enumerating known ids set during tests. Simpler than re-importing.
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
}

describe("browserSpawner", () => {
  beforeEach(() => {
    reset();
    // Clear any in-memory leftovers from prior tests by overwriting then
    // clearing every key that may have been set.
    for (const ctx of ["b1", "b2", "b3"]) clearBrowserSpawner(ctx);
  });

  test("setBrowserSpawner stores both directions", () => {
    setBrowserSpawner("b1", "topic-A");
    expect(getBrowserSpawner("b1")).toBe("topic-A");
    expect(getSpawnedBrowser("topic-A")).toBe("b1");
  });

  test("same browser re-mapped to a different topic drops the old reciprocal", () => {
    setBrowserSpawner("b1", "topic-A");
    setBrowserSpawner("b1", "topic-B");
    expect(getBrowserSpawner("b1")).toBe("topic-B");
    expect(getSpawnedBrowser("topic-B")).toBe("b1");
    // topic-A no longer points at b1 — otherwise the chat header would
    // surface a stale jump button to a browser it no longer owns.
    expect(getSpawnedBrowser("topic-A")).toBeNull();
  });

  test("same topic spawning a new browser updates the reciprocal", () => {
    setBrowserSpawner("b1", "topic-A");
    setBrowserSpawner("b2", "topic-A");
    expect(getSpawnedBrowser("topic-A")).toBe("b2");
    // Old browser b1 still maps to topic-A — the user might re-focus it
    // manually. Only the topic→browser direction tracks "most recent".
    expect(getBrowserSpawner("b1")).toBe("topic-A");
    expect(getBrowserSpawner("b2")).toBe("topic-A");
  });

  test("clearBrowserSpawner removes both directions", () => {
    setBrowserSpawner("b1", "topic-A");
    clearBrowserSpawner("b1");
    expect(getBrowserSpawner("b1")).toBeNull();
    expect(getSpawnedBrowser("topic-A")).toBeNull();
  });

  test("no-op writes do not notify subscribers", () => {
    let fires = 0;
    const off = subscribeBrowserSpawner(() => { fires += 1; });
    setBrowserSpawner("b1", "topic-A");
    expect(fires).toBe(1);
    setBrowserSpawner("b1", "topic-A");
    expect(fires).toBe(1);
    off();
  });

  test("missing args are rejected silently", () => {
    setBrowserSpawner("", "topic-A");
    setBrowserSpawner("b1", "");
    expect(getBrowserSpawner("b1")).toBeNull();
    expect(getSpawnedBrowser("topic-A")).toBeNull();
  });

  test("subscriber receives notifications on real changes", () => {
    let fires = 0;
    const off = subscribeBrowserSpawner(() => { fires += 1; });
    setBrowserSpawner("b1", "topic-A");
    setBrowserSpawner("b2", "topic-B");
    clearBrowserSpawner("b1");
    expect(fires).toBe(3);
    off();
  });
});

describe("resolveTerminalBrowserContext", () => {
  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearBrowserSpawner("browser-ctx-1");
  });

  test("non-terminal ids pass through unchanged", () => {
    // A chat topic's pane binds to its own ctx — the close broadcast already
    // carries the right id, so no remap.
    expect(resolveTerminalBrowserContext("topic-abc")).toBe("topic-abc");
    setBrowserSpawner("browser-ctx-1", "topic-abc");
    expect(resolveTerminalBrowserContext("topic-abc")).toBe("topic-abc");
  });

  test("term-<id> resolves to the browser ctx the terminal spawned", () => {
    // Open path records: setBrowserSpawner(browserCtx, `terminal:<id>`).
    setBrowserSpawner("browser-ctx-1", "terminal:d1b33bbe");
    // Server close broadcast carries `term-<id>` — map it back to the real pane
    // so the terminal that opened it can actually close it.
    expect(resolveTerminalBrowserContext("term-d1b33bbe")).toBe("browser-ctx-1");
  });

  test("term-<id> with no recorded spawner falls back to itself", () => {
    // Nothing opened → nothing to remap; the raw id is a harmless no-op target.
    expect(resolveTerminalBrowserContext("term-unknown")).toBe("term-unknown");
  });
});
