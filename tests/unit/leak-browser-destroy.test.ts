/**
 * SUSPECT (C): the per-contextId registries of BrowserService, and the
 * `onDestroy` callback the server wires to them.
 *
 * `server.ts` passes `onDestroy: (contextId) => { clearBrowserCaches(contextId);
 * resetMoondreamCounter(contextId); }`. Those two flush Maps that live in OTHER
 * modules (`browser-tools-handler`'s observe + ref-snapshot caches,
 * `moondream-client`'s per-context call counter) and have no other way to
 * shrink. So the question is not "is destroyContext written correctly" but
 * "does one context leaving produce exactly one flush", plus "do the service's
 * own seven registries come back to where they started".
 *
 * THIS DRIVES THE REAL SERVICE. `createBrowserService` is the production
 * factory and `createContext` / `getOrCreate` / `destroyContext` are the
 * production methods. No logic is copied: the only injected thing is
 * `connectOverCDP`, the seam the module already exposes for its `chromium`
 * engine, so the cycles run against a fake CDP peer instead of launching a
 * real Chromium. The `chromium` engine is used precisely because it is the
 * branch with that seam; both engine branches leave through the same teardown.
 *
 * TWO WAYS OUT, and only one of them is the obvious one:
 *   1. `destroyContext(id)` - a pane the user closed.
 *   2. `getOrCreate(id)` finding `page.isClosed()` and discarding the entry.
 *      This is the one that matters: the very next line recreates a context
 *      under the SAME id, so a cache that was not flushed is now attached to a
 *      different page. That is the stale-ref hazard the callback exists to
 *      prevent, not just a few bytes of growth.
 *
 * The engine hint is the one registry that is SUPPOSED to survive a destroy -
 * it is how an engine switch is carried across teardown and remount
 * (setEngineHint -> destroyContext -> client remounts -> getOrCreate). The
 * last test below pins that down, so nobody "fixes" the leak by deleting the
 * hint and silently breaking the switch.
 *
 * @covers LEAK-01
 */
import { describe, expect, test } from "bun:test";
import { createBrowserService } from "../../server/browser-service";
import type { Browser } from "playwright-core";

/** The one line an aggregator parses. Same shape in all three leak measurements. */
function leakCounterLine(suspect: string, counter: string, before: number, after: number, cycles: number): void {
  const verdict = after === before ? "ok" : "LEAK";
  console.log(`LEAK-COUNTER ${suspect} | ${counter} | before=${before} after=${after} cycles=${cycles} | ${verdict}`);
}

const CYCLES = 25;
const ENDPOINT = "ws://127.0.0.1:19333/fake-cdp";

/**
 * A CDP peer that answers, and nothing more. Every method the chromium branch
 * of createContext / setupPage / destroyContext touches, and no behaviour of
 * its own: this is a stand-in for a browser, not a second implementation of
 * anything under measurement.
 */
function fakeChromium() {
  let pageClosed = false;
  const page = {
    on: () => page,
    url: () => "about:blank",
    title: async () => "",
    isClosed: () => pageClosed,
    close: async () => { pageClosed = true; },
    setViewportSize: async () => {},
  };
  const session = {
    send: async () => ({ targetInfo: { targetId: "target-fake" } }),
    detach: async () => {},
  };
  const context = {
    newPage: async () => { pageClosed = false; return page; },
    newCDPSession: async () => session,
    close: async () => {},
  };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {},
    isConnected: () => true,
  };
  return {
    connectOverCDP: async (): Promise<Browser> => browser as unknown as Browser,
    /** Simulate the page dying under us (Chromium crash, page closed remotely). */
    killPage: () => { pageClosed = true; },
  };
}

/** Sum of every per-contextId registry that must return to its baseline. */
type Sizes = ReturnType<Awaited<ReturnType<typeof createBrowserService>>["registrySizes"]>;

