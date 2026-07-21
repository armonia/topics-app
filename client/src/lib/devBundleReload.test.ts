import { describe, test, expect, beforeEach, afterEach } from "bun:test";

/**
 * devBundleReload no longer auto-reloads (2026-07-20). A rev-mismatch frame
 * must only DISPATCH `topics:bundle-stale` — never call location.replace out
 * from under the user. The manual reloadForNewBundle() is the only path that
 * navigates, and it cache-busts.
 */

type AnyFn = (...a: unknown[]) => unknown;

interface FakeState {
  replaceCalls: string[];
  dispatched: string[];
  sessionStore: Record<string, string>;
  scripts: string[]; // src values the DOM "exposes"
}

let fake: FakeState;

function installFakeWindow(state: FakeState) {
  const listeners: Record<string, AnyFn[]> = {};
  const sessionStorage = {
    getItem: (k: string) => (k in state.sessionStore ? state.sessionStore[k] : null),
    setItem: (k: string, v: string) => { state.sessionStore[k] = v; },
    removeItem: (k: string) => { delete state.sessionStore[k]; },
  };
  const location = {
    href: "https://macbook:3333/",
    replace: (u: string) => { state.replaceCalls.push(u); },
  };
  const fakeWindow = {
    location,
    sessionStorage,
    history: { replaceState: (_s: unknown, _t: string, _u: string) => {}, state: null },
    document: {
      querySelectorAll: (_sel: string) =>
        state.scripts.map((src) => ({
          getAttribute: (name: string) => (name === "src" ? src : null),
        })),
    },
    addEventListener(kind: string, cb: AnyFn) { (listeners[kind] ||= []).push(cb); },
    removeEventListener(kind: string, cb: AnyFn) {
      listeners[kind] = (listeners[kind] || []).filter((f) => f !== cb);
    },
    dispatchEvent(ev: { type: string }) { state.dispatched.push(ev.type); return true; },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = fakeWindow;
  g.document = fakeWindow.document;
  g.sessionStorage = sessionStorage;
  g.history = fakeWindow.history;
  // Minimal CustomEvent shim (Bun has one, but keep the type flowing to dispatchEvent).
  if (typeof (g.CustomEvent as unknown) !== "function") {
    g.CustomEvent = class { type: string; constructor(t: string) { this.type = t; } } as unknown;
  }
}

beforeEach(() => {
  fake = { replaceCalls: [], dispatched: [], sessionStore: {}, scripts: ["/assets/index-ABC123.js"] };
  installFakeWindow(fake);
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window; delete g.document; delete g.sessionStorage; delete g.history;
});

describe("devBundleReload — prompt, never auto-reload", () => {
  test("a rev-mismatch frame dispatches bundle-stale and does NOT reload", async () => {
    const { initDevBundleReload, BUNDLE_STALE_EVENT } = await import("./devBundleReload");
    const { dispatchFrame } = await import("./wsFrameBus");
    const stop = initDevBundleReload();
    try {
      dispatchFrame({ type: "ui:bundle-updated", rev: "/assets/index-DIFFERENT" });
      expect(fake.dispatched).toContain(BUNDLE_STALE_EVENT);
      expect(fake.replaceCalls.length).toBe(0);
    } finally {
      stop();
    }
  });

  test("a matching rev is silent (no stale, no reload)", async () => {
    const { initDevBundleReload } = await import("./devBundleReload");
    const { dispatchFrame } = await import("./wsFrameBus");
    const stop = initDevBundleReload();
    try {
      // Server rev equals our own DOM-derived entry rev (the regex keeps the
      // `.js` — the char class includes `.`), so this window is fresh.
      dispatchFrame({ type: "ui:bundle-rev", rev: "/assets/index-ABC123.js" });
      expect(fake.dispatched.length).toBe(0);
      expect(fake.replaceCalls.length).toBe(0);
    } finally {
      stop();
    }
  });

  test("reloadForNewBundle cache-busts and caps attempts", async () => {
    const { reloadForNewBundle } = await import("./devBundleReload");
    reloadForNewBundle();
    expect(fake.replaceCalls.length).toBe(1);
    expect(fake.replaceCalls[0]).toContain("bundle-bust=");
    // Cap at MAX_RELOAD_ATTEMPTS (3): a 4th call is a no-op (stale cache loop guard).
    reloadForNewBundle();
    reloadForNewBundle();
    reloadForNewBundle();
    expect(fake.replaceCalls.length).toBe(3);
  });
});
