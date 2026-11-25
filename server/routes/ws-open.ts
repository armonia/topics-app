/**
 * WebSocket `open`: what a socket of each kind (voice bridge, browser pane, terminal, app window) is given when it connects.
 */
import { providerHold, planUsage } from "../lib/provider-hold";
import { providerHoldFrame } from "../lib/provider-hold-broadcast";
import { swapFreezeViews } from "../lib/swap-freeze-hold";
import { handleTerminalWebSocket } from "../routes/terminal";
import { sendBrowserWsMessage } from "../../shared/browser-ws-messages";
import { countSharedViewers } from "../browser-viewer-count";
import { SERVER_VERSION, SERVER_PROTOCOL_VERSION, SERVER_CAPABILITIES } from "../ws-capabilities";
import { noteDeviceConnected } from "../routes/auth";
import { isGuestHandshakeFrame, isGuestSocketData } from "../lib/grants";
import { refreshSocketPrincipal, socketMayReceiveFrame, socketMayReadTopic } from "../lib/socket-principals";
import { attentionInitFrame } from "../attention/store";
import { loadAllUiState } from "../routes/ui-state";
import { VoiceBridgeSession } from "../services/voice-call/bridge";
import { sendWsFrame } from "../lib/ws-send";
import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import type { AfterHttp } from "../boot/scope";

