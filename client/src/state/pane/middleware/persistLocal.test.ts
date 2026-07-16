/**
 * Chat scroll persistence — the `pane-store-scroll-offsets` device-local key.
 *
 * `pane.scrollOffset` is stripped from BOTH snapshots (selectors) and from
 * every inbound hydrate (sanitizeSnapshot), so before this key existed a
 * reload always lost it and every chat reopened at the bottom. These tests
 * cover the round-trip: flush writes the map (positive offsets only, closed
 * panes pruned), boot hydrate re-applies it to live panes only.
 */
import { describe, test, expect, beforeEach } from "bun:test";

// Fake window stub (same pattern as bootstrap.test.ts / syncCrossTab.test.ts).
function installFakeWindow(): void {
  const store: Record<string, string> = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
}
installFakeWindow();

const { usePaneStore } = await import("../store");
const { hydrateFromLocalSnapshot, flushLocalPaneStoreNow } = await import("./persistLocal");

const SCROLL_KEY = "pane-store-scroll-offsets";

function mkPane(id: string) {
  return { id, type: "chat" as const, title: id };
}

function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    tombstones: {},
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

describe("persistLocal — chat scroll offsets (device-local key)", () => {
  test("flush writes positive offsets only and prunes closed panes", () => {
    usePaneStore.setState({
      panes: {
        "chat:a": { ...mkPane("chat:a"), scrollOffset: 300 },
        "chat:b": { ...mkPane("chat:b"), scrollOffset: 0 }, // bottom-anchor default: not worth keeping
        "chat:c": mkPane("chat:c"), // never scrolled
      },
    });
    flushLocalPaneStoreNow();
    const map = JSON.parse(localStorage.getItem(SCROLL_KEY)!);
    expect(map).toEqual({ "chat:a": 300 });

    // The pane closes → the next flush iterates live panes only → auto-prune.
    usePaneStore.setState({ panes: { "chat:c": mkPane("chat:c") } });
    flushLocalPaneStoreNow();
    expect(localStorage.getItem(SCROLL_KEY)).toBeNull();
  });

  test("boot hydrate re-applies saved offsets to live panes only", () => {
    localStorage.setItem(
      SCROLL_KEY,
      JSON.stringify({ "chat:a": 420, "chat:ghost": 99, "chat:bad": "nope", "chat:neg": -5 }),
    );
    usePaneStore.setState({ panes: { "chat:a": mkPane("chat:a") } });

    hydrateFromLocalSnapshot();

    const { panes } = usePaneStore.getState();
    expect(panes["chat:a"].scrollOffset).toBe(420);
    expect(panes["chat:ghost"]).toBeUndefined(); // no pane resurrected for a stale id
  });

  test("a later server hydrate does not wipe the restored offset", () => {
    // The HYDRATE_FROM_SNAPSHOT wholesale pane apply preserves device-local
    // scrollOffset (openedAt pattern) — the ~500ms-later server hydrate that
    // lands after boot must not reset the chat back to the bottom.
    localStorage.setItem(SCROLL_KEY, JSON.stringify({ "chat:a": 420 }));
    usePaneStore.setState({ panes: { "chat:a": mkPane("chat:a") } });
    hydrateFromLocalSnapshot();

    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          panes: { "chat:a": mkPane("chat:a") }, // server copy: scrollOffset stripped inbound
          groups: {},
          closedStack: [],
          groupOrder: [],
          lastSeq: 10,
          server_seq: 10,
          seq: 10,
        },
      },
    } as Parameters<ReturnType<typeof usePaneStore.getState>["dispatch"]>[0]);

    expect(usePaneStore.getState().panes["chat:a"].scrollOffset).toBe(420);
  });

  test("corrupt scroll map is ignored (best-effort)", () => {
    localStorage.setItem(SCROLL_KEY, "{not json");
    usePaneStore.setState({ panes: { "chat:a": mkPane("chat:a") } });
    hydrateFromLocalSnapshot(); // must not throw
    expect(usePaneStore.getState().panes["chat:a"].scrollOffset).toBeUndefined();
  });
});
