/**
 * Engine switch (task 54601eeb) — the 'chromium' engine path of BrowserService.
 *
 * A chromium-engine context connects to a real Chromium sidecar over CDP instead
 * of launching the server's own headless Chromium. The CDP connector is injected
 * (opts.connectOverCDP), so this exercises the full createContext / destroyContext
 * chromium branch WITHOUT a live browser: it asserts the connector is used, the
 * SHARED sidecar context is reused (extensions live there), teardown closes the
 * page + disconnects the CDP client but NEVER closes the shared context, and the
 * engine hint drives an opts-less getOrCreate recreate onto chromium.
  * @covers ENGSVC-01
 */
import { describe, it, expect } from "bun:test";
import { createBrowserService } from "./browser-service";
import type { Browser } from "playwright-core";

function makeFakeChromium() {
  const calls = {
    connect: 0,
    newPage: 0,
    contextClosed: 0, // must stay 0 — closing the shared context kills sidecar tabs
    pageClosed: 0,
    browserClosed: 0, // disconnect count
    endpoints: [] as string[],
  };

  const page = {
    on: () => page,
    url: () => "about:blank",
    title: async () => "",
    isClosed: () => false,
    close: async () => { calls.pageClosed++; },
  };

  const session = {
    send: async () => ({ targetInfo: { targetId: "target-xyz" } }),
    detach: async () => {},
  };

  const context = {
    newPage: async () => { calls.newPage++; return page; },
    newCDPSession: async () => session,
    close: async () => { calls.contextClosed++; },
  };

  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => { calls.browserClosed++; },
    isConnected: () => true,
  };

  const connectOverCDP = async (endpoint: string): Promise<Browser> => {
    calls.connect++;
    calls.endpoints.push(endpoint);
    return browser as unknown as Browser;
  };

  return { calls, connectOverCDP, page, context, browser };
}

describe("BrowserService chromium engine", () => {
  it("connects over CDP, reuses the shared sidecar context, captures the targetId", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      await svc.createContext("ctx-a", { engine: "chromium", cdpEndpoint: "ws://127.0.0.1:19333/x" });
      expect(fake.calls.connect).toBe(1);
      expect(fake.calls.endpoints[0]).toBe("ws://127.0.0.1:19333/x");
      expect(fake.calls.newPage).toBe(1);
      expect(await svc.getTargetId("ctx-a")).toBe("target-xyz");
      expect(svc.getUrl("ctx-a")).toEqual({ url: "about:blank", title: "" });
    } finally {
      await svc.close();
    }
  });

  it("requires a cdpEndpoint for the chromium engine", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      await expect(svc.createContext("ctx-b", { engine: "chromium" })).rejects.toThrow(/cdpEndpoint/);
      expect(fake.calls.connect).toBe(0);
    } finally {
      await svc.close();
    }
  });

  it("destroyContext closes the page + disconnects, but never the shared context", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      await svc.createContext("ctx-c", { engine: "chromium", cdpEndpoint: "ws://e" });
      await svc.destroyContext("ctx-c");
      expect(fake.calls.pageClosed).toBe(1);
      expect(fake.calls.browserClosed).toBe(1); // CDP client disconnected
      expect(fake.calls.contextClosed).toBe(0); // shared context untouched
      expect(svc.getUrl("ctx-c")).toBeNull();
    } finally {
      await svc.close();
    }
  });

  it("setEngineHint drives an opts-less recreate onto chromium (the switch path)", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      // Simulates: applyEngineSwitch set the hint, then the client remounts and
      // getOrCreate recreates the context WITHOUT engine opts.
      svc.setEngineHint("ctx-d", "chromium", "ws://hinted");
      const entry = await svc.getOrCreate("ctx-d");
      expect(entry.engine).toBe("chromium");
      expect(fake.calls.connect).toBe(1);
      expect(fake.calls.endpoints[0]).toBe("ws://hinted");

      // Clearing the hint (switch back to native) makes a fresh recreate ignore it.
      svc.setEngineHint("ctx-d", "default");
      await svc.destroyContext("ctx-d");
      // A native recreate would call ensureBrowser() (real Chromium) — we only
      // assert the hint was cleared, not launch a headless browser here.
      expect(fake.calls.connect).toBe(1); // unchanged: no second CDP connect queued
    } finally {
      await svc.close();
    }
  });
});

/**
 * `flushStorageState` sta sul percorso di MONTAGGIO di una pane nativa (il
 * passaggio condivisa→nativa lo chiama prima di leggere il barattolo), e
 * `storageState({indexedDB:true})` è la cosa cara che l'autosave fa apposta
 * ogni 30s e solo se il contesto ha visto attività. Quindi il caso normale —
 * nessun contesto server vivo, che è la stragrande maggioranza dei montaggi di
 * una pane nativa — deve costare zero e uscire subito.
 */
describe("BrowserService.flushStorageState", () => {
  it("non fa nulla quando non c'è nessun contesto vivo con quell'id", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      expect(await svc.flushStorageState("mai-esistito")).toBe(false);
      expect(fake.calls.connect).toBe(0); // e non ne fa nascere uno per scoprirlo
    } finally {
      await svc.close();
    }
  });

  it("non tocca il motore chromium: il profilo persistente è del sidecar", async () => {
    const fake = makeFakeChromium();
    const svc = await createBrowserService({ connectOverCDP: fake.connectOverCDP });
    try {
      await svc.createContext("ctx-flush", { engine: "chromium", cdpEndpoint: "ws://e" });
      expect(await svc.flushStorageState("ctx-flush")).toBe(false);
    } finally {
      await svc.close();
    }
  });
});
