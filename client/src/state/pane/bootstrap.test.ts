/**
 * Tests for finding #14 — bootstrap GET fallback suppression gate.
 *
 * The previous `lastSeq > 0` gate suppressed the fallback for ANY local
 * dispatch (e.g. an early `OPEN_PANE`). Now the gate is the
 * `hasReceivedServerHydrate()` module flag, which flips only when syncWS
 * processes a real server frame OR the fallback GET itself completes.
 *
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { blankPaneState } from "./testSupport";

// Fake window stub (same pattern as syncCrossTab.test.ts).
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
function uninstallFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}
installFakeWindow();

const { usePaneStore } = await import("./store");
const { __scheduleInitialLoadFallbackForTests } = await import("./bootstrap");
const { __resetServerHydratedForTests, hasReceivedServerHydrate, markServerHydrated } =
  await import("./middleware/serverHydrated");

function resetStore(): void {
  // `setState` FONDE: i campi non elencati sopravvivono al reset. Mancavano
  // `tombstones`, `spaces`, `activeSpaceId` e `lastServerSeq`, quindi un
  // marcatore lasciato da un test precedente entrava nel successivo — e
  // proprio i tombstone sono ciò che impedisce a una pane chiusa di tornare.
  // Nessun tipo se ne accorgeva: `setState` accetta un parziale.
  usePaneStore.setState(blankPaneState());
}

// fetch stub with assertable call count.
let fetchCalls: number;
let originalFetch: typeof fetch | undefined;
// `Partial<Response>` era una promessa che questo finto non mantiene: di
// `Response` usa solo lo status, e `body` qui non e' lo stream di `Response`
// (`ReadableStream | null`) ma il JSON da serializzare. Il tipo ora dice quello
// che la funzione accetta davvero — `{ data: {}, meta: {} }` non e' uno stream.
function installFetchStub(response: { status?: number; body?: unknown }): void {
  fetchCalls = 0;
  originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? {}), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}
function restoreFetch(): void {
  if (originalFetch !== undefined) {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  } else {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
  }
}

/** Yield past the 500ms setTimeout + the awaited fetch chain. */
async function waitForFallback(): Promise<void> {
  await new Promise((r) => setTimeout(r, 550));
  // One extra microtask flush for the chained `.then`s inside the fallback.
  await Promise.resolve();
  await Promise.resolve();
}

describe("bootstrap — scheduleInitialLoadFallback gate (finding #14)", () => {
  beforeEach(() => {
    installFakeWindow();
    __resetServerHydratedForTests();
    resetStore();
    installFetchStub({ status: 200, body: { data: {}, meta: {} } });
  });
  afterEach(() => {
    restoreFetch();
    uninstallFakeWindow();
  });

  test(
    "OPEN_PANE (local dispatch) does NOT suppress the fallback when no server hydrate arrived",
    async () => {
      // Dispatch a local action — this bumps lastSeq > 0 but must NOT gate
      // the fallback (that was the bug).
      usePaneStore.getState().dispatch({
        type: "OPEN_PANE",
        payload: {
          id: "pane:1",
          type: "chat",
          title: "x",
          groupId: "group:default",
        },
      });
      expect(usePaneStore.getState().lastSeq).toBeGreaterThan(0);
      expect(hasReceivedServerHydrate()).toBe(false);

      __scheduleInitialLoadFallbackForTests();
      await waitForFallback();

      // GET must have fired — the local dispatch must NOT have suppressed it.
      expect(fetchCalls).toBe(1);
      // And the fallback must flip the hydrated flag on success.
      expect(hasReceivedServerHydrate()).toBe(true);
    },
  );

  test(
    "fallback is suppressed once markServerHydrated() has fired (e.g. WS init)",
    async () => {
      // Simulate syncWS receiving a real ui-state:init before the 500ms timer.
      markServerHydrated();

      __scheduleInitialLoadFallbackForTests();
      await waitForFallback();

      // GET must NOT have fired — the WS init already hydrated us.
      expect(fetchCalls).toBe(0);
    },
  );

  test(
    "failed GET (non-2xx) does NOT mark serverHydrated — leaves the door open",
    async () => {
      restoreFetch();
      installFetchStub({ status: 503, body: {} });

      __scheduleInitialLoadFallbackForTests();
      await waitForFallback();

      expect(fetchCalls).toBe(1);
      // 5xx response: the tab is NOT hydrated. A later caller (or future
      // retry) can still legitimately fire.
      expect(hasReceivedServerHydrate()).toBe(false);
    },
  );
});
