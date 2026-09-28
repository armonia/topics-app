/**
 * THE TAURI SHELL, FAKED IN ONE PLACE, WITH ITS NETWORK SENT HOME.
 *
 * Some specs need the page to believe it runs inside the desktop shell: the
 * native browser pane, the machine's `perf_metrics`, the IPC drains. The shell
 * is recognised by one global, `window.__TAURI_INTERNALS__`, so faking it is
 * one assignment in an init script. That assignment also turns on EVERYTHING
 * else `isTauri` gates, and one of those things is `lib/shell/net.ts`: every
 * API call and every WebSocket goes to `127.0.0.1:13333`, the loopback proxy
 * the real shell runs in Rust in front of the production server.
 *
 * WHAT IT COST (28/09/2026). On a developer Mac that address is not empty: it
 * is the proxy of the REAL Topics.app, which forwards to production on :3333.
 * Specs run under WebKit against the isolated test server on :13334 reached
 * the live server: its log showed requests with `ref=http://localhost:13334`,
 * CORS preflights answered 404, and WebSocket handshakes from the test page.
 * CI never saw it, because no proxy runs on a CI runner and the same calls
 * simply failed there. Three specs already sent the proxy home with their own
 * copy of the rewrite; two files did not (`perf-panel.spec.ts` and
 * `withMachineNumbers` in `identity-stub.ts`).
 *
 * SO THIS IS THE ONLY WAY TO FAKE THE SHELL, and `tests/unit/
 * e2e-fake-tauri-shell-single-door.test.ts` fails on any other file under
 * `tests/e2e` that names the global. A driver that is not Playwright (the raw
 * CDP scripts in `tests/manual`, run against the Windows PC where the same
 * address is the installed Topics.app) cannot call this helper, so it injects
 * the rewrite itself through `sendProxyHomeScript()`, and the same test fails
 * on a file there that names the global without it.
 *
 * TWO LAYERS, AND WHICH ONE CARRIES THE LOAD.
 *
 * 1. The REWRITE is primary. In the page, before the app boots, `fetch` and
 *    `WebSocket` are wrapped so that `//127.0.0.1:13333` becomes the page's own
 *    origin, the test server. It is the only layer that keeps the app WORKING:
 *    the calls stay same-origin (no CORS, the same cookies), which is what the
 *    real shell has, a server behind that address. A Playwright route cannot
 *    do it for a socket (`connectToServer()` connects to the URL the page
 *    asked for, there is no other), and fulfilling a cross-origin `fetch` from
 *    a route would need CORS headers the real proxy never sends. Those two are
 *    the only doors `net.ts`-based code opens from script: `serverHttpBase()`
 *    feeds `fetch` (through `installNetShim`) and a few URLs, `serverWsBase()`
 *    feeds `new WebSocket`. `installNetShim` also subclasses `EventSource`, but
 *    no client code constructs one, and no client code uses `XMLHttpRequest`
 *    (grep of client/src, 28/09).
 *
 * 2. The ROUTES are the belt, at the Playwright level, on the whole context
 *    (a popup opened by the page is covered too). Any HTTP request to the live
 *    app on loopback, on the proxy port or on the production port, is aborted;
 *    any WebSocket to it is closed without ever connecting. They catch what no
 *    script rewrite can reach: an `<img>` or an iframe whose URL was built on
 *    `serverHttpBase()` (the profile banner, media and preview URLs), a beacon,
 *    a popup. Aborting and not fulfilling is deliberate: it is exactly what CI
 *    sees for those requests, since nothing listens on 13333 there.
 *
 * ORDER MATTERS FOR THE SOCKET BELT. `routeWebSocket` works by replacing
 * `window.WebSocket` with Playwright's mock in an init script of its own, and
 * the mock keeps the constructor it found. The belt is therefore installed
 * BEFORE the fake's init script, so the rewrite wraps the mock and the mock
 * only ever sees URLs that are already home; installed after, the mock would
 * wrap the rewrite and close the app's socket before the rewrite could run.
 * A spec that adds its own `routeWebSocket` later is fine: the mock is
 * injected once per document.
 */
import type { Page } from "@playwright/test";