export function createWsOpen(scope: Pick<AfterHttp, "browserService" | "browserWsClients" | "ctx" | "db" | "devBundleReload" | "hostBootRace" | "hostMirror" | "memoryPressureSignal" | "streamCatchupFrames" | "turnLedger" | "viewerCountPublisher" | "viewportWiring" | "voiceBrainDoor" | "wsClients">) {
  const { browserService, browserWsClients, ctx, db, devBundleReload, hostBootRace, hostMirror, memoryPressureSignal, streamCatchupFrames, turnLedger, viewerCountPublisher, viewportWiring, voiceBrainDoor, wsClients } = scope;
  return {
    open(ws: ServerWebSocket<WSData>) {
      ws.data.lastPong = Date.now();
      // A voice bridge is not a device of the app: no broadcasts, no presence. It
      // still sits in deviceSockets, the set revocation walks: a device revoked or
      // demoted mid-call must lose the bridge too, not keep a 30-minute call.
      if (ws.data.voiceBridge) {
        ctx.deviceSockets.add(ws);
        ws.data._voice = new VoiceBridgeSession(
          { send: (d) => void ws.send(d), close: (code, reason) => ws.close(code, reason), bufferedAmount: () => ws.getBufferedAmount() },
          { complete: voiceBrainDoor },
        );
        return;
      }
      ctx.deviceSockets.add(ws);
      if (ws.data.deviceId) noteDeviceConnected(ws.data.deviceId);

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      // Started BEFORE the terminal branch since both use ws.data fields,
      // but the browser branch is the more specific check.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        console.log(`[WS][browser] Open: ${ws.data.id} -> ctx ${ctxId}`);
        // Arrival order decides the viewport until somebody uses the page.
        viewportWiring.onOpen(ctxId, ws.data);
        // Phase 30 BROWSER-CHAT-03 — register this WS in the broadcast set
        // so broadcastToBrowserWs(ctxId, msg) reaches it.
        let bset = browserWsClients.get(ctxId);
        if (!bset) {
          bset = new Set();
          browserWsClients.set(ctxId, bset);
        }
        bset.add(ws);
        // A person just attached to this context: whatever the band was, the
        // shared Chromium goes back to normal priority (card 7f4d8f32).
        browserService.refreshBackgroundPriority(`viewer joined: ${ctxId}`);
        // Tell the newcomer where the count stands, then the others that it
        // moved. The direct send covers the one case the broadcast cannot: a
        // socket joining a context whose count did not change.
        // The newcomer is never in its own number: undeclared, it would count
        // itself and a native pane would flip to shared on its own reflection
        // (the two-second register/destroy loop of 2026-09-03).
        sendBrowserWsMessage(ws, { type: 'viewers', count: countSharedViewers(bset, ws) });
        viewerCountPublisher.publish(ctxId, ws);
        // A viewer that opens while the page is still on its way, or after it
        // failed to get there, hears it now: it was not here when it was said.
        const navNow = browserService.navReplay(ctxId);
        if (navNow) sendBrowserWsMessage(ws, navNow);
        // This WS's own frame consumer. Hoisted to a const so we pass the SAME
        // identity to stopScreencast — with fan-out, that removes only THIS
        // viewer and leaves the shared CDP screencast running for the others
        // (the old stopScreencast(ctxId) detached the session, blacking out
        // every other client viewing the same browser).
        const onFrame = (data: string, metadata: { timestamp: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number }) => {
          // Backpressure: if the WS isn't OPEN (1), drop the frame.
          if (ws.readyState !== 1) return;
          // Backpressure #2 — congested link: the CDP screencast keeps producing at
          // full local rate and its frame ACK fires on receipt (decoupled from this
          // send), so a slow viewer (mobile PWA on a bad link) would otherwise pile
          // frames unbounded in the server-side WS send buffer. DROP instead of
          // queue: for a LIVE view the freshest frame once the buffer drains is what
          // matters, not a stale backlog. ~1MB ≈ tens of q70 JPEG frames of slack.
          if (ws.getBufferedAmount() > 1_000_000) return;
          sendBrowserWsMessage(ws, {
            type: 'frame',
            data,
            metadata: {
              timestamp: metadata.timestamp,
              pageScaleFactor: metadata.pageScaleFactor,
              deviceWidth: metadata.deviceWidth,
              deviceHeight: metadata.deviceHeight,
            },
          });
        };
        // Deferred + race-safe screencast start. A Tauri native pane's FIRST
        // frame is `register_native_executor`, which arrives a few ms after
        // open — but startScreencast's getOrCreate would already be launching a
        // headless Chromium for a context that must NOT exist server-side
        // (delegated panes run ops natively). The old code started eagerly and
        // the 'registered' cleanup raced it: stopScreencast found no session
        // yet (idempotent no-op), the start then completed seconds later, and
        // the screencast streamed JPEGs forever into a pane that ignores them —
        // with the phantom context pinning Chromium past the reaper's
        // contexts.size===0 gate. The grace window lets the register frame
        // cancel the start before anything launches; if the start already
        // began, cleanup AWAITS it before stopping so the stop can't lose.
        const SCREENCAST_START_GRACE_MS = 250;
        let screencastCancelled = false;
        let screencastStart: Promise<void> | null = null;
        // Task 052f53ef — the desired stream state for THIS viewer. The web pane
        // flips it to false while it shows a native <iframe> (T2) so the headless
        // Chromium stops rendering frames nobody watches, and back to true when it
        // returns to the stream. Distinct from screencastCancelled (WS teardown).
        let streamActive = true;
        const startScreencastForViewer = () => {
          screencastStart = browserService.startScreencast(ctxId, onFrame).catch(err => {
            console.warn(`[WS][browser] startScreencast failed for ${ctxId}:`, err.message);
            try {
              ws.send(JSON.stringify({ type: 'error', message: `Screencast start failed: ${err.message}` }));
            } catch { /* socket may have closed before the error could be sent */ }
          });
        };
        hostBootRace.begin(ws, ctxId, ws.data.expectsNativeHost === true, (frames) => {
          const requestedRender = frames.find((frame) => frame.type === "set_render");
          if (!screencastCancelled && streamActive && !requestedRender && !screencastStart) startScreencastForViewer();
        });
        const screencastTimer = setTimeout(() => {
          // Skip the deferred start if a native executor cancelled it OR the pane
          // already paused the stream (iframe-mode) during the grace window.
          // A socket opened with `?executor=1` said at open that it is a native
          // executor: it never views frames, so it does not depend on its
          // register frame beating the 250 ms (it often does not, see the
          // 'registered' branch below).
          if (screencastCancelled || ws.data.expectsExecutor) return;
          if (hostBootRace.isWaiting(ws)) return;
          // A native pane hosts this context: the viewer mirrors its DOM, and a
          // screencast would launch the very Chromium the host replaces. A
          // viewer that did not ask for the mirror by now (video mode, a page
          // it would frame itself, an older client) is put on it here.
          if (hostMirror.isHosting(ctxId)) {
            hostMirror.attachIfIdle(ws, ctxId);
            return;
          }
          if (!streamActive) return;
          // A `set_stream: true` inside the grace window already started it
          // (see `_browserSetStream`): a second start would open a second CDP
          // session on the same page before the first one is registered.
          if (screencastStart) return;
          startScreencastForViewer();
        }, SCREENCAST_START_GRACE_MS);
        ws.data._browserSetStream = (active: boolean) => {
          if (screencastCancelled) return;
          if (active === streamActive) {
            if (active && !hostBootRace.isWaiting(ws) && !screencastStart) startScreencastForViewer();
            return;
          }
          if (active && hostBootRace.isWaiting(ws)) { streamActive = true; return; }
          // Same rule as the deferred start: no screencast under a host.
          if (active && hostMirror.isHosting(ctxId)) return;
          streamActive = active;
          if (active) {
            // Resume: re-attach this viewer to the (shared) screencast.
            startScreencastForViewer();
          } else {
            // Pause: detach this viewer. When it was the last viewer the shared
            // CDP session tears down and the headless page stops rendering; the
            // context stays alive (WS open) so agent_active still reaches the pane.
            browserService.stopScreencast(ctxId, onFrame).catch(err =>
              console.warn(`[WS][browser] pause stopScreencast failed for ${ctxId}:`, err.message)
            );
          }
        };
        ws.data._browserCleanup = async () => {
          screencastCancelled = true;
          hostBootRace.cancel(ws);
          clearTimeout(screencastTimer);
          if (screencastStart) await screencastStart;
          await browserService.stopScreencast(ctxId, onFrame).catch(err =>
            console.warn(`[WS][browser] stopScreencast failed for ${ctxId}:`, err.message)
          );
        };
        return;
      }

      const termId = ws.data.terminalId;
      if (termId) {
        // Terminal WebSocket
        const handler = handleTerminalWebSocket(ws, termId);
        if (handler) ws.data._termHandler = handler;
        return;
      }
      wsClients.add(ws);
      console.log(`[WS] Client connected: ${ws.data.id} (total: ${wsClients.size})`);

      /**
       * LA PORTA UNICA della raffica di apertura.
       *
       * Serve perché questi `send` non passano da `broadcastToAll`: sono
       * diretti alla socket appena aperta, e per questo scavalcavano il filtro
       * degli ospiti per intero. Il buco non era teorico — un ospite riceveva
       * `ui-state:init` (il pane-store del PROPRIETARIO, con i titoli e gli id
       * di ogni chat), `unread:init` (i non-letti di tutte), e dal catch-up il
       * CONTENUTO vivo di qualunque stream in corso. L'API era perfetta e la
       * roba passava sul filo.
       *
       * La regola è la stessa dei broadcast, e non una seconda scritta a mano:
       * stretta di mano sempre, per un ospite tipo ammesso più entità
       * concessa, altrimenti si tace. Un frame nuovo aggiunto qui domani cade
       * dalla parte giusta senza che nessuno se ne ricordi.
       */
      const ospiteWS = (): boolean => {
        refreshSocketPrincipal(ctx.db, ws.data);
        return isGuestSocketData(ws.data);
      };
      const inviaIniziale = (frame: Record<string, unknown>): void => {
        const tipo = String(frame.type ?? "");
        if (!isGuestHandshakeFrame(tipo) && ospiteWS()
          && !socketMayReceiveFrame(ctx.db, ws.data, frame)) {
          return;
        }
        try { sendWsFrame(ws, JSON.stringify(frame), tipo); } catch { /* socket già chiusa */ }
      };

      inviaIniziale({ type: "connected", clientId: ws.data.id });
      // A hold in force is the first thing a reconnecting client must know:
      // without it the banner would appear only at the NEXT change.
      const holdInForce = providerHoldFrame(providerHold());
      if (holdInForce.window) inviaIniziale(holdInForce);
      // The frozen trees, for the same reason: the frost has to be on the card
      // the moment a reloaded client paints it, and the next change may be ten
      // minutes away.
      const frozenNow = swapFreezeViews();
      if (frozenNow.length > 0) inviaIniziale({ type: "swap-freeze:state", views: frozenNow });
      inviaIniziale(memoryPressureSignal.frame());
      // Same for the reading behind it: a reload must land on the same row,
      // and the next event may be minutes away.
      const usageNow = planUsage();
      if (usageNow) {
        inviaIniziale({ type: "provider:usage", fiveHour: usageNow.fiveHour, sevenDay: usageNow.sevenDay, observedAtMs: usageNow.observedAtMs });
      }
      // v3 foundations WS-02 — handshake welcome (additive; old clients ignore unknown types).
      inviaIniziale({
        type: "welcome",
        serverVersion: SERVER_VERSION,
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverTime: Date.now(),
        clientId: ws.data.id,
      });
      // Dev-only freshness check: a window that missed the deploy-time
      // broadcast reloads itself on reconnect (null when the flag is off —
      // standalone installs never see this frame).
      { const __rev = devBundleReload.getRev(); if (__rev) inviaIniziale({ type: "ui:bundle-rev", rev: __rev }); }
      // The attention state, whole, at every open of a socket of the person
      // (ATTN-07): the client replaces its store with it, so a seen lost while
      // a phone slept is not lost for good. It carries each chat's unread too:
      // the old `unread:init` snapshot went with the client that read it
      // (notifications-redesign, tasks.md 6.2). Never to a guest.
      if (!ospiteWS()) inviaIniziale(attentionInitFrame());
      // `ui-state:init` e `providers:snapshot` NON hanno una versione ristretta,
      // e non devono averla: il primo è l'area di lavoro del proprietario — le
      // sue finestre, il suo layout — e il secondo la configurazione della
      // macchina. Non sono dati di cui esista una fetta che spetti a un ospite,
      // quindi cadono dal filtro come qualunque altro frame non ammesso.
      { const __ui = loadAllUiState(db); inviaIniziale({ type: "ui-state:init", data: __ui.data, meta: __ui.meta }); }
      // Initial provider snapshot — keeps the picker / settings page in sync without an extra HTTP fetch.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy like the `await import` of the same module at boot: static, it would move the snapshot manager (and the provider registry it imports) up the boot's module order
        const { getSnapshotManager } = require("../providers/snapshot-manager") as typeof import("../providers/snapshot-manager");
        inviaIniziale({ type: "providers:snapshot", snapshot: getSnapshotManager().getSnapshot() });
      } catch {
        // Snapshot manager not loaded yet — initial bootstrap will broadcast once it warms up.
      }

      // Send catch-up for any active streams so new clients can join mid-stream.
      //
      // The catchup MUST include `toolCalls` and `blocks` from the partial
      // message in DB, not just `content` + `thinking`. Without them, a fresh
      // WS connect (browser refresh, second window, network reconnect) sees
      // only the cumulative text and loses any tool calls that already
      // executed in the stream — the user perceives "response arrived all
      // at once with no tools visible". With them, the chronological timeline
      // is preserved and future stream:* deltas continue appending live.
      // The common case is zero active streams (idle app): skip the work
      // entirely rather than paying a full loadTopics() table-scan+joins on
      // every WS connect. When streams do exist, resolve each one's topicId
      // via the indexed single-row lookup instead of scanning all topics.
      //
      // Dalla stessa porta della raffica: questo frame porta il TESTO di un
      // turno a metà, ed è quello che un ospite non deve vedere per una chat
      // che non è sua.
      // A guest is asked about the topic BEFORE its row is flushed: a turn it
      // cannot see is not written for it.
      const catchupWanted = ospiteWS()
        ? (topicId: string | undefined) => !!topicId && socketMayReadTopic(ctx.db, ws.data, topicId)
        : () => true;
      for (const frame of streamCatchupFrames(catchupWanted)) inviaIniziale(frame);
      // Which sessions have a turn open right now: a window that reconnects
      // learns here which turns ended while it was away, and its queue drains
      // on this, not on a streaming flag the reconnect reset.
      inviaIniziale({ type: "turn:snapshot", ...turnLedger.snapshot() });
      // The feed only says CHANGES, so a window that connects mid-turn would stay
      // on `think` until the next one: tell it what each open turn is doing now.
      // To this socket alone. `inviaIniziale` asks a guest for the grant on the
      // frame's topic, the same permission the catch-up above checks.
      for (const payload of ctx.currentStreamActions?.() ?? []) inviaIniziale({ type: "stream:action", ...payload });
    },
  };
}
