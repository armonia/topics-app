/**
 * WebSocket `message`: the frames a voice bridge, a browser pane, a terminal and an app window send to the server.
 */
import { sendBrowserWsMessage, parseBrowserWsMessage } from "../../shared/browser-ws-messages";
import { applyEngineSwitch } from "../browser-engine-switch";
import { browserEngineRegistry, chromiumExtensionsCount } from "../browser-engine-registry";
import { nativeDelegateRegistry, handleNativeDelegationFrame, isNativeDelegateFrameAllowed } from "../browser-native-delegate";
import { parseHostFrame } from "../lib/native-dom-host";
import { seedNativeFromShared } from "../browser-session-handoff";
import { parseChatWsInbound } from "../schemas/chat-ws-inbound";
import { isGuestSocketData, isGuestInboundFrameAllowed } from "../lib/grants";
import { refreshSocketPrincipal, socketMayReceiveFrame, socketMayReadTopic } from "../lib/socket-principals";
import { setSocketFocus } from "../attention/store";
import { isAttentionSubject, topicSubject } from "../../shared/attention";
import { sendWsFrame } from "../lib/ws-send";
import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import type { AfterHttp } from "../boot/scope";

export function createWsMessage(scope: Pick<AfterHttp, "broadcast" | "broadcastPresence" | "broadcastToAll" | "broadcastToBrowserWs" | "broadcastToTopic" | "browserService" | "browserWsClients" | "ctx" | "hostBootRace" | "hostMirror" | "nativeHostLiveness" | "resizeFromViewer" | "streamCatchupFrames" | "viewerActions" | "viewerCountPublisher" | "viewportWiring" | "webrtcBridge">) {
  const { broadcast, broadcastPresence, broadcastToAll, broadcastToBrowserWs, broadcastToTopic, browserService, browserWsClients, ctx, hostBootRace, hostMirror, nativeHostLiveness, resizeFromViewer, streamCatchupFrames, viewerActions, viewerCountPublisher, viewportWiring, webrtcBridge } = scope;
  return {
    message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
      ws.data.lastPong = Date.now();
      if (ws.data._voice) {
        if (typeof message === "string") ws.data._voice.onText(message);
        else ws.data._voice.onBinary(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
        return;
      }
      refreshSocketPrincipal(ctx.db, ws.data);

      // Phase 30 BROWSER-CHAT-02 — browser WS branch.
      if (ws.data.browserContextId) {
        const ctxId = ws.data.browserContextId;
        try {
          const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
          if ((raw as { type?: unknown })?.type === "host_pong") {
            nativeHostLiveness.pong(ws);
            return;
          }
          if (ws.data._nativeDelegate && !isNativeDelegateFrameAllowed(raw)) {
            console.warn("[WS][browser] ignored non-delegate frame from native executor");
            return;
          }
          // Tauri native-pane delegation — raw types OUTSIDE the strict browser-ws
          // Zod envelope (kept out of it on purpose so the schema stays the
          // streaming protocol). Classified by the shared helper (unit-tested);
          // handled before parseBrowserWsMessage.
          const delegated = handleNativeDelegationFrame(
            raw, ctxId,
            (m) => { try { ws.send(JSON.stringify(m)); } catch { /* socket may already be closed */ } },
            nativeDelegateRegistry,
            ws, // owner — lets unregister() skip stale-socket cleanups after a re-register
            // Liveness del proprietario corrente: e' cio' che distingue una
            // RICONNESSIONE (socket vecchio gia' chiuso -> subentro lecito) da un
            // DIROTTAMENTO (un secondo processo locale che si registra sul
            // contextId di una pane ancora servita, e ne intercetterebbe le
            // tool-call, browser_load_state compreso).
            () => ws.readyState === 1 /* OPEN */,
          );
          if (delegated === 'rejected') {
            // Un esecutore vivo serve gia' questo contextId. Dirlo al socket e
            // chiuderlo: un client che si crede registrato e non lo e' resterebbe
            // in attesa di tool-call che non arriveranno mai, e la diagnosi
            // sarebbe "il browser non risponde" invece di "sei il secondo".
            try {
              ws.send(JSON.stringify({
                type: "register_native_executor_rejected",
                contextId: ctxId,
                reason: "un esecutore nativo vivo serve gia' questo contextId",
              }));
            } catch { /* socket gia' andato */ }
            try { ws.close(1008, "native executor already registered"); } catch { /* socket may already be closed */ }
            return;
          }
          if (delegated === 'registered') {
            nativeHostLiveness.register(ctxId, ws);
            // This socket executes, it does not watch: it leaves the audience of
            // the viewport arbiter, exactly as it leaves the viewer count. A
            // native pane has no viewport of its own to impose, and counting it
            // as a spectator made the shell's own streaming socket queue up
            // behind a phone when the pane later flipped to shared.
            viewportWiring.onNativeExecutor(ctxId, ws.data);
            // A native pane runs ops itself — it never views server frames, so tear
            // down the screencast the open handler auto-started (no wasted headless
            // Chromium / bandwidth for a context that isn't streaming).
            //
            // FERMARE LO SCREENCAST NON BASTA. Il commento sulla grazia dei
            // 250 ms (SCREENCAST_START_GRACE_MS) dice che per una pane nativa
            // il contesto server «must NOT exist», e che un fantasma «pinning
            // Chromium past the reaper's contexts.size===0 gate». Ma la grazia
            // PERDE regolarmente: nel log di produzione il registro nativo
            // arriva DOPO che il timer ha gia' fatto `Context created` +
            // `Screencast started`, e da li' in poi si vede solo
            // `Screencast stopped` — mai `Context destroyed`. Il contesto
            // resta, si ri-naviga da solo all'ultima URL salvata (quindi
            // ricarica pagine e login che nessuno guarda) e tiene acceso
            // l'intero processo Chromium, che non puo' morire finche' esiste
            // un contesto. Il 2026-07-30 ne sono sopravvissuti quattro
            // insieme, raccolti solo dal reaper d'inattivita' a 30 minuti.
            //
            // Si aspetta la cleanup (che e' async: senza await lo stop puo'
            // perdere la corsa con la start in volo) e poi si distrugge il
            // contesto — ma SOLO se non esisteva prima di questo socket.
            // Cosi' muore il fantasma nato dalla partenza differita, e mai un
            // contesto legittimo che qualcun altro sta usando.
            const cleanup = ws.data._browserCleanup;
            ws.data._browserCleanup = undefined;
            // Mark it so the viewer count excludes it: a native pane is NOT a viewer
            // of the shared session, and counting its own delegate socket made an
            // 'auto' pane flap native↔shared every poll (browser reset every ~2s).
            // Va marcato PRIMA del controllo qui sotto, o questo stesso socket si
            // conterebbe come spettatore e il contesto non morirebbe mai.
            ws.data._nativeDelegate = true;
            // The delegate just left the count: the panes of this context (this
            // one included) hear the new value now, not on the next poll.
            viewerCountPublisher.publish(ctxId);
            // Il `message` handler non e' async: si sequenzia in una IIFE, che
            // e' comunque l'ordine che serve (prima lo stop, poi la distruzione).
            void (async () => {
              try {
                await cleanup?.();
              } catch (err) {
                // Logged, not swallowed: a failed screencast stop is worth a trace.
                // It does not skip the destroy below, which runs regardless and is
                // what kills the ghost context. No automated test: this needs a live
                // native-delegate WebSocket plus a real browser context to throw in.
                console.warn(`[WS][browser] cleanup failed for ${ctxId}:`, err);
              }
              // La condizione NON e' «l'ho creato io» ma «lo sta guardando
              // qualcun altro?».
              //
              // La prima versione si fidava di `_browserCtxExistedBefore`,
              // fotografato in `open()`. Copriva solo il contesto nato dalla
              // partenza differita di QUESTO socket: alla RICONNESSIONE il
              // contesto esiste gia', quindi il controllo passava e il fantasma
              // sopravviveva. Misurato dopo quel fix: due contesti vivi, nove
              // processi Chromium, 664 MB — con zero pane browser aperte.
              //
              // Il contratto (vedi SCREENCAST_START_GRACE_MS) dice che per una
              // pane NATIVA il contesto server «must NOT exist». Non «non deve
              // essere creato da questo socket»: non deve esistere. Quindi si
              // guarda chi resta attaccato: se non c'e' nessun socket che NON
              // sia un delegato nativo, quel contesto non lo guarda nessuno e
              // se ne va. Una sessione condivisa (co-browse, il telefono che
              // guarda lo stream) tiene il suo socket non-delegato e sopravvive.
              //
              // Di proposito NON si riusa il contatore dei viewer di
              // `createBrowserRouter`: quello esclude anche chi ha la pane fuori
              // dallo schermo (`_watching === false`), che per il flapping
              // native↔shared e' giusto ma qui sarebbe un disastro — uno
              // spettatore in secondo piano e' comunque uno spettatore, e
              // distruggergli il contesto sotto lo lascerebbe a mani vuote
              // quando torna a guardare.
              const watchers = [...(browserWsClients.get(ctxId) ?? [])]
                .filter((w) => !w.data._nativeDelegate).length;
              if (watchers === 0) {
                try {
                  await browserService.destroyContext(ctxId);
                  console.log(`[WS][browser] destroyed phantom context ${ctxId} (native pane delegates ops, 0 viewers)`);
                } catch (err) {
                  console.warn(`[WS][browser] destroyContext(${ctxId}) failed:`, (err as Error).message);
                }
              }
              // IL VERSO OPPOSTO DEL CASSETTO COOKIE. Questa e' l'unica volta in
              // cui una WKWebView nativa si annuncia viva su un contesto: se la
              // sessione condivisa di quello stesso contesto ha un login (il
              // telefono si e' loggato mentre il Mac era via), qui lo si versa
              // nel suo barattolo. Senza, «mi loggo dal telefono e sul Mac sono
              // ancora fuori» non aveva nessun codice che lo risolvesse.
              //
              // Il flush prima serve quando il contesto e' ancora VIVO (qualcuno
              // guarda): l'autosave e' a 30s, e leggere il file cosi' com'e'
              // vorrebbe dire perdersi il login appena fatto. Se il contesto e'
              // stato appena distrutto, e' gia' stato salvato e il flush e' un
              // no-op. Nessuna delle due puo' lanciare: sta davanti al primo
              // fotogramma della pane nativa.
              await browserService.flushStorageState(ctxId).catch(() => false);
              const back = await seedNativeFromShared(ctxId);
              if (back.ok) {
                console.log(`[WS][browser] cookie della sessione condivisa passati alla pane nativa ${ctxId} (${back.cookies} cookie)`);
              } else if (back.skipped !== "empty" && back.skipped !== "unchanged" && back.skipped !== "no-native-pane") {
                console.warn(`[WS][browser] passaggio cookie condivisa→nativa saltato per ${ctxId}: ${back.skipped}${back.error ? ` (${back.error})` : ""}`);
              }
            })();
            console.log(`[WS][browser] native executor registered for ctx ${ctxId}`);
            return;
          }
          if (delegated === 'result') return;
          // The native pane hosting this context's mirror: its declaration, its
          // DOM events, and where its page is. Raw frames, like the delegation ones.
          const hostFrame = parseHostFrame(raw);
          if (hostFrame) {
            hostMirror.onHostFrame(ws, ctxId, hostFrame);
            return;
          }
          const result = parseBrowserWsMessage(raw);
          if (!result.ok) {
            console.warn(`[WS][browser] Invalid message from ${ws.data.id}: ${result.error}`);
            return;
          }
          const parsed = result.data;
          if (hostBootRace.hold(ws, ctxId, parsed)) return;
          if (hostMirror.routeViewer(ws, ctxId, parsed)) return;
          if (parsed.type === 'input') {
            // Using the page is what makes a client the driver of its viewport.
            viewportWiring.onFrame(ctxId, ws.data, parsed);
            const relayed = browserService.dispatchInput(ctxId, parsed.action, parsed.payload).catch(err => {
              console.warn(`[WS][browser] dispatchInput failed for ${ctxId}:`, err.message);
              return 'failed' as const;
            });
            // DOPO IL CLICK, CHI HA PRESO IL FUOCO.
            //
            // Il pane deve vestire il proprio campo di cattura come il campo
            // remoto, o dal telefono esce sempre la stessa tastiera (quella di
            // testo) qualunque cosa si tocchi. Sul co-browse DOM la risposta è
            // in casa, nel mirror; sul ramo video il pane vede pixel e la
            // risposta può darla solo la pagina vera, qui.
            //
            // Va SOLO a chi ha cliccato: in una sessione condivisa gli altri non
            // hanno toccato niente, e non devono ritrovarsi una tastiera aperta.
            if (parsed.action === 'click') {
              void relayed.then(async (outcome) => {
                if (outcome === 'failed') return;
                const field = await browserService.describeFocusedField(ctxId).catch(() => null);
                try {
                  sendBrowserWsMessage(ws, { type: 'focus_field', ...(field ? { field } : {}) });
                } catch { /* socket gone — the keyboard question died with it */ }
              });
            }
          } else if (parsed.type === 'focus_query') {
            // LA STESSA RISPOSTA DEL CLICK, CHIESTA A VOCE.
            //
            // Sul ramo video il click non passa più di qui: da quando l'input
            // viaggia sul DataChannel va dal pane al sidecar a CDP, e il ramo
            // qui sopra — che è quello che nomina il campo a fuoco — non si
            // sveglia mai. Il pane allora chiede, subito dopo aver spinto il
            // click sul canale, e paga il round trip solo per la tastiera.
            //
            // Deliberatamente identico nel corpo al ramo del click, non
            // fattorizzato: sono due domande diverse (una segue un click che
            // abbiamo eseguito noi, l'altra un click che non abbiamo visto) e
            // l'unica cosa che condividono è la risposta.
            void (async () => {
              const field = await browserService.describeFocusedField(ctxId).catch(() => null);
              try {
                sendBrowserWsMessage(ws, { type: 'focus_field', ...(field ? { field } : {}) });
              } catch { /* socket gone — the keyboard question died with it */ }
            })();
          } else if (parsed.type === 'nav' && parsed.phase === 'request') {
            viewerActions.navigate(ws, ctxId, parsed.url);
          } else if (parsed.type === 'take_control') {
            // Phase 30 BROWSER-CHAT-04 — user reclaimed control. Force-release the
            // lock with an eager agent_active=false broadcast. The agent's in-flight
            // tool will complete naturally (Playwright actions are quick), and its
            // withLock finally block will broadcast agent_active=false a second
            // time. The double-broadcast is idempotent on the client. Aborting the
            // tool mid-action is a future enhancement (would require an
            // AbortController plumbed through BrowserService dispatchInput / handlers).
            console.log(`[WS][browser] take_control received for ctx ${ctxId}`);
            browserService.broadcastAgentActive(ctxId, false);
          } else if (parsed.type === 'resize') {
            // Match the server viewport (+HiDPI) to the pane's real size so the
            // page reflows responsively and renders sharp, no fixed-1280
            // letterbox.
            //
            // Only from the driver (TOPIC-BROWSER-05), and the deciding is not
            // done here: `onFrame` answers and applies in one move. A
            // spectator's pane keeps streaming its own size from its
            // ResizeObserver, and applying it reflowed the shared page to the
            // smallest screen watching it: a phone opening the context turned
            // the Mac's page into a phone page under the hands of whoever was
            // typing. Dropped silently: the spectator is not asking for
            // anything, it is just measuring itself.
            resizeFromViewer(ctxId, ws.data, parsed);
          } else if (parsed.type === 'set_engine') {
            // Engine switch (task 54601eeb). Non più dietro un flag: la
            // capacità la decide la presenza di un Chromium sulla macchina, e il
            // bottone lato client è già nascosto quando non c'è. Se lo switch
            // fallisce comunque (Chromium sparito, sidecar che non parte) si
            // torna a 'native': la pane resta dov'era invece di restare a metà.
            applyEngineSwitch(
              { registry: browserEngineRegistry, service: browserService, extensionsCount: chromiumExtensionsCount },
              ctxId,
              parsed.engine,
            ).then((msg) => {
              broadcastToBrowserWs(ctxId, msg);
            }).catch((err) => {
              console.warn(`[WS][browser] set_engine failed for ${ctxId}:`, err?.message || err);
              try { sendBrowserWsMessage(ws, { type: 'engine', engine: 'native' }); } catch { /* socket gone */ }
            });
          } else if (parsed.type === 'set_stream') {
            // Task 052f53ef — pause/resume this viewer's screencast when the pane
            // enters/leaves native iframe-mode (kills the wasted headless render).
            ws.data._browserSetStream?.(parsed.active);
          } else if (parsed.type === 'set_watching') {
            // «La mia pane è sullo schermo». È l'UNICO ingresso del conteggio
            // spettatori (browser-viewer-count.ts) e sta apposta fuori da
            // set_stream: quello è il transport, e il WebRTC lo mette in pausa
            // mentre guarda eccome.
            ws.data._watching = parsed.active;
            viewerCountPublisher.publish(ctxId);
            // A mirror leaving the screen may be the last one: the host stops
            // recording. And a pane off screen is not using a hosted page.
            hostMirror.onWatching(ws, ctxId);
          } else if (parsed.type === 'set_native_host_sharing') {
            if (ws.data._nativeDelegate) hostMirror.setSharing(ctxId, ws, parsed.active);
          } else if (parsed.type === 'set_render') {
            // T1 DOM co-browse — switch THIS viewer between the pixel stream
            // ('video', default) and a native rrweb DOM reconstruction ('dom').
            // DOM mode injects rrweb into the SHARED headless page, streams tiny
            // DOM events, and pauses this viewer's wasted screencast; input keeps
            // flowing over the existing `input` messages (same page-CSS coords).
            // A hosted context never gets here (hostMirror.routeViewer).
            if (parsed.mode === 'dom') {
              hostMirror.enableChromiumDom(ws, ctxId);
            } else {
              viewerActions.toVideo(ws, ctxId);
            }
          } else if (parsed.type === 'webrtc_offer') {
            // Shared-session WebRTC transport — relay the viewer's offer to the Rust
            // sidecar, which attaches to THIS pane's CDP target and streams it as an
            // H.264 track. If the sidecar is unavailable the client gets no answer and
            // transparently keeps its JPEG stream (no regression).
            // One line per offer, sidecar or not: the server log is where "does
            // anybody use the video mode?" gets its answer (the client's own
            // lines stay in the viewer's console).
            console.log(`[WS][browser] webrtc offer for ${ctxId} (bridge ${webrtcBridge.available() ? 'available' : 'missing, the viewer keeps JPEG'})`);
            if (webrtcBridge.available()) {
              const streamId = parsed.stream ?? 'default';
              const peerId = `${ws.data.id}:${streamId}`;
              (ws.data._webrtcPeers ??= new Set()).add(peerId);
              const offeredSdp = parsed.sdp;
              // The pane's CDP target is created asynchronously from the `nav` that
              // precedes the offer; the first offer can arrive before it exists. Poll
              // briefly (rather than dropping the offer and forcing the client through
              // its multi-second retry watchdog) so a fresh pane connects on the first try.
              (async () => {
                let targetId: string | null = null;
                for (let i = 0; i < 12; i++) {
                  targetId = await browserService.getTargetId(ctxId);
                  if (targetId) break;
                  if (!ws.data._webrtcPeers?.has(peerId)) return; // peer torn down while waiting
                  await new Promise((r) => setTimeout(r, 250));
                }
                if (!targetId) {
                  console.warn(`[WS][browser] webrtc: no CDP target for ${ctxId} after wait (pane not streaming?)`);
                  return; // client retries with a fresh offer
                }
                webrtcBridge.offer(peerId, targetId, offeredSdp, {
                  onAnswer: (sdp) => { try { sendBrowserWsMessage(ws, { type: 'webrtc_answer', sdp, stream: streamId }); } catch { /* socket gone */ } },
                  onIce: (candidate, sdpMid, sdpMLineIndex) => { try { sendBrowserWsMessage(ws, { type: 'webrtc_ice', candidate, sdpMid, sdpMLineIndex, stream: streamId }); } catch { /* socket gone */ } },
                  onError: (m) => console.warn(`[WS][browser] webrtc offer failed for ${ctxId}: ${m}`),
                });
              })().catch((err) => console.warn(`[WS][browser] webrtc getTargetId failed for ${ctxId}:`, err?.message || err));
            }
          } else if (parsed.type === 'webrtc_ice') {
            // Trickle ICE from the viewer → sidecar (belt-and-suspenders on LAN).
            const streamId = parsed.stream ?? 'default';
            webrtcBridge.ice(`${ws.data.id}:${streamId}`, parsed.candidate, parsed.sdpMid ?? null, parsed.sdpMLineIndex ?? null);
          }
          // Ignore other message types from client (frame/agent_active/console/download/engine are server -> client only).
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[WS][browser] Failed to parse message from ${ws.data.id}:`, msg);
        }
        return;
      }

      const handler = ws.data._termHandler;
      if (handler) { handler.message(message); return; }
      try {
        const raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        const result = parseChatWsInbound(raw);
        if (!result.ok) {
          // Backward-compat: silently drop unknown/malformed messages instead
          // of crashing. The previous handler did the same (unmatched types
          // hit none of the `if` branches). Log in dev for observability.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[WS] Invalid inbound message from ${ws.data.id}: ${result.error}`);
          }
          return;
        }
        const data = result.data;
        // A guest socket is read-only in BOTH directions. The outbound filter
        // (`isGuestSafeFrameType`, in the fan-out helpers) is what keeps the
        // owner's content off the wire; this is what keeps the guest's frames
        // off the owner's windows: typing text into any chat by topicId,
        // drag frames that close panels in a window whose id they name,
        // presence announcements that fill the roster. One rule, in
        // `lib/grants.ts` like the other three, not a check per case.
        const guestSocket = isGuestSocketData(ws.data);
        if (guestSocket && !isGuestInboundFrameAllowed(data.type)) {
          console.warn(`[WS] guest socket ${ws.data.id} sent '${data.type}': dropped`);
          return;
        }
        switch (data.type) {
          case 'focus':
            ws.data.focusedTopicId = data.topicId;
            // What this window has in front and whether it is awake: an epoch
            // born there is born seen (ATTN-06). A guest's focus never counts.
            // A client that sends `subject` (null included: a browser pane in
            // front) says it itself; an older one is read from its topic.
            {
              const subject = typeof data.subject === 'string' && isAttentionSubject(data.subject)
                ? data.subject
                : 'subject' in data ? null
                : data.topicId ? topicSubject(data.topicId) : null;
              setSocketFocus(ws.data.id, { subject, awake: data.awake ?? true, chosen: data.chosen === true }, { guest: guestSocket });
            }
            break;
          case 'subscribe': {
            // P6: the set of topics this connection currently has open, used to
            // route streaming deltas only to clients showing that topic.
            const before = ws.data.openTopicIds;
            const next = new Set(data.topicIds);
            ws.data.openTopicIds = next;
            // A topic that JOINS the set in the middle of its turn missed the
            // frames before this one: a chat opened while its agent works, a
            // project chat mounting. It gets the turn so far, as a socket that
            // opens does (card 423e016f). Not on the first set: until then the
            // socket received every delta, and its open sent every catch-up.
            const joinedIds = before ? [...next].filter((id) => !before.has(id)) : [];
            if (joinedIds.length > 0) {
              const joined = (topicId: string | undefined) =>
                !!topicId && joinedIds.includes(topicId) &&
                (!guestSocket || socketMayReadTopic(ctx.db, ws.data, topicId));
              for (const frame of streamCatchupFrames(joined)) {
                if (guestSocket && !socketMayReceiveFrame(ctx.db, ws.data, frame)) continue;
                try { sendWsFrame(ws, JSON.stringify(frame), "stream:catchup"); } catch { /* socket closed */ }
              }
            }
            break;
          }
          case 'typing':
            broadcastToTopic(data.topicId, { type: 'typing', topicId: data.topicId, clientId: ws.data.id, text: data.text || '' }, ws);
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'drag:start':
            broadcast({ type: 'drag:start', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:end':
            broadcast({ type: 'drag:end', topicId: data.topicId, sourceWindowId: data.windowId }, ws);
            break;
          case 'drag:drop':
            broadcastToAll({ type: 'drag:accepted', topicId: data.topicId, targetWindowId: data.windowId, sourceWindowId: data.sourceWindowId });
            break;
          case 'hello':
            // v3 foundations WS-02 handshake — log client version + capabilities
            // for observability. Future protocol versions may use this to emit
            // an `upgrade-required` frame when clientProtocolVersion < SERVER_PROTOCOL_VERSION.
            console.log(`[WS][handshake] hello from ${ws.data.id}: client v${data.clientVersion} (proto ${data.protocolVersion}), caps=[${data.capabilities.join(', ')}]`);
            // Presence: a window may carry its identity + open topics on hello
            // (reconnect-safe — the client re-sends hello on every WS 'open').
            // Not for a guest: the handshake is protocol and passes, but the
            // presence fields would put its window into the owner's roster,
            // which is the same pollution `presence:announce` is refused for.
            if (data.windowId && !guestSocket) {
              ws.data.windowId = data.windowId;
              ws.data.windowLabel = data.windowLabel;
              ws.data.detached = data.detached;
              ws.data.presenceSpaceId = data.spaceId;
              ws.data.presenceTopicIds = data.topicIds ?? [];
              ws.data.presenceFocusedTopicId = data.focusedTopicId;
              ws.data.presenceTabs = data.tabs;
              broadcastPresence();
            }
            break;
          case 'presence:announce':
            // Presence update after hello (tab opened/closed/focused inside the
            // window, or detach state changed). Restamp this socket + re-snapshot.
            ws.data.windowId = data.windowId;
            ws.data.windowLabel = data.windowLabel;
            ws.data.detached = data.detached;
            ws.data.presenceSpaceId = data.spaceId;
            ws.data.presenceTopicIds = data.topicIds;
            ws.data.presenceFocusedTopicId = data.focusedTopicId;
            ws.data.presenceTabs = data.tabs;
            broadcastPresence();
            break;
        }
      } catch (err) { console.warn(`[WS] Failed to parse message from ${ws.data.id}:`, err); }
    },
  };
}
