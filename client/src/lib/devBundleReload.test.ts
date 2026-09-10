/**
 * @covers BUNDLE-RELOAD-01
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

/**
 * Who decides a reload, and when nobody has to.
 *
 * A VISIBLE window is never yanked: a rev-mismatch frame only DISPATCHES
 * `topics:bundle-stale` and the prompt owns the decision (2026-07-20 — the old
 * unconditional auto-reload tore live panes away every few minutes on an
 * actively edited repo). A HIDDEN one reloads itself: there is nobody to
 * interrupt, and asking a person to press a button to be up to date is the
 * friction this exists to remove.
 *
 * Either way the navigation cache-busts, is capped, and first runs the
 * teardowns registered with `onBeforeBundleReload` — the native webviews a
 * reload would otherwise leave behind with no owner.
 */

type AnyFn = (...a: unknown[]) => unknown;

interface FakeState {
  replaceCalls: string[];
  dispatched: string[];
  sessionStore: Record<string, string>;
  /** content of the <meta name="topics-bundle-rev"> stamp; null = unstamped. */
  metaRev: string | null;
  /** Is the window hidden? Decides self-reload vs prompt. */
  hidden: boolean;
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
    hidden: false,
    history: { replaceState: (_s: unknown, _t: string, _u: string) => {}, state: null },
    document: {
      // `document.hidden` is the whole difference between "reload yourself" and
      // "ask": modelled here so both roads are exercised, not just the one this
      // machine happens to be on.
      hidden: state.hidden,
      // The client reads ONE stamped value now. Modelling the meta (instead of
      // a bag of <script src>) is the point: the old DOM scrape is what drifted.
      querySelector: (sel: string) =>
        sel.includes("topics-bundle-rev") && state.metaRev !== null
          ? { getAttribute: (name: string) => (name === "content" ? state.metaRev : null) }
          : null,
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
  fake = { replaceCalls: [], dispatched: [], sessionStore: {}, metaRev: "/assets/index-ABC123.js", hidden: false };
  installFakeWindow(fake);
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window; delete g.document; delete g.sessionStorage; delete g.history;
});

describe("devBundleReload — prompt, never auto-reload", () => {
  test("a rev-mismatch frame on a VISIBLE window dispatches bundle-stale and does NOT reload", async () => {
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
      // Server rev equals the rev stamped into the HTML we booted with, so
      // this window is fresh.
      dispatchFrame({ type: "ui:bundle-rev", rev: "/assets/index-ABC123.js" });
      expect(fake.dispatched.length).toBe(0);
      expect(fake.replaceCalls.length).toBe(0);
    } finally {
      stop();
    }
  });

  /**
   * NOBODY SHOULD PRESS A BUTTON TO BE UP TO DATE.
   *
   * The prompt is the right answer for a window somebody is looking at. It is
   * pure friction for a hidden one — and hidden is where most of these land,
   * because the rebuilds arrive while the person is working somewhere else. On
   * 2026-09-10 that was 19 landings in a day: nineteen banners for a window
   * that could have caught up on its own.
   */
  test("una finestra NASCOSTA si ricarica da sola, e non lascia un cartello da premere", async () => {
    fake.hidden = true;
    installFakeWindow(fake);
    const { initDevBundleReload, BUNDLE_STALE_EVENT } = await import("./devBundleReload");
    const { dispatchFrame } = await import("./wsFrameBus");
    const stop = initDevBundleReload();
    try {
      dispatchFrame({ type: "ui:bundle-updated", rev: "/assets/index-DIFFERENT" });
      expect(fake.replaceCalls.length).toBe(1);
      expect(fake.replaceCalls[0]).toContain("bundle-bust=");
      expect(fake.dispatched).not.toContain(BUNDLE_STALE_EVENT);
    } finally {
      stop();
    }
  });

  /**
   * A reload does not unmount the native child webviews: a browser pane's
   * WKWebView belongs to the window, not to the document, so `location.replace`
   * leaves it alive with no React owner and no later `browser_close` aimed at
   * it. Measured 2026-07-29: 14 GB, 61 WebContent processes with zero CPU in
   * twelve seconds. Whoever owns one registers its teardown here, and this is
   * the last moment it can run — which is why it must run BEFORE navigating,
   * and must NOT run when the cap says the navigation is not happening.
   */
  describe("i teardown registrati girano prima di navigare", () => {
    test("una ricarica vera li esegue, una volta, prima della navigazione", async () => {
      const { reloadForNewBundle, onBeforeBundleReload } = await import("./devBundleReload");
      const ordine: string[] = [];
      const off = onBeforeBundleReload(() => ordine.push("teardown"));
      try {
        reloadForNewBundle();
        expect(ordine).toEqual(["teardown"]);
        expect(fake.replaceCalls.length).toBe(1);
      } finally {
        off();
      }
    });

    test("oltre il tetto non si chiude niente: la navigazione non ci sara'", async () => {
      const { reloadForNewBundle, onBeforeBundleReload } = await import("./devBundleReload");
      let chiusure = 0;
      const off = onBeforeBundleReload(() => { chiusure++; });
      try {
        reloadForNewBundle();
        reloadForNewBundle();
        reloadForNewBundle();
        reloadForNewBundle();
        expect(fake.replaceCalls.length).toBe(3);
        expect(chiusure).toBe(3);
      } finally {
        off();
      }
    });

    test("un teardown che esplode non impedisce la ricarica", async () => {
      const { reloadForNewBundle, onBeforeBundleReload } = await import("./devBundleReload");
      const off = onBeforeBundleReload(() => { throw new Error("webview gia' morta"); });
      try {
        reloadForNewBundle();
        expect(fake.replaceCalls.length).toBe(1);
      } finally {
        off();
      }
    });
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

  // ── Regression: the phantom "nuova versione disponibile" loop ──────────────
  // The rev used to be re-derived by scraping every /assets/index-* out of the
  // LIVE DOM. Vite's preload helper appends <link rel="modulepreload"> tags for
  // lazy chunks at runtime, and several of those chunks are themselves named
  // index-* (any lazy module whose file is index.js). So the client's set grew
  // past index.html's and the comparison could NEVER match — a permanent stale
  // signal on the freshest possible build, returning on every reconnect, which
  // no reload could clear. Reading the single stamped value is what fixes it.
  test("a matching rev stays silent even though the page loaded lazy index-* chunks", async () => {
    const { initDevBundleReload } = await import("./devBundleReload");
    const { dispatchFrame } = await import("./wsFrameBus");
    // The document has since pulled in lazy chunks that are ALSO named index-*.
    // Under the old DOM scrape this window reported a different rev and nagged
    // forever; the stamp is unaffected by anything injected after boot.
    const stop = initDevBundleReload();
    try {
      dispatchFrame({ type: "ui:bundle-rev", rev: "/assets/index-ABC123.js" });
      expect(fake.dispatched.length).toBe(0);
    } finally {
      stop();
    }
  });

  test("an UNSTAMPED document opts out entirely (Tauri embedded/disk bundle)", async () => {
    // No meta → this window did not boot from our server, so reloading can
    // never make it converge. It must not prompt at all.
    fake.metaRev = null;
    const { initDevBundleReload } = await import("./devBundleReload");
    const { dispatchFrame } = await import("./wsFrameBus");
    const stop = initDevBundleReload();
    try {
      dispatchFrame({ type: "ui:bundle-updated", rev: "/assets/index-TOTALLY-OTHER.js" });
      expect(fake.dispatched.length).toBe(0);
      expect(fake.replaceCalls.length).toBe(0);
    } finally {
      stop();
    }
  });
});
