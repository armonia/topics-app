/**
 * The sockets around a native pane that hosts its context's DOM mirror.
 *
 * `lib/native-dom-host.ts` is the protocol (who hosts, what a late viewer
 * replays); this is the wiring to the /ws/browser sockets of a context: who gets
 * the host's events, when the recorder runs, what a viewer's frame turns into,
 * and what happens when the host comes or goes. Lifted out of server.ts with the
 * sockets and the browser service injected, so it is tested with fakes.
 *
 * The rule it keeps: while a native pane hosts a context, nothing here calls the
 * browser service on the viewers' behalf. Every one of its methods would create
 * the Chromium context the host replaces.
 */
import type { BrowserService } from "./browser-service";
import { sendBrowserWsMessage, type BrowserWsMessage } from "../shared/browser-ws-messages";
import type { DomHostRegistry, HostFrame } from "./lib/native-dom-host";

/** The little of a browser socket this module uses (a Bun ServerWebSocket fits). */
export interface MirrorSocket {
  readyState: number;
  data: {
    _domRender?: boolean;
    _nativeDelegate?: boolean;
    _watching?: boolean;
    _browserSetStream?: (active: boolean) => void;
  };
  send(text: string): unknown;
}

export interface HostMirrorDeps {
  hosts: DomHostRegistry;
  /** The open sockets of a context. */
  sockets: (contextId: string) => Iterable<MirrorSocket>;
  browser: Pick<BrowserService, "enableDomMode" | "destroyContext" | "navigate">;
  /**
   * How long viewers keep the last mirror after the host drops, before the
   * server's Chromium takes over. The executor socket comes back in 1-2 s after
   * an ordinary blip (nativeExecutorSocket.ts), and a Chromium launched for a
   * blip would be thrown away the moment the pane returns.
   */
  fallbackGraceMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const OPEN = 1;

export function createHostMirror(deps: HostMirrorDeps) {
  const { hosts, browser } = deps;
  const graceMs = deps.fallbackGraceMs ?? 8_000;
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const fallbacks = new Map<string, () => void>();

  const send = (ws: MirrorSocket, msg: BrowserWsMessage): boolean => {
    try { sendBrowserWsMessage(ws, msg); return true; } catch { return false; }
  };
  const viewersOf = (contextId: string): MirrorSocket[] =>
    [...deps.sockets(contextId)].filter((w) => w.readyState === OPEN && !w.data._nativeDelegate);
  /** The viewers that render the page as a DOM mirror. */
  const mirrorsOf = (contextId: string): MirrorSocket[] => viewersOf(contextId).filter((w) => w.data._domRender);

  const sendPage = (ws: MirrorSocket, contextId: string): void => {
    const page = hosts.page(contextId);
    if (!page) return;
    send(ws, {
      type: "nav", url: page.url, phase: "response",
      ...(page.canGoBack !== undefined ? { canGoBack: page.canGoBack } : {}),
      ...(page.canGoForward !== undefined ? { canGoForward: page.canGoForward } : {}),
    });
  };

  /** The recorder runs on the host while a mirror is on screen somewhere, and only then. */
  const sync = (contextId: string): void => {
    if (!hosts.isHosting(contextId)) return;
    hosts.setWanted(contextId, mirrorsOf(contextId).some((w) => w.data._watching !== false));
  };

  /**
   * Put a viewer on the host's mirror. DOM whatever mode it asked for: without
   * the server's Chromium there are no pixels to stream. Then the page it is on,
   * and what rebuilds it now (nothing, when the host is about to send a fresh
   * snapshot that reaches it as a broadcast).
   */
  const attach = (ws: MirrorSocket, contextId: string): void => {
    ws.data._domRender = true;
    ws.data._browserSetStream?.(false);
    if (!send(ws, { type: "render_mode", mode: "dom", host: "native" })) return;
    sendPage(ws, contextId);
    sync(contextId);
    for (const event of hosts.bootstrap(contextId)) {
      if (!send(ws, { type: "dom_event", event })) return;
    }
  };

  /**
   * DOM mode on the server's Chromium for one viewer: the only path before
   * hosts, and the one a context falls back to when its host leaves.
   */
  const enableChromiumDom = (ws: MirrorSocket, contextId: string): void => {
    browser.enableDomMode(contextId).then((bootstrap) => {
      // A host declared while Chromium was starting: the viewer is on its
      // mirror already, and a late answer here would flip it back.
      if (hosts.isHosting(contextId)) return;
      if (!bootstrap) {
        // Unsupported (no page / injection failed): force back to video.
        send(ws, { type: "render_mode", mode: "video" });
        return;
      }
      ws.data._domRender = true;
      send(ws, { type: "render_mode", mode: "dom" });
      // Bootstrap this viewer so it reconstructs without a reload.
      for (const event of bootstrap) send(ws, { type: "dom_event", event });
      // Stop paying for JPEG frames this viewer no longer renders.
      ws.data._browserSetStream?.(false);
    }).catch((err: unknown) => {
      console.warn(`[WS][browser] enableDomMode failed for ${contextId}:`, (err as Error)?.message || err);
      send(ws, { type: "render_mode", mode: "video" });
    });
  };

  const cancelFallback = (contextId: string): void => {
    fallbacks.get(contextId)?.();
    fallbacks.delete(contextId);
  };

  /**
   * The host left. Viewers keep the last mirror for a grace period; if no host
   * is back by then, the server's Chromium takes over at the page the host was on.
   */
  const scheduleFallback = (contextId: string): void => {
    cancelFallback(contextId);
    fallbacks.set(contextId, schedule(() => {
      fallbacks.delete(contextId);
      if (hosts.isHosting(contextId) || mirrorsOf(contextId).length === 0) return;
      const url = hosts.page(contextId)?.url;
      const opened = url && /^https?:/i.test(url)
        ? browser.navigate(contextId, url).catch(() => null)
        : Promise.resolve(null);
      void opened.then(() => {
        for (const w of mirrorsOf(contextId)) enableChromiumDom(w, contextId);
      });
    }, graceMs));
  };

  return {
    isHosting: (contextId: string): boolean => hosts.isHosting(contextId),
    sync,
    enableChromiumDom,

    /** A viewer that opened on a hosted context and did not ask for the mirror
     *  by now (video mode, a page it would frame itself, an older client). */
    attachIfIdle(ws: MirrorSocket, contextId: string): void {
      if (!ws.data._domRender && ws.readyState === OPEN) attach(ws, contextId);
    },

    /** A host frame from `ws`, the context's registered executor or not. */
    onHostFrame(ws: MirrorSocket, contextId: string, frame: HostFrame): void {
      if (frame.type === "native_dom_host") {
        // Only the pane that won the executor registration hosts: the delegate
        // registry has already turned a second one away.
        if (!ws.data._nativeDelegate) return;
        hosts.declare(contextId, ws, (cmd) => { ws.send(JSON.stringify(cmd)); });
        try { ws.send(JSON.stringify({ type: "native_dom_host_ack" })); } catch { /* socket gone */ }
        // Every viewer moves onto the host's mirror, and the Chromium context
        // that was serving them goes. It serves nobody now: an agent's ops on a
        // delegated context already run in the native pane.
        cancelFallback(contextId);
        for (const w of viewersOf(contextId)) attach(w, contextId);
        void browser.destroyContext(contextId).catch((err: unknown) =>
          console.warn(`[WS][browser] destroyContext(${contextId}) after host handover failed:`, (err as Error)?.message));
        console.log(`[WS][browser] native pane hosts the DOM mirror of ctx ${contextId}`);
        return;
      }
      if (frame.type === "host_dom_events") {
        const events = hosts.ingest(contextId, ws, frame.events);
        if (events.length === 0) return;
        const mirrors = mirrorsOf(contextId);
        // Serialized once for every viewer: a FullSnapshot of a real page is hundreds of KB.
        const payloads = events.map((event) => JSON.stringify({ type: "dom_event", event } satisfies BrowserWsMessage));
        for (const w of mirrors) {
          for (const p of payloads) {
            try { w.send(p); } catch { /* socket gone: its close handler cleans up */ }
          }
        }
        return;
      }
      const { url, title, canGoBack, canGoForward } = frame;
      if (hosts.notePage(contextId, ws, { url, title, canGoBack, canGoForward })) {
        for (const w of viewersOf(contextId)) sendPage(w, contextId);
      }
    },

    /**
     * A viewer's frame on a hosted context. What would drive the server's
     * Chromium goes to the native pane instead; what only Chromium could answer
     * is dropped. False when the context is not hosted, or for the frames the
     * ordinary path handles without touching Chromium.
     */
    routeViewer(ws: MirrorSocket, contextId: string, parsed: BrowserWsMessage): boolean {
      if (ws.data._nativeDelegate || !hosts.isHosting(contextId)) return false;
      switch (parsed.type) {
        case "input":
          hosts.command(contextId, { type: "host_input", action: parsed.action, payload: parsed.payload });
          return true;
        case "nav":
          if (parsed.phase !== "request") return false;
          // Already there: a pane seeding its stored url, not a reload of the Mac's page.
          if (hosts.page(contextId)?.url === parsed.url) sendPage(ws, contextId);
          else hosts.command(contextId, { type: "host_nav", action: "navigate", url: parsed.url });
          return true;
        case "set_render":
          attach(ws, contextId);
          return true;
        // The Mac's pane sets the viewport, the mirror knows what has focus,
        // and there is no video track to negotiate.
        case "resize":
        case "focus_query":
        case "webrtc_offer":
        case "webrtc_ice":
          return true;
        default:
          return false;
      }
    },

    /** A socket of the context closed (already out of its socket set). */
    onClose(ws: MirrorSocket, contextId: string): void {
      // The host leaving starts the countdown to the server's Chromium; a
      // mirror leaving may have been the last one on screen.
      if (hosts.withdraw(contextId, ws)) scheduleFallback(contextId);
      else if (ws.data._domRender) sync(contextId);
    },
  };
}