describe("suspect (C): browser context teardown", () => {
  test(`${CYCLES} create/destroy cycles leave every per-context registry empty`, async () => {
    const fake = fakeChromium();
    const flushed: string[] = [];
    const service = await createBrowserService({
      connectOverCDP: fake.connectOverCDP,
      onDestroy: (contextId) => { flushed.push(contextId); },
    });

    try {
      const before = service.registrySizes();
      /** Teardowns this test caused. One flush is owed per teardown. */
      let owed = 0;
      let peakContexts = 0;

      for (let i = 0; i < CYCLES; i++) {
        const id = `leak-ctx-${i}`;
        await service.createContext(id, { engine: "chromium", cdpEndpoint: ENDPOINT });
        // Populate the two hint Maps the way production does: the pane reports
        // its size on ws.onopen, the tool dispatcher labels the next action.
        await service.resize(id, 800, 600, 2);
        service.setAgentAction(id, "clicking something");
        peakContexts = Math.max(peakContexts, service.registrySizes().contexts);

        await service.destroyContext(id);
        owed++;
      }

      // A registry that never filled would return to baseline for the wrong
      // reason. It filled.
      expect(peakContexts).toBeGreaterThan(0);

      const after = service.registrySizes();
      const counters: (keyof Sizes)[] = [
        "contexts", "targetIds", "agentActionHints",
        "pendingViewportHints", "pendingEngineHints",
        "screencastSessions", "pendingCreates",
      ];
      for (const key of counters) {
        leakCounterLine("browser-destroy", key, before[key], after[key], CYCLES);
      }
      leakCounterLine("browser-destroy", "cache flushes owed minus delivered", 0, owed - flushed.length, CYCLES);

      for (const key of counters) expect(after[key], key).toBe(before[key]);
      expect(flushed.length).toBe(owed);
      expect(new Set(flushed).size).toBe(CYCLES);
    } finally {
      await service.close();
    }
  }, 25_000);

  test(`${CYCLES} dead-page discards flush their caches too, and recreate clean`, async () => {
    // The path `destroyContext` does not cover: `getOrCreate` throws away an
    // entry whose page died and builds a new one under the SAME id. If the
    // discard skips the callback, the observe/snapshot cache of the OLD page is
    // still there when the new one answers.
    const fake = fakeChromium();
    const flushed: string[] = [];
    const service = await createBrowserService({
      connectOverCDP: fake.connectOverCDP,
      onDestroy: (contextId) => { flushed.push(contextId); },
    });

    try {
      const before = service.registrySizes();
      let owed = 0;

      for (let i = 0; i < CYCLES; i++) {
        const id = `leak-dead-${i}`;
        // The hint is what keeps the recreate on the fake CDP peer. Without it
        // getOrCreate would fall back to the default engine and launch a real
        // headless Chromium, which is not what this measures.
        service.setEngineHint(id, "chromium", ENDPOINT);
        await service.getOrCreate(id);

        fake.killPage();
        const flushedBeforeDiscard = flushed.length;
        const revived = await service.getOrCreate(id);
        owed++;                                   // the discard is a teardown
        // Pinned per cycle, not just in the total: THIS discard has to produce
        // exactly one flush. At HEAD it produced none - the branch deleted
        // `contexts` / `targetIds` / `agentActionHints` and returned, so the
        // recreate below came up under an id whose observe cache still held
        // the dead page's elements.
        expect(flushed.length - flushedBeforeDiscard, `flush for discard of ${id}`).toBe(1);
        expect(flushed[flushed.length - 1]).toBe(id);
        expect(revived.page.isClosed()).toBe(false);
        expect(service.registrySizes().contexts).toBe(before.contexts + 1);

        await service.destroyContext(id);
        owed++;
        // Switch back to the default engine: that is the documented way the
        // hint is dropped, and it is what a pane that goes away for good would
        // never do on its own (see the last test).
        service.setEngineHint(id, "default");
      }

      const after = service.registrySizes();
      const counters: (keyof Sizes)[] = [
        "contexts", "targetIds", "agentActionHints",
        "pendingViewportHints", "pendingEngineHints",
        "screencastSessions", "pendingCreates",
      ];
      for (const key of counters) {
        leakCounterLine("browser-destroy", `${key} (dead-page discards)`, before[key], after[key], CYCLES);
      }
      leakCounterLine("browser-destroy", "cache flushes owed minus delivered (dead-page discards)", 0, owed - flushed.length, CYCLES);

      for (const key of counters) expect(after[key], key).toBe(before[key]);
      // Two teardowns per cycle: the discard and the explicit destroy.
      expect(owed).toBe(CYCLES * 2);
      expect(flushed.length).toBe(owed);
    } finally {
      await service.close();
    }
  }, 25_000);

  test("the engine hint outlives destroyContext ON PURPOSE, and only that", async () => {
    // The counter-proof for the test above. `applyEngineSwitch` is
    // setEngineHint -> destroyContext -> (the client remounts) -> getOrCreate,
    // so a teardown that dropped the hint would silently send every switched
    // pane back to the default engine. The hint is a per-pane preference, not
    // a cache: it is cleared by switching back, not by closing.
    const fake = fakeChromium();
    const service = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      service.setEngineHint("switch-ctx", "chromium", ENDPOINT);
      expect(service.registrySizes().pendingEngineHints).toBe(1);

      await service.getOrCreate("switch-ctx");
      await service.destroyContext("switch-ctx");
      expect(service.registrySizes().pendingEngineHints).toBe(1);

      // And the remount still lands on chromium, which is the whole point.
      const back = await service.getOrCreate("switch-ctx");
      expect(back.engine).toBe("chromium");

      await service.destroyContext("switch-ctx");
      service.setEngineHint("switch-ctx", "default");
      expect(service.registrySizes().pendingEngineHints).toBe(0);
    } finally {
      await service.close();
    }
  }, 20_000);
});
