/**
 * Process-wide context: the app context, the turn ledger and the HTTP/WS client sets every later stage reads.
 */
import { join } from "path";
import type { ServerWebSocket } from "bun";
import type { WSData } from "../types";
import { createAppContext } from "../utils";
import { setUploadRootsProvider } from "../browser-tool-dispatcher";
import { uploadAllowedRoots, parseExtraRoots } from "../lib/upload-allowlist";
import { homedir } from "os";
import { initPrimaryRole } from "../lib/primary-role";
import type { BaseScope } from "./scope";

export function bootCore(scope: BaseScope) {
  const { rootDir } = scope;
  // Create app context (initializes SQLite database)
  const ctx = createAppContext(rootDir);
  // Who is the primary, read before any stage that would start work. A non-primary server keeps quiet.
  const primaryRole = initPrimaryRole({
    db: ctx.db,
    stateFile: join(ctx.APP_DATA_DIR, "primary-state.json"),
    localMachineId: () => ctx.machineStore.upsertLocal().id,
  });
  if (!primaryRole.isPrimary()) {
    console.log(`[primary] this server is NOT the primary (epoch ${primaryRole.epoch()}): dispatcher, scheduled cards and hub reader stay off`);
  }

  // Always built by `createAppContext`; optional on the type only for test contexts.
  const turnLedger = ctx.turnLedger!;


  // Da dove `browser_upload` può leggere. Prima da nessun posto in particolare:
  // prendeva il path della tool-call e apriva il file, punto — quindi una chiamata
  // con un path sbagliato faceva leggere al server un file arbitrario dell'utente
  // e lo caricava su una pagina raggiungibile.
  //
  // Le radici sono quelle che hanno un senso per un upload: dove gli agenti
  // depositano i propri artefatti, la cartella uploads del server, e i progetti
  // REGISTRATI (che sono cartelle dichiarate dall'utente — così il caso d'uso vero,
  // caricare un documento del progetto su cui si lavora, continua a funzionare).
  // `TOPICS_UPLOAD_ROOTS` (separate da `:`) è la valvola esplicita per il resto.
  //
  // Ricalcolate a ogni chiamata: registrare un progetto nuovo deve bastare, senza
  // riavviare il server.
  setUploadRootsProvider(() =>
    uploadAllowedRoots({
      mediaDirs: [
        join(homedir(), ".topics/media"),
        join(homedir(), ".topics/workspace"),
        join(ctx.APP_DATA_DIR, "media"),
        join(ctx.APP_DATA_DIR, "workspace"),
      ],
      uploadsDir: ctx.UPLOADS_DIR,
      projectPaths: ctx.projectStore.list().map((p) => p.path).filter(Boolean),
      extraRoots: parseExtraRoots(process.env.TOPICS_UPLOAD_ROOTS),
    }),
  );

  const { PORT, PUBLIC_DIR, wsClients, broadcastToAll, broadcastToTopic, broadcast,
    loadTopics, loadUnread, saveUnread,
    activeStreams, getMessageById, getMimeType, logRequest, db } = ctx;


  // Phase 30 BROWSER-CHAT-03 — registry of active /ws/browser/:contextId
  // connections keyed by contextId. Multiple panels may watch the same context
  // (UI plus E2E spies); the broadcast iterates the whole set. Populated by the
  // websocket.open browser branch and cleaned by websocket.close.
  const browserWsClients = new Map<string, Set<ServerWebSocket<WSData>>>();


  // Make that registry observable on `/api/system/status`, next to `wsClients`.
  // Two numbers, because they fail apart: `sockets` stuck above zero with every
  // pane closed means a `close` handler did not run; `contexts` stuck with
  // `sockets` at zero means the empty-Set delete did not. Cheap - the Map holds
  // one entry per open pane, so this walk is a handful of iterations per poll.
  ctx.browserWsCounts = () => {
    let sockets = 0;
    for (const set of browserWsClients.values()) sockets += set.size;
    return { contexts: browserWsClients.size, sockets };
  };

  return { PORT, PUBLIC_DIR, activeStreams, broadcast, broadcastToAll, broadcastToTopic, browserWsClients, ctx, db, getMessageById, getMimeType, loadTopics, loadUnread, logRequest, saveUnread, turnLedger, wsClients };
}
