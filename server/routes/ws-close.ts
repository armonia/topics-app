/**
 * WebSocket `pong` and `close`: heartbeat bookkeeping and the teardown of whatever a socket owned.
 */
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { WS_TRANSPORT_OPTIONS } from "../lib/websocket-options";
import { noteDeviceDisconnected } from "../routes/auth";
import { forgetSocket } from "../attention/store";
import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import type { AfterHttp } from "../boot/scope";

export function createWsClose(scope: Pick<AfterHttp, "broadcastPresence" | "browserService" | "browserWsClients" | "ctx" | "hostMirror" | "nativeHostLiveness" | "viewerCountPublisher" | "viewportWiring" | "webrtcBridge" | "wsClients">) {
  const { broadcastPresence, browserService, browserWsClients, ctx, hostMirror, nativeHostLiveness, viewerCountPublisher, viewportWiring, webrtcBridge, wsClients } = scope;
  return {
    pong(ws: ServerWebSocket<WSData>) { ws.data.lastPong = Date.now(); },
    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      if (ws.data._voice) {
        ctx.deviceSockets.delete(ws);
        ws.data._voice.onClose();
        return;
      }
      if (code === 1009) console.warn(`[WS] payload socket oltre il limite ${WS_TRANSPORT_OPTIONS.maxPayloadLength} B (${ws.data.id}): ${reason || "Payload Too Large"}`);
      ctx.deviceSockets.delete(ws);
      if (ws.data.deviceId) noteDeviceDisconnected(ws.data.deviceId);
      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        console.log(`[WS][browser] Close: ${ws.data.id} -> ctx ${ws.data.browserContextId}`);
        // The viewport goes back to the oldest pane left (and the context is
        // forgotten when this was the last one). Asking the heir for its size
        // is deferred below: it has to happen once this socket is out of the
        // broadcast set, and never to the socket that is leaving.
        const viewportHeir = viewportWiring.onClose(ws.data.browserContextId, ws.data);
        // Phase 30 BROWSER-CHAT-03 — remove from broadcast set BEFORE invoking
        // cleanup so any concurrent broadcast no longer targets this socket.
        const bset = browserWsClients.get(ws.data.browserContextId);
        if (bset) {
          bset.delete(ws);
          if (bset.size === 0) {
            browserWsClients.delete(ws.data.browserContextId);
            viewerCountPublisher.forget(ws.data.browserContextId);
          } else {
            viewerCountPublisher.publish(ws.data.browserContextId);
          }
        }
        if (viewportHeir) viewportWiring.askViewportOf(ws.data.browserContextId, viewportHeir);
        browserService.refreshBackgroundPriority(`viewer left: ${ws.data.browserContextId}`);
        // T1 DOM co-browse — if this was the last DOM-mode viewer, stop emission
        // (the page keeps recording cheaply; no wasted `dom_event` fan-out).
        if (ws.data._domRender) {
          const anyDom = [...(bset ?? [])].some((w) => w.data._domRender);
          if (!anyDom) browserService.setDomEmit(ws.data.browserContextId, false);
        }
        // The host of the mirror leaving starts the countdown to the server's
        // Chromium; a mirror leaving may have been the last one on screen.
        hostMirror.onClose(ws, ws.data.browserContextId);
        nativeHostLiveness.unregister(ws);
        // Drop any native-executor registration for this pane + fail its in-flight
        // ops (Tauri delegation) — no-op if this context never registered, and
        // owner-scoped so a late `close` from an OLD socket can't kill a fresh
        // re-registration made by the pane's reconnect (see unregister()).
        nativeDelegateRegistry.unregister(ws.data.browserContextId, ws);
        // Tear down any WebRTC peers this pane opened on the sidecar.
        if (ws.data._webrtcPeers) {
          for (const peerId of ws.data._webrtcPeers) webrtcBridge.close(peerId);
          ws.data._webrtcPeers.clear();
        }
        ws.data._browserCleanup?.().catch(err =>
          console.warn(`[WS][browser] cleanup failed:`, err.message)
        );
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.close(); return; }
      // Remove from client set FIRST so concurrent focus-based routing
      // (broadcastToTopic iterates wsClients by focusedTopicId) doesn't see this
      // ws at all. Clear focusedTopicId after as defense-in-depth in case any ref
      // to this ws object lingers elsewhere.
      wsClients.delete(ws);
      ws.data.focusedTopicId = null;
      forgetSocket(ws.data.id);
      console.log(`[WS] Client disconnected: ${ws.data.id} (total: ${wsClients.size})`);
      // Presence self-heal: if this socket had declared a window, re-broadcast
      // so peers drop its "open elsewhere" markers the instant it dies. Removed
      // from wsClients first, so the fresh snapshot no longer includes it.
      if (ws.data.windowId) broadcastPresence();
    },
  };
}
