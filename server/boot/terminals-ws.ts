/**
 * Live terminals and the WebSocket heartbeat.
 */
import { listTopicsLiveTerminals, readTopicsTerminalScreen, writeTopicsTerminal } from "../routes/terminal";
import { createLiveTerminals } from "../lib/live-terminals";
import { createLiveTerminalsRouter } from "../routes/live-terminals";
import { createExternalSessionsRouter } from "../routes/external-sessions";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import { reapBrowserSocket } from "../browser-socket-reaper";
import type { AfterHeartbeat } from "./scope";

export function bootTerminalsWs(scope: AfterHeartbeat) {
  const { browserWsClients, ctx, externalSessions, hostMirror, loadTopics, loadUnread, nativeHostLiveness, saveUnread, viewerCountPublisher, wsClients } = scope;
  // External-session census: poll + broadcast so a `claude` started in iTerm
  // surfaces on the board within ~20s without any client polling.
  // Le sessioni fuori da Topics, per la barra e per la presence: quante sono e
  // quante stanno LAVORANDO adesso. Il secondo numero e' quello che mancava —
  // dire «4 fuori da Topics» mentre una di quelle sta macinando, e non dirlo,
  // fa sembrare fermo un lavoro in corso.
  //
  // Si contano su `list()`, NON su `byProject()`: il secondo raggruppa per
  // progetto della board e quindi lascia fuori chi non e' attribuibile.
  //
  // NOTA su come ci sono arrivato, perche' la prima spiegazione era sbagliata.
  // Il 23/08 la presence diceva «0 al lavoro» avendone quattro, e avevo
  // incolpato questa riga. Rimettendo `byProject()` sul server vivo il numero
  // tornava CORRETTO: la vera causa era che lo scanner jcode non attribuiva
  // nessuna sessione a nessun progetto (`projectPath: null` fisso), quindi il
  // rollup era vuoto. Corretto li'.
  //
  // La formula su `list()` resta comunque quella giusta, per una ragione di
  // significato e non di sintomo: «quante stanno lavorando» non deve dipendere
  // dal fatto che la board conosca quella cartella. Chi lavora fuori da Topics
  // puo' benissimo lavorare fuori dai progetti di Topics, e in quel caso il
  // numero deve dirlo lo stesso. Stessa cache (TTL 10s), nessuna scansione in
  // piu'.
  ctx.externalSessionsCount = () => externalSessions.list().length;

  ctx.externalSessionsWorking = () =>
    externalSessions.list().filter((s) => s.state === "active").length;

  const externalSessionsRouter = createExternalSessionsRouter(ctx, externalSessions);

  // Every live terminal on the Mac, inside and outside Topics: the menu at the end
  // of the tabs and the agents (MCP `session_*`) read and write through here.
  const liveTerminals = createLiveTerminals({
    topics: listTopicsLiveTerminals,
    topicsScreen: readTopicsTerminalScreen,
    topicsSend: writeTopicsTerminal,
    sources: { terminal: process.env.TOPICS_LIVE_TERMINAL_APP !== "0" && process.platform === "darwin" },
  });

  const liveTerminalsRouter = createLiveTerminalsRouter(ctx, liveTerminals);



  const WS_HEARTBEAT_INTERVAL_MS = 30000;

  const WS_TIMEOUT_MS = 90000;


  // WebSocket heartbeat
  const wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wsClients) {
      if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
        console.log(`[WS] Removing stale client ${ws.data.id} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
        wsClients.delete(ws);
        try { ws.close(1001, "Connection timeout"); } catch { /* handle may already be closed */ }
        continue;
      }
      if (ws.readyState === 1) { try { ws.ping(); } catch { /* ping on a dying socket: the next sweep drops it */ } }
    }
    // Browser screencast sockets are kept OUT of wsClients, so reap them here too.
    // Without this, a half-open TCP break (laptop sleep / network drop) never
    // fires `close`, so _browserCleanup never runs and the CDP screencast keeps
    // streaming JPEG frames into a dead socket — this watchdog is the only thing
    // that releases the CDP session. _browserCleanup is idempotent, so calling it
    // here and again in the close handler is safe.
    for (const [ctxId, set] of browserWsClients) {
      for (const ws of set) {
        if (now - ws.data.lastPong > WS_TIMEOUT_MS) {
          console.log(`[WS][browser] Reaping stale browser client for ctx ${ctxId} (no pong for ${Math.round((now - ws.data.lastPong) / 1000)}s)`);
          // De-register the native executor explicitly (idempotent): a server-side
          // close on an already-half-dead socket may not fire the `close` handler,
          // which would otherwise leave a Tauri pane's delegation pointing at a dead
          // socket so isDelegated() keeps routing agent ops into the void.
          // Owner-scoped: if the pane already re-registered on a NEWER socket
          // (reconnect after sleep), reaping this stale one must not drop the
          // fresh registration.
          reapBrowserSocket(ctxId, ws, set, {
            unregisterExecutor: (contextId, socket) => nativeDelegateRegistry.unregister(contextId, socket),
            unregisterLiveness: (socket) => nativeHostLiveness.unregister(socket),
            cleanup: ws.data._browserCleanup,
            hostClosed: (socket, contextId) => hostMirror.onClose(socket, contextId),
            close: (code, reason) => ws.close(code, reason),
          });
          continue;
        }
        if (ws.readyState === 1) { try { ws.ping(); } catch { /* ping on a dying socket: the next sweep drops it */ } }
      }
      if (set.size === 0) {
        browserWsClients.delete(ctxId);
        viewerCountPublisher.forget(ctxId);
      } else {
        // A reaped viewer changes the count for the panes that stay; a tick
        // that reaped nobody sends nothing (the publisher compares first).
        viewerCountPublisher.publish(ctxId);
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);


  // Startup cleanup: remove orphaned unread entries
  {
    const topicsData = loadTopics();
    const unreadData = loadUnread();
    let cleaned = false;
    for (const topicId of Object.keys(unreadData)) {
      if (!topicsData.topics[topicId]) { delete unreadData[topicId]; cleaned = true; }
    }
    if (cleaned) { saveUnread(unreadData); console.log("[Startup] Cleaned orphaned unread entries"); }
  }

  return { externalSessionsRouter, liveTerminalsRouter, wsHeartbeatTimer };
}
