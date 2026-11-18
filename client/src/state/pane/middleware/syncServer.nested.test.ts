/**
 * Mirror mode of the pane-store writer: a client nested in a Topics browser
 * pane reads the shared layout but never PUTs it (fetch, keepalive or beacon),
 * or the real app opens every tab clicked inside the pane.
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from "bun:test";

const g = globalThis as unknown as Record<string, unknown>;
const REAL_FETCH = g.fetch;
const REAL_NAVIGATOR = g.navigator;

function installWindow(nested: boolean): void {
  const store: Record<string, string> = Object.create(null);
  const win: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  if (nested) win.__topicsConsoleInstalled = true;
  win.self = win;
  win.top = win;
  g.window = win;
  g.localStorage = win.localStorage;
}
installWindow(false);
afterAll(() => { delete g.window; delete g.localStorage; });

const { initServerSync, flushPaneStoreNow, __pushSnapshotForTests, __stopServerSyncForTests } =
  await import("./syncServer");
const { usePaneStore } = await import("../store");
const { markServerHydrated, __resetServerHydratedForTests } = await import("./serverHydrated");
const { __resetNestedPaneForTests } = await import("../../../lib/shell/nestedPane");

let writes: string[];
let beacons: string[];

beforeEach(() => {
  jest.useFakeTimers();
  writes = [];
  beacons = [];
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    writes.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ server_seq: 1 }), { status: 200 });
  };
  g.navigator = { sendBeacon: (url: string) => { beacons.push(String(url)); return true; } };
  markServerHydrated();
});

afterEach(() => {
  __stopServerSyncForTests();
  __resetServerHydratedForTests();
  jest.useRealTimers();
  g.fetch = REAL_FETCH;
  if (REAL_NAVIGATOR === undefined) delete g.navigator; else g.navigator = REAL_NAVIGATOR;
  __resetNestedPaneForTests();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

let paneCounter = 0;
function editLocally(): void {
  paneCounter += 1;
  usePaneStore.getState().dispatch({
    type: "OPEN_PANE",
    payload: { id: `terminal:nested-${paneCounter}`, type: "terminal", groupId: "group:default" },
  });
}

describe("syncServer inside a Topics pane", () => {
  test("control: outside a pane an edit is PUT to pane-store-v2", async () => {
    installWindow(false);
    __resetNestedPaneForTests();
    initServerSync();
    editLocally();
    jest.advanceTimersByTime(1500);
    await drain();
    expect(writes.some((w) => w.startsWith("PUT /api/ui-state/pane-store-v2"))).toBe(true);
  });

  test("nested: edits, direct push and explicit flush send nothing", async () => {
    installWindow(true);
    __resetNestedPaneForTests();
    initServerSync();
    editLocally();
    jest.advanceTimersByTime(1500);
    await drain();
    await __pushSnapshotForTests("pane-store-v2", { panes: {} }, 1);
    await flushPaneStoreNow();
    await drain();
    expect(writes).toEqual([]);
    expect(beacons).toEqual([]);
  });
});
