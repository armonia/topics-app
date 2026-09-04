import { rowsCarryAsk, type AskHaystackRow } from "../lib/ask-answer-routing";
import { canonicalProjectPath } from "../lib/canonical-project-path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { detectProjectPath } from "../lib/detect-project-path";
import { homedir } from "os";
import type { AppContext, RouteHandler, Topic } from "../types";
import { getProvider, getDefaultProvider, getDefaultProviderName, type AIProvider } from "../providers";
import { routesThroughGateway } from "./commandRouting";
import { createAutoNameRouter } from "./autoname";
import { createHistoryRouter, createToolDetailRouter } from "./history";
import { blocksForDisk, leanMessagesForWire, toolCallsColumnForRow } from "../../shared/lean-tool-call";
import { createEditRouter } from "./edit";
import { createChatRouter } from "./chat";
import { e2eRoutesEnabled } from "./e2e";
import { createPermissionRouter } from "./permission";
import { createBrowserBridgeRouter } from "./browser-bridge";
import type { BrowserService } from "../browser-service";
import { resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { getTerminalSessionById, setSubAgentExitHandler } from "./terminal";
import { getSessionContext } from "../db/session-context";
import { markTargetNotificationsSeen, countUnseenNotifications } from "../db/notification-log";
import { classifyContext, windowForMeasure } from "../usage/context-window";
import { contextUpdateFromUsage } from "../usage/usage-update";
import { createTaskService } from "../services/tasks";
import { persistAgentTaskTab, attachLoginHandleToTaskTab } from "../services/task-tab-persist";
import { matchProjectRefAll, type ProjectRefCandidate } from "../lib/project-ref";
import { shouldHonorClearMessages } from "../../shared/clear-messages-policy";
import { projectIdForPath } from "../../shared/board";
import { clearActionFor } from "./clearPolicy";
import { switchTopicCore, createTopicCore } from "../lib/session-control-core";
import { moveTerminalPaneToProject as relocateTerminalPaneToProject, moveTopicToProject } from "../lib/relocate-pane";
import { bumpUnreadCount } from "../lib/unread-count";
import { createSubagentWatcher } from "../lib/subagent-watch";
import { computeTopicChanges } from "../lib/topic-changes";
import { archiveTopicFully } from "../services/archive-topic";
import { dropTurnCheckpoints } from "../services/turn-checkpoints";
import { clearRetirement, recordRetirement } from "../services/retirement";
import { parkTopicSession } from "../lib/session-parking";
import { parseTranscriptToMessages } from "../lib/claude-transcript-import";
import { parseTranscriptFacts } from "../lib/external-claude-sessions";
import { EFFORT_TIERS } from "../../shared/effort";
// Only the «delivery» side: the waiting legs (beginAsk/waitForAnswer) live in
// the human channel, in ./permission.
import { deliverAnswer, hasPendingAsk, cancelAsk } from "../lib/ask-user-bridge";
// "Waiting on you" is also read off the ROW: the panel's questions travel over
// the MCP bridge, not the provider's native channel, and after a restart no
// in-memory map remembers them. See lib/waiting-ask.ts.
import { waitingAskStartedAt } from "../lib/waiting-ask";
import { isPlanApprovalAnswer } from "../lib/plan-approval";
import { releaseHumanHold, humanHoldAgeMs } from "../lib/human-hold";
import { readSlashCommandSource, isValidSlashCommandName } from "../lib/slash-command-source";
import { recordTurnEnd } from "../providers/turn-end-registry";
import { cancelled } from "../providers/stop-reason";
import { decodeCol } from "../../shared/message-blob";
import { subagentProcesses } from "./subagentProcesses";
import { sessionStatus } from "./sessionStatus";

/**
 * Remove a topic id from every ui_state record's `openChatTopicIds` array,
 * across all clients. Called when a topic is archived or deleted to prevent
 * phantom ids from lingering in per-project persisted tab state.
 *
 * The read-modify-write is wrapped in a transaction so concurrent writes from
 * clients (debounced ui_state PUTs) can't interleave and lose the purge.
 * Broadcasts are collected and emitted AFTER the transaction commits so
 * clients never see a mutation that was subsequently rolled back.
 */
/**
 * Remove every reference to `topicId` from a single ui_state record value,
 * mutating `parsed` in place. Returns true iff something changed.
 *
 * Handles BOTH persisted shapes that can hold an open chat:
 *  - Project / legacy tab-identity records: `{ openChatTopicIds: string[],
 *    activeChatTopicId? }` (written by the project-window layout sync).
 *  - The single global `pane-store-v2` snapshot: `{ panes, groups, closedStack }`,
 *    where a top-level chat pane is keyed by the RAW topic id
 *    (`createPaneId('chat', id) === id`).
 *
 * Why both: before this, the purge only filtered `openChatTopicIds`, which the
 * current `pane-store-v2` snapshot does NOT contain. So archiving/deleting a
 * chat removed it from project records but NEVER from `pane-store-v2` — the
 * pane lingered in the single shared snapshot and resurfaced as a phantom tab
 * on any client that didn't independently filter it (the "ghost tab on mobile"
 * bug). Now the shared snapshot is purged too, with a fresh server_seq so LWW
 * treats the removal as newer than any pre-purge client write.
 */
/** Mirror of the client's `TOMBSTONES_MAX` (client/src/state/pane/types.ts). */
const TOMBSTONES_MAX = 500;

export function removeTopicFromUiStateValue(parsed: any, topicId: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let changed = false;

  // Shape A — project / legacy tab-identity records.
  if (Array.isArray(parsed.openChatTopicIds) && parsed.openChatTopicIds.includes(topicId)) {
    parsed.openChatTopicIds = parsed.openChatTopicIds.filter((id: string) => id !== topicId);
    changed = true;
  }
  if (parsed.activeChatTopicId === topicId) {
    delete parsed.activeChatTopicId;
    changed = true;
  }

  // Shape B — pane-store-v2 snapshot (panes / groups / closedStack).
  const removedPaneIds = new Set<string>();
  if (parsed.panes && typeof parsed.panes === "object" && !Array.isArray(parsed.panes)) {
    for (const [pid, p] of Object.entries(parsed.panes as Record<string, any>)) {
      if (pid === topicId || (p && typeof p === "object" && (p as any).topicId === topicId)) {
        removedPaneIds.add(pid);
      }
    }
    for (const pid of removedPaneIds) {
      delete (parsed.panes as Record<string, any>)[pid];
      changed = true;
    }
  }
  if (parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)) {
    for (const g of Object.values(parsed.groups as Record<string, any>)) {
      if (g && Array.isArray(g.paneIds)) {
        const filtered = g.paneIds.filter((id: string) => id !== topicId && !removedPaneIds.has(id));
        if (filtered.length !== g.paneIds.length) {
          g.paneIds = filtered;
          changed = true;
        }
      }
      // Defensive only: the current synced pane-store-v2 Group shape carries no
      // `activePaneId` (active pane is derived at render time, never persisted),
      // so this never fires for real data — it's a no-op guard for legacy/demo
      // group shapes that did carry it. Kept for parity with the orphan-cleanup
      // backstop; safe because `Set.has(undefined)` is false.
      if (g && typeof g === "object" && removedPaneIds.has((g as any).activePaneId)) {
        delete (g as any).activePaneId;
        changed = true;
      }
    }
  }
  // THE UNDO RECORD STAYS, AND ITS ID IS STAMPED AS CLOSED.
  //
  // Until 2026-08-19 this line DELETED the record, and that is the chain that
  // emptied `closedStack` after a real close:
  //
  //   someone closes a chat tab
  //     → the reducer puts the undo record in `closedStack` and PUTs
  //     → the retirement cascade archives that topic (`retirement.ts`, «tab-close»)
  //     → `archiveTopicFully` calls this purge
  //     → the record just created vanishes, and the tombstone below does not
  //       replace it, because it looks at `removedPaneIds` — i.e. the panes
  //       taken out of `panes`, and a pane already closed is no longer there.
  //
  // Measured result: after a close, the close leaves NO trace — neither the
  // record nor the marker. `pane-undo.spec.ts` saw it («closedStack must have at
  // least one entry after CLOSE_PANE») and stayed green anyway, because the
  // idle write loop resent the state a moment later and put the record back. So
  // one defect was propped up by another: the fix for the loop (branch
  // `wip/ciclo-scritture-localseq`) made this one surface, and that is why it
  // stayed out of main.
  //
  // WHY DELETING IT WAS NOT NEEDED. The defect this purge guards against is the
  // GHOST TAB — an archived chat reappearing open on another device — and that
  // one lives in `panes`, which is still cleaned above. `closedStack` reopens
  // nothing: on the client it feeds `bumpClosed` (`reducers/panes.ts`), exactly
  // the same CLOSE signal the tombstones carry. Removing it from there did not
  // prevent a resurrection, it deleted an undo.
  //
  // And the marker is printed all the same: `id` goes into `removedPaneIds`, so
  // the block below stamps it as if the pane had been removed now. That way a
  // peer that still had that tab open drops it — the protection is intact — and
  // the undo survives.
  if (Array.isArray(parsed.closedStack)) {
    for (const rec of parsed.closedStack as any[]) {
      if (!rec || !rec.pane) continue;
      if (rec.pane.id === topicId || rec.pane.topicId === topicId) {
        removedPaneIds.add(rec.pane.id);
      }
    }
  }

  // Durable close MARKER for every pane we just deleted. Deleting the entry is
  // NOT enough: the client's HYDRATE_FROM_SNAPSHOT does a cross-client UNION
  // (reducers/panes.ts — "we let the closedStack TOMBSTONE channel carry
  // removals"), so a pane that a live client still holds locally and that the
  // incoming snapshot merely OMITS is kept, not dropped — a bare deletion is
  // structurally indistinguishable from "this peer never knew about it". So the
  // purge was silently undone: the archived chat rode the client's next
  // debounced PUT straight back into the shared snapshot (measured: server
  // purge at seq N, resurrection at seq N+1 ~1s later), and the re-add was then
  // mistaken for a preview-navigation, which closed a BYSTANDER tab.
  // `tombstones` is the map that union actually consults; its causal guard
  // (`openedAt > closedAt`) keeps a genuine later reopen alive, so stamping now
  // can't kill a tab the user re-opens afterwards.
  if (removedPaneIds.size > 0) {
    if (!parsed.tombstones || typeof parsed.tombstones !== "object" || Array.isArray(parsed.tombstones)) {
      parsed.tombstones = {};
    }
    const closedAt = Date.now();
    for (const pid of removedPaneIds) parsed.tombstones[pid] = closedAt;
    // Mirror the client's TOMBSTONES_MAX cap (state/pane/types.ts) so a
    // long-lived DB can't grow the map without bound: keep the newest ids.
    const ids = Object.keys(parsed.tombstones);
    if (ids.length > TOMBSTONES_MAX) {
      const keep = new Set(
        ids.sort((a, b) => (parsed.tombstones[b] ?? 0) - (parsed.tombstones[a] ?? 0)).slice(0, TOMBSTONES_MAX),
      );
      for (const id of ids) if (!keep.has(id)) delete parsed.tombstones[id];
    }
    changed = true;
  }

  return changed;
}

/**
 * Retract the durable close markers this topic's panes may carry — the exact
 * inverse of the tombstone stamping in `removeTopicFromUiStateValue`.
 *
 * Required for symmetry: the client's hydrate runs a BIDIRECTIONAL tombstone
 * strip (reducers/panes.ts), so a pane listed in the incoming snapshot is
 * DELETED whenever a live tombstone claims its id. Stamping on archive without
 * retracting on unarchive therefore makes the reopen invisible — the chat comes
 * back in the topic list but its tab is stripped on every hydrate, forever.
 * Matches both pane-id encodings for a chat: the raw topic id
 * (`createPaneId('chat', id) === id`) and any `<prefix>:<topicId>` form.
 */
