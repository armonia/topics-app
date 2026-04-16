import { describe, test, expect, beforeEach, afterEach } from "bun:test";

type StorageListener = (event: {
  key: string | null;
  newValue: string | null;
  storageArea: unknown;
}) => void;

// Minimal window + localStorage polyfill so syncCrossTab (normally
// Vite/browser-only) runs in the Bun test sandbox. Single set of module
// imports — using `?testcase=` queries creates separate module instances
// and the listener ends up bound to a different zustand store than the test
// reads from.
function installFakeWindow() {
  const listeners: StorageListener[] = [];
  const fakeLocalStorage = Object.create(null) as Record<string, string>;
  const fakeStorageApi = {
    getItem: (k: string) => (k in fakeLocalStorage ? fakeLocalStorage[k] : null),
    setItem: (k: string, v: string) => {
      fakeLocalStorage[k] = v;
    },
    removeItem: (k: string) => {
      delete fakeLocalStorage[k];
    },
    clear: () => {
      for (const k of Object.keys(fakeLocalStorage)) delete fakeLocalStorage[k];
    },
  };
  const fakeWindow = {
    localStorage: fakeStorageApi,
    addEventListener(kind: string, cb: StorageListener) {
      if (kind === "storage") listeners.push(cb);
    },
    removeEventListener(_k: string, _cb: StorageListener) {},
  };
  (globalThis as unknown as { window: unknown }).window = fakeWindow;
  (globalThis as unknown as { localStorage: unknown }).localStorage = fakeStorageApi;
  return { listeners, fakeStorageApi };
}

function uninstallFakeWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

// Install the fake window BEFORE importing modules so the syncCrossTab
// listener registers against a controlled stub, and lazy reads of `localStorage`
// inside the store's devtools bail harmlessly.
installFakeWindow();
// Re-install per-test (each test gets fresh listeners/localStorage) — but
// keep the SAME imported modules so the zustand store singleton, the
// syncCrossTab module scope, and the test all share identity.
const { usePaneStore } = await import("../store");
const {
  initCrossTabSync,
  getTabId,
  __resetTabIdForTests,
} = await import("./syncCrossTab");

function resetStore(): void {
  // Baseline: reset lastSeq + buckets to 0 so each test starts from a clean
  // slate without relying on module reloads. (HYDRATE requires strict-greater
  // than local lastSeq, so leakage between tests would mask bugs.)
  usePaneStore.setState({
    panes: {},
    groups: {},
    projects: {},
    closedStack: [],
    focusedPaneId: null,
    groupOrder: [],
    lastSeq: 0,
  });
}

describe("syncCrossTab — tabId allocation (bug #4)", () => {
  beforeEach(() => {
    installFakeWindow();
    __resetTabIdForTests();
    resetStore();
  });
  afterEach(() => uninstallFakeWindow());

  test("getTabId returns a stable per-tab identifier", () => {
    const a = getTabId();
    const b = getTabId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe("string");
    expect(a).toBe(b);
  });

  test("getTabId produces different ids across fresh middleware instances", () => {
    const aId = getTabId();
    // Simulate a different tab by resetting the in-module identifier.
    __resetTabIdForTests();
    const bId = getTabId();
    expect(aId).not.toBe(bId);
  });
});

describe("syncCrossTab — self-suppression (bug #4)", () => {
  let fake: ReturnType<typeof installFakeWindow>;
  beforeEach(() => {
    fake = installFakeWindow();
    __resetTabIdForTests();
    resetStore();
  });
  afterEach(() => uninstallFakeWindow());

  test("storage event with matching senderId is ignored (no HYDRATE)", () => {
    initCrossTabSync();
    const tabId = getTabId();

    expect(usePaneStore.getState().lastSeq).toBe(0);

    const selfPayload = JSON.stringify({
      panes: {},
      groups: {},
      projects: {},
      groupOrder: [],
      closedStack: [],
      lastSeq: 99,
      senderId: tabId, // MATCH — self-originated
    });

    const win = (globalThis as unknown as { window: { localStorage: unknown } }).window;
    fake.listeners[0]({
      key: "pane-store-v2",
      newValue: selfPayload,
      // Must match `window.localStorage` so the I2/I7 storageArea guard passes.
      storageArea: win.localStorage,
    });

    // lastSeq MUST still be 0 — self-echo was suppressed.
    expect(usePaneStore.getState().lastSeq).toBe(0);
  });

  test("storage event from a different tab is applied (senderId differs)", () => {
    initCrossTabSync();
    const myId = getTabId();

    const foreignPayload = JSON.stringify({
      panes: {},
      groups: {},
      projects: {},
      groupOrder: [],
      closedStack: [],
      lastSeq: 100,
      senderId: `${myId}-other-tab`, // DIFFERENT — not self
    });

    const win = (globalThis as unknown as { window: { localStorage: unknown } }).window;
    fake.listeners[0]({
      key: "pane-store-v2",
      newValue: foreignPayload,
      storageArea: win.localStorage,
    });

    expect(usePaneStore.getState().lastSeq).toBe(100);
  });

  test("storage event with missing senderId is still applied (back-compat)", () => {
    initCrossTabSync();

    // Legacy snapshot written by an older tab before bug #4 fix — no senderId.
    const legacyPayload = JSON.stringify({
      panes: {},
      groups: {},
      projects: {},
      groupOrder: [],
      closedStack: [],
      lastSeq: 50,
    });

    const win = (globalThis as unknown as { window: { localStorage: unknown } }).window;
    fake.listeners[0]({
      key: "pane-store-v2",
      newValue: legacyPayload,
      storageArea: win.localStorage,
    });

    expect(usePaneStore.getState().lastSeq).toBe(50);
  });
});
