/**
 * Per-pane browser ENGINE registry — the server half of the engine switch.
 *
 * Each browser pane runs on one of two engines:
 *   - "native"   → the lightweight WKWebView/WebView2/WebKitGTK pane (default,
 *                  zero extra processes). The agent reaches it via the native
 *                  delegate registry (browser-native-delegate.ts).
 *   - "chromium" → a real Chromium-family browser the user already has installed,
 *                  driven over CDP, so their Chrome extensions load. Provided
 *                  on-demand by the ref-counted sidecar (browser-chromium-sidecar.ts).
 *
 * This module owns ONLY the contextId → engine mapping and the sidecar
 * bookkeeping, so switching a pane to "chromium" acquires exactly one sidecar
 * ref and switching back (or closing the pane) releases exactly one — no
 * double-acquire, no leaked ref. It is cross-platform by construction: the
 * chromium engine is a CDP endpoint, identical on macOS / Windows (Edge/WebView2
 * host is Chromium too) / Linux, unlike the native pane which is OS-specific.
 *
 * The sidecar is dependency-injected so the state machine is unit-tested without
 * launching a browser.
 */

import { createChromiumSidecar, type SidecarHandle } from "./browser-chromium-sidecar";
import { discoverInstalledExtensions } from "./browser-chromium-extensions";

export type BrowserEngine = "native" | "chromium";

/** The subset of the chromium sidecar this registry needs (injectable for tests). */
export interface EngineSidecar {
  acquire(): Promise<SidecarHandle>;
  release(): void;
}

export interface BrowserEngineRegistry {
  /** Current engine for a pane (defaults to "native" for unknown contexts). */
  getEngine(contextId: string): BrowserEngine;
  /**
   * Switch a pane's engine. Idempotent: setting the engine a pane already runs
   * is a no-op that returns the current state (no extra acquire/release).
   * Switching to "chromium" acquires one sidecar ref and returns its CDP
   * endpoint; switching to "native" releases the ref this pane held.
   */
  setEngine(contextId: string, engine: BrowserEngine): Promise<EngineState>;
  /**
   * Drop a pane entirely (closed / client gone). Releases its sidecar ref iff it
   * was on the chromium engine. Safe to call for unknown/native contexts.
   */
  release(contextId: string): void;
  /** Every context currently on the chromium engine (introspection / tests). */
  listChromium(): string[];
  /** Count of tracked contexts. */
  size(): number;
}

export interface EngineState {
  engine: BrowserEngine;
  /** Present only when engine === "chromium". */
  cdpEndpoint?: string;
}

interface Entry {
  engine: BrowserEngine;
  /** The CDP endpoint of the sidecar ref this context holds (chromium only). */
  cdpEndpoint?: string;
}

export function createBrowserEngineRegistry(deps: {
  sidecar: EngineSidecar;
}): BrowserEngineRegistry {
  const { sidecar } = deps;
  const entries = new Map<string, Entry>();

  function current(contextId: string): Entry {
    return entries.get(contextId) ?? { engine: "native" };
  }

  return {
    getEngine(contextId) {
      return current(contextId).engine;
    },

    async setEngine(contextId, engine) {
      const entry = current(contextId);
      if (entry.engine === engine) {
        // Idempotent — no ref churn. Return the live state as-is.
        return { engine, ...(entry.cdpEndpoint ? { cdpEndpoint: entry.cdpEndpoint } : {}) };
      }

      if (engine === "chromium") {
        // native → chromium: take exactly one ref. If the cold start fails, the
        // pane stays native (the sidecar already rolled its own ref back).
        const handle = await sidecar.acquire();
        entries.set(contextId, { engine: "chromium", cdpEndpoint: handle.cdpEndpoint });
        return { engine: "chromium", cdpEndpoint: handle.cdpEndpoint };
      }

      // chromium → native: release the one ref this pane held, forget the endpoint.
      if (entry.engine === "chromium") sidecar.release();
      entries.set(contextId, { engine: "native" });
      return { engine: "native" };
    },

    release(contextId) {
      const entry = entries.get(contextId);
      if (!entry) return;
      if (entry.engine === "chromium") sidecar.release();
      entries.delete(contextId);
    },

    listChromium() {
      return [...entries.entries()]
        .filter(([, e]) => e.engine === "chromium")
        .map(([id]) => id);
    },

    size() {
      return entries.size;
    },
  };
}

/**
 * Process-wide singletons used by the live server (the /ws/browser route wires
 * setEngine/release when a client toggles a pane's engine; the tool dispatcher
 * reads getEngine to route ops to native vs the chromium CDP endpoint). Both are
 * lazy: constructing the sidecar launches NOTHING until the first chromium pane
 * acquires it. Tests build their own via createChromiumSidecar / the injectable
 * sidecar. Live WS/route wiring + CDP screencast are the remaining LIVE pieces.
 */
// Option 1 (decision 2026-07-19): the sidecar loads the user's ALREADY-installed
// Chrome-family extensions (code) into its dedicated, PERSISTENT profile — the
// user logs into them once inside the pane and the login sticks. Discovery is a
// thunk → runs only when the first chromium pane actually launches, not at import.
export const chromiumSidecar = createChromiumSidecar({
  loadExtensions: () => discoverInstalledExtensions().map((e) => e.path),
});
export const browserEngineRegistry = createBrowserEngineRegistry({ sidecar: chromiumSidecar });
