/**
 * Coverage for the resolveOps native-vs-Playwright gate + the awaitNativeCdpTarget
 * primitive in browser-tools-handler.ts.
 *
 * Regression contract for the "open_browser_pane shows about:blank / state resets
 * between turns" bug: when Electron is the host and a contextId owns a native
 * WebContentsView (native-bound), the browser tools must NOT silently fall back to
 * an invisible server-side Playwright context. They wait briefly for the CDP target
 * to (re)register and then either drive the real native view or FAIL LOUD — never a
 * phantom. In pure web mode (no Electron CDP) the Playwright path is unchanged.
 *
 * All global state touched here (the module-level cdpDispatcher, the CDP probe
 * cache, global.fetch) is restored in afterEach so this file can't pollute the
 * combined `bun test:unit` run.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  awaitNativeCdpTarget,
  handleBrowserObserve,
  setBrowserCdpDispatcher,
} from "./browser-tools-handler";
import { resetCdpProbeCache } from "./electron-cdp-probe";
import type { ElectronCdpDispatcher } from "./browser-cdp-dispatcher";

const realFetch = globalThis.fetch;

/** Make isElectronCdpAvailable() resolve true by stubbing the /json/version probe. */
function stubElectronUp(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ Browser: "Chrome/130 Electron/33" }), { status: 200 })) as unknown as typeof fetch;
  resetCdpProbeCache();
}

/** Build a mock dispatcher with controllable target resolution. */
function mockDispatcher(opts: {
  targetId?: string | null;
  nativeBound?: boolean;
  getPage?: () => Promise<never>;
}): ElectronCdpDispatcher {
  return {
    registerTarget() {},
    getTargetId: () => opts.targetId ?? null,
    isNativeBound: () => !!opts.nativeBound,
    unregisterTarget() {},
    getPage: opts.getPage ?? (async () => { throw new Error("getPage should not be called"); }),
    close: async () => {},
  };
}

afterEach(() => {
  setBrowserCdpDispatcher(null);
  resetCdpProbeCache();
  globalThis.fetch = realFetch;
});

describe("awaitNativeCdpTarget", () => {
  test("returns null fast in web mode (no dispatcher)", async () => {
    setBrowserCdpDispatcher(null);
    const t0 = Date.now();
    expect(await awaitNativeCdpTarget("ctx", 2000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500); // did not poll the full timeout
  });

  test("resolves the target id immediately when already registered", async () => {
    stubElectronUp();
    setBrowserCdpDispatcher(mockDispatcher({ targetId: "tid-42", nativeBound: true }));
    expect(await awaitNativeCdpTarget("ctx", 2000)).toBe("tid-42");
  });

  test("returns null after the timeout when the target never appears", async () => {
    stubElectronUp();
    setBrowserCdpDispatcher(mockDispatcher({ targetId: null, nativeBound: true }));
    const t0 = Date.now();
    expect(await awaitNativeCdpTarget("ctx", 250)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });
});

describe("resolveOps gate (via handleBrowserObserve)", () => {
  test("native-bound context with no CDP target FAILS LOUD instead of using a Playwright phantom", async () => {
    stubElectronUp();
    setBrowserCdpDispatcher(mockDispatcher({ targetId: null, nativeBound: true }));
    // Bare service: if resolveOps wrongly fell back to Playwright it would touch
    // these and throw a different error; the "not ready" message proves the guard.
    const service = {} as never;
    await expect(handleBrowserObserve(service, "ctx", {})).rejects.toThrow(/not ready/i);
  }, 8000);

  test("drives the native view over CDP (no Playwright) when the target is registered", async () => {
    stubElectronUp();
    const getPage = async (): Promise<never> => { throw new Error("SENTINEL_CDP_PATH"); };
    setBrowserCdpDispatcher(mockDispatcher({ targetId: "tid-7", nativeBound: true, getPage }));
    const service = {
      broadcastAgentActive() {},
    } as never;
    // cdpOps.snapshot resolves via dispatcher.getPage → our sentinel surfaces,
    // proving the CDP adapter (not playwrightOps) was selected.
    await expect(handleBrowserObserve(service, "ctx", {})).rejects.toThrow(/SENTINEL_CDP_PATH/);
  });
});
