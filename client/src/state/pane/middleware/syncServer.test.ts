/**
 * Tests for finding #13 — syncServer inflight coalescing.
 *
 * Scope: verify that launching a new PUT for the same key aborts any prior
 * inflight PUT (including its retry chain), and that the retry chain respects
 * AbortSignal so a stale chain can't "win" against a newer snapshot.
 *
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";

// Minimal browser-ish globals so the module imports without blowing up under
// bun:test. syncCrossTab is imported by syncServer (for getTabId), and it
// reads `window`/`localStorage` lazily — see selfEcho.test.ts for the model.
type StorageArea = Record<string, string>;
function installFakeWindow(): void {
  const store: StorageArea = Object.create(null);
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
function uninstallFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

installFakeWindow();
// Every afterEach re-installs the fake for the next test; nothing took it down
// once the FILE was done, so `window` + `localStorage` outlived it into the
// next file of the same `bun test` process.
afterAll(() => uninstallFakeWindow());

const {
  __getInflightKeys,
  __resetInflightForTests,
  __pushSnapshotForTests,
  __teardownFlushUrlForTests,
  PANE_STORE_REMOTE_KEY,
} = await import("./syncServer");
const { usePaneStore } = await import("../store");
const { __resetSelfEchoForTests } = await import("./selfEcho");

// Record each fetch call + the AbortSignal we received so tests can assert
// the old PUT is cancelled when a new one starts.
interface FetchCall {
  url: string;
  signal: AbortSignal | undefined;
  aborted: boolean;
}
let fetchCalls: FetchCall[];
let originalFetch: typeof fetch | undefined;

/**
 * Install a fetch stub that never resolves (simulates a slow server). Each
 * call records the signal so the test can observe abort propagation.
 */
function installHangingFetch(): void {
  fetchCalls = [];
  originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (
    url: string,
    init?: { signal?: AbortSignal },
  ): Promise<Response> => {
    const entry: FetchCall = { url, signal: init?.signal, aborted: false };
    fetchCalls.push(entry);
    return new Promise((_resolve, reject) => {
      if (init?.signal) {
        init.signal.addEventListener(
          "abort",
          () => {
            entry.aborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      }
      // Never resolve the happy path — the test controls timing via abort.
    });
  };
}

function restoreFetch(): void {
  if (originalFetch !== undefined) {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  } else {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
  }
}

describe("syncServer — inflight coalescing (finding #13)", () => {
  beforeEach(() => {
    __resetInflightForTests();
    __resetSelfEchoForTests();
    installHangingFetch();
  });
  afterEach(() => {
    __resetInflightForTests();
    restoreFetch();
    uninstallFakeWindow();
    installFakeWindow();
  });

  test(
    "new PUT for the same key aborts the prior inflight PUT",
    async () => {
      // First PUT — snapshot seq 5
      const first = __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 5 }, 5);
      // Give the microtask queue a spin so fetch is called.
      await Promise.resolve();
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].aborted).toBe(false);
      // Inflight Map should hold exactly our key.
      expect(__getInflightKeys()).toContain(PANE_STORE_REMOTE_KEY);

      // Second PUT — snapshot seq 6 (newer)
      const second = __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 6 }, 6);
      await Promise.resolve();

      // The first fetch must now be aborted (signal fired → AbortError).
      expect(fetchCalls[0].aborted).toBe(true);
      // A second fetch must have been issued with a different signal.
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[1].aborted).toBe(false);
      expect(fetchCalls[0].signal).not.toBe(fetchCalls[1].signal);

      // The first promise resolves silently (AbortError is swallowed).
      await expect(first).resolves.toBeUndefined();

      // Cleanup: abort the second so this test can finish.
      __resetInflightForTests();
      await expect(second).resolves.toBeUndefined();
      // Inflight slot is now empty.
      expect(__getInflightKeys()).toEqual([]);
    },
  );

  test(
    "inflight slot is cleaned up after a PUT completes (success path)",
    async () => {
      // Swap in a fetch that resolves 200 with a server_seq.
      (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ server_seq: 99 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      await __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 99 }, 99);
      expect(__getInflightKeys()).toEqual([]);
    },
  );

  test(
    "AbortError from a superseded PUT is swallowed (not counted as failure)",
    async () => {
      const p1 = __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1);
      await Promise.resolve();
      // Trigger supersession.
      const p2 = __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 2 }, 2);
      await Promise.resolve();
      // p1 must resolve (not reject) even though its fetch aborted.
      await expect(p1).resolves.toBeUndefined();
      // Cleanup p2.
      __resetInflightForTests();
      await expect(p2).resolves.toBeUndefined();
    },
  );
});