/**
 * `DESKTOP_SERVER_HOST` of `client/src/lib/shell/net.ts` (and `PROXY_PORT` of
 * `desktop-tauri/src-tauri/src/lib.rs`). The unit guard checks the two agree:
 * if the shell's proxy ever moves, this file has to move with it or the leak
 * comes back on the new port.
 */
export const SHELL_PROXY_HOST = "127.0.0.1:13333";

/** The live app on this machine, at either loopback door: the shell's proxy
 *  and the production server behind it (3333, `DEFAULT_UPSTREAM_PORT`). */
const LIVE_APP_DOORS = `(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):(?:${SHELL_PROXY_HOST.split(":")[1]}|3333)(?:[/?#]|$)`;
const LIVE_APP_HTTP = new RegExp(`^https?://${LIVE_APP_DOORS}`);
const LIVE_APP_WS = new RegExp(`^wss?://${LIVE_APP_DOORS}`);

/** The shell's IPC entry point, as the caller answers it. A plain value, a
 *  promise or a throw: the fake hands the app a promise in every case, as the
 *  real `invoke` does. */
type TauriInvoke = (cmd: string, args?: unknown) => unknown;

/**
 * Fake the Tauri shell on `page`, with the loopback proxy sent home.
 *
 * `setup` runs IN THE PAGE, before the app's first module, and returns the
 * `invoke` handler. It is serialised like any `addInitScript` function, so it
 * may only use `arg` (JSON) and page globals, never a variable of the spec.
 * It is also the place for any other page-side state the spec needs next to
 * the shell (a call recorder, a visibility override).
 *
 * Call it before the first navigation, as any init script.
 */
export async function fakeTauriShell<A = undefined>(
  page: Page,
  setup: (arg: A) => TauriInvoke,
  arg?: A,
): Promise<void> {
  const context = page.context();
  await context.route(LIVE_APP_HTTP, (route) => route.abort("blockedbyclient"));
  await context.routeWebSocket(LIVE_APP_WS, (ws) => {
    void ws.close({ code: 1008, reason: "e2e: the live Topics app is out of bounds" });
  });
  await page.addInitScript({
    content: [
      sendProxyHomeScript(),
      `(${installShell.toString()})((${setup.toString()})(${arg === undefined ? "undefined" : JSON.stringify(arg)}));`,
    ].join("\n"),
  });
}

/**
 * The rewrite as page source, for a driver that injects init scripts without
 * Playwright (`Page.addScriptToEvaluateOnNewDocument` over raw CDP). Like any
 * init script it must run before the app's first module. This file only
 * imports Playwright's TYPES, so importing it costs such a driver nothing.
 */
export function sendProxyHomeScript(): string {
  return `(${sendProxyHome.toString()})(${JSON.stringify(SHELL_PROXY_HOST)});`;
}

/** Page side: rewrite the shell's proxy origin onto the page's own origin. */
function sendProxyHome(proxyHost: string): void {
  const httpProxy = `http://${proxyHost}`;
  const wsProxy = `ws://${proxyHost}`;
  const wsOrigin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  const home = (url: string): string =>
    url.startsWith(httpProxy) ? location.origin + url.slice(httpProxy.length)
    : url.startsWith(wsProxy) ? wsOrigin + url.slice(wsProxy.length)
    : url;

  // `installNetShim` wraps the `fetch` it finds at boot, which is this one: it
  // hands over the URL already pointed at the proxy, and it goes home here.
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") return realFetch(home(input), init);
    if (input instanceof URL) return realFetch(home(input.href), init);
    const url = home(input.url);
    return realFetch(url === input.url ? input : new Request(url, input), init);
  }) as typeof fetch;

  // Sockets do not pass through the shim: the call sites build the URL with
  // `serverWsBase()`, so the constructor is intercepted. A Proxy and not a
  // subclass, so the static constants (OPEN, CLOSED...) stay the real ones;
  // `newTarget` is forwarded so a subclass of it still gets its own prototype.
  window.WebSocket = new Proxy(window.WebSocket, {
    construct: (target, args: unknown[], newTarget) =>
      Reflect.construct(target, [home(String(args[0])), ...args.slice(1)], newTarget),
  });
}

/** Page side: the global the app reads to decide it runs in the shell. */
function installShell(invoke: TauriInvoke): void {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    invoke: (cmd: string, args?: unknown) => {
      try {
        return Promise.resolve(invoke(cmd, args));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}
