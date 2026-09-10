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
const { __scheduleInitialLoadFallbackForTests, __stopInitialLoadFallbackForTests } =
  await import("./bootstrap");
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

/**
 * A stub whose answer changes per call: the retry ladder needs it, because the
 * whole point there is that attempt number N can succeed after the first ones
 * failed.
 */
function installFetchSequence(steps: Array<{ status?: number; body?: unknown } | "throws">): void {
  fetchCalls = 0;
  originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (): Promise<Response> => {
    const step = steps[Math.min(fetchCalls, steps.length - 1)]!;
    fetchCalls += 1;
    if (step === "throws") return Promise.reject(new Error("Load failed"));
    // `"body" in step` and NOT `step.body ?? {}`: a key never written answers
    // exactly `null`, and a `??` turned it into `{}` - that is, the stub
    // answered the one thing the case under test is not (measured: with the
    // defect put back, the test passed all the same).
    const body = "body" in step ? step.body : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: step.status ?? 200,
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
    // The pending retry is disarmed BEFORE the stub is removed: firing after
    // that, it would call the NEXT case's `fetch` and inflate its count (the
    // red that changes target every run).
    __stopInitialLoadFallbackForTests();
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

/**
 * A KEY NEVER WRITTEN IS AN ANSWER; A 5xx IS NOT.
 *
 * `markServerHydrated()` opens the gate that holds back every write towards
 * the server (the debounced PUT, the teardown flush, the `pagehide` beacon),
 * and that gate exists because of a failure documented in `syncServer.ts`: the
 * empty snapshot PUT over the good copy, with the tabs disappearing. So
 * "hydrated" has to mean "the server ANSWERED".
 *
 * The case nobody served is the NEW device. Measured against the live server
 * on 2026-09-10: a key never written answers `200` with a `null` body, not
 * 404. The old fallback read `.value` off that `null`, threw, and landed in
 * the mute `catch`; and the WS did not make up for it, because `syncWS`
 * returns early when the key is missing. Net result: the flag was NEVER
 * raised, and for the whole session no pane state reached the server.
 * @covers TAB-SYNC-01
 */
describe("bootstrap - the fallback tells \"I do not have it\" from \"I do not know\"", () => {
  beforeEach(() => {
    installFakeWindow();
    __resetServerHydratedForTests();
    resetStore();
  });
  afterEach(() => {
    __stopInitialLoadFallbackForTests();
    restoreFetch();
    uninstallFakeWindow();
  });

  test("a key never written (200 + null body): it hydrates, and does not retry", async () => {
    installFetchSequence([{ status: 200, body: null }]);
    __scheduleInitialLoadFallbackForTests();
    await waitForFallback();

    expect(fetchCalls).toBe(1);
    expect(hasReceivedServerHydrate(), "the server answered: there is nothing to protect").toBe(true);
  });

  test("a 404 counts as the same answer", async () => {
    installFetchSequence([{ status: 404, body: {} }]);
    __scheduleInitialLoadFallbackForTests();
    await waitForFallback();

    expect(hasReceivedServerHydrate()).toBe(true);
  });

  test("a 5xx does NOT hydrate, and is no longer the last word: it retries", async () => {
    // The first attempt fails, the second finds the server back with the real
    // row. The fallback used to be one-shot: past that `return` nobody tried
    // again, and the WS could not make up for it.
    installFetchSequence([
      { status: 503, body: {} },
      { status: 200, body: { value: { panes: {} }, server_seq: 12 } },
    ]);
    __scheduleInitialLoadFallbackForTests();
    await waitForFallback();
    expect(fetchCalls).toBe(1);
    expect(hasReceivedServerHydrate(), "a 5xx says nothing about the row").toBe(false);

    // The second rung of the ladder (1 s).
    await new Promise((r) => setTimeout(r, 1100));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCalls, "it tried again").toBe(2);
    expect(hasReceivedServerHydrate(), "and this time the server answered").toBe(true);
  });

  test("a network that is down does not hydrate either", async () => {
    installFetchSequence(["throws"]);
    __scheduleInitialLoadFallbackForTests();
    await waitForFallback();
    expect(fetchCalls).toBe(1);
    expect(hasReceivedServerHydrate()).toBe(false);
  });
});