/**
 * Compare-and-swap base on the TEARDOWN flush paths.
 *
 * The defect: the server stamps every PUT with a fresh, higher `server_seq`,
 * and the client's HYDRATE gate compares `server_seq` — so a snapshot that is
 * genuinely OLD still outranks everything once written. A tab that slept
 * through another device's edits and then fires `pagehide` drags every other
 * device back in time. `?base=` lets the server refuse that write (409).
 */
describe("syncServer — CAS base on teardown flush", () => {
  beforeEach(() => {
    __resetInflightForTests();
    __resetSelfEchoForTests();
    usePaneStore.setState((d) => { d.lastServerSeq = 0; });
  });
  afterEach(() => {
    __resetInflightForTests();
    restoreFetch();
    uninstallFakeWindow();
    installFakeWindow();
  });

  test("the teardown URL declares the base seq the tab last saw", () => {
    expect(__teardownFlushUrlForTests(42)).toBe("/api/ui-state/pane-store-v2?base=42");
    // A tab that never saw a server frame declares base 0 — which is exactly
    // what the server reads for a row that does not exist yet.
    expect(__teardownFlushUrlForTests(0)).toBe("/api/ui-state/pane-store-v2?base=0");
  });

  test("a PUT with a base carries it on the query string; one without does not", async () => {
    installHangingFetch();
    void __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1, 7);
    await Promise.resolve();
    expect(fetchCalls[0].url).toBe("/api/ui-state/pane-store-v2?base=7");

    __resetInflightForTests();
    void __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 2 }, 2);
    await Promise.resolve();
    expect(fetchCalls[1].url).toBe("/api/ui-state/pane-store-v2");
    __resetInflightForTests();
  });

  test("409 is TERMINAL — the stale snapshot is never retried", async () => {
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "stale_base", server_seq: 12 }), { status: 409 }),
      );
    };
    await __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1, 3);
    // Exactly one attempt: retrying would re-send the same refused body, and if
    // the row ever settled it would succeed at overwriting fresher state —
    // which is the bug the gate exists to prevent.
    expect(calls).toBe(1);
    expect(__getInflightKeys()).toEqual([]);
  });

  test("a 5xx still retries — only the CAS conflict is terminal", async () => {
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> => {
      calls++;
      return Promise.resolve(new Response("boom", { status: 500 }));
    };
    await __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1, 3);
    expect(calls).toBeGreaterThan(1);
  });

  test("an accepted write advances the base, so the NEXT teardown flush isn't self-blocked", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ server_seq: 55 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    expect(usePaneStore.getState().lastServerSeq).toBe(0);
    await __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1);
    // Our own write never comes back through HYDRATE (the self-echo filter
    // drops it), so without this the base would freeze at the last REMOTE
    // frame and every teardown flush after a local edit would 409 forever.
    expect(usePaneStore.getState().lastServerSeq).toBe(55);
  });

  test("the base only ever moves forward", async () => {
    usePaneStore.setState((d) => { d.lastServerSeq = 90; });
    (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ server_seq: 12 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    await __pushSnapshotForTests(PANE_STORE_REMOTE_KEY, { lastSeq: 1 }, 1);
    expect(usePaneStore.getState().lastServerSeq).toBe(90);
  });
});
