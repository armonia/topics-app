/**
 * COUNTER BENCH: the destroy callback of a browser context.
 *
 * `BrowserService` takes an `onDestroy(contextId)` and the server wires the
 * flush of everything it keys by contextId to it: the browser_observe element
 * cache, the ref snapshot cache, the vision-call counter. Those Maps live in
 * other modules and have no other way to shrink, so the question is not "is
 * the callback correct" but "does it fire once per context that leaves".
 *
 * So this file counts. It drives the REAL service (the chromium-engine branch,
 * whose CDP connector is injectable, so no browser is launched) through N
 * cycles of each way a context can leave, and compares the number of contexts
 * that went away with the number of callbacks that ran. An inspection of
 * `destroyContext` would have said "it fires"; the count says on which path it
 * did not.
 *
 * Three exits, not one:
 *   1. `destroyContext` - the explicit close of a pane.
 *   2. `getOrCreate` finding the page dead and discarding the entry. This is
 *      the one that matters most: the very next line recreates a context under
 *      the SAME id, which is the stale-snapshot case the callback exists for.
 *   3. the whole service closing.
 *
 * @covers LEAK-04
 */
import { describe, expect, test } from "bun:test";
import { createBrowserService } from "./browser-service";
import type { Browser } from "playwright-core";

const CYCLES = 12;

/** A CDP sidecar that never existed: pages, contexts and browser are objects. */
function makeFakeChromium() {
  let pageAlive = true;
  const page = {
    on: () => page,
    url: () => "about:blank",
    title: async () => "",
    isClosed: () => !pageAlive,
    close: async () => { pageAlive = false; },
  };
  const session = {
    send: async () => ({ targetInfo: { targetId: "target-xyz" } }),
    detach: async () => {},
  };
  const context = {
    newPage: async () => { pageAlive = true; return page; },
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
    /** The page died under us: a crash, or a close from the other side. */
    killPage: () => { pageAlive = false; },
  };
}

/** The service plus a counter of the callbacks it fired, by contextId. */
async function bench() {
  const fake = makeFakeChromium();
  const destroyed: string[] = [];
  const svc = await createBrowserService({
    connectOverCDP: fake.connectOverCDP,
    onDestroy: (id) => { destroyed.push(id); },
  });
  return { svc, destroyed, fake };
}

function report(name: string, before: number, after: number, cycles: number): void {
  const ok = before === after ? "ok" : "LEAK";
  console.log(
    `LEAK-COUNTER context-destroy | ${name} | before=${before} after=${after} cycles=${cycles} | ${ok}`,
  );
}

describe("browser context destroy callbacks", () => {
  test("an explicit destroy fires the callback once per pane, and leaves no context", async () => {
    const { svc, destroyed } = await bench();
    const before = svc.listContexts().length;
    try {
      for (let i = 0; i < CYCLES; i++) {
        await svc.createContext(`ctx-${i}`, { engine: "chromium", cdpEndpoint: "ws://e" });
        await svc.destroyContext(`ctx-${i}`);
      }
      const after = svc.listContexts().length;
      report("live contexts (explicit destroy)", before, after, CYCLES);
      report("callbacks owed vs fired", CYCLES, destroyed.length, CYCLES);
      expect(after).toBe(before);
      expect(destroyed.length).toBe(CYCLES);
    } finally {
      await svc.close();
    }
  });

  test("a context discarded because its page died fires it too (same id is reused right after)", async () => {
    const { svc, destroyed, fake } = await bench();
    const before = svc.listContexts().length;
    try {
      // ONE id, reopened N times: the pane the user keeps coming back to while
      // the page behind it dies. Before the fix this loop produced zero
      // callbacks, so the observe snapshot of cycle 1 was still there, under
      // this id, when cycle 12 recreated the context.
      svc.setEngineHint("ctx-churn", "chromium", "ws://e");
      for (let i = 0; i < CYCLES; i++) {
        await svc.getOrCreate("ctx-churn");
        fake.killPage();
      }
      const live = svc.listContexts().length;
      report("callbacks owed vs fired (dead-page discard)", CYCLES - 1, destroyed.length, CYCLES);
      // N cycles, N-1 discards: the first one had nothing to discard, and the
      // last context created is still alive at the end of the loop.
      expect(destroyed.length).toBe(CYCLES - 1);
      expect(destroyed.every((id) => id === "ctx-churn")).toBe(true);
      expect(live).toBe(before + 1);
    } finally {
      await svc.close();
    }
  });

  test("closing the service does not drop the contexts silently", async () => {
    const { svc, destroyed } = await bench();
    for (let i = 0; i < CYCLES; i++) {
      await svc.createContext(`ctx-close-${i}`, { engine: "chromium", cdpEndpoint: "ws://e" });
    }
    await svc.close();
    report("callbacks owed vs fired (service close)", CYCLES, destroyed.length, CYCLES);
    expect(destroyed.length).toBe(CYCLES);
    expect(svc.listContexts().length).toBe(0);
  });
});
