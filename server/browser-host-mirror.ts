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
import type { BrowserWsMessage } from "../shared/browser-ws-messages";
import { BrowserWsChunkAssembler, chunkText } from "../shared/browser-ws-chunks";
import { shouldCompressFrame } from "./lib/ws-compression";
import type { DomHostRegistry, HostFrame } from "./lib/native-dom-host";
import { createHostViewport, type HostViewport } from "./browser-host-viewport";
import { isDrivingInput } from "./browser-viewport-arbiter";
import { viewportClaimantOf } from "./browser-viewport-wiring";

/** The little of a browser socket this module uses (a Bun ServerWebSocket fits). */
export interface MirrorSocket {
  readyState: number;
  data: {
    /** Who is behind the socket, for the viewport (see `viewportClaimantOf`). */
    id?: string;
    deviceId?: string | null;
    clientId?: string | null;
    remote?: boolean;
    _domRender?: boolean;
    _nativeDelegate?: boolean;
    _watching?: boolean;
    _browserSetStream?: (active: boolean) => void;
  };
  send(text: string, compress?: boolean): unknown;
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
  /** Who the host lays the page out for (TOPIC-BROWSER-05). Built here when absent. */
  viewport?: HostViewport;
  /**
   * The server's Chromium took the context over: ask whoever drives it for
   * their size. Their pane sent it while the Mac hosted, and does not repeat a
   * size it has sent.
   */
  askViewport?: (contextId: string) => void;
  now?: () => number;
}

const OPEN = 1;