export function retractTopicTombstoneFromUiStateValue(parsed: any, topicId: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const tomb = parsed.tombstones;
  if (!tomb || typeof tomb !== "object" || Array.isArray(tomb)) return false;
  let changed = false;
  for (const key of Object.keys(tomb)) {
    if (key === topicId || key.endsWith(`:${topicId}`)) {
      delete tomb[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Apply `mutate` to every ui_state record, persisting + broadcasting only the
 * ones it actually changed. Shared by the archive purge and the unarchive
 * retraction so both inherit the same seq allocation and locking discipline.
 */
function mutateAllUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  label: string,
  topicId: string,
  mutate: (parsed: any, topicId: string) => boolean,
): { ok: true } | { ok: false; error: string } {
  // Phase 30 PANE-02 invariant: every ui_state write must allocate a fresh
  // server_seq so cross-device LWW treats this purge as newer than any
  // pre-purge snapshot. Without this bump, a later client PUT carrying an
  // older seq could silently win and re-introduce the purged topic.
  //
  // Race-fix (round-6 audit): mirrors the BEGIN IMMEDIATE pattern used in
  // server/routes/ui-state.ts (single-key PUT L74-90, bulk PUT L107-126). The
  // previous implementation used db.transaction() (DEFERRED) plus three
  // redundant `SELECT MAX(server_seq)` subqueries per row (INSERT VALUES,
  // ON CONFLICT SET, and a separate readback), so a concurrent PUT could
  // snapshot the same MAX and collide on seq. Now: acquire RESERVED lock at
  // BEGIN via .immediate(), read MAX once, allocate N distinct seqs with a
  // counter, and bind nextSeq as a parameter (no more subqueries). The allocated
  // seq is returned from the txn, eliminating the separate readback SELECT.
  let broadcasts: { key: string; value: any; server_seq: number }[] = [];
  try {
    broadcasts = db.transaction(() => {
      const out: { key: string; value: any; server_seq: number }[] = [];
      const rows = db.query("SELECT key, value FROM ui_state").all() as { key: string; value: string }[];
      const { maxSeq } = db.query(
        "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
      ).get() as { maxSeq: number };
      let i = 0;
      for (const row of rows) {
        let parsed: any;
        try { parsed = JSON.parse(row.value); } catch { continue; }
        if (!mutate(parsed, topicId)) continue;
        const next = JSON.stringify(parsed);
        const nextSeq = maxSeq + (++i);
        db.run(
          `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
           VALUES (?, ?, 2, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             payload_version = 2,
             server_seq = excluded.server_seq,
             updated_at = datetime('now')`,
          [row.key, next, nextSeq],
        );
        out.push({ key: row.key, value: parsed, server_seq: nextSeq });
      }
      return out;
    }).immediate();
  } catch (err) {
    // Bug #12 (round-7 hardening): do NOT swallow. A silent failure here leaves
    // the ui_state record stale so the archived topic id "resurrects" on the
    // next reload — the ghost-topic bug. Log structured + propagate so the
    // caller can surface it to the client (500) instead of returning 200 OK
    // while the server state is incoherent.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[topics] ${label} failed for topicId=${topicId}:`, { error: message, stack: err instanceof Error ? err.stack : undefined });
    return { ok: false, error: message };
  }
  for (const b of broadcasts) {
    broadcastToAll({
      type: "ui-state:updated",
      key: b.key,
      value: b.value,
      payload_version: 2,
      server_seq: b.server_seq,
    });
  }
  return { ok: true };
}

/** Archive/delete: strip the topic from every ui_state record + tombstone it.
 *  Esportata perché `archiveTopicFully` (services/archive-topic.ts) la riceve
 *  iniettata: il servizio non può importare da `routes/` senza invertire gli
 *  strati, ma questo è il passo 3 dell'archiviazione e deve restare uno solo. */
export function purgeTopicFromUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  topicId: string,
): { ok: true } | { ok: false; error: string } {
  return mutateAllUiState(db, broadcastToAll, "purgeTopicFromUiState", topicId, removeTopicFromUiStateValue);
}

/**
 * Unarchive: retract the close markers left by the purge. Best-effort by
 * design — unlike the purge, a failure here can't leave the topic in a
 * half-archived state, so it must never turn a successful unarchive into a
 * 500. The retraction is idempotent, so the next unarchive retries it.
 */
function restoreTopicInUiState(
  db: import("bun:sqlite").Database,
  broadcastToAll: (msg: any) => void,
  topicId: string,
): void {
  mutateAllUiState(db, broadcastToAll, "restoreTopicInUiState", topicId, retractTopicTombstoneFromUiStateValue);
}

/** Quanti caratteri grezzi leggere per ricavarne {@link PREVIEW_MAX_CHARS} puliti.
 *  Largo abbastanza da sopravvivere a un blocco di codice in testa al messaggio,
 *  stretto abbastanza da non far viaggiare il `content` intero: il messaggio più
 *  lungo in archivio è di 158.122 caratteri, e ne servono 120. GEMELLA di
 *  `TOPIC_PREVIEW_SOURCE_MAX` in `client/src/state/topicPreviews.ts`, dove taglia
 *  il testo che arriva dal WS prima della stessa potatura. */
const PREVIEW_SOURCE_CHARS = 600;
/** Quante righe indietro guardare quando la prima si pota a NIENTE (un turno di
 *  solo codice: in SQL ha `content`, dopo {@link topicPreviewText} non ha più
 *  prosa). Sull'archivio di oggi il ripiego non scatta mai — 0 topic su 456 —
 *  quindi il costo è zero query in più; serve perché la promessa «si prende la
 *  precedente che parla» sia vera anche quando il caso si presenta. */
const PREVIEW_FALLBACK_DEPTH = 6;
/** Per quanto vale una fotografia di boot già scattata. Pochi secondi: basta a
 *  coprire la raffica di N finestre che si idratano insieme dopo un reload, ed è
 *  il tetto alla staleness nel solo caso che il validatore della cache non vede
 *  (una modifica in place dell'ultimo messaggio). Vedi `previewCache`. */
const PREVIEW_CACHE_TTL_MS = 5_000;
/** Lunghezza dell'anteprima. GEMELLA di `TOPIC_PREVIEW_MAX` in
 *  `client/src/state/topicPreviews.ts`: le due pulizie devono restare in passo,
 *  perché il client ripassa sul testo che arriva di qui (l'operazione è
 *  idempotente, quindi su un testo già pulito non fa niente). */
const PREVIEW_MAX_CHARS = 120;
/** Il prefisso delle buste di contesto di OpenClaw — vedi `isContextMessage` in
 *  `server/utils/build-provider-history.ts`. Qui serve come pattern SQL, quindi
 *  niente apici né `%` dentro: entra in un `LIKE` per concatenazione. */
const CONTEXT_ENVELOPE_PREFIX = "[Chat messages since your last reply";

/**
 * Il testo di un messaggio ridotto a UNA riga da mostrare sotto il nome di una
 * chat in sidebar.
 *
 * Non è un troncamento: è una potatura. Sotto al nome c'è una riga da 11px, e
 * quasi tutto ciò che rende un messaggio leggibile in chat lì diventa rumore —
 * un blocco di codice occupa l'intera anteprima senza dire niente, un `#` a
 * inizio riga si legge come un carattere a caso, un a-capo diventa uno spazio
 * doppio. Si tiene solo la prosa.
 *
 * IDEMPOTENTE di proposito: il client applica la stessa pulizia al testo che
 * arriva dal WS, e quel testo può già essere passato di qui.
 *
 * Esportata per `topics-preview.test.ts`, che la esercita sugli STESSI casi del
 * test di `cleanPreviewText` lato client: sono due copie a mano, oggi identiche,
 * e finché solo una aveva un test potevano divergere in silenzio.
 */
export function topicPreviewText(raw: string): string {
  let s = raw;
  // I blocchi di codice non stanno in una riga da 11px, e di solito SONO il
  // messaggio: via il blocco intero, resta la frase che lo introduceva. Anche la
  // recinzione APERTA — è così che arriva un turno tagliato a 600 caratteri.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/```[\s\S]*$/, " ");
  // Impalcatura iniettata: non l'ha scritta né l'umano né il modello.
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
  // Immagini via, link ridotti alla loro etichetta: l'URL non si legge comunque.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Segni di struttura a inizio riga (titoli, citazioni, elenchi): quando le
  // righe vengono compresse in una sola non delimitano più niente.
  // `(?:…)+`, non `(?:…)`: i marcatori si IMPILANO — «> > citato», «## # x»,
  // «1. 2. x» — e togliendone uno solo per passata questa potatura smetteva di
  // essere IDEMPOTENTE, che è la proprietà su cui si regge il patto con la
  // gemella lato client (`cleanPreviewText`). Il testo che arriva dal WS fa UNA
  // passata, quello dell'idratazione ne fa DUE: la stessa chat mostrava due
  // testi diversi prima e dopo un ricarico. Consumandoli tutti in una volta, la
  // seconda passata non trova più niente da togliere.
  s = s.replace(/^[ \t]{0,3}(?:(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+)+/gm, "");
  // Righe orizzontali: una riga fatta di soli `---` è un separatore, e compressa
  // in una riga sola diventa il primo "carattere a caso" che si legge.
  s = s.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ");
  // Enfasi. `__` e `_` NON si toccano: qui dentro passano `session_key` e
  // `mcp__topics__browser_navigate`, e toglierli storpierebbe le parole. Il
  // corsivo si toglie solo a coppia CHIUSA sulla stessa riga e con l'interno
  // attaccato agli asterischi, così una moltiplicazione («2 * 3 * 4») resta com'è.
  s = s.replace(/\*\*|~~/g, "");
  s = s.replace(/\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, "$1");
  s = s.replace(/`/g, "");
  // UNA riga: gli a-capo diventano spazi e gli spazi si comprimono.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= PREVIEW_MAX_CHARS) return s;
  return s.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
}

/**
 * `paneAttachedTo` — «una pane viva sta guardando questo contextId?». Il
 * registro dei socket `/ws/browser/<ctx>` vive in `server.ts`, quindi arriva
 * come predicato: serve solo al ponte del browser (`browser-bridge`), che senza
 * di lui non sa distinguere una pane montata da un contesto headless che
 * nessuno vede. Assente (test, build parziali) ⇒ «non lo so», trattato come
 * «nessuna pane»: la rotta prova comunque il ripiego force-open.
 */
export function createTopicsRouter(
  ctx: AppContext,
  browserService?: BrowserService,
  paneAttachedTo: (contextId: string) => boolean = () => false,
): RouteHandler {
  const {
    GATEWAY_URL, GATEWAY_TOKEN, OPENCLAW_DIR,
    broadcastToAll,
    loadTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey,
    loadUnread, saveUnread,
    loadLocalMessages, countMessagesBySession, saveLocalMessages, appendLocalMessage,
    updateLastMessage, updateToolCallFields, discardIfEmptyTurn,
    endStream, isStreaming,
    readJSON, json, matchRoute, errorResponse, slugify,
    searchTranscripts,
    getMessageById,
    activeStreams,
    worktreeStore,
    projectStore,
  } = ctx;

  /**
   * Ri-emette il ring dopo un cambio di modello, contro la finestra NUOVA.
   *
   * Rilegge la misura persistita — `used` non cambia, è la dimensione reale
   * dell'ultima chiamata — e la classifica contro la finestra del modello appena
   * scelto. Best-effort per costruzione: se non c'è ancora una misura non c'è
   * nulla da correggere, e un errore qui non deve far fallire la PATCH.
   */
  /**
   * Il modello contro cui va letto il contesto di questa chat.
   *
   * Non è `topic.model`: quello è il PIN, e una chat senza pin non gira senza
   * modello — gira col default del provider, che oggi è la variante a finestra
   * lunga (`claude-opus-5[1m]`). Leggere il pin vuoto come «non lo so» faceva
   * cadere il denominatore sul nome nudo che la CLI riporta nei suoi eventi,
   * cioè 200k su una chat da un milione: l'anello segnava pieno a un quinto.
   */
  function currentModelOf(topic: Topic): string | null {
    if (topic.model) return topic.model;
    try { return resolveProvider(topic).defaultModel?.() ?? null; }
    catch { return null; }
  }

  function broadcastContextForModelChange(topic: Topic): void {
    const row = getSessionContext(ctx.db, topic.sessionKey);
    if (!row) return;
    const usage = classifyContext(row.usedTokens, windowForMeasure(row, currentModelOf(topic)));
    const update = contextUpdateFromUsage(usage, row.model);
    broadcastToAll({ type: "stream:context", sessionKey: topic.sessionKey, topicId: topic.id, ...update });
  }

  // Task lookup per il ponte MCP del browser (fork del browser su un task +
  // etichetta della scheda nell'inventario). One instance over the shared db
  // (same pattern as the dispatcher's service); le due letture che servono
  // finiscono in `BrowserBridgeDeps`.
  const taskSvc = createTaskService(ctx.db);

  /** Resolve the AI provider for a topic. Uses topic.provider if set, else default. */
  function resolveProvider(topic?: Topic | null): AIProvider {
    if (topic?.provider) {
      // Legacy coercion: Master topics were once created with the experimental
      // "claude-code-team" provider, which is NOT a registered chat provider —
      // getProvider would throw and we'd silently fall back to a non-deterministic
      // default. Map it to the real subscription-backed CLI provider so old leads
      // (and the removed PTY-teams path) keep working without a data migration.
      // See change refactor-master-into-kanban (AD-1).
      const name = topic.provider === "claude-code-team" ? "claude-code" : topic.provider;
      try { return getProvider(name); } catch {}
    }
    return getDefaultProvider();
  }

  /** Look up the topic owning a sessionKey and resolve its provider. */
  function providerForSessionKey(sessionKey: string): AIProvider {
    const topic = getTopicBySessionKey(sessionKey);
    return resolveProvider(topic);
  }

  /**
   * Lo slash command di questo sessionKey va inoltrato al gateway OpenClaw?
   *
   * Si decide sul provider DICHIARATO dal topic, non su quello risolto: la
   * regola (e il perché) stanno in `commandRouting.ts`, pure e testate.
   */
  function commandRoutesThroughGateway(sessionKey: string): boolean {
    const topic = getTopicBySessionKey(sessionKey);
    return routesThroughGateway(topic?.provider, getDefaultProviderName());
  }

  // ── Recapito dei risultati dei sub-agent ────────────────────────────────
  // Estratto in `server/lib/subagent-watch.ts`: erano trecento righe con uno
  // stato proprio (mappa delle sessioni osservate, timer, cursore in byte per
  // file) dentro un file di ROTTE, e chiuse lì non erano testabili — né un giro
  // di polling, né un transcript finto, né le guardie di rotazione. La closure
  // gli serviva per nove valori, che ora sono dipendenze scritte.
  const subagents = createSubagentWatcher({
    gatewayUrl: GATEWAY_URL,
    gatewayToken: GATEWAY_TOKEN,
    getTopicById,
    getTopicBySessionKey,
    saveSingleTopic,
    appendLocalMessage,
    broadcastToAll,
    bumpUnread: updateUnreadCount,
    resolveProvider,
  });
  const watchSessionForSubagents = subagents.watch;
  // La registrazione della strada B resta QUI: così il modulo non importa
  // `routes/terminal` e la dipendenza fra i due resta a senso unico.
  setSubAgentExitHandler(subagents.deliverExit);

  /** Politica di lettura e incremento: `server/lib/unread-count.ts`. */
  function updateUnreadCount(topicId: string) {
    bumpUnreadCount(
      { loadUnread, saveUnread, broadcastToAll, isArchived: (id) => getTopicById(id)?.archived === true },
      topicId,
    );
  }

  // Track which topics already had a browser navigate this session to avoid duplicate triggers
  const browserNavigatedTopics = new Set<string>();

  // Phase 30 BROWSER-CHAT-03 — OpenClaw browser bridge removed; agent now
  // controls the browser via 5 native tools at /api/browsers/:id/agent/*.
  // The legacy per-request targetId memoization Map (used by the deleted
  // bridge handler) was deleted alongside the bridge block.

  /**
   * Auto-open the browser pane when the assistant mentions a localhost:PORT dev
   * server in plain text (once per topic per stream). This is NOT a marker — it's
   * a convenience heuristic on natural output — so it survived the marker removal.
   * Explicit browser control is via the `open_browser_pane` tool.
   * Returns content unchanged (no stripping); only the side-effect matters.
   */
  function detectLocalhostAutoNav(content: string, topic: Topic | null): string {
    if (!topic) return content;
    // Cheap substring guard before the regex (the pattern always requires the
    // literal "localhost:") so we don't rescan every delta for nothing.
    if (!browserNavigatedTopics.has(topic.id) && content.includes('localhost:')) {
      const localhostMatch = content.match(/(?:https?:\/\/)?localhost:(\d{4,5})\b/);
      if (localhostMatch) {
        const port = parseInt(localhostMatch[1]);
        const appPort = parseInt(process.env.PORT || "3333");
        if (port !== appPort && port >= 3000 && port <= 65535) {
          const browserUrl = localhostMatch[0].startsWith("http") ? localhostMatch[0] : `http://${localhostMatch[0]}`;
          console.log(`[Browser] Auto-navigate via localhost detection: ${browserUrl}`);
          broadcastToAll({ type: "browser:navigate", topicId: topic.id, contextId: resolveContextIdForTopic(topic), url: browserUrl });
          browserNavigatedTopics.add(topic.id);
        }
      }
    }
    return content;
  }

  function isExistingDir(p: string): boolean {
    try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
  }

  /**
   * Resolve a project reference (a Topics project name/slug, a `~/` or absolute
   * path, or an OpenClaw workspace name) to an absolute directory on disk.
   *
   * Crucially this prefers the user's REAL Topics projects (projectStore) and
   * folders already bound to a topic — not just `~/.openclaw/workspace`. That is
   * what makes a cloud session's "open project Pix" land on the actual Pix
   * project the user has in Topics. Returns null when nothing resolves to an
   * existing directory.
   */
  function resolveProjectRef(ref: string, opts?: { trustRawPaths?: boolean }): string | null {
    const raw = (ref || "").trim();
    if (!raw) return null;

    // Absolute / home-relative paths. Honoured verbatim ONLY for explicit local
    // user actions (the /project command, an adopt body). On the AI-marker path
    // (trustRawPaths falsy) a raw path must already be a project Topics knows
    // about — otherwise a model, or prompt injection reaching a cloud session,
    // could emit {{PROJECT_OPEN:~/.ssh}} / {{PROJECT_OPEN:/etc}} and make every
    // connected client open a pane rooted at an arbitrary directory.
    if (raw.startsWith("/") || raw.startsWith("~/")) {
      // Il link si scioglie qui, prima del cancello: `isKnownProject` confronta
      // stringhe, e un progetto gia' noto raggiunto dal suo link non risultava noto.
      const abs = canonicalProjectPath(raw);
      if (!isExistingDir(abs)) return null;
      return (opts?.trustRawPaths || isKnownProject(abs)) ? abs : null;
    }

    // Bare name/slug: match against known projects (strongest signal first).
    const candidates: ProjectRefCandidate[] = [];
    try {
      for (const p of projectStore.list({ archived: false })) {
        candidates.push({ path: p.path, name: p.name, slug: p.slug });
      }
    } catch { /* projectStore is best-effort here */ }
    // Topic-bound paths ordered by liveness: a NON-archived, recently-updated
    // binding beats a dead one. Without this, "topics-app" once resolved to an
    // empty workspace husk because six archived June chats iterated before the
    // live ones bound to the real repo.
    const topicList = (Object.values(loadTopics().topics) as any[])
      .filter((t) => typeof t?.projectPath === "string" && t.projectPath)
      .sort((a, b) =>
        (Number(!!a.archived) - Number(!!b.archived)) ||
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    for (const t of topicList) candidates.push({ path: t.projectPath });
    for (const p of getWorkspaceProjects()) candidates.push({ path: p });

    // Compare candidate slugs with the SAME slugify that produced them (the
    // store's), so "My App" matches a project stored as slug "my-app". On an
    // ambiguous ref (same basename in several places) prefer the match that
    // LOOKS like a project (git repo, CLAUDE.md, manifest…) over a bare husk.
    const matches = matchProjectRefAll(raw, candidates, (s) => projectStore.slugify(s)).filter(isExistingDir);
    if (matches.length) return matches.find(looksLikeProject) ?? matches[0];

    // Last resort: a same-named folder directly under the workspace.
    //
    // Lo slug si controlla PRIMA del join, e non è pignoleria. Un `raw` fatto
    // solo di caratteri non ammessi — «../..» è il caso da manuale — dà slug
    // VUOTO, e `join(WORKSPACE_DIR, "")` è WORKSPACE_DIR: `isExistingDir`
    // rispondeva sì e questa funzione restituiva la RADICE del workspace,
    // legandoci la topic. È esattamente la classe che il docstring qui sopra
    // dice di parare («un modello, o una prompt injection… potrebbe emettere
    // {{PROJECT_OPEN:~/.ssh}}»), e il ramo è raggiungibile proprio con
    // `trustRawPaths` falso, perché una stringa così non inizia né con «/» né
    // con «~/» e non viene intercettata dal controllo là sopra.
    const slug = raw.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!slug) return null;
    const wsDir = join(WORKSPACE_DIR, slug);
    return isExistingDir(wsDir) ? wsDir : null;
  }

  /** Is this directory already a project Topics knows about? Used to decide
   *  whether a heuristic auto-bind is safe to surface as a project window. */
  function isKnownProject(dir: string): boolean {
    try { if (projectStore.getByPath(dir)) return true; } catch { /* ignore */ }
    if (getWorkspaceProjects().includes(dir)) return true;
    for (const t of Object.values(loadTopics().topics)) {
      if ((t as any).projectPath === dir) return true;
    }
    return false;
  }

  /**
   * Single source of truth for binding a topic (a chat / cloud session) to a
   * project directory. Persists `projectPath`, notifies clients (topic:updated)
   * and — when `focus` — emits `pane:focus-suggest` so every client opens the
   * project window and nests THIS session inside it. The cloud session then
   * shows up as a project on Topics, the way a Warp cloud session is scoped to
   * its repo. `projectPath` rides along on the focus-suggest so the client
   * never has to wait for topic:updated to arrive first (removes a race).
   */
  function bindTopicToProject(topicId: string, targetDir: string, opts?: { focus?: boolean }): boolean {
    const t = getTopicById(topicId);
    if (!t) return false;
    // Un progetto e' una CARTELLA. Il cancello sta qui, alla porta, e non sugli
    // otto chiamanti: metterlo li' vorrebbe dire dimenticarne uno, e quello
    // dimenticato sarebbe il buco. Un path che non esiste passa — puo' essere
    // una cartella che sta per nascere, o un progetto su un disco staccato —
    // ma un FILE no: quello e' definitivamente non un progetto, e legarcisi
    // fa comparire nella barra laterale un progetto fantasma col nome del file.
    try {
      if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
        console.warn(`[topics] bind rifiutato: ${targetDir} esiste e non e' una cartella`);
        return false;
      }
    } catch { /* stat fallito: si lascia passare, come per un path assente */ }
    if (t.projectPath !== targetDir) {
      t.projectPath = targetDir;
      t.updatedAt = new Date().toISOString();
      saveSingleTopic(t);
      broadcastToAll({ type: "topic:updated", topic: t });
    }
    if (opts?.focus) {
      // Lo spostamento vero, prima del suggerimento: la chat entra
      // nell'appartenenza del progetto e si porta dietro il suo pannello
      // browser, che restava fuori come tab orfano. Solo sul ramo `focus`,
      // cioe' quando lo spostamento e' stato CHIESTO (open_project /
      // create_project / bind esplicito): l'aggancio euristico di
      // `autoBindProject` non deve aprire tab in una finestra di progetto per
      // conto suo.
      moveTopicToProject(
        db,
        broadcastToAll,
        { id: t.id, browserContextIds: [t.browserState?.contextId ?? t.id] },
        targetDir,
      );
      broadcastToAll({ type: "pane:focus-suggest", topicId: t.id, projectPath: targetDir });
    }
    return true;
  }

  /**
   * Indovina la cartella di progetto dai messaggi. La regola sta in
   * `lib/detect-project-path.ts`, fuori da questa closure perche' dentro non
   * la poteva provare nessuno — ed e' proprio il suo ripiego ad aver legato una
   * chat a un eseguibile.
   */
  const detectProjectPathFromMessages = (messages: { role: string; content: string }[]) =>
    detectProjectPath(messages);

  /**
   * After first AI response: auto-detect projectPath and auto-name the topic (simple heuristic).
   * Runs server-side without needing a second LLM call.
   */
  function autoBindProject(topic: Topic): void {
    if (topic.projectPath) return; // already bound
    const localMsgs = loadLocalMessages(topic.sessionKey);
    if (localMsgs.length < 2) return; // need at least 1 user + 1 assistant
    const detected = detectProjectPathFromMessages(localMsgs);
    if (detected) {
      const t = getTopicById(topic.id);
      if (t && !t.projectPath) {
        // Heuristic detection: only force the project window open when the
        // folder is one Topics already knows about. A brand-new path mentioned
        // in passing still binds, but doesn't surprise the user with a window.
        bindTopicToProject(t.id, detected, { focus: isKnownProject(detected) });
        console.log(`[AutoBind] Detected projectPath for "${t.name}": ${detected}`);
      }
    }
  }

  function matchHistoryRoute(pathname: string): string | null {
    const prefix = "/api/history/";
    if (pathname.startsWith(prefix)) return decodeURIComponent(pathname.slice(prefix.length));
    return null;
  }

  /**
   * Stream an assistant response for an edited message.
   * Reuses the same gateway streaming flow as /api/chat.
   */
  // streamEditResponse() + POST /api/messages/:id/edit moved to server/routes/edit.ts

  const { db } = ctx;

  /**
   * Il `projectId` della board a cui un topic appartiene, o `null` se il topic
   * non è legato a un progetto.
   *
   * L'hash NON è più riscritto qui: questa closure era la copia che nessun test
   * di parità copriva, quindi l'unica delle tre che poteva derivare in silenzio.
   */
  function getProjectIdForTopic(topicId: string): string | null {
    const topic = getTopicById(topicId);
    if (!topic?.projectPath) return null;
    return projectIdForPath(topic.projectPath);
  }

  // Scan workspace directory for project directories
  const WORKSPACE_DIR = join(OPENCLAW_DIR, "workspace");
  const SKIP_DIRS = new Set(["node_modules", "memory", "backups", "test-results"]);
  const PROJECT_MARKERS = [
    ".git", "package.json", "CLAUDE.md", "Cargo.toml", "go.mod", "pyproject.toml",
    "Makefile", "README.md", "tsconfig.json", "requirements.txt", "Dockerfile",
    "index.html", "server.ts", "server.py", "server.js",
  ];
  function getWorkspaceProjects(): string[] {
    try {
      if (!existsSync(WORKSPACE_DIR)) return [];
      return readdirSync(WORKSPACE_DIR, { withFileTypes: true })
        .filter(e => {
          if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) return false;
          return looksLikeProject(join(WORKSPACE_DIR, e.name));
        })
        .map(e => join(WORKSPACE_DIR, e.name));
    } catch { return []; }
  }

  /** Does this dir carry at least one project marker? Used both by the
   *  workspace scan and by resolveProjectRef's ambiguity tiebreak (a real
   *  repo beats a marker-less husk with the same basename). */
  function looksLikeProject(dir: string): boolean {
    try { return PROJECT_MARKERS.some(m => existsSync(join(dir, m))); } catch { return false; }
  }

  /**
   * Relocate a Claude Code TERMINAL tab into a project window — extracted to
   * server/lib/relocate-pane.ts (unit-testable; the closure needed only db +
   * broadcastToAll). The extraction rode along with the duplicate-tab fix:
   * the splice now writes a durable TOMBSTONE, without which live clients'
   * union-hydrate re-persisted the standalone tab right back (moved tab
   * duplicated inside+outside the project, closes coupled). See the module
   * header for the full story.
   */
  const moveTerminalPaneToProject = (
    term: { id: string; name?: string },
    projectDir: string,
  ): { paneId: string; membershipKey: string } =>
    relocateTerminalPaneToProject(db, broadcastToAll, term, projectDir);

  // Auto-naming endpoint extracted to its own router  // Auto-naming endpoint extracted to its own router; it needs two closure
  // helpers injected (they close over this scope), so it's instantiated here.
  const autoNameRouter = createAutoNameRouter(ctx, { resolveProvider, detectProjectPathFromMessages });
  const historyRouter = createHistoryRouter(ctx, { matchHistoryRoute, providerForSessionKey });
  // Il rovescio dello sfoltimento di `/api/history`: la riga di tool arriva col
  // testo svuotato e se lo riprende da qui, la prima volta che qualcuno la apre.
  const toolDetailRouter = createToolDetailRouter(ctx);
  const editRouter = createEditRouter(ctx, { resolveProvider, updateUnreadCount });
  // Il canale umano non chiede niente a questa closure: solo ctx.
  const permissionRouter = createPermissionRouter(ctx);
  const chatRouter = createChatRouter(ctx, {
    resolveProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef,
    getProjectIdForTopic, getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR,
  }, browserService);
  // Il ponte MCP del browser (le sei rotte `…/browser/*` in due forme
  // d'indirizzo) sta in `browser-bridge.ts` con i tre helper di risoluzione del
  // contesto che usava SOLO lui. `browserNavigatedTopics` è la stessa istanza
  // che vede la chat: la deduplica del ripiego localhost non si sdoppia.
  const browserBridgeRouter = createBrowserBridgeRouter(ctx, {
    getTerminalSessionById,
    taskForTopic: (topicId) => taskSvc.taskForTopic(topicId),
    taskByIdPrefix: (prefix) => taskSvc.taskByIdPrefix(prefix),
    browserNavigatedTopics,
    persistTaskTab: (taskId, contextId, url, title) => { persistAgentTaskTab(ctx.db, broadcastToAll, taskId, contextId, url, title); },
    attachLoginHandle: (contextId, handle) => { attachLoginHandleToTaskTab(ctx.db, broadcastToAll, contextId, handle); },
    paneAttachedTo,
  }, browserService);

  /**
   * L'ultimo messaggio di OGNI chat, pronto per la riga di sidebar.
   *
   * PERCHÉ UNA SOTTOQUERY CORRELATA E NON UNA FINESTRA. La forma precedente
   * (`ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY sort_order DESC)` su
   * tutta `messages`) faceva quello che il piano diceva: «SCAN messages USING
   * INDEX idx_messages_session» + «USE TEMP B-TREE FOR LAST TERM OF ORDER BY».
   * Cioè leggeva TUTTI i messaggi — content compreso, vedi sotto — e li
   * riordinava in un B-tree temporaneo, per tenerne uno per chat. Misurato
   * sull'archivio vero (13.348 messaggi, 514 topic, 7,66 MB di `content`):
   * 321-620 ms a cache fredda, 39-40 ms a caldo. Ed è una `.all()` SINCRONA:
   * quei millisecondi sono event loop FERMO, a ogni boot di ogni finestra.
   *
   * Questa forma chiede invece a ogni topic la SUA riga, e la trova con una
   * ricerca su `idx_messages_session_order (session_key, sort_order)` che si
   * ferma alla prima che passa i filtri: «SEARCH p USING INDEX
   * idx_messages_session_order (session_key=?)», nessun B-tree temporaneo.
   * 7,7-12 ms, e indifferente allo stato della cache — tocca così poche pagine
   * che scaldarle non cambia niente. Stesso risultato, riga per riga: 456
   * anteprime identiche.
   *
   * QUALI RIGHE NON CONTANO:
   *  · `content` vuoto — un turno di soli tool (il testo sta in `blocks` /
   *    `tool_calls`). Non si mostra il vuoto e non si prova a riassumere gli
   *    strumenti: «ha eseguito 4 comandi» non è un'anteprima, la frase che li
   *    introduceva sì. Si scarta la riga e si prende la precedente che parla.
   *  · `partial` — un turno in volo ha testo mozzo, e mentre vola la riga mostra
   *    comunque lo stato live (SessionActivity), non l'anteprima.
   *  · le buste di contesto di OpenClaw, che sono impalcatura, non messaggi.
   *
   * COSA FA DAVVERO IL `substr`. Non risparmia la LETTURA del `content`: i due
   * filtri di testo qui accanto (`trim(content) <> ''`, il `NOT LIKE` sulla
   * busta) obbligano SQLite a materializzare per intero il valore di ogni riga
   * che il filtro tocca — anche il messaggio da 158.122 caratteri. Il `substr`
   * accorcia solo ciò che ESCE: senza, {@link topicPreviewText} girerebbe ~10
   * regex su quei 158 KB per scriverne 120 caratteri. Il risparmio sulla lettura
   * lo compra la forma della query, non il `substr`: le righe toccate dai filtri
   * passano da tutte e 13.348 a una manciata per topic.
   */
  function topicPreviewsQuery(): { topicId: string; sessionKey: string; role: string; text: string; at: string }[] {
    return db.prepare(`
      SELECT t.id AS topicId, t.session_key AS sessionKey,
             m.role AS role, substr(m.content, 1, ${PREVIEW_SOURCE_CHARS}) AS text, m.timestamp AS at
      FROM topics t
      JOIN messages m ON m.rowid = (
        SELECT p.rowid FROM messages p
        WHERE p.session_key = t.session_key
          AND COALESCE(p.partial, 0) = 0
          AND trim(p.content) <> ''
          AND p.content NOT LIKE '${CONTEXT_ENVELOPE_PREFIX}%'
        ORDER BY p.sort_order DESC
        LIMIT 1
      )
    `).all() as { topicId: string; sessionKey: string; role: string; text: string; at: string }[];
  }

  /** Le righe SUCCESSIVE alla prima, per il ripiego di {@link topicPreviewsPayload}.
   *  Stessi filtri, stesso indice: cambia solo il `LIMIT`. */
  function topicPreviewCandidates(sessionKey: string): { role: string; text: string; at: string }[] {
    return db.prepare(`
      SELECT role, substr(content, 1, ${PREVIEW_SOURCE_CHARS}) AS text, timestamp AS at
      FROM messages
      WHERE session_key = ?
        AND COALESCE(partial, 0) = 0
        AND trim(content) <> ''
        AND content NOT LIKE '${CONTEXT_ENVELOPE_PREFIX}%'
      ORDER BY sort_order DESC
      LIMIT ${PREVIEW_FALLBACK_DEPTH}
    `).all(sessionKey) as { role: string; text: string; at: string }[];
  }

  type TopicPreviewsBody = Record<string, { text: string; role: "user" | "assistant"; at: number }>;
  /**
   * La cache dell'endpoint. Non serve a rendere veloce UNA risposta — quello lo
   * fa già la query — ma a non ripagarla N volte: `/api/topics/previews` è una
   * fotografia di BOOT, e ogni finestra aperta la chiede all'avvio e a ogni
   * ricarico, tutte insieme dopo un reload del server.
   *
   * Il validatore è `max(rowid) + count(*)` su `messages`: 0,31 ms misurati sul
   * DB vero, contro i 7,7-12 ms della query piena. Coglie ogni messaggio NUOVO
   * (rowid cresce) e ogni cancellazione (count cala) — cioè le due cose che
   * spostano davvero l'ultimo messaggio di una chat, «Svuota chat» compresa. Non
   * coglie una MODIFICA in place dell'ultimo messaggio, ed è per questo che
   * sopra c'è anche un TTL: lì la finestra di staleness è al massimo di
   * {@link PREVIEW_CACHE_TTL_MS}.
   */
  let previewCache: { until: number; mx: number; n: number; body: TopicPreviewsBody } | null = null;

  function topicPreviewsPayload(): TopicPreviewsBody {
    const stamp = db.prepare("SELECT max(rowid) AS mx, count(*) AS n FROM messages").get() as { mx: number | null; n: number };
    const mx = stamp.mx ?? 0;
    if (previewCache && previewCache.until > Date.now() && previewCache.mx === mx && previewCache.n === stamp.n) {
      return previewCache.body;
    }
    const previews: TopicPreviewsBody = {};
    for (const r of topicPreviewsQuery()) {
      let text = topicPreviewText(r.text);
      let role = r.role;
      let at = r.at;
      // Il ripiego che il commento SQL prometteva e il codice non faceva: la
      // riga scelta ha `content` in SQL ma dopo la potatura può non avere più
      // prosa (era tutta un blocco di codice), e allora il topic restava muto
      // invece di mostrare «la precedente che parla». Oggi non scatta mai
      // (0 topic su 456), quindi non costa una query in più — esiste perché la
      // promessa sia vera il giorno che il caso si presenta.
      if (!text) {
        for (const c of topicPreviewCandidates(r.sessionKey)) {
          const t = topicPreviewText(c.text);
          if (!t) continue;
          text = t; role = c.role; at = c.at;
          break;
        }
      }
      // Nemmeno {@link PREVIEW_FALLBACK_DEPTH} righe indietro c'era prosa:
      // meglio una riga muta che una riga di rumore.
      if (!text) continue;
      previews[r.topicId] = {
        text,
        role: role === "user" ? "user" : "assistant",
        at: Date.parse(at) || 0,
      };
    }
    previewCache = { until: Date.now() + PREVIEW_CACHE_TTL_MS, mx, n: stamp.n, body: previews };
    return previews;
  }

  return async function topicsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- Topics CRUD ---
    if (method === "GET" && pathname === "/api/topics") {
      const data = loadTopics();
      const fixedIds: string[] = [];
      for (const topic of Object.values(data.topics)) {
        if (topic.parentId && !data.topics[topic.parentId]) {
          console.log(`[Orphan Fix] Topic "${topic.name}" (${topic.id}) had broken parentId "${topic.parentId}" — moved to root`);
          topic.parentId = null;
          fixedIds.push(topic.id);
        }
      }
      // Save only the topics we actually modified — saveTopics-all would
      // re-write every row and could overwrite a sibling request's recent
      // mutation on an unrelated field. One outer transaction so a crash
      // mid-loop can't leave half the orphan-fixes applied.
      if (fixedIds.length > 0) {
        ctx.db.transaction(() => {
          for (const id of fixedIds) saveSingleTopic(data.topics[id]);
        })();
      }
      return json({ ...data, workspaceProjects: getWorkspaceProjects() });
    }

    // Streaming-session snapshot for cross-reload loading hydration. The client
    // (useSignalsSync) polls this so a chat that was mid-reply when the page
    // (re)loaded shows its spinner even before its window mounts — the live WS
    // stream only drives the foreground session. Sourced from the authoritative
    // in-memory activeStreams registry (isStreaming auto-expires stale entries),
    // NOT the DB `partial` flag which a crashed stream can leave set forever.
    // Replaces the route lost when Master was removed: the old client path
    // /api/topics/master/sessions 404'd, so hydration silently never fired.
    if (method === "GET" && pathname === "/api/topics/streaming") {
      // Walk the registry, not the topics table. This used to `loadTopics()`
      // and filter EVERY topic (1,452 rows plus the four relation-table scans
      // of buildTopicRelations) every 15s per client, to keep the zero, one or
      // two whose session is in a Map with as many entries. The Map is the
      // source; the topic row is looked up per stream. A stream with no topic
      // row is omitted, exactly as the old filter omitted it.
      // sessionKey is included so the client can reconcile its per-session
      // streaming flags against this authoritative registry (self-heal a
      // spinner stuck after a lost stream:end). topicId stays for the
      // hydratedStreamTopics mapping.
      // «Sta lavorando» e «aspetta te» sono due cose diverse, e da fuori la chat
      // si vedevano uguali: stesso pallino, stessa parola. Un turno fermo su una
      // domanda non macina niente — chiamarlo streaming manda a controllare un
      // agente che in realtà sta aspettando noi da mezz'ora. `awaitingSince` è
      // l'istante in cui ha smesso di lavorare, così chi disegna può dire da
      // quanto senza tenere un proprio cronometro.
      const sessions: {
        topicId: string;
        sessionKey: string;
        state: "streaming" | "waiting";
        awaitingSince?: number;
      }[] = [];
      for (const sessionKey of activeStreams.keys()) {
        // `isStreaming` is the staleness gate; it never deletes from the Map,
        // the sweeper in server.ts owns that.
        if (!isStreaming(sessionKey)) continue;
        const topic = getTopicBySessionKey(sessionKey);
        if (!topic?.sessionKey) continue;
        let awaitingSince: number | null = null;
        // Un provider che non sa sospendersi non espone il metodo, e un provider
        // morto non deve far fallire lo scatto di tutti gli altri.
        try { awaitingSince = resolveProvider(topic).pendingInputSince?.(topic.sessionKey) ?? null; } catch { /* provider gone */ }
        // Tre fonti, in ordine di precisione. La prima conosce le domande del
        // canale NATIVO della CLI; il pannello di Topics però passa dal bridge
        // MCP, e lì la prima non vede niente — una chat ferma su una domanda si
        // diceva «sta lavorando» in sidebar e sulle tab. La terza è la riga, ed
        // è l'unica che sopravvive a un riavvio del server: le due mappe in
        // memoria si svuotano, il figlio la domanda ce l'ha ancora aperta.
        if (awaitingSince == null) {
          // Domanda o PERMESSO: per chi guarda la sidebar sono lo stesso fatto
          // — la chat aspetta te, non sta lavorando.
          const holdAge = humanHoldAgeMs(topic.sessionKey);
          if (holdAge != null) awaitingSince = Date.now() - holdAge;
        }
        if (awaitingSince == null) {
          try {
            const row = ctx.db.prepare(
              "SELECT tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1",
            ).get(topic.sessionKey) as { tool_calls?: unknown; blocks?: unknown } | undefined;
            awaitingSince = waitingAskStartedAt(decodeCol(row?.tool_calls), decodeCol(row?.blocks), Date.now());
          } catch { /* riga illeggibile: resta «streaming», come prima */ }
        }
        sessions.push({
          topicId: topic.id,
          sessionKey: topic.sessionKey,
          state: awaitingSince != null ? "waiting" : "streaming",
          ...(awaitingSince != null ? { awaitingSince } : {}),
        });
      }
      return json({ sessions });
    }

    /**
     * GET /api/topics/previews — l'ultimo messaggio di OGNI chat, in un colpo solo.
     *
     * La riga di sidebar deve dire sempre qualcosa: quando la sessione è ferma —
     * il caso di gran lunga più comune — al posto dello stato live compare
     * l'ultimo messaggio. Con N righe l'unica forma sostenibile è UNA richiesta:
     * una `/api/history/:sessionKey?limit=1` per topic sarebbero cinquecento
     * richieste al boot per scrivere cinquecento righe da 120 caratteri.
     *
     * Il corpo sta in {@link topicPreviewsPayload}, che tiene anche la cache: qui
     * resta solo la porta HTTP.
     */
    if (method === "GET" && pathname === "/api/topics/previews") {
      return json({ previews: topicPreviewsPayload() });
    }

    // Custom slash commands + skills the user has, for composer autocomplete.
    // The headless CLI expands both (`/commit`, `/vai`, …) — verified — so the
    // composer just needs to surface them; on send they fall through to the
    // child (handleSlashCommand only intercepts the app allowlist). Best-effort:
    // a missing dir is simply skipped.
    // Il CORPO di un comando slash. Sul filo non passa — la CLI espande lo
    // slash prima del turno — ma il file c'è, ed è lo stesso da cui l'elenco
    // qui sotto ricava nome e descrizione. Il nome arriva dal client: il
    // cancello sta in lib/slash-command-source.ts, che rifiuta tutto ciò che
    // potrebbe uscire dalle cartelle note (link simbolici compresi).
    if (method === "GET" && pathname.startsWith("/api/slash-commands/")) {
      const name = decodeURIComponent(pathname.slice("/api/slash-commands/".length));
      if (!isValidSlashCommandName(name)) return errorResponse(400, "nome non valido");
      const src = readSlashCommandSource(name);
      if (!src) return errorResponse(404, "comando non trovato");
      return json(src);
    }

    if (method === "GET" && pathname === "/api/slash-commands") {
      const out: Array<{ name: string; description: string; kind: "command" | "skill" }> = [];
      const seen = new Set<string>();
      const descOf = (file: string): string => {
        try {
          const txt = readFileSync(file, "utf-8");
          const fm = txt.match(/^---[\s\S]*?\n\s*description:\s*(.+?)\s*(?:\n|$)/i);
          if (fm) return fm[1].replace(/^["']|["']$/g, "").slice(0, 100);
          for (const line of txt.split("\n")) {
            const t = line.trim();
            if (!t || t === "---" || t.startsWith("#")) continue;
            return t.slice(0, 100);
          }
        } catch { /* unreadable — no description */ }
        return "";
      };
      const add = (name: string, description: string, kind: "command" | "skill") => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        out.push({ name, description, kind });
      };
      for (const dir of [join(homedir(), ".claude", "commands"), join(process.cwd(), ".claude", "commands")]) {
        try {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".md")) continue;
            add(f.slice(0, -3), descOf(join(dir, f)), "command");
          }
        } catch { /* dir absent */ }
      }
      for (const dir of [join(homedir(), ".claude", "skills"), join(homedir(), "jarvis", "skills-marketplace", "skills")]) {
        try {
          for (const d of readdirSync(dir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const md = join(dir, d.name, "SKILL.md");
            if (!existsSync(md)) continue;
            add(d.name, descOf(md), "skill");
          }
        } catch { /* dir absent */ }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return json(out);
    }

    if (method === "POST" && pathname === "/api/topics") {
      const body = await readJSON(req);
      // typeof guard: slugify() calls .toLowerCase() and would 500 on a non-string name.
      if (!body || typeof body.name !== "string" || !body.name) return json({ error: "name (string) required" }, 400);
      const data = loadTopics();
      const id = crypto.randomUUID();
      const slug = slugify(body.name);
      const parentId = body.parentId || null;
      const topic: Topic = {
        id, name: body.name, slug, parentId, links: [],
        sessionKey: "", color: body.color || "#5865f2", icon: body.icon || "MessageSquare",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        archived: false, systemPrompt: body.systemPrompt || "",
        contextFiles: [], pinnedMessages: [],
        sortOrder: Object.keys(data.topics).length,
        provider: body.provider || null,
      };
      // Set projectPath if explicitly provided (e.g. creating from within a project).
      // CANONICO: la stessa cartella raggiunta da un link non deve diventare un
      // secondo progetto (due board, due voci in sidebar). Vedi canonical-project-path.
      if (body.projectPath) {
        (topic as any).projectPath = canonicalProjectPath(body.projectPath);
      }
      // Optional binding to a Worktree (Phase A · TOPIC-WT-01).
      // Validate the FK before persistence — the DB-level FK would also
      // reject the insert, but a friendly 400 is nicer than a 500.
      if (body.worktreeId !== undefined && body.worktreeId !== null) {
        const wt = worktreeStore.get(body.worktreeId);
        if (!wt) return json({ error: "worktreeId not found" }, 400);
        topic.worktreeId = body.worktreeId;
      }
      // Phase C · TOPIC-IM-01: optional one-shot initial message.
      // Validation: ≤ 8000 chars, control-char strip. Empty string normalises
      // to null so callers can send "" without persisting useless rows.
      if (body.initialMessage !== undefined && body.initialMessage !== null) {
        const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
        if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
        if (cleaned.length > 0) topic.initialMessage = cleaned;
      }

      data.topics[id] = topic;
      topic.sessionKey = "topic:" + id.slice(0, 8);
      saveSingleTopic(topic);
      broadcastToAll({ type: "topic:created", topic });
      return json(topic, 201);
    }

    // POST /api/topics/adopt — open a cloud (gateway) session as a first-class,
    // INTERACTIVE Topics chat (like opening a cloud session from Warp), instead
    // of only viewing it read-only. Idempotent: if a topic already owns this
    // sessionKey, return (and focus) it. Otherwise create an openclaw-backed
    // topic bound to the EXISTING gateway session so the user can talk to it,
    // optionally scoped to a project.
    if (method === "POST" && pathname === "/api/topics/adopt") {
      try {
        const body = await readJSON(req);
        const sessionKey = body?.sessionKey ? String(body.sessionKey).trim() : "";
        if (!sessionKey) return json({ error: "sessionKey required" }, 400);

        // Shape guard: a session key is `kind:id` / a bare token (e.g.
        // "topic:abc12345", "agent:sub-xyz", "main"). Reject whitespace,
        // control chars, path-like inputs and `..` so a fabricated/garbled key
        // from a buggy client can't mint a phantom cloud chat.
        if (!/^[A-Za-z0-9][\w:.\-/]{0,127}$/.test(sessionKey) || sessionKey.includes("..")) {
          return json({ error: "invalid sessionKey" }, 400);
        }

        const existing = getTopicBySessionKey(sessionKey);
        if (existing) {
          if (existing.projectPath) bindTopicToProject(existing.id, existing.projectPath, { focus: true });
          return json(existing, 200);
        }

        const id = crypto.randomUUID();
        const name =
          (body?.name ? String(body.name).trim() : "") ||
          `Cloud session ${sessionKey.replace(/^topic:/, "").slice(0, 12)}`;
        // body.projectPath is an explicit local action → raw paths are trusted.
        const projectDir = body?.projectPath
          ? resolveProjectRef(String(body.projectPath), { trustRawPaths: true })
          : null;

        // Atomic check-then-insert: re-read INSIDE the transaction so two
        // concurrent adopts for the same sessionKey converge on one topic,
        // rather than the second INSERT OR REPLACE destructively deleting the
        // first row (session_key is UNIQUE; REPLACE would cascade FK deletes).
        const out = ctx.db.transaction((): { topic: Topic; created: boolean } => {
          const again = getTopicBySessionKey(sessionKey);
          if (again) return { topic: again, created: false };
          const data = loadTopics();
          const topic: Topic = {
            id, name, slug: slugify(name), parentId: null, links: [],
            sessionKey,                     // adopt the EXISTING gateway session
            color: body?.color || "#5865f2", icon: body?.icon || "Cloud",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            archived: false, systemPrompt: "",
            contextFiles: [], pinnedMessages: [],
            sortOrder: Object.keys(data.topics).length,
            provider: "openclaw",           // cloud-backed
          };
          if (projectDir) (topic as any).projectPath = projectDir;
          saveSingleTopic(topic);
          return { topic, created: true };
        })();

        if (!out.created) {
          if (out.topic.projectPath) bindTopicToProject(out.topic.id, out.topic.projectPath, { focus: true });
          return json(out.topic, 200);
        }

        broadcastToAll({ type: "topic:created", topic: out.topic });
        // Scope to its project (open + nest) when one was resolved; otherwise the
        // caller opens it as a standalone cloud chat.
        if (projectDir) bindTopicToProject(out.topic.id, projectDir, { focus: true });
        return json(out.topic, 201);
      } catch (err: any) {
        console.warn("[adopt] failed:", err);
        return json({ error: `adopt failed: ${err?.message || String(err)}` }, 500);
      }
    }

    // POST /api/topics/adopt-claude — adopt a Claude Code session that is
    // already running OUTSIDE Topics (a bare `claude` in a terminal, a resume
    // from another client) into a first-class interactive topic. The durable
    // trace of that session is its transcript
    // (`~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`), so we:
    //   1. locate the transcript by session id (filename is the id — robust to
    //      the cwd-slug encoding);
    //   2. read the session's cwd from the transcript itself (never trust a
    //      client-supplied path);
    //   3. create a claude-code topic scoped to that cwd, BIND its chat session
    //      to the existing claude_session_id (so the next turn spawns
    //      `claude --resume <id>` and lands in the same conversation), and
    //   4. replay the transcript into the topic's messages so the history is
    //      visible in chat.
    // Idempotent: a second adopt of the same session id returns (and focuses)
    // the topic already bound to it.
    if (method === "POST" && pathname === "/api/topics/adopt-claude") {
      try {
        const body = await readJSON(req);
        const sessionId = body?.sessionId ? String(body.sessionId).trim() : "";
        // Claude session ids are UUID-shaped; the transcript filename is exactly
        // this id, so a strict charset guard also stops path traversal.
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(sessionId)) {
          return json({ error: "invalid sessionId" }, 400);
        }

        // Already bound to a topic? Return it (idempotent). The binding lives in
        // claude_code_sessions(session_key → claude_session_id).
        const boundRow = ctx.db
          .prepare(`SELECT session_key FROM claude_code_sessions WHERE claude_session_id = ?`)
          .get(sessionId) as { session_key?: string } | undefined;
        if (boundRow?.session_key) {
          const existingTopic = getTopicBySessionKey(boundRow.session_key);
          if (existingTopic) {
            if (existingTopic.projectPath) bindTopicToProject(existingTopic.id, existingTopic.projectPath, { focus: true });
            return json(existingTopic, 200);
          }
        }

        // Locate the transcript by id: scan the project store for <id>.jsonl.
        const projectsDir = join(homedir(), ".claude", "projects");
        let transcriptPath: string | null = null;
        try {
          for (const dir of readdirSync(projectsDir)) {
            const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
            if (existsSync(candidate)) { transcriptPath = candidate; break; }
          }
        } catch { /* projects dir missing → handled below */ }
        if (!transcriptPath) return json({ error: "session transcript not found" }, 404);

        const text = readFileSync(transcriptPath, "utf-8");
        // The session's real cwd is stamped on its transcript entries.
        const cwd = parseTranscriptFacts(text).cwd;
        if (!cwd) return json({ error: "could not resolve session cwd" }, 400);

        const messages = parseTranscriptToMessages(text);
        // Byte cursor for the incremental import sweep: everything up to and
        // including the last complete line has just been imported, so the sweep
        // reads only what the TERMINAL appends after this. A partial trailing
        // line (mid-write) is deliberately left for the sweep to re-read whole.
        const lastNl = text.lastIndexOf("\n");
        const importOffset = lastNl >= 0 ? Buffer.byteLength(text.slice(0, lastNl + 1), "utf-8") : 0;
        const projectDir = resolveProjectRef(cwd, { trustRawPaths: true });
        const id = crypto.randomUUID();
        const sessionKey = "topic:" + id.slice(0, 8);
        const base = cwd.replace(/\/+$/, "").split("/").pop() || "sessione";
        const name = (body?.name ? String(body.name).trim() : "") || `${base} (ripresa)`;

        // One transaction: create the topic, bind the CLI session id, import the
        // history. All-or-nothing so a half-adopted topic never appears.
        const nowIso = new Date().toISOString();
        const topic = ctx.db.transaction((): Topic => {
          const data = loadTopics();
          const t: Topic = {
            id, name, slug: slugify(name), parentId: null, links: [],
            sessionKey,
            color: body?.color || "#5865f2", icon: body?.icon || "TerminalSquare",
            createdAt: nowIso, updatedAt: nowIso,
            archived: false, systemPrompt: "",
            contextFiles: [], pinnedMessages: [],
            sortOrder: Object.keys(data.topics).length,
            provider: "claude-code",
          };
          if (projectDir) (t as any).projectPath = projectDir;
          saveSingleTopic(t);
          // Bind the topic's chat session to the EXISTING claude session id. The
          // provider's getOrCreateClaudeSessionId will now find this row, see
          // created_at !== spawn-time-now, and take the `--resume` branch.
          // Persist jsonl_path + import_offset here so the import sweep can pick
          // up where the initial import stopped and stream in the terminal's
          // later turns. import_offset being non-null is exactly what enrolls
          // this (adopted) session in the sweep; native sessions leave it NULL.
          ctx.db.prepare(
            `INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, jsonl_path, import_offset)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_key) DO UPDATE SET
               claude_session_id = excluded.claude_session_id,
               updated_at = excluded.updated_at,
               jsonl_path = excluded.jsonl_path,
               import_offset = excluded.import_offset`
          ).run(sessionKey, sessionId, nowIso, nowIso, transcriptPath, importOffset);
          if (messages.length) saveLocalMessages(sessionKey, messages);
          return t;
        })();

        broadcastToAll({ type: "topic:created", topic });
        if (projectDir) bindTopicToProject(topic.id, projectDir, { focus: true });
        return json({ ...topic, importedMessages: messages.length }, 201);
      } catch (err: any) {
        console.warn("[adopt-claude] failed:", err);
        return json({ error: `adopt failed: ${err?.message || String(err)}` }, 500);
      }
    }

    // PATCH /api/topics/:id
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "PATCH") {
        const body = await readJSON(req);
        if (!body) return json({ error: "body required" }, 400);
        // Loads all topics: the parent/ancestor cycle check below walks
        // `data.topics[ancestorId]` across the tree, so a single indexed read
        // would not suffice here.
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "not found" }, 404);
        // typeof guard: a non-string name here would set topic.name to garbage
        // and then 500 inside slugify() (.toLowerCase()), after the mutation.
        if (typeof body.name === "string" && body.name) { topic.name = body.name; topic.slug = slugify(body.name); }
        if (body.color !== undefined) topic.color = body.color;
        if (body.icon !== undefined) topic.icon = body.icon;
        if (body.parentId !== undefined) {
          const newParentId = body.parentId || null;
          // Prevent circular reference: topic can't be its own parent or ancestor
          if (newParentId) {
            if (newParentId === params.id) {
              return json({ error: "topic cannot be its own parent" }, 400);
            }
            // Walk up the ancestor chain to detect cycles
            let ancestorId: string | null = newParentId;
            const visited = new Set<string>();
            while (ancestorId) {
              if (visited.has(ancestorId)) break; // already a cycle in existing data
              visited.add(ancestorId);
              if (ancestorId === params.id) {
                return json({ error: "circular reference: topic cannot be nested under its own descendant" }, 400);
              }
              ancestorId = data.topics[ancestorId]?.parentId || null;
            }
          }
          topic.parentId = newParentId;
        }
        if (body.systemPrompt !== undefined) topic.systemPrompt = body.systemPrompt;
        if (body.contextFiles !== undefined) topic.contextFiles = body.contextFiles;
        if (body.pinnedMessages !== undefined) topic.pinnedMessages = body.pinnedMessages;
        // `archived` NON si cambia da qui, e dirlo e' meglio che ignorarlo: la
        // PATCH lo accettava in silenzio e non archiviava niente — un'archiviazione
        // che non archivia e non protesta e' peggio di un errore. La strada vera e'
        // DELETE {archived:true}, che azzera anche gli unread e pulisce ui_state.
        if (body.archived !== undefined) {
          return json({ error: "usa DELETE /api/topics/:id con {archived:true|false}", code: "wrong_route" }, 400);
        }
        if (body.projectPath !== undefined) {
          topic.projectPath = body.projectPath ? canonicalProjectPath(body.projectPath) : undefined;
        }
        // Provider/model are spawn-time flags for the claude-code CLI (same
        // as effort below): track changes so we can force an idle respawn.
        let spawnConfigChanged = false;
        if (body.autonomyLevel !== undefined) {
          const valid: Topic['autonomyLevel'][] = ['ask', 'auto-apply', 'yolo'];
          // Un livello sconosciuto è un ERRORE del chiamante, non un `ask`.
          //
          // Ripiegare su `ask` voleva dire che una stringa sbagliata — un typo,
          // un client vecchio, un rinomino a metà — metteva la chat in PIANO:
          // l'agente smette di toccare i file e chi ha scritto crede di aver
          // impostato tutt'altro. È la deriva già vista due volte fra il CHECK
          // di SQLite e l'union TS, e il ripiego silenzioso è ciò che la
          // rendeva invisibile.
          if (!valid.includes(body.autonomyLevel)) {
            return json({ error: `autonomyLevel must be one of ${valid.join(', ')}`, code: 'invalid_autonomy_level' }, 400);
          }
          const next = body.autonomyLevel as Topic['autonomyLevel'];
          // L'autonomia decide `--permission-mode`, quindi è un flag di SPAWN
          // come provider e modello: senza il respawn la scelta non avrebbe
          // effetto finché la chat non riparte da sola — cioè sembrerebbe
          // un'impostazione che non fa niente.
          if (next !== topic.autonomyLevel) spawnConfigChanged = true;
          topic.autonomyLevel = next;
        }
        if (body.provider !== undefined) {
          const prev = topic.provider ?? null;
          topic.provider = body.provider || null;
          spawnConfigChanged ||= (topic.provider ?? null) !== prev;
        }
        if (body.model !== undefined) {
          const prev = topic.model ?? null;
          topic.model = body.model || null;
          spawnConfigChanged ||= (topic.model ?? null) !== prev;
        }
        // Per-topic effort tier (migration 033). Accepts a valid tier, or
        // null/""/"default" to clear the override (fall back to the global
        // env-resolved default). Unknown tiers are rejected so a stale client
        // can't persist garbage that silently disables the flag at spawn time.
        let effortChanged = false;
        if (body.effort !== undefined) {
          const prev = topic.effort ?? null;
          if (body.effort === null || body.effort === "" || body.effort === "default") {
            topic.effort = null;
          } else {
            const tier = String(body.effort).trim().toLowerCase();
            const VALID_EFFORTS = new Set<string>(EFFORT_TIERS);
            if (!VALID_EFFORTS.has(tier)) return json({ error: "invalid effort tier" }, 400);
            topic.effort = tier;
          }
          effortChanged = (topic.effort ?? null) !== prev;
        }
        // Fast Mode (migration 024). Accept boolean only; null/undefined leaves
        // the existing value alone. Coerce non-boolean truthy/falsy inputs
        // defensively so a stale client sending "false" string doesn't toggle.
        if (body.fastMode !== undefined && body.fastMode !== null) {
          topic.fastMode = body.fastMode === true;
        }
        // Per-topic notification mute (migration 073). Boolean only; null/
        // undefined leaves it alone. Pure metadata — unlike effort/model it is
        // NOT a spawn-time flag, so no respawn/context re-broadcast; the
        // `topic:updated` below is all the client needs to re-gate banners.
        if (body.muted !== undefined && body.muted !== null) {
          topic.muted = body.muted === true;
        }
        if (body.disabledContextSources !== undefined) topic.disabledContextSources = body.disabledContextSources;
        // worktreeId update (Phase A · TOPIC-WT-01). NULL = clear binding.
        if (body.worktreeId !== undefined) {
          if (body.worktreeId === null) {
            topic.worktreeId = null;
          } else {
            const wt = worktreeStore.get(body.worktreeId);
            if (!wt) return json({ error: "worktreeId not found" }, 400);
            topic.worktreeId = body.worktreeId;
          }
        }
        // Phase C · TOPIC-IM-01. NULL = clear (renderer PATCHes after dispatch).
        if (body.initialMessage !== undefined) {
          if (body.initialMessage === null || body.initialMessage === "") {
            topic.initialMessage = null;
          } else {
            const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
            if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
            topic.initialMessage = cleaned;
          }
        }
        topic.updatedAt = new Date().toISOString();
        saveSingleTopic(topic);
        broadcastToAll({ type: "topic:updated", topic });
        // Effort tier AND model/provider are fixed at CLI spawn time — drop the
        // idle pooled process so the next turn respawns with the new `--effort`
        // / `--model`. Fire-and-forget: failures are non-fatal (the change still
        // applies on the next natural respawn) and must not block the PATCH
        // response.
        if (effortChanged || spawnConfigChanged) {
          try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
          catch (err) { console.warn(`[topics] refreshSessionConfig failed for ${topic.sessionKey}:`, err); }
          // Il ring cambia DENOMINATORE, non numeratore: cambiare modello cambia
          // la finestra, e l'ultima misura va riletta contro quella nuova. Senza
          // questo il ring resta fermo sul vecchio rapporto fino al turno dopo —
          // e uno che passa a 1M per fare spazio vede un anello che non si muove,
          // che è indistinguibile da un ring rotto.
          try { broadcastContextForModelChange(topic); }
          catch (err) { console.warn(`[topics] context re-broadcast failed for ${topic.sessionKey}:`, err); }
        }
        return json(topic);
      }

      if (params && method === "DELETE") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "not found" }, 404);
        let archive = true;
        try { const body = await req.json(); if (typeof body.archived === 'boolean') archive = body.archived; } catch {}
        if (archive) {
          // Un solo posto sa cosa vuol dire "archiviato": flag + unread a zero
          // + purge da ui_state. Lo stesso servizio che usa il dispatcher, così
          // i due percorsi non possono più divergere (services/archive-topic.ts).
          const res = archiveTopicFully({
            getTopicById, saveSingleTopic, loadUnread, saveUnread, broadcastToAll,
            purgeFromUiState: (id) => purgeTopicFromUiState(ctx.db, broadcastToAll, id),
            parkClaudeSession: parkTopicSession,
            recordRetirement: (id, at) => recordRetirement(ctx.db, "topic", id, at, "archive"),
            cancelPendingAsk: cancelAsk,
          }, params.id);
          // Bug #12: if the purge fails we return 500 — topic is archived but
          // ui_state is stale, so client-side reload will see a phantom id.
          if (res.purgeError) {
            return json({ error: "topic archived but ui_state purge failed", details: res.purgeError, topic: res.topic }, 500);
          }
          // Archiving IS the end of the session, so the automatic checkpoints
          // go with it: they are a net for "undo the last turn", and once the
          // chat is closed there is no last turn left to undo. Leaving them
          // would be leaving git objects in somebody's repository forever, one
          // namespace per chat they ever opened. Non-fatal and not awaited: a
          // ref that refuses to die must not turn an archive into a 500.
          if (topic.projectPath) {
            void dropTurnCheckpoints(topic.projectPath, topic.sessionKey).catch((err) =>
              console.warn(`[topics] checkpoint sweep failed for ${topic.sessionKey}:`, err),
            );
          }
          return json(res.topic);
        }
        // Unarchive is a REOPEN: retract the close markers the purge left, or
        // the client's hydrate strip would delete the tab on every load and
        // the chat would be permanently un-openable.
        topic.archived = false;
        topic.updatedAt = new Date().toISOString();
        saveSingleTopic(topic);
        broadcastToAll({ type: "topic:archived", topic });
        restoreTopicInUiState(ctx.db, broadcastToAll, params.id);
        // Il fatto va ritrattato con gli altri due registri, o al riavvio
        // successivo il riconcilio richiuderebbe la chat appena riaperta —
        // con l'utente dentro.
        clearRetirement(ctx.db, "topic", params.id);
        return json(topic);
      }
    }

    // POST /api/topics/bulk-archive
    if (method === "POST" && pathname === "/api/topics/bulk-archive") {
      const body = await readJSON(req);
      if (!body || !body.projectPath || typeof body.archived !== 'boolean') {
        return json({ error: "projectPath and archived (boolean) required" }, 400);
      }
      const { projectPath, archived } = body;
      const data = loadTopics();
      const unread = loadUnread();
      const updatedTopics: Topic[] = [];
      const now = new Date().toISOString();
      for (const topic of Object.values(data.topics)) {
        if (topic.projectPath === projectPath) {
          topic.archived = archived;
          topic.updatedAt = now;
          updatedTopics.push(topic);
          if (archived) {
            unread[topic.id] = { lastReadAt: now, unreadCount: 0 };
          }
        }
      }
      if (updatedTopics.length === 0) return json({ error: "no topics found for projectPath" }, 404);
      // Targeted writes wrapped in one transaction — only the topics we just
      // modified are written (no trampling of unrelated rows) AND a crash
      // mid-archive can't leave half the project archived. saveUnread for
      // the archive path is included so the unread reset commits with the
      // archive flip.
      ctx.db.transaction(() => {
        for (const topic of updatedTopics) saveSingleTopic(topic);
        if (archived) saveUnread(unread);
      })();
      const purgeFailures: { topicId: string; error: string }[] = [];
      for (const topic of updatedTopics) {
        broadcastToAll({ type: "topic:archived", topic });
        if (archived) {
          broadcastToAll({ type: "unread:updated", topicId: topic.id, unreadCount: 0 });
          // Stesso passo 4 del percorso singolo (services/archive-topic.ts).
          // È QUESTA la strada che ha prodotto la perdita misurata: le 28
          // sessioni rimaste vive su chat chiuse portavano tutte la data di
          // un'archiviazione di progetto in blocco.
          parkTopicSession(topic.sessionKey);
          const purgeResult = purgeTopicFromUiState(ctx.db, broadcastToAll, topic.id);
          if (!purgeResult.ok) {
            purgeFailures.push({ topicId: topic.id, error: purgeResult.error });
          }
          // Il fatto, come nel percorso singolo. Un'archiviazione in blocco che
          // non timbra e' esattamente la strada da cui sono usciti i topic
          // «aperti» chiusi da settimane: il flag c'era, la data no.
          recordRetirement(ctx.db, "topic", topic.id, now, "bulk-archive");
        } else {
          // Bulk UNarchive — same reopen symmetry as the single-topic DELETE.
          restoreTopicInUiState(ctx.db, broadcastToAll, topic.id);
          clearRetirement(ctx.db, "topic", topic.id);
        }
      }
      // Bug #12: surface any purge failure in the response body (partial-fail
      // semantics — topics are archived but some ui_state records may be stale).
      if (purgeFailures.length > 0) {
        return json({
          ok: false,
          count: updatedTopics.length,
          topics: updatedTopics,
          error: "some ui_state purges failed. Stale topic ids may resurrect on client reload.",
          purgeFailures,
        }, 500);
      }
      return json({ ok: true, count: updatedTopics.length, topics: updatedTopics });
    }

    // POST /api/topics/:id/link
    {
      const params = matchRoute(pathname, "/api/topics/:id/link");
      if (params && method === "POST") {
        const body = await readJSON(req);
        if (!body || !body.targetId) return json({ error: "targetId required" }, 400);
        const topic = getTopicById(params.id);
        const target = getTopicById(body.targetId);
        if (!topic || !target) return json({ error: "not found" }, 404);
        if (!topic.links.includes(body.targetId)) topic.links.push(body.targetId);
        if (!target.links.includes(params.id)) target.links.push(params.id);
        topic.updatedAt = new Date().toISOString();
        target.updatedAt = new Date().toISOString();
        // Atomic: both sides of the symmetric link write together, so a
        // crash mid-pair can't leave a half-link (A→B exists, B→A doesn't).
        ctx.db.transaction(() => {
          saveSingleTopic(topic);
          saveSingleTopic(target);
        })();
        return json({ ok: true });
      }
    }

    // DELETE /api/topics/:id/link/:targetId
    {
      const params = matchRoute(pathname, "/api/topics/:id/link/:targetId");
      if (params && method === "DELETE") {
        const topic = getTopicById(params.id);
        const target = getTopicById(params.targetId);
        if (!topic) return json({ error: "not found" }, 404);
        topic.links = topic.links.filter((l) => l !== params.targetId);
        if (target) target.links = target.links.filter((l) => l !== params.id);
        topic.updatedAt = new Date().toISOString();
        if (target) target.updatedAt = new Date().toISOString();
        ctx.db.transaction(() => {
          saveSingleTopic(topic);
          if (target) saveSingleTopic(target);
        })();
        return json({ ok: true });
      }
    }

    // POST /api/topics/reorder
    if (method === "POST" && pathname === "/api/topics/reorder") {
      const body = await readJSON(req);
      if (!body?.order || !Array.isArray(body.order)) return json({ error: "order array required" }, 400);
      // Targeted column update inside one transaction: only `sort_order` is
      // touched, so a sibling request mutating `name` / `provider` / `model`
      // on the same topic concurrently doesn't have its write rolled back.
      // We bypass `saveSingleTopic` here because that function rewrites the
      // entire row from a Topic snapshot (and we don't want to re-fetch each
      // one just to flip one integer).
      const stmt = ctx.db.prepare("UPDATE topics SET sort_order = ?, updated_at = ? WHERE id = ?");
      const now = new Date().toISOString();
      ctx.db.transaction(() => {
        for (let i = 0; i < body.order.length; i++) {
          stmt.run(i, now, body.order[i]);
        }
      })();
      broadcastToAll({ type: "topics:reordered", order: body.order });
      return json({ ok: true });
    }

    // GET /api/unread
    if (method === "GET" && pathname === "/api/unread") {
      return json(loadUnread());
    }

    // POST /api/topics/:id/read
    //
    // Idempotente e SILENZIOSA quando non c'è niente da azzerare. Il client la
    // chiamava a ogni cambio di tab, e a contatore già a zero il no-op costava
    // caro su entrambi i lati: `saveUnread` riscrive TUTTE le righe (legge la
    // tabella, cancella le sparite, fa l'upsert di ognuna, in transazione) e il
    // `broadcastToAll` sveglia OGNI client connesso con un `unread:updated{0}`
    // che non cambia nulla ma gli fa comunque validare il frame e ri-renderizzare.
    // Con una dozzina di tab aperte era il costo principale dello switch.
    //
    // `lastReadAt` non avanza in questo ramo, di proposito: è informativo. È
    // questa POST — e SOLO questa — a decidere che una topic è letta: il server
    // non deduce più "letto" dal focus (vedi updateUnreadCount).
    {
      const params = matchRoute(pathname, "/api/topics/:id/read");
      if (params && method === "POST") {
        const unread = loadUnread();
        // Riga assente = già a zero: `updateUnreadCount` se la crea da sé quando
        // arriva il primo messaggio non letto, quindi materializzarla qui è
        // un'altra scrittura inutile.
        if ((unread[params.id]?.unreadCount ?? 0) === 0) return json({ ok: true });
        unread[params.id] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
        saveUnread(unread);
        broadcastToAll({ type: "unread:updated", topicId: params.id, unreadCount: 0 });
        // E LA CAMPANELLA SI SPEGNE CON LEI.
        //
        // Fino a qui la lettura azzerava il non-letto nella sidebar e lasciava
        // acceso il contatore delle notifiche: due numeri sullo stesso fatto che
        // dicevano cose diverse. Il peggiore dei due era quello che restava
        // acceso, perche' nessun gesto naturale lo spegneva - solo aprire il
        // pannello della cronologia, che e' un posto in cui non si passa mai
        // apposta. Segnalato: «assicuriamoci che le notifiche siano
        // sincronizzate con lo stato della notifica della sidebar».
        //
        // Il broadcast parte SOLO se qualcosa e' cambiato davvero: questa rotta
        // e' gia' silenziosa sul no-op per la stessa ragione (un
        // `unread:updated{0}` inutile sveglia ogni client connesso), e sarebbe
        // strano che la riga sotto reintroducesse il costo appena evitato.
        const viste = markTargetNotificationsSeen("topic", params.id);
        if (viste > 0) {
          broadcastToAll({ type: "notification:seen", unseen: countUnseenNotifications() });
        }
        return json({ ok: true });
      }
    }

    // Il ponte MCP del browser: sei rotte (`open-pane`, `close-pane`,
    // `import-chrome`, i tool generici `:tool`, `list-tabs`, `focus-pane`) in due
    // forme d'indirizzo, estratte in `browser-bridge.ts` insieme ai tre helper di
    // risoluzione del contesto che usavano solo loro. Montato QUI, dov'era
    // `open-pane`: `matchRoute` filtra per numero di segmenti e le uniche altre
    // rotte a sei segmenti sono `/api/topics/:id/link/:targetId` (letterale
    // diverso) — nessuna precedenza cambia.
    {
      const browserResp = await browserBridgeRouter(req, url, pathname, method);
      if (browserResp) return browserResp;
    }

    // POST /api/sessions/:sessionKey/move-to-project
    //
    // Single authoritative op to relocate a Claude Code terminal tab INTO a
    // project window, de-duplicated. A membership-only add leaves the tab BOTH
    // inside the project and standalone (the app-level store still owns it), so
    // this endpoint does the whole move server-side:
    //   1. add the pane to the project's server-synced membership
    //      (`topics-project-panes-<projectHash(path)>`)
    //   2. splice it out of the app-level standalone store (`pane-store-v2`:
    //      its `panes` entry + every `groups.*.paneIds` ref)
    //   3. open/focus the project window
    // Both ui_state writes get a fresh monotonic server_seq + `ui-state:updated`
    // broadcast so live clients converge to exactly ONE instance. Device-local
    // split geometry (`project-layout-<hash>`) is intentionally NOT touched.
    // Chat topics use bindTopicToProject instead; this is the terminal-tab path
    // (a tab is not a chat-topic).
    {
      const bySession = matchRoute(pathname, "/api/sessions/:sessionKey/move-to-project");
      if (bySession && method === "POST") {
        const body = (await readJSON(req)) as { projectPath?: unknown } | null;
        const rawPath = typeof body?.projectPath === "string" ? body.projectPath : "";
        if (!rawPath) return json({ error: "projectPath (string) is required" }, 400);
        const dir = resolveProjectRef(rawPath, { trustRawPaths: true });
        if (!dir) return json({ error: "project path does not exist" }, 404);

        const sk = decodeURIComponent(bySession.sessionKey);
        const term = getTerminalSessionById(sk);
        if (!term) {
          return json({ error: "move-to-project supports terminal tabs only; use bind-project for chat topics" }, 400);
        }

        const { paneId, membershipKey } = moveTerminalPaneToProject(term, dir);
        broadcastToAll({ type: "open-project", projectPath: dir });
        return json({ ok: true, paneId, projectPath: dir, membershipKey });
      }
    }

    // Canale umano — domande, permessi e regole di «consenti sempre».
    // Estratto in server/routes/permission.ts: montato QUI, alla posizione che
    // il blocco occupava nel dispatch (l'ordine fra rotte è comportamento).
    {
      const permResp = await permissionRouter(req, url, pathname, method);
      if (permResp) return permResp;
    }

    // POST /api/sessions/:sessionKey/{switch-topic,new-topic,create-project,open-project}
    //
    // Tool-shaped successors to the {{TOPIC_SWITCH/TOPIC_NEW/PROJECT_CREATE/
    // PROJECT_OPEN}} markers (the MCP `switch_topic`/`new_topic`/`create_project`/
    // `open_project` tools + the SDK-passthrough dispatcher both hit these).
    // AI-driven: project refs go through resolveProjectRef(trustRawPaths:false),
    // so a model (or prompt injection) can't open a pane rooted at /etc or ~/.ssh.
    //
    // The CALLER is resolved from its sessionKey, which is EITHER a chat topic OR
    // a Claude Code terminal tab:
    //   - open-project / create-project work from BOTH surfaces. A chat topic
    //     binds via bindTopicToProject; a terminal tab (no chat topic) falls back
    //     to moveTerminalPaneToProject — the tab pane is spliced out of the
    //     app-level store and into the project's membership (same as
    //     move-to-project, but resolving the ref by name/slug like the chat
    //     branch, not an absolute path). create-project scaffolds the dir first
    //     (409 on collision) either way, then routes by surface.
    //   - switch-topic / new-topic act on chat topics only (they migrate/split a
    //     conversation; a terminal tab has no conversation to switch). A terminal
    //     session gets a structured 400 naming open_project/move_session_to_project,
    //     not a bare 404 — so the caller knows the RIGHT tool, not just that this
    //     one didn't apply.
    //
    // switch/new reproduce the UI `topic:switch` broadcast but do NOT migrate
    // already-streamed messages (that was marker-only mid-turn surgery, not
    // reproducible by a tool call) — tool-driven switch is UI-only by design.
    {
      const switchM = matchRoute(pathname, "/api/sessions/:sessionKey/switch-topic");
      const newM = matchRoute(pathname, "/api/sessions/:sessionKey/new-topic");
      const createM = matchRoute(pathname, "/api/sessions/:sessionKey/create-project");
      const openM = matchRoute(pathname, "/api/sessions/:sessionKey/open-project");

      if (switchM && method === "POST") {
        const skRaw = decodeURIComponent(switchM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to switch — tell it the right
          // tool instead of a bare 404 (which reads like "session doesn't exist").
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "switch_topic acts on chat topics; this is a terminal Claude tab with no conversation to switch. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "switch_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { topicId?: unknown } | null;
        const targetId = typeof body?.topicId === "string" ? body.topicId : "";
        if (!targetId) return json({ error: "topicId (string) is required" }, 400);
        const r = switchTopicCore(cur, targetId, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        if (!r.ok) {
          // AC-01: archived is a client error distinct from "doesn't exist" — the
          // topic IS there, it's just not switchable (unarchive/open it first).
          if (r.code === "archived") return json({ error: r.message, code: "topic_archived", topicId: targetId }, 400);
          return json({ error: r.message }, 404);
        }
        return json({ ok: true, toTopicId: r.toTopicId });
      }

      if (newM && method === "POST") {
        const skRaw = decodeURIComponent(newM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        if (!cur) {
          // A terminal Claude tab has no chat topic to fork a new one from.
          if (getTerminalSessionById(skRaw)) {
            return json({
              error: "new_topic forks a new chat topic from the current one; this is a terminal Claude tab with no conversation. To move this tab into a project use open_project (or move_session_to_project with an absolute path).",
              code: "not_a_chat_topic",
              tool: "new_topic",
            }, 400);
          }
          return json({ error: "no chat topic bound to this session" }, 404);
        }
        const body = (await readJSON(req)) as { title?: unknown } | null;
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!title) return json({ error: "title (string) is required" }, 400);
        const { topic: newTopic } = createTopicCore(cur, title, { getTopicById, loadTopics, saveSingleTopic, slugify, broadcastToAll });
        return json({ ok: true, topicId: newTopic.id });
      }

      if (createM && method === "POST") {
        const skRaw = decodeURIComponent(createM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can create a project. Resolve
        // the terminal fallback up front so we only scaffold when a caller exists.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { name?: unknown } | null;
        const rawName = typeof body?.name === "string" ? body.name.trim() : "";
        const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required" }, 400);
        const targetDir = join(WORKSPACE_DIR, safeName);
        // AC-01: create means CREATE — a name collision is a 409, never a silent
        // bind to whatever already lives there (that's open-project/bind-project).
        if (existsSync(targetDir)) {
          return json(
            { error: `project "${safeName}" already exists`, code: "project_exists", name: safeName, projectPath: targetDir },
            409,
          );
        }
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
        if (cur) {
          if (!bindTopicToProject(cur.id, targetDir, { focus: true })) {
            return json({ error: "topic not found for this session", code: "project_created_unbound", projectPath: targetDir }, 404);
          }
        } else if (term) {
          // Terminal tab: move the pane into the freshly-scaffolded project and
          // focus it (same focus semantics as the chat bind, via open-project).
          moveTerminalPaneToProject(term, targetDir);
          broadcastToAll({ type: "open-project", projectPath: targetDir });
        }
        return json({ ok: true, projectPath: targetDir });
      }

      if (openM && method === "POST") {
        const skRaw = decodeURIComponent(openM.sessionKey);
        const cur = getTopicBySessionKey(skRaw);
        // Chat topic OR terminal Claude tab — both can open a project.
        const term = cur ? null : getTerminalSessionById(skRaw);
        if (!cur && !term) return json({ error: "no chat topic bound to this session" }, 404);
        const body = (await readJSON(req)) as { ref?: unknown } | null;
        const ref = typeof body?.ref === "string" ? body.ref : "";
        if (!ref) return json({ error: "ref (string) is required" }, 400);
        // Same resolver as the chat branch (trustRawPaths:false): "apri il
        // progetto yup" resolves by name/slug against known projects, and a model
        // still can't reach /etc or ~/.ssh from a terminal tab either.
        const dir = resolveProjectRef(ref, { trustRawPaths: false });
        if (!dir) return json({ error: "project not found (must be a project Topics already knows)" }, 404);
        if (cur) {
          if (!bindTopicToProject(cur.id, dir, { focus: true })) {
            return json({ error: "topic not found for this session" }, 404);
          }
        } else if (term) {
          // Terminal tab: move the pane into the project and focus it (the
          // open-project broadcast gives the same focus semantics as the bind).
          moveTerminalPaneToProject(term, dir);
          broadcastToAll({ type: "open-project", projectPath: dir });
        }
        return json({ ok: true, projectPath: dir });
      }
    }

    // POST /api/topics/:id/system-message
    {
      const params = matchRoute(pathname, "/api/topics/:id/system-message");
      if (params && method === "POST") {
        const body = await readJSON(req);
        // Guard the TYPE up front: a non-string content would persist via
        // appendLocalMessage + fire the first broadcast, then throw on the
        // `.slice(0, 100)` below → a half-written message plus a 500.
        if (typeof body?.content !== "string" || !body.content) return json({ error: "content (string) required" }, 400);
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        const stored = appendLocalMessage(topic.sessionKey, "assistant", body.content);
        broadcastToAll({ type: "message", sessionKey: topic.sessionKey, message: { id: stored.id, role: "assistant", content: body.content, timestamp: stored.timestamp } });
        broadcastToAll({ type: "message:new", topicId: params.id, sessionKey: topic.sessionKey, role: "assistant", messageId: stored.id, content: body.content, preview: body.content.slice(0, 100) });
        updateUnreadCount(params.id);
        return json({ ok: true, message: stored });
      }
    }

    // GET /api/topics/:id/messages - fetch conversation messages for a topic
    {
      const params = matchRoute(pathname, "/api/topics/:id/messages");
      if (params && method === "GET") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);

        const urlParams = url.searchParams;
        const limit = parseInt(urlParams.get("limit") || "200");
        const offset = parseInt(urlParams.get("offset") || "0");

        const localMsgs = loadLocalMessages(topic.sessionKey);
        const completeMsgs = localMsgs.filter(m => !m.partial || (m.content && m.content.trim()));
        const total = completeMsgs.length;
        const sliced = offset > 0 ? completeMsgs.slice(0, Math.max(0, total - offset)) : completeMsgs;
        // Same slimming as `/api/history/:key`. Without it this route shipped
        // 12.54 MB where the other shipped 5.42 for the same topic, because here
        // `toolCalls` still travelled alongside `blocks` AND each one carried a
        // duplicated `result`. The caller is the agents' `read_chat` over MCP,
        // which then keeps 4,000 characters per message and throws the rest away
        // (server/mcp/topics-mcp-server.ts:1219). See shared/lean-tool-call.ts.
        const result = leanMessagesForWire(sliced.slice(-limit));

        return json({ messages: result, total, topicName: topic.name });
      }
    }

    // GET /api/topics/:id/changes - the files THIS conversation wrote, crossed
    // with git limited to those paths (server/lib/topic-changes.ts). The chat
    // knew it all along, in its write tool calls: nothing was reading them back,
    // so the only way to see what an agent touched was to scroll the transcript
    // or open a terminal on the whole repo.
    {
      const params = matchRoute(pathname, "/api/topics/:id/changes");
      if (params && method === "GET") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        // The worktree wins over the project folder: a topic bound to one has
        // its own checkout, and the project path would answer for another tree.
        const worktree = topic.worktreeId ? worktreeStore.get(topic.worktreeId) : null;
        const cwd = worktree?.absPath || topic.projectPath || null;
        const messages = loadLocalMessages(topic.sessionKey);
        return json(await computeTopicChanges(cwd, messages));
      }
    }

    // --- Search ---
    if (method === "POST" && pathname === "/api/search") {
      const body = await readJSON(req);
      if (!body || !body.query) return json({ error: "query required" }, 400);
      return json({ results: searchTranscripts(body.query, body.limit || 50) });
    }

    // STT (/api/stt) + TTS (/api/tts) live in server/routes/voice.ts now.

    // --- Context file upload ---
    // /api/context-upload moved to server/routes/media.ts (with the other uploads).

    // --- Test: Seed message (for E2E tests — inserts a message directly into DB) ---
    //
    // Dietro lo STESSO cancello delle altre rotte di test (`e2eRoutesEnabled`,
    // TOPICS_E2E=1): era l'unica superficie di test registrata anche in
    // produzione, e scriveva righe `messages` arbitrarie senza guard — finding
    // F57 dell'audit del 19/06. Su un server normale ora è 404, come se non
    // esistesse: un endpoint di test spento deve essere indistinguibile da un
    // endpoint che non c'è, altrimenti dice comunque che c'è qualcosa lì.
    if (method === "POST" && pathname === "/api/test/seed-message") {
      if (!e2eRoutesEnabled()) return null;
      const body = await readJSON(req);
      if (!body?.sessionKey || !body?.role) {
        return json({ error: "sessionKey and role required" }, 400);
      }
      const id = body.id || crypto.randomUUID();
      const timestamp = body.timestamp || new Date().toISOString();
      const sortOrder = body.sortOrder ?? Date.now();
      // Default the parent to the session's current last message so seeded
      // threads stay linked. Without this a seeded message lands with parent_id
      // NULL — a second root — and loadActiveThread treats the roots as branches
      // and renders the thread truncated. Tests that build branch trees can
      // still pass an explicit parentId (or null) to override.
      const seedParentId = body.parentId !== undefined
        ? body.parentId
        : ((db.prepare(`SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1`).get(body.sessionKey) as any)?.id ?? null);
      try {
        db.prepare(`
          INSERT INTO messages (id, session_key, role, content, thinking, tool_calls, blocks, media, partial, streamed_at, plan_status, timestamp, sort_order, parent_id, branch_index, latency_ms, usage_prompt_tokens, usage_completion_tokens, cost_cents, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens)
          VALUES ($id, $session_key, $role, $content, $thinking, $tool_calls, $blocks, $media, 0, NULL, NULL, $timestamp, $sort_order, $parent_id, $branch_index, $latency_ms, $usage_prompt_tokens, $usage_completion_tokens, $cost_cents, $cache_read_tokens, $cache_creation_tokens, $cache_creation_1h_tokens)
        `).run({
          $id: id,
          $session_key: body.sessionKey,
          $role: body.role,
          $content: body.content || '',
          $thinking: body.thinking || null,
          $tool_calls: toolCallsColumnForRow(body.toolCalls, body.blocks),
          // `blocks` è la cronologia che il client rende quando c'è — e quando
          // c'è, `content` non viene stampato affatto. Senza questa colonna nel
          // seed, nessun test poteva riprodurre la classe di difetti che vive
          // proprio in quella divergenza.
          $blocks: blocksForDisk(body.blocks),
          $media: body.media ? JSON.stringify(body.media) : null,
          $timestamp: timestamp,
          $sort_order: sortOrder,
          $parent_id: seedParentId,
          // Branch index — defaults to 0 (linear thread). Tests seed sibling
          // branches (same parent, distinct index) to exercise the branch-
          // navigation UI without driving a provider-backed edit.
          $branch_index: typeof body.branchIndex === "number" ? body.branchIndex : 0,
          // Slice 7 — optional per-message footer fields. Tests use these to
          // exercise the MessageMetaFooter without driving a real provider.
          $latency_ms: typeof body.latencyMs === "number" ? body.latencyMs : null,
          $usage_prompt_tokens: typeof body.usagePromptTokens === "number" ? body.usagePromptTokens : null,
          $usage_completion_tokens: typeof body.usageCompletionTokens === "number" ? body.usageCompletionTokens : null,
          $cost_cents: typeof body.costCents === "number" ? body.costCents : null,
          // Lo SCORPORO della cache. `null` non è 0: assente vuol dire "il
          // provider non l'ha riportato" e la striscia lo dice a parole, 0 vuol
          // dire misurato-nessuna-cache. Senza queste tre colonne non c'era modo
          // di provare da un test la parte di UI che le mostra.
          $cache_read_tokens: typeof body.cacheReadTokens === "number" ? body.cacheReadTokens : null,
          $cache_creation_tokens: typeof body.cacheCreationTokens === "number" ? body.cacheCreationTokens : null,
          $cache_creation_1h_tokens: typeof body.cacheCreation1hTokens === "number" ? body.cacheCreation1hTokens : null,
        });
        return json({ ok: true, id });
      } catch (err: any) {
        return json({ error: "Seed failed: " + err.message }, 500);
      }
    }

    // --- Chat proxy (streaming) ---
    // --- Chat streaming --- (handler extracted to server/routes/chat.ts)
    {
      const chatResp = await chatRouter(req, url, pathname, method);
      if (chatResp) return chatResp;
    }

    // --- Abort streaming ---
    if (method === "POST" && pathname === "/api/chat/abort") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      if (!sessionKey) return json({ error: "sessionKey required" }, 400);

      const stream = activeStreams.get(sessionKey);

      // Resolve topic and provider for abort — O(1) UNIQUE-index lookup
      // instead of a full topics scan per /api/chat/abort hit.
      const abortTopic = getTopicBySessionKey(sessionKey);
      const topicId: string | undefined = abortTopic?.id;
      const abortProvider = resolveProvider(abortTopic);

      // `clearMessages` è una PROPOSTA del client, non un ordine, e la risposta
      // — il campo `cleared` — è ciò che autorizza il client a svuotare la
      // pagina, chiudere la pane e archiviare il topic. Prima il client non la
      // leggeva e decideva da solo: il 10 agosto 2026 una chat viva è sparita
      // dalla vista mentre qui il wipe veniva rifiutato.
      const decideClear = (): boolean => {
        if (!body?.clearMessages) return false;
        const stored = loadLocalMessages(sessionKey);
        // Il conteggio della sessione INTERA, non del solo ramo attivo: è la
        // cancellazione che colpisce tutta la session_key, quindi è su quella
        // che si deve decidere.
        const decision = shouldHonorClearMessages(stored, countMessagesBySession(sessionKey));
        if (!decision.shouldWipe) {
          console.warn(
            `[Abort] Ignored clearMessages=true for ${sessionKey} — DB has ${decision.userCount} user / ${decision.assistantCount} assistant messages` +
            (decision.assistantDidWork ? ", e il turno aveva già prodotto lavoro"
             : decision.hiddenRows > 0 ? `, e la sessione ha ${decision.hiddenRows} righe fuori dal ramo attivo`
             : ", not first-message")
          );
          return false;
        }
        // Si scrive PRIMA di cancellare, e sul ramo che cancella. Finora il
        // log parlava solo quando RIFIUTAVA: la distruzione di una chat non
        // lasciava una riga che la nominasse, e nell'incidente dell'8 agosto
        // l'unica traccia era un `resetSession` a due righe di distanza.
        console.log(
          `[Abort] ${sessionKey}: chat cancellata su clearMessages=true — ${decision.userCount} utente / ${decision.assistantCount} assistente, nessun lavoro prodotto`
        );
        saveLocalMessages(sessionKey, []);
        // Stesso taglio di `/clear`, per la stessa ragione: qui la chat viene
        // buttata via INTERA (era il primo messaggio, fermato prima della
        // risposta). Senza questo la riga `claude_code_sessions` resta, e la
        // chat "nuova" che l'utente riapre riprende con `--resume` su una
        // sessione che ricorda il messaggio appena annullato.
        if (clearActionFor(abortProvider).kind === "reset") {
          abortProvider.resetSession!(sessionKey).catch((err: any) =>
            console.warn(`[Abort] resetSession failed:`, err),
          );
        }
        return true;
      };

      if (!stream) {
        // Niente da fermare: turno già finito, oppure una finestra che stava
        // solo guardando quello di un'altra. Nessun effetto — né sul provider
        // (un `abort` alla cieca taglierebbe un turno headless che questo
        // server non ha in `activeStreams`) né sulle righe: `cleared: false`
        // esplicito, così il client sa che non deve buttare via niente.
        // Il prezzo è al più una chat usa-e-getta che resta aperta; il prezzo
        // opposto sarebbe cancellare la domanda di un turno ancora vivo.
        return json({ ok: false, reason: "no_active_stream", cleared: false });
      }

      // CHI ha fermato il turno si DEPOSITA, prima di qualunque altra cosa.
      //
      // Chi guida un turno headless (`runHeadlessTurn` in server.ts) legge la
      // fine da `takeTurnEnd`, e quando non la trova assume `end_turn`. Da qui
      // non ci passava mai: `stream.abortController.abort()` fa scattare il
      // listener della route di chat, che latcha `streamState = "finalized"`, e
      // da quel momento `finalizeStream` esce alla prima riga — quindi il suo
      // `recordTurnEnd` non gira. Uno stop premuto da una persona arrivava al
      // dispatcher come una consegna RIUSCITA: bruciava un tentativo e
      // rilanciava l'agente all'istante, sul task che l'umano aveva appena
      // fermato.
      //
      // `cancelled("user")` è quello che il provider stesso depositerebbe: se la
      // sua finalizzazione arriva comunque, riscrive lo stesso verdetto.
      recordTurnEnd(sessionKey, cancelled("user", "POST /api/chat/abort"));

      // PRIMA il provider, POI il controller dell'SSE. L'ordine conta: l'abort
      // del controller chiude la macchina a stati della route, quindi tutto ciò
      // che il provider ha ancora da dire su questo turno (il suo `onAborted`,
      // con la ragione autorevole) troverebbe un `finalizeStream` già spento.
      if (abortProvider.connected) {
        abortProvider.abort?.(sessionKey, undefined, "user")?.catch((err: any) => console.warn(`[Abort] Provider abort failed:`, err));
        abortProvider.unregisterStreamHandler?.(sessionKey);
      }

      // Abort the gateway request (HTTP fallback)
      if (stream.abortController) {
        try { stream.abortController.abort(); } catch {}
      }

      // If a `mcp__topics__ask_user_question` bridge handler is blocked waiting
      // for this session's human answer, unblock it with an error so the CLI
      // turn tears down now instead of hanging on the 10-min ask timeout.
      releaseHumanHold(sessionKey, "turn aborted");

      // Fermare un turno PRIMA che il modello dica qualcosa lasciava in chat il
      // segnaposto creato all'inizio dello stream, finalizzato vuoto: una bolla
      // senza niente dentro, che poi rientra nella history rimandata al modello
      // a ogni turno successivo. Ne contiamo a decine nei giorni di dispatch.
      // Ora un turno che non ha prodotto niente non lascia niente — mezza frase
      // o una tool call sono invece lavoro fatto e restano (vedi shared/empty-turn.ts).
      let discardedMessageId: string | null = null;
      const finalizeAborted = () => {
        // Indirizzato per id, non "l'ultima riga": la finalize del provider
        // (`onAborted` → finalizeStream in chat.ts) può aver già scartato il
        // segnaposto di questo stream. Se non c'è più non c'è niente da
        // finalizzare — e `updateLastMessage`, che è posizionale, scriverebbe
        // sulla riga dell'UTENTE.
        if (stream.messageId && !getMessageById(stream.messageId)) return;
        const finalized = updateLastMessage(sessionKey, { content: stream.content, thinking: stream.thinking || undefined, partial: undefined, streamedAt: undefined });
        discardedMessageId = discardIfEmptyTurn(sessionKey, finalized);
        if (discardedMessageId) console.log(`[Abort] ${sessionKey}: turno vuoto scartato (${discardedMessageId})`);
      };
      const clearedForReal = decideClear();
      // Rifiutata (o mai proposta): si passa dalla finalize normale, così non si
      // perde il contenuto parziale che l'utente stava per fermare.
      if (!clearedForReal) finalizeAborted();

      endStream(sessionKey);
      // user_abort: user explicitly clicked stop — they are present in the tab,
      // so we intentionally do NOT increment unread count. This is a design
      // choice, not an omission.
      broadcastToAll({ type: "stream:end", sessionKey, topicId, reason: "user_abort", ...(discardedMessageId ? { discardedMessageId } : {}) });

      return json({ ok: true, cleared: clearedForReal });
    }

    // --- Tool response (resume a paused AskUserQuestion / MCP elicitation) ---
    //
    // Companion endpoint to the `onUserInputRequired` callback wired into
    // the stream handler above. The provider has paused the turn waiting
    // for a `tool_result` block on its stdin; we validate the submission
    // against the still-pending request on its side, persist the user's
    // answer onto the assistant message's tool_calls blob (so the
    // exchange survives reload), and ask the provider to inject the
    // result. Status transitions waiting_for_input → running; the next
    // `tool_result` from the CLI will flip it to success/error normally.
    if (method === "POST" && pathname === "/api/chat/tool-response") {
      const body = await readJSON(req);
      const sessionKey = body?.sessionKey;
      const toolCallId = body?.toolCallId;
      const response = body?.response;
      if (!sessionKey || !toolCallId || !response || typeof response.kind !== 'string') {
        return errorResponse(400, "sessionKey, toolCallId, and response{kind,...} required");
      }

      // --- Bridge ask path: mcp__topics__ask_user_question ---
      // The Topics MCP bridge tool answers through the bridge subprocess'
      // OWN JSON-RPC response (see server/lib/ask-user-bridge.ts), NOT via a
      // stdin `tool_result` line. A blocked bridge handler for this session
      // means THIS session's pending input IS the bridge ask (the CLI blocks
      // the turn on one ask at a time), so route the answer to the rendez-vous
      // and skip the provider stdin path entirely. Without this, the answer
      // would be written to stdin AND returned by the bridge — a double result
      // that desyncs the transcript.
      // Il tool che si sta rispondendo È il pannello del bridge?
      //
      // `hasPendingAsk` legge una mappa IN MEMORIA, e quella mappa si svuota a
      // ogni riavvio del server mentre il figlio continua a pollare imperterrito
      // (le sue gambe ripartono da sole). In quella finestra la risposta
      // dell'umano cadeva nel ramo di sotto — stdin del provider — dove nessuno
      // la aspetta: il pannello restava su «Invio…» per sempre e la risposta si
      // perdeva. Osservato il 4 agosto su topic:ed2070df, con la POST arrivata
      // al server e il figlio che continuava a chiedere.
      //
      // Il nome del tool è un fatto della RIGA, non della memoria di questo
      // processo: se è il pannello, la risposta va al rendez-vous — che se non
      // c'è nessuno in ascolto la mette da parte per la gamba successiva
      // (`deliverAnswer` bufferizza apposta).
      const answeringBridgeAsk = (() => {
        if (response.kind !== 'questions') return false;
        if (hasPendingAsk(sessionKey)) return true;
        try {
          // NOT ONLY THE LAST ROW - the rule and its measurement live in
          // `lib/ask-answer-routing.ts`. The window is short on purpose: the
          // question being answered belongs to this exchange, and a scan of the
          // whole session would cost a table walk per answer.
          const rows = ctx.db.prepare(
            "SELECT tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 20",
          ).all(sessionKey) as AskHaystackRow[];
          return rowsCarryAsk(rows, toolCallId, decodeCol);
        } catch { return false; }
      })();
      if (answeringBridgeAsk) {
        const submittedAt = new Date().toISOString();
        const answers = (response.answers || {}) as Record<string, string>;
        const normalised = {
          kind: 'questions' as const,
          answers,
          metadata: response.metadata as Record<string, unknown> | undefined,
          submittedAt,
        };
        const topic = getTopicBySessionKey(sessionKey);
        // Unblock the bridge handler → it returns the answers as its tool
        // result → the CLI resumes the turn.
        deliverAnswer(sessionKey, answers);
        // Forget the provider's pending entry so a reattach REPLAY won't
        // re-open the panel for an already-answered question. We intentionally
        // do NOT call resumeWithToolResponse — the bridge return is the result.
        try { resolveProvider(topic).clearPendingInput?.(sessionKey, toolCallId); } catch { /* provider gone; nothing to clear */ }
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'running',
          userResponse: normalised,
        });
        broadcastToAll({
          type: 'stream:tool_update',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          // THE STATUS TRAVELS, or the panel never switches off. The call
          // above writes it to the DB and this announcement used to stay
          // silent about it: the client entered only when a `partialResult`
          // was present, so the transition reached nobody and the form sat on
          // its spinner until a reload. See `toolUpdatePatch` on the client.
          status: 'running',
          userResponse: normalised,
        });
        return json({ ok: true, submittedAt });
      }

      // --- Approvazione di un piano ---
      // Non c'è nessun tool sospeso da sbloccare: il turno è già finito, e la
      // domanda l'ha messa Topics a fine turno perché la CLI in plan mode non
      // ha più `ExitPlanMode` per chiederla (vedi server/lib/plan-approval.ts).
      // Qui si registra solo la risposta; a far ripartire il lavoro è il client,
      // che manda un turno nuovo con l'autonomia giusta — la stessa strada di
      // qualunque altro messaggio, invece di un secondo modo di avviare turni.
      if (response.kind === 'questions' && isPlanApprovalAnswer(response)) {
        const submittedAt = new Date().toISOString();
        const topicForPlan = getTopicBySessionKey(sessionKey);
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'success',
          userResponse: { ...response, submittedAt },
        });
        broadcastToAll({
          type: 'stream:tool_update',
          sessionKey,
          topicId: topicForPlan?.id,
          toolCallId,
          // This is the ONLY announcement that will ever arrive: the plan
          // hangs off a tool already finished, which Topics back-marks at the
          // end of the turn, so no provider will emit a `stream:tool_result`
          // for this id. Without the status in here the plan panel spun
          // forever while the new turn scrolled underneath.
          status: 'success',
          userResponse: { ...response, submittedAt },
        });
        return json({ ok: true, submittedAt });
      }

      // Provider lookup mirrors abort: O(1) by sessionKey instead of a topics scan.
      const topic = getTopicBySessionKey(sessionKey);
      const provider = resolveProvider(topic);
      if (!provider.connected || !provider.resumeWithToolResponse) {
        // Fail the tool fast — the route never leaves a waiting_for_input
        // status orphaned on the row.
        const errMsg = provider.resumeWithToolResponse
          ? `provider ${provider.name} is not connected`
          : `provider ${provider.name} does not support user input`;
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'error',
          error: errMsg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: errMsg,
        });
        return errorResponse(503, errMsg);
      }

      const submittedAt = new Date().toISOString();
      // Normalize the payload — accept partial shapes from the client so
      // a forgetful caller (no `submittedAt`) still gets a record we can
      // persist and replay.
      const normalised =
        response.kind === 'questions'
          ? {
              kind: 'questions' as const,
              answers: (response.answers || {}) as Record<string, string>,
              metadata: response.metadata as Record<string, unknown> | undefined,
              submittedAt,
            }
          : response.kind === 'elicitation'
            ? { kind: 'elicitation' as const, value: response.value, submittedAt }
            : response.kind === 'raw'
              ? { kind: 'raw' as const, text: String(response.text ?? ''), submittedAt }
              : null;
      if (!normalised) {
        return errorResponse(400, `unsupported response kind: ${String(response.kind)}`);
      }

      try {
        await provider.resumeWithToolResponse(sessionKey, toolCallId, normalised);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Provider rejected (no pending input, process dead, stdin write
        // failed). Flag the tool as errored so the UI unblocks; the next
        // user turn can retry from scratch.
        updateToolCallFields(sessionKey, toolCallId, {
          status: 'error',
          error: msg,
        });
        broadcastToAll({
          type: 'stream:tool_result',
          sessionKey,
          topicId: topic?.id,
          toolCallId,
          status: 'error',
          error: msg,
        });
        // 404 specifically for "no pending input" so the client can show
        // a friendly "this question was already answered" toast.
        const status = /no pending input/i.test(msg) ? 404 : 502;
        return errorResponse(status, msg);
      }

      updateToolCallFields(sessionKey, toolCallId, {
        status: 'running',
        userResponse: normalised,
      });
      broadcastToAll({
        type: 'stream:tool_update',
        sessionKey,
        topicId: topic?.id,
        toolCallId,
        // No partialResult - this is just a status transition. The next
        // tool_result event will carry the actual content from the model.
        //
        // But the transition NOW travels. This announcement used to carry the
        // id alone, and the client entered only when a `partialResult` was
        // present: the transition never arrived, and the panel sat on its
        // spinner for the whole duration of the tool instead of an instant.
        status: 'running',
        userResponse: normalised,
      });

      return json({ ok: true, submittedAt });
    }

    // --- Edit message --- (handler extracted to server/routes/edit.ts)
    {
      const editResp = await editRouter(req, url, pathname, method);
      if (editResp) return editResp;
    }

    // Switch-branch (POST /api/messages/:id/switch-branch) lives in server/routes/branches.ts now.

    // --- History --- (handler extracted to server/routes/history.ts)
    {
      const historyResp = await historyRouter(req, url, pathname, method);
      if (historyResp) return historyResp;
    }

    // --- Tool detail on demand --- (GET /api/messages/:id/tool/:id/detail)
    {
      const toolDetailResp = await toolDetailRouter(req, url, pathname, method);
      if (toolDetailResp) return toolDetailResp;
    }

    // --- Media serving ---
    // Media serving + uploads (/api/media, /api/upload, /api/upload-image,
    // /api/context-upload, DELETE /api/context-file) live in server/routes/media.ts now.

    // --- Auto-name --- (handler extracted to server/routes/autoname.ts)
    {
      const autoNameResp = await autoNameRouter(req, url, pathname, method);
      if (autoNameResp) return autoNameResp;
    }

    // --- Slash commands ---
    if (method === "POST" && pathname === "/api/command") {
      const body = await readJSON(req);
      if (!body?.command || !body?.sessionKey) return json({ error: "command and sessionKey required" }, 400);
      const { command, sessionKey, args } = body;
      try {
        switch (command) {
          case "status": {
            // The report itself lives in `sessionStatus.ts`, where a test can
            // reach it; this branch only gathers what it reads.
            const messages = loadLocalMessages(sessionKey);
            const topic = getTopicBySessionKey(sessionKey);
            const output = sessionStatus({
              sessionKey,
              messaggi: messages.length,
              topic: topic as never,
            });
            return json({ ok: true, command: "status", output });
          }
          case "clear": {
            const existingMsgs = loadLocalMessages(sessionKey);
            if (existingMsgs.length > 0) {
              const backupDir = join(ctx.BASE_DIR, "backups");
              try { mkdirSync(backupDir, { recursive: true }); const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); const backupFile = join(backupDir, `${sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}_${timestamp}.json`); writeFileSync(backupFile, JSON.stringify(existingMsgs, null, 2)); console.log(`[clear] Backed up ${existingMsgs.length} messages to ${backupFile}`); } catch (err) { console.warn("[clear] Backup failed:", err); }
            }
            saveLocalMessages(sessionKey, []);
            // Svuotare la tabella pulisce solo quello che si VEDE: al provider
            // va detto a parte, o il modello ricorda tutto (vedi clearPolicy.ts
            // — la regola sta lì, pura e testata).
            const clearProvider = providerForSessionKey(sessionKey);
            const clearAction = clearActionFor(clearProvider);
            try {
              if (clearAction.kind === "reset") await clearProvider.resetSession!(sessionKey);
              else if (clearAction.kind === "in-band") await clearProvider.sendToSession!(sessionKey, "/clear");
              else console.warn(`[clear] ${clearProvider.name} non sa dimenticare una sessione: svuotata solo la chat`);
            } catch (err) { console.warn("Failed to clear provider session:", err); }
            broadcastToAll({ type: "clear", sessionKey });
            return json({ ok: true, command: "clear", message: "Conversation cleared" });
          }
          case "model": {
            const modelName = args?.model;
            if (!modelName) return json({ error: "model name required" }, 400);
            // Il provider DICHIARATO, non quello risolto: vedi declaredProviderName.
            if (commandRoutesThroughGateway(sessionKey)) {
              const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/model ${modelName}` }] }) });
              if (!resp.ok) return json({ error: "Failed to set model" }, 500);
              return json({ ok: true, command: "model", model: modelName, message: `Model set to: ${modelName}` });
            }
            // claude-code (and any respawn provider): the model is a spawn-time
            // `--model` flag. Persist it per-topic and drop the idle pooled
            // process so the next turn respawns with it — same path as PATCH
            // /api/topics/:id. (Previously this returned a hard 400.)
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevModel = topic.model ?? null;
            topic.model = String(modelName).trim() || null;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            if ((topic.model ?? null) !== prevModel) {
              try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
              catch (err) { console.warn(`[command] refreshSessionConfig (model) failed:`, err); }
            }
            return json({ ok: true, command: "model", model: topic.model, message: `Modello impostato: ${topic.model}. Attivo dal prossimo turno.` });
          }
          case "effort": {
            // Per-topic reasoning-effort tier for claude-code (spawn-time
            // `--effort`). openclaw has no effort tier → route through /reasoning.
            const tier = String(args?.level || args?.effort || "").trim().toLowerCase();
            const VALID_EFFORTS = new Set<string>(EFFORT_TIERS);
            if (commandRoutesThroughGateway(sessionKey)) {
              return json({ error: "L'effort non si applica a questo provider. Usa /reasoning." }, 400);
            }
            if (!tier || !VALID_EFFORTS.has(tier)) {
              return json({ error: "Uso: /effort <low|medium|high|xhigh|max>" }, 400);
            }
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);
            const prevEffort = topic.effort ?? null;
            topic.effort = tier;
            topic.updatedAt = new Date().toISOString();
            saveSingleTopic(topic);
            broadcastToAll({ type: "topic:updated", topic });
            if ((topic.effort ?? null) !== prevEffort) {
              try { resolveProvider(topic).refreshSessionConfig?.(topic.sessionKey); }
              catch (err) { console.warn(`[command] refreshSessionConfig (effort) failed:`, err); }
            }
            return json({ ok: true, command: "effort", level: tier, message: `Effort impostato: ${tier}. Attivo dal prossimo turno.` });
          }
          case "reasoning": {
            const level = args?.level || "on";
            if (commandRoutesThroughGateway(sessionKey)) {
              const resp = await fetch(`${GATEWAY_URL}/api/inference/chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-scopes": "operator.read,operator.write" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: `/reasoning ${level}` }] }) });
              if (!resp.ok) return json({ error: "Failed to toggle reasoning" }, 500);
              const text = await resp.text();
              return json({ ok: true, command: "reasoning", level, message: `Reasoning set to: ${level}`, output: text });
            }
            // claude-code has no on/off reasoning toggle — it has an effort tier.
            // Point the user at /effort instead of the old hard 400.
            return json({ ok: true, command: "reasoning", message: "Su claude-code il ragionamento si regola con l'effort: usa /effort <low|medium|high|xhigh|max>." });
          }
          case "project": {
            const sub = args?.sub || "info"; // create | open | info
            const value = (args?.value || "").trim();
            const topic = getTopicBySessionKey(sessionKey);
            if (!topic) return json({ error: "No topic found for this session" }, 404);

            if (sub === "create") {
              if (!value) return json({ error: "/project create <name> requires a project name" }, 400);
              const safeName = value.replace(/[^a-zA-Z0-9_-]/g, "");
              if (!safeName) return json({ error: "Invalid project name (only letters, digits, _ and - allowed)" }, 400);
              const targetDir = join(WORKSPACE_DIR, safeName);
              if (existsSync(targetDir)) return json({ error: `Project "${safeName}" already exists at ${targetDir}` }, 409);
              try {
                mkdirSync(targetDir, { recursive: true });
                writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
              } catch (err: any) {
                return json({ error: `Failed to create project: ${err.message}` }, 500);
              }
              bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "create", path: targetDir, output: `📁 Created project "${safeName}" at ${targetDir} and bound it to this topic.` });
            }

            if (sub === "open") {
              if (!value) return json({ error: "/project open <name-or-path> requires a target" }, 400);
              const targetDir = resolveProjectRef(value, { trustRawPaths: true });
              if (!targetDir) {
                return json({ error: `Project not found: ${value}` }, 404);
              }
              bindTopicToProject(topic.id, targetDir, { focus: true });
              return json({ ok: true, command: "project", sub: "open", path: targetDir, output: `📁 Opened project at ${targetDir} and bound it to this topic.` });
            }

            // info (no args): show current binding + list workspace projects
            const lines: string[] = [];
            if (topic.projectPath) {
              lines.push(`📍 Current project: ${topic.projectPath}`);
            } else {
              lines.push("📍 No project bound to this topic.");
            }
            const wsProjects = getWorkspaceProjects();
            if (wsProjects.length > 0) {
              lines.push("", "🗂 Workspace projects:");
              for (const p of wsProjects.slice(0, 20)) {
                const name = p.split("/").pop() || p;
                lines.push(`  • ${name}  ·  ${p}`);
              }
              if (wsProjects.length > 20) lines.push(`  …and ${wsProjects.length - 20} more`);
            }
            return json({ ok: true, command: "project", sub: "info", output: lines.join("\n") });
          }
          default: return json({ error: `Unknown command: ${command}` }, 400);
        }
      } catch (err: any) { return json({ error: `Command failed: ${err.message}` }, 500); }
    }

    // Remote-access tunnel endpoints (/api/remote/*) live in server/routes/remote.ts now.

    // --- Processes API ---
    if (method === "GET" && pathname === "/api/processes") {
      const topicId = url.searchParams.get("topicId");
      if (!topicId) return json({ error: "topicId parameter required" }, 400);
      try {
        const procProvider = resolveProvider(getTopicById(topicId));
        let result: any;
        if (procProvider.listSessions) {
          result = await procProvider.listSessions({ kinds: ["other"], activeMinutes: 30 });
        } else if (procProvider.invokeTool) {
          result = await procProvider.invokeTool("sessions_list", { kinds: ["other"], activeMinutes: 30 });
        } else {
          return json([]);
        }
        const sessions = result?.result?.sessions || [];
        return json(subagentProcesses(sessions));
      } catch { return json([]); }
    }

    {
      const params = matchRoute(pathname, "/api/topics/:topicId/project-id");
      if (params && method === "GET") {
        const projectId = getProjectIdForTopic(params.topicId);
        if (!projectId) return json({ error: "Topic has no project" }, 400);
        return json({ projectId });
      }
    }

    // --- Open project (broadcast to UI) ---
    if (method === "POST" && pathname === "/api/open-project") {
      try {
        const body = await req.json();
        const rawPath = body?.path;
        if (!rawPath || typeof rawPath !== "string") {
          return json({ error: "path is required" }, 400);
        }
        const projectPath = resolve(rawPath);
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          return json({ error: "Directory does not exist" }, 404);
        }
        broadcastToAll({ type: "open-project", projectPath });
        return json({ ok: true, projectPath });
      } catch (e: any) {
        return errorResponse(500, e instanceof Error ? e.message : String(e));
      }
    }

    return null;
  };
}
