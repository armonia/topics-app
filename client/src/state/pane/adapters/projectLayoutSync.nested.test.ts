/**
 * Mirror mode of the project-channel writer: nested in a Topics browser pane,
 * a layout edit is saved locally but never PUT or beaconed to the server.
 * @covers LAYOUT-02
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from "bun:test";

const g = globalThis as unknown as Record<string, unknown>;
const REAL_FETCH = g.fetch;
const REAL_NAVIGATOR = g.navigator;
const pageHide: Array<() => void> = [];

function installWindow(nested: boolean): void {
  const store: Record<string, string> = Object.create(null);
  const win: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
    addEventListener: (type: string, fn: () => void) => { if (type === "pagehide") pageHide.push(fn); },
    removeEventListener: () => {},
  };
  if (nested) win.__topicsConsoleInstalled = true;
  win.self = win;
  win.top = win;
  g.window = win;
  g.localStorage = win.localStorage;
  g.document = { visibilityState: "visible" };
}
installWindow(false);
afterAll(() => { delete g.window; delete g.localStorage; delete g.document; });

const { saveProjectLayout, projectPanesLocalKey, __flushAllProjectSyncForTests, __resetProjectSyncForTests } =
  await import("./projectLayoutSync");
const { __resetNestedPaneForTests } = await import("../../../lib/shell/nestedPane");

const PROJECT = "/work/nested-demo";
const KEY = projectPanesLocalKey(PROJECT);
const layout = { nonChatPanes: [{ id: "board:1", type: "board" }], openChatTopicIds: [] };

let puts: string[];
let beacons: string[];

beforeEach(() => {
  jest.useFakeTimers();
  __resetProjectSyncForTests();
  puts = [];
  beacons = [];
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    puts.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ server_seq: 1 }), { status: 200 });
  };
  g.navigator = { sendBeacon: (url: string) => { beacons.push(String(url)); return true; } };
});

afterEach(() => {
  jest.useRealTimers();
  __resetProjectSyncForTests();
  g.fetch = REAL_FETCH;
  if (REAL_NAVIGATOR === undefined) delete g.navigator; else g.navigator = REAL_NAVIGATOR;
  __resetNestedPaneForTests();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

describe("projectLayoutSync inside a Topics pane", () => {
  test("control: outside a pane the edit is PUT after the debounce", async () => {
    installWindow(false);
    __resetNestedPaneForTests();
    saveProjectLayout(KEY, PROJECT, layout);
    jest.advanceTimersByTime(1500);
    await drain();
    expect(puts.some((p) => p.startsWith(`PUT /api/ui-state/${encodeURIComponent(KEY)}`))).toBe(true);
  });

  test("nested: debounce, teardown flush and beacon send nothing; the edit stays local", async () => {
    installWindow(true);
    __resetNestedPaneForTests();
    saveProjectLayout(KEY, PROJECT, layout);
    jest.advanceTimersByTime(1500);
    await drain();
    __flushAllProjectSyncForTests();
    for (const fn of pageHide) fn();
    await drain();
    expect(puts).toEqual([]);
    expect(beacons).toEqual([]);
    expect(JSON.parse((g.localStorage as Storage).getItem(KEY) ?? "null")).toEqual(layout);
  });
});