export function createHostMirror(deps: HostMirrorDeps) {
  const { hosts, browser } = deps;
  const graceMs = deps.fallbackGraceMs ?? 8_000;
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const fallbacks = new Map<string, () => void>();
  const hostChunks = new Map<string, BrowserWsChunkAssembler>();
  const now = deps.now ?? Date.now;
  const statusTimers = new Map<string, () => void>();
  const statusSamples = new Map<string, { at: number; bytes: number; lastFrameAt: number; error?: string }>();
  const viewport = deps.viewport ?? createHostViewport({ send: (contextId, cmd) => { hosts.command(contextId, cmd); } });
  const deviceOf = (ws: MirrorSocket): string =>
    viewportClaimantOf({ id: ws.data.id ?? "", deviceId: ws.data.deviceId, clientId: ws.data.clientId, remote: ws.data.remote }).device;

  const sendText = (ws: MirrorSocket, text: string, type: string, contextId?: string): boolean => {
    try {
      ws.send(text, shouldCompressFrame({ type, bytes: Buffer.byteLength(text), remote: ws.data.remote === true }));
      return true;
    } catch (err) {
      if (contextId) noteError(contextId, err);
      return false;
    }
  };
  const noteError = (contextId: string, err: unknown): void => {
    const sample = statusSamples.get(contextId);
    if (sample) sample.error = err instanceof Error ? err.message : String(err);
    queueStatus(contextId);
  };
  const queueStatus = (contextId: string): void => {
    if (statusTimers.has(contextId)) return;
    statusTimers.set(contextId, schedule(() => {
      statusTimers.delete(contextId);
      const host = [...deps.sockets(contextId)].find((w) => w.readyState === OPEN && w.data._nativeDelegate);
      if (!host) return;
      const at = now();
      const sample = statusSamples.get(contextId) ?? { at, bytes: 0, lastFrameAt: at };
      const elapsed = Math.max(1, at - sample.at);
      const devices = new Set(mirrorsOf(contextId).filter((w) => w.data._watching !== false).map(deviceOf)).size;
      const rate = sample.bytes * 1000 / elapsed / 1024;
      send(host, { type: "native_host_status", sharing: hosts.isSharing(contextId), devices,
        kbps: Math.round(rate * 10) / 10, delayMs: Math.max(0, at - sample.lastFrameAt), ...(sample.error ? { error: sample.error } : {}) });
      statusSamples.set(contextId, { at, bytes: 0, lastFrameAt: sample.lastFrameAt, ...(sample.error ? { error: sample.error } : {}) });
    }, 1000));
  };
  /** A mirror event as it goes on the wire: one frame, or pieces under the socket's ceiling (NATIVE-HOST-05). */
  const domEventFrames = (text: string): string[] => {
    if (Buffer.byteLength(text) <= 256 * 1024) return [text];
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return chunkText(text, id).map((chunk) => JSON.stringify({ type: "dom_event_chunk", ...chunk }));
  };
  const sendFrames = (ws: MirrorSocket, frames: string[], contextId?: string): boolean =>
    frames.every((frame) => sendText(ws, frame, frames.length > 1 ? "dom_event_chunk" : "dom_event", contextId));
  const send = (ws: MirrorSocket, msg: BrowserWsMessage, contextId?: string): boolean => {
    const text = JSON.stringify(msg);
    return msg.type === "dom_event" ? sendFrames(ws, domEventFrames(text), contextId) : sendText(ws, text, msg.type, contextId);
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
    hosts.setWanted(contextId, hosts.isSharing(contextId) && mirrorsOf(contextId).some((w) => w.data._watching !== false));
    queueStatus(contextId);
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
    if (!hosts.isSharing(contextId)) {
      send(ws, { type: "host_share_state", sharing: false });
      return;
    }
    sync(contextId);
    for (const event of hosts.bootstrap(contextId)) {
      if (!send(ws, { type: "dom_event", event }, contextId)) return;
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
      if (hosts.isHosting(contextId) || !hosts.isSharing(contextId) || mirrorsOf(contextId).length === 0) return;
      const url = hosts.page(contextId)?.url;
      const opened = url && /^https?:/i.test(url)
        ? browser.navigate(contextId, url).catch(() => null)
        : Promise.resolve(null);
      void opened.then(() => {
        viewport.forget(contextId);
        for (const w of mirrorsOf(contextId)) enableChromiumDom(w, contextId);
        deps.askViewport?.(contextId);
      });
    }, graceMs));
  };

  return {
    isHosting: (contextId: string): boolean => hosts.isHosting(contextId),
    sync,
    enableChromiumDom,
    setSharing(contextId: string, owner: MirrorSocket, active: boolean): boolean {
      if (!hosts.isHost(contextId, owner)) return false;
      hosts.setSharing(contextId, active);
      for (const viewer of viewersOf(contextId)) send(viewer, { type: "host_share_state", sharing: active }, contextId);
      sync(contextId);
      queueStatus(contextId);
      return true;
    },

    /** A viewer that opened on a hosted context and did not ask for the mirror
     *  by now (video mode, a page it would frame itself, an older client). */
    attachIfIdle(ws: MirrorSocket, contextId: string): void {
      if (!ws.data._domRender && ws.readyState === OPEN) attach(ws, contextId);
    },

    /** A host frame from `ws`, the context's registered executor or not. */
    onHostFrame(ws: MirrorSocket, contextId: string, frame: HostFrame): void {
      if (frame.type === "host_dom_events_chunk") {
        if (!hosts.isHost(contextId, ws)) return;
        let assembler = hostChunks.get(contextId);
        if (!assembler) { assembler = new BrowserWsChunkAssembler(); hostChunks.set(contextId, assembler); }
        const text = assembler.add(frame);
        if (text === null) return;
        hostChunks.delete(contextId);
        let events: unknown = null;
        try { events = JSON.parse(text); } catch { /* reported below, like any other shape */ }
        if (!Array.isArray(events)) {
          console.warn(`[WS][browser] native DOM pieces for ${contextId} are not an event list: dropped`);
          return;
        }
        this.onHostFrame(ws, contextId, { type: "host_dom_events", events });
        return;
      }
      if (frame.type === "native_dom_host") {
        // Only the pane that won the executor registration hosts: the delegate
        // registry has already turned a second one away.
        if (!ws.data._nativeDelegate) return;
        hostChunks.delete(contextId);
        hosts.declare(contextId, ws, (cmd) => { ws.send(JSON.stringify(cmd)); });
        if (!hosts.isSharing(contextId)) ws.send(JSON.stringify({ type: "host_dom_stop" }));
        try { ws.send(JSON.stringify({ type: "native_dom_host_ack" })); } catch { /* socket gone */ }
        // Every viewer moves onto the host's mirror, and the Chromium context
        // that was serving them goes. It serves nobody now: an agent's ops on a
        // delegated context already run in the native pane.
        cancelFallback(contextId);
        viewport.noteHostReady(contextId, frame.used === true);
        for (const w of viewersOf(contextId)) attach(w, contextId);
        queueStatus(contextId);
        void browser.destroyContext(contextId).catch((err: unknown) =>
          console.warn(`[WS][browser] destroyContext(${contextId}) after host handover failed:`, (err as Error)?.message));
        console.log(`[WS][browser] native pane hosts the DOM mirror of ctx ${contextId}`);
        return;
      }
      if (frame.type === "host_local_use") {
        // The Mac's own pane: the page goes back to its slot (TOPIC-BROWSER-05).
        if (hosts.isHost(contextId, ws)) viewport.noteHostUse(contextId);
        return;
      }
      if (frame.type === "host_dom_events") {
        const events = hosts.ingest(contextId, ws, frame.events);
        if (events.length === 0) return;
        const mirrors = mirrorsOf(contextId);
        // Serialized and cut once for every viewer: a FullSnapshot of a real page is hundreds of KB.
        const payloads = events.map((event) => domEventFrames(JSON.stringify({ type: "dom_event", event } satisfies BrowserWsMessage)));
        for (const w of mirrors) {
          for (const frames of payloads) {
            const bytes = frames.reduce((n, value) => n + Buffer.byteLength(value), 0);
            const sample = statusSamples.get(contextId) ?? { at: now(), bytes: 0, lastFrameAt: now() };
            sample.bytes += bytes;
            sample.lastFrameAt = now();
            statusSamples.set(contextId, sample);
            sendFrames(w, frames, contextId);
          }
        }
        queueStatus(contextId);
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
      if (ws.data._nativeDelegate) return false;
      if (!hosts.isSharing(contextId)) return true;
      // Kept whoever serves the page: a pane does not repeat a size it has sent
      // (useRemoteBrowser), so one sent while the server's Chromium served it,
      // or while the host was away, is the one the host needs when it is used.
      if (parsed.type === "resize") {
        // The layout first: a device driving the page that now lays it out on its
        // own gives it back, rather than resizing the Mac once more on the way.
        viewport.noteLayout(contextId, deviceOf(ws), parsed.layout === "own");
        viewport.noteSize(contextId, deviceOf(ws), parsed.width, parsed.height);
      }
      if (!hosts.isHosting(contextId)) return false;
      switch (parsed.type) {
        case "input":
          // The input first: it was aimed at the layout the viewer is looking
          // at, and the host runs the two in the order they arrive.
          hosts.command(contextId, { type: "host_input", action: parsed.action, payload: parsed.payload });
          if (isDrivingInput(parsed.action)) viewport.noteRemoteUse(contextId, deviceOf(ws));
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
        case "resize":
          // Kept above, not applied: the size counts once this device uses the page.
          if (parsed.driving === true) viewport.noteRemoteUse(contextId, deviceOf(ws));
          return true;
        // The mirror knows what has focus, and there is no video track to negotiate.
        case "focus_query":
        case "webrtc_offer":
        case "webrtc_ice":
          return true;
        default:
          return false;
      }
    },

    /**
     * A viewer's pane went off screen or came back (`set_watching`). Off screen
     * is not using the page: it goes back to the Mac, unless the same device
     * still shows it in another pane. Back on screen, the device that was using
     * it still is, if nobody used the page meanwhile.
     */
    onWatching(ws: MirrorSocket, contextId: string): void {
      sync(contextId);
      if (ws.data._nativeDelegate) return;
      const device = deviceOf(ws);
      if (ws.data._watching !== false) { viewport.noteViewerShown(contextId, device); return; }
      const shown = viewersOf(contextId).some((w) => w !== ws && w.data._watching !== false && deviceOf(w) === device);
      if (!shown) viewport.noteViewerHidden(contextId, device);
    },

    /** A socket of the context closed (already out of its socket set). */
    onClose(ws: MirrorSocket, contextId: string): void {
      // The host leaving starts the countdown to the server's Chromium; a
      // mirror leaving may have been the last one on screen.
      if (hosts.withdraw(contextId, ws)) {
        hostChunks.delete(contextId);
        statusTimers.get(contextId)?.(); statusTimers.delete(contextId);
        scheduleFallback(contextId);
        return;
      }
      queueStatus(contextId);
      if (ws.data._domRender) sync(contextId);
      // The device's last socket: the page it was using goes back to the Mac.
      const device = deviceOf(ws);
      const stays = [...deps.sockets(contextId)].some((w) => w !== ws && w.readyState === OPEN && deviceOf(w) === device);
      if (!stays) viewport.noteViewerGone(contextId, device);
    },
  };
}
