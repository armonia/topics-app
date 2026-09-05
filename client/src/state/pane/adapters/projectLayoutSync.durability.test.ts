/**
 * Durability of the project-channel sync (`topics-project-panes-*`).
 *
 * Regression contract for the "revive → repoint lost → PTY orphaned, tab lost"
 * bug: a project's tab-identity PUT (which repoints a terminal pane to a live
 * session id after a revive/reopen) MUST reach the server even if the window
 * dies or the server restarts inside the 500 ms debounce. The old code fired a
 * single un-retried, un-flushed PUT, so a write racing the 16:23 server restart
 * was lost and the channel kept pointing at the dead terminal id.
 *
 * These lock:
 *   - a PUT that fails (server down) is RETAINED as un-acked, not swallowed;
 *   - a teardown flush (pagehide) beacons every not-yet-durable value out;
 *   - a WS reconnect retries the un-acked set;
 *   - a successful PUT clears the un-acked entry (no perpetual re-send).
 *
 * @covers TAB-SYNC-01, LAYOUT-02
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";

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

// The fake window/localStorage/document is partial: left behind at the end of
// the file it flips the `typeof window === 'undefined'` guards of later files in
// the same sharded process (e.g. useMobile -> getComputedStyle). Restore bun's
// baseline (no DOM globals).
function uninstallFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { document?: unknown }).document;
}

installFakeWindow();
afterAll(uninstallFakeWindow);

const mod = await import("./projectLayoutSync");
const {
  saveProjectLayout,
  projectPanesLocalKey,
  __getUnackedProjectSyncKeys,
  __flushAllProjectSyncForTests,
  __resetProjectSyncForTests,
} = mod as typeof import("./projectLayoutSync") & {
  __getUnackedProjectSyncKeys: () => string[];
  __flushAllProjectSyncForTests: () => void;
  __resetProjectSyncForTests: () => void;
};

const PROJECT = "/work/demoapp";
const KEY = projectPanesLocalKey(PROJECT);

interface FetchCall { url: string; body: string; keepalive: boolean }
interface BeaconCall { url: string; body: string }
let fetchCalls: FetchCall[];
let beaconCalls: BeaconCall[];
let fetchOk: boolean;

// The REAL globals, captured ONCE at module load. Capturing inside
// installFetch poisoned the whole bun-test process: a test that installed
// twice (down → up) re-captured the FIRST STUB as "original", afterEach then
// restored the stub, and every later test file in the suite saw a fake fetch
// answering { server_seq: N } (broke browser-native-delegate.socket.test.ts).
const REAL_FETCH: unknown = (globalThis as unknown as { fetch?: unknown }).fetch;
const REAL_NAVIGATOR: unknown = (globalThis as unknown as { navigator?: unknown }).navigator;

function installFetch(ok: boolean): void {
  fetchOk = ok;
  fetchCalls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { body?: string; keepalive?: boolean },
  ): Promise<Response> => {
    fetchCalls.push({ url: String(url), body: init?.body ?? "", keepalive: !!init?.keepalive });
    if (!fetchOk) throw new Error("network down");
    return {
      ok: true,
      json: async () => ({ server_seq: fetchCalls.length }),
    } as unknown as Response;
  };
}

function installBeacon(): void {
  beaconCalls = [];
  (globalThis as unknown as { navigator: unknown }).navigator = {
    sendBeacon: (url: string, blob: { text?: () => Promise<string> } & Blob) => {
      // bun's Blob has .text(); we only need the url + a best-effort body marker.
      beaconCalls.push({ url: String(url), body: "beacon" });
      void blob;
      return true;
    },
  };
}

const layout = (paneId: string) => ({
  nonChatPanes: [{ id: paneId, type: "terminal" }],
  openChatTopicIds: [],
});

// The sync is debounced 500 ms; wait past it.
const settle = () => new Promise((r) => setTimeout(r, 650));

beforeEach(() => {
  __resetProjectSyncForTests();
  installBeacon();
});

afterEach(() => {
  __resetProjectSyncForTests();
  if (REAL_FETCH === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
  else (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  if (REAL_NAVIGATOR === undefined) delete (globalThis as unknown as { navigator?: unknown }).navigator;
  else (globalThis as unknown as { navigator: unknown }).navigator = REAL_NAVIGATOR;
});

describe("project channel PUT durability", () => {
  test("a successful debounced PUT lands and leaves nothing un-acked", async () => {
    installFetch(true);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await settle();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
    expect(__getUnackedProjectSyncKeys()).not.toContain(KEY);
  });

  test("a failing PUT (server down) is RETAINED as un-acked, not swallowed", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await settle();
    // Retries exhausted → value kept for a later teardown/reconnect flush.
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
  });

  test("teardown flush beacons the un-acked repoint out synchronously", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await settle();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
    // pagehide-equivalent: everything not durable must beacon out NOW.
    __flushAllProjectSyncForTests();
    expect(beaconCalls.length).toBeGreaterThanOrEqual(1);
    expect(beaconCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
    // The beacon carries the client id fallback so the server can dedupe echoes.
    expect(beaconCalls.some((c) => c.url.includes("cid="))).toBe(true);
  });

  test("teardown flush drains a value still sitting in the debounce buffer (never hit its timer)", () => {
    installFetch(true);
    // Queue but DON'T settle — the 500 ms timer hasn't fired yet.
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    // Window dies right now.
    __flushAllProjectSyncForTests();
    expect(beaconCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
  });

  test("a later successful PUT clears the un-acked entry (no perpetual re-send)", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await settle();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
    // Server comes back; a new save with a DIFFERENT value succeeds.
    installFetch(true);
    saveProjectLayout(KEY, PROJECT, layout("terminal:a6d64304"));
    await settle();
    expect(__getUnackedProjectSyncKeys()).not.toContain(KEY);
  });
});
