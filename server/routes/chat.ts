/**
 * Chat streaming engine — the POST /api/chat handler, extracted verbatim from
 * the topics.ts god-file. This is the streaming chat-proxy core: resolve the
 * topic/provider, assemble context, open an SSE writer, drive the provider
 * stream (WS-preferred with an HTTP-SSE fallback), dispatch inline markers
 * (browser / topic-switch / project) and server-side browser tool calls, track
 * soft/hard inactivity timeouts, persist blocks/tool-calls, and finalize the
 * assistant message.
 *
 * Pattern mirrors edit.ts/history.ts/autoname.ts: a dependency-injected
 * sub-router instantiated INSIDE createTopicsRouter, receiving the closure-local
 * helpers it needs (see ChatDeps) by reference. The only SHARED mutable state it
 * touches is `browserNavigatedTopics` (the localhost-auto-navigate dedupe Set),
 * passed in as the same instance so the dedupe contract still spans the marker
 * helper + the open-pane route. Behaviour is a verbatim move — only the route
 * dispatch wrapper changed.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AppContext, ContentBlock, RouteHandler, ToolCall, Topic } from "../types";
import { getProvider, type AIProvider, type ChatMessage, type StreamHandler } from "../providers";
import { deriveToolDetail } from "../providers/claude/tool-detail";
import { classifyShellToolResult } from "../providers/claude/background-shell";
import { getSessionCliPid } from "../providers/session-pids";
import {
  closeBackgroundShell,
  noteBackgroundShellOutput,
  registerBackgroundShell,
} from "./processes";
import { insertCompactionMarkerIfNew, backfillPostTokens } from "../db/compaction-markers";
import { getActiveGoal, replaceSteps } from "../services/goals";
import { recordSessionContext } from "../db/session-context";
import { buildContextUpdate } from "../usage/usage-update";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { cancelled, classifyTurnError, isAcpStopReason, type TurnEndInfo } from "../providers/stop-reason";
import { recordTurnEnd } from "../providers/turn-end-registry";
import { appendUsageRecord } from "../usage/store";
import { autoreDaIdentita } from "../lib/message-author";
import { makeGatewaySseProcessor } from "../lib/gateway-sse-consumer";
import { accumulateTurnUsage, emptyTurnUsage, turnUsageParts, turnUsageWire } from "../usage/turn-usage";
import { calculateCost, calculateCostWithCache, splitPromptTokens } from "../usage/pricing";
import type { BrowserService } from "../browser-service";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { browserTools } from "../browser-tools";
import { isPassthroughProvider } from "../browser-tools-adapters";
import { dispatchBrowserToolCall, resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { decodeCol } from "../../shared/message-blob";
import {
  controlTools,
  isControlTool,
  dispatchControlToolCall,
  ControlToolError,
  type ControlDispatchDeps,
} from "../control-tools";
import { resolveTabRef } from "../lib/tab-resolver";
import { tabResolverDeps } from "../lib/tab-resolver-deps";
import {
  adaptEnvelope,
  assembleTopicContext,
  composeSystemMessages,
  getInlineSentState,
  getProviderStrategy,
  inlineScope,
  markInlineSent,
  pushSnapshot,
  rekeyInlineSent,
  type ContextEnvelope,
} from "../context";
import {
  logStreamSoftTimeout,
  logStreamHardTimeout,
  logStreamComplete,
  logStreamAborted,
  logStreamError,
  logStreamRecovered,
} from "../db/activity-log";
// `stripSlowAnnotation` resta: non lo appende piu' nessuno, ma `fullContent` puo'
// essere seminato da un messaggio parziale RILETTO dal DB (reattach, hot-reload
// con due server in volo), e quello puo' ancora portarla. Toglierlo qui
// riesumerebbe l'annotazione nel contenuto finale.
import { computeCleanBroadcastDelta, stripSlowAnnotation } from "./stream-markers";
import { createHumanWaitLedger } from "../lib/human-wait";
import { crashedTurnNotice, rowCarriesWork, sendFailureNotice, shortErrorDetail, type CrashedTurnRow } from "./crashedTurnNotice";
import { attribuisciMedia, type TurnToolTrace } from "../lib/media-ownership";
import { mergeReattachedRow, type RowSnapshot } from "./reattachMerge";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { DEFAULT_CONTEXT_WINDOW } from "../usage/context-window";
import { permissionModeForAutonomy, planModeFor } from "../lib/autonomy-mode";
import { findPlanAwaitingApproval, shouldAskPlanApproval, planApprovalSchema } from "../lib/plan-approval";
import { createIdempotencyCache } from "../lib/idempotency-cache";
import { cancelledNotice, abortLogTitle } from "../lib/cancelled-notice";
import { providerSurvivesRestart } from "../lib/quiescence";

/**
 * Le chiavi dei messaggi gia' presi, per riconoscere una ripetizione.
 *
 * TTL lungo (mezz'ora) perche' non costa niente sbagliare da questa parte: la
 * chiave e' un uuid coniato UNA volta per invio, non un'impronta del testo.
 * Rimandare due volte «ok» resta due messaggi distinti, con due chiavi diverse;
 * l'unica cosa che una chiave ripetuta puo' significare e' «e' lo stesso invio
 * che ci riprova». Tenerla in memoria a lungo copre una riconnessione lenta,
 * scaderla presto rimetterebbe in gioco il doppione che vogliamo evitare.
 *
 * Vive nel processo, quindi un riavvio la perde: e' un limite accettato, non un
 * difetto nascosto. Il caso che protegge (client che ritenta subito una richiesta
 * caduta) si consuma in secondi, e la finestra dopo un riavvio e' coperta dalla
 * riga utente gia' scritta, che il client rilegge dalla history.
 */
const chatIdempotency = createIdempotencyCache({ ttlMs: 30 * 60_000 });

/**
 * Closure-local helpers from createTopicsRouter that the /api/chat block needs,
 * injected by reference (they keep their own closures, so their transitive deps
 * stay in topics.ts). `browserNavigatedTopics` is shared mutable state — pass
 * the SAME Set instance the marker helper + open-pane route use.
 */
export interface ChatDeps {
  resolveProvider: (topic?: Topic | null) => AIProvider;
  detectLocalhostAutoNav: (content: string, topic: Topic | null) => string;
  bindTopicToProject: (topicId: string, targetDir: string, opts?: { focus?: boolean }) => boolean;
  resolveProjectRef: (ref: string, opts?: { trustRawPaths?: boolean }) => string | null;
  getProjectIdForTopic: (topicId: string) => string | null;
  getWorkspaceProjects: () => string[];
  autoBindProject: (topic: Topic) => void;
  watchSessionForSubagents: (topicId: string, sessionKey: string) => void;
  updateUnreadCount: (topicId: string) => void;
  browserNavigatedTopics: Set<string>;
  WORKSPACE_DIR: string;
}

/**
 * I due ingredienti dello scope di `inline-sent-state`: quale conversazione CLI
 * stiamo servendo, e quante volte è stata compattata. Letture indicizzate su una
 * riga sola — trascurabili accanto al turno di modello che stanno per precedere,
 * e sempre best-effort: un errore qui deve costare una re-iniezione, non un send.
 */
function readClaudeSessionId(ctx: AppContext, sessionKey: string): string | null {
  try {
    const row = ctx.db
      .prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?`)
      .get(sessionKey) as { claude_session_id?: string } | undefined;
    return row?.claude_session_id ?? null;
  } catch {
    return null;
  }
}

function countCompactions(ctx: AppContext, sessionKey: string): number {
  try {
    const row = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM compaction_markers WHERE session_key = ?`)
      .get(sessionKey) as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function createChatRouter(ctx: AppContext, deps: ChatDeps, browserService?: BrowserService): RouteHandler {
  const {
    broadcastToAll, broadcastToTopicSubscribers, db, json, readJSON,
    getTopicBySessionKey, saveSingleTopic, touchTopicActivity,
    appendLocalMessage,
    createPartialMessage, reuseOrCreatePartialForReattach, updateLastMessage, discardIfEmptyTurn, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields,
    startStream, updateStreamContent, updateStreamActivity, endStream, isStreaming,
    findNewMediaFiles, updateLastMessageWithMedia,
  } = ctx;
  const {
    resolveProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef,
    getProjectIdForTopic, getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR,
  } = deps;

  /**
   * Un evento di tool va a chi ha quella topic aperta, non a tutti.
   *
   * I chunk di contenuto e di thinking passavano gia' da
   * `broadcastToTopicSubscribers` (righe 1226, 1255, 2077-2078): gli eventi dei
   * tool erano gli unici rimasti su `broadcastToAll`, e su un turno agentico
   * sono le CENTINAIA di frame piu' grossi del turno — un `stream:tool_result`
   * porta il risultato intero. Ogni finestra aperta su un'altra topic li
   * riceveva tutti per scartarli: il client li instrada per `topicId` e li
   * butta. Su un desktop con tre finestre piu' la PWA in LAN sono tre copie di
   * troppo per frame.
   *
   * Non e' un cambio di semantica ma l'allineamento al resto della famiglia:
   * `clientReceivesTopicDelta` include comunque i client che non hanno ancora
   * dichiarato un insieme aperto, e chi non riceve piu' i tool di una topic non
   * ne riceveva GIA' il testo.
   *
   * Senza `topicId` (sessione non ancora legata a una topic) resta il broadcast
   * a tutti: non c'e' niente su cui instradare.
   */
  const broadcastStreamToTopic = (message: OutboundMessage, topicId: string | undefined): void => {
    if (topicId) broadcastToTopicSubscribers(topicId, message);
    else broadcastToAll(message);
  };

  // Bump the topic's own timestamp on real activity — a new user message
  // (below) OR a completed/errored/timed-out assistant turn (via
  // finalizeTurnActivity). Without the latter, a turn that never round-trips
  // through a fresh POST /api/chat user message (autonomous continuation,
  // dispatched task) left the sidebar's lastActivity — and the project row
  // rolled up from it — frozen mid-conversation.
  //
  // Scrittura MIRATA su `updated_at`, non un upsert della riga intera: `topic`
  // qui è l'oggetto letto quando la richiesta è arrivata, e questo bump scatta
  // alla FINE del turno, anche venti minuti dopo. Riscrivere tutte le colonne
  // da quell'oggetto riportava indietro qualunque cosa il turno avesse cambiato
  // nel frattempo — in particolare `projectPath`, che `open_project` /
  // `create_project` scrivono a metà risposta: la chat si spostava nel progetto
  // e a fine turno si ritrovava fuori, slegata, senza un errore da nessuna
  // parte (card 76b0058b). Il broadcast porta la riga RILETTA, così i client
  // vedono lo stato vero e non la copia vecchia.
  const bumpTopicActivity = (topic: Topic): void => {
    const updatedAt = new Date().toISOString();
    topic.updatedAt = updatedAt;
    const fresh = touchTopicActivity(topic.id, updatedAt);
    if (fresh) broadcastToAll({ type: "topic:updated", topic: fresh });
  };

  // Every turn-finalization site (success / error / soft- or hard-timeout)
  // funnels through here so the activity bump and the unread bump stay in
  // lockstep — a new terminal path can't silently forget to refresh the
  // sidebar's lastActivity and leave the row looking frozen mid-turn.
  const finalizeTurnActivity = (topic: Topic): void => {
    bumpTopicActivity(topic);
    updateUnreadCount(topic.id);
  };

  // Deps for the SDK-passthrough control tools (open/create-project, switch/new-
  // topic). Reuses the SAME closure-local project helpers + AppContext topic
  // ops the Layer-1 endpoints use, so a claude/openai tool call and an MCP tool
  // call land on identical side-effects + broadcasts.
  //
  // `resolveTab` chiude sulle STESSE deps della rotta `GET /api/tabs/resolve`
  // (`lib/tab-resolver-deps.ts`): l'agente via MCP e la chat SDK devono
  // rispondere la stessa cosa sullo stesso link, e il resolver è di sola lettura
  // — non tocca `ui_state`, non riflette niente nella history.
  const tabDeps = tabResolverDeps(ctx, browserService);
  const controlDispatchDeps: ControlDispatchDeps = {
    getTopicById: ctx.getTopicById,
    loadTopics: ctx.loadTopics,
    saveSingleTopic: ctx.saveSingleTopic,
    slugify: ctx.slugify,
    broadcastToAll,
    resolveProjectRef,
    bindTopicToProject,
    workspaceDir: WORKSPACE_DIR,
    resolveTab: (ref) => resolveTabRef(ref, tabDeps),
  };

  return async function chatRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "POST" && pathname === "/api/chat") {
      console.log(`[HTTP] POST /api/chat received`);
      const body = await readJSON(req);
      if (!body) return json({ error: "body required" }, 400);
      const sessionKey = body.sessionKey;

      /**
       * LO STESSO MESSAGGIO NON SI PRENDE DUE VOLTE.
       *
       * Il client aveva una regola sola per sapere se un messaggio era partito:
       * `streamStarted`, che diventa vero quando la `fetch` restituisce la
       * risposta. Se la connessione muore PRIMA — e muore, perché su questa
       * macchina il server si ricarica a ogni salvataggio in `server/` — per lui
       * il server non l'ha mai ricevuto. Ma le due cose che possono essere
       * successe sono opposte e da fuori identiche: (a) siamo morti prima di
       * scrivere la riga, e allora il messaggio è perso e va rispedito;
       * (b) siamo morti dopo, e allora rispedirlo lo duplica.
       *
       * Non potendo distinguerle, il client sceglieva: teneva il messaggio in
       * coda e sperava. Il commento del suo drain lo dice in chiaro — «tenerlo
       * qui significherebbe rispedirlo a un server che potrebbe averlo già
       * preso». Misurato il 2026-08-18: un messaggio scritto durante un reload
       * non è mai arrivato (zero righe, zero turni) e la pagina è rimasta a
       * girare; poco prima, un altro aveva mostrato «Message queued» pur essendo
       * arrivato benissimo.
       *
       * Con una chiave il dubbio sparisce: il client rispedisce SEMPRE, e siamo
       * noi a dire se l'avevamo già preso. La chiave si ricorda solo DOPO che la
       * riga utente è scritta (più sotto), perché è quello il momento in cui il
       * messaggio esiste davvero: se cadiamo prima, la ripetizione deve poter
       * ripartire pulita.
       *
       * Stessa meccanica di `POST /api/terminal/sessions`, stesso modulo.
       */
      const idempotencyKey =
        req.headers.get("x-idempotency-key")
        ?? (typeof body.clientMessageId === "string" && body.clientMessageId.trim() ? body.clientMessageId.trim() : null);
      const idempotencySlot = idempotencyKey ? `${sessionKey} ${idempotencyKey}` : null;
      if (idempotencySlot) {
        const already = chatIdempotency.lookup(idempotencySlot);
        if (already) {
          console.log(`[HTTP] POST /api/chat: ripetizione di ${idempotencyKey} su ${sessionKey} — già preso come ${already}, non lo rifaccio`);
          return json(
            { error: "message already accepted", code: "duplicate_message", messageId: already },
            409,
          );
        }
      }
      // Turno guidato dalla board (runHeadlessTurn), non una chat umana: si
      // propaga sul `stream:end` di completamento così la push di fine risposta
      // lo esclude (vedi server/push-triggers.ts). Decine di turni d'agente = spam.
      const dispatched = body.dispatched === true;
      // O(1) UNIQUE-index lookup — replaces a full topics scan per chat send.
      const matchedTopic = getTopicBySessionKey(sessionKey);
      // Reset browser navigate tracking for this topic so new URLs can trigger
      if (matchedTopic) browserNavigatedTopics.delete(matchedTopic.id);
      // Il piano ha UNA leva sola, ed è l'autonomia della chat.
      //
      // C'erano due modi di chiedere un piano, e facevano cose diverse: un
      // interruttore nel composer che iniettava questo blocco di prompt — una
      // RICHIESTA, che il modello poteva ignorare, tenuta in localStorage e mai
      // sincronizzata — e il livello di autonomia `ask`, che passa
      // `--permission-mode plan` alla CLI, dove i file non si possono proprio
      // scrivere. Potevano contraddirsi a vicenda sullo stesso turno.
      //
      // L'interruttore è sparito; il blocco di prompt no, perché è quello che
      // dà al piano il formato che l'app poi sa leggere («## Plan / ## Summary»,
      // planModeContent). Adesso lo accende il livello di autonomia. Stessa
      // forma del Fast Mode qui sotto: flag per-turno OPPURE preferenza del
      // topic. Il flag resta accettato per i chiamanti headless (dispatcher,
      // bridge), che non hanno un composer da cui premere niente.
      const planMode = planModeFor({ turnFlag: body.planMode === true, autonomy: matchedTopic?.autonomyLevel });
      // Fast Mode: per-turn flag OR per-topic persisted preference. Either is
      // enough to opt in. Resolution into an actual model id happens after
      // provider resolution below (the mapping is provider-dependent).
      const fastModeRequested = body.fastMode === true;
      const messages = body.messages;
      /**
       * `reattach` NON porta un messaggio: adotta il turno che sta già girando
       * nel broker dopo un riavvio del server (`runHeadlessReattach` in
       * server.ts, `reattachSurvivingChatTurns`). Pretendere un `messages` non
       * vuoto lo respingeva con 400 — e il chiamante drenava quel JSON come se
       * fosse SSE, non trovava `[DONE]`, e riportava `end_turn`: un turno mai
       * iniziato, dichiarato finito bene. Tutta la macchina di reattach qui
       * sotto (`reuseOrCreatePartialForReattach`, il ramo `reattachFn`) era
       * quindi irraggiungibile.
       */
      const isReattach = body.mode === "reattach";
      /**
       * `woken`: il turno che la CLI ha aperto DA SOLA — un `Monitor` che
       * consegna il suo evento (vedi `claude/woken-turn.ts`).
       *
       * È un riattacco a tutti gli effetti: non porta un messaggio, adotta un
       * turno già in corso, e tutto ciò che viene dopo — riga parziale, SSE,
       * finalizzazione, usage, broadcast — è identico. Cambia solo COME ci si
       * attacca, quindi la distinzione vive in DUE punti (la scelta di `drive` e
       * la guardia di capacità) e ovunque altro conta `adottaTurnoVivo`. Una
       * route separata sarebbe una seconda copia di novecento righe di
       * finalizzazione: due posti dove sbagliare la stessa cosa.
       */
      const isWoken = body.mode === "woken";
      /** Le due modalità che ADOTTANO un turno invece di iniziarne uno. */
      const adottaTurnoVivo = isReattach || isWoken;

      if (!messages || !Array.isArray(messages) || (messages.length === 0 && !adottaTurnoVivo)) {
        return json({ error: "messages array required" }, 400);
      }

      /**
       * UN TURNO PER SESSIONE.
       *
       * Questa era l'unica route mutante di sessione senza cancello: `edit.ts`
       * e `branches.ts` rispondono già 409 su stream attivo, la chat no. Due
       * POST sulla stessa sessione (due finestre sullo stesso topic, o l'umano
       * che scrive mentre un task dispatchato sta lavorando nella sua topic)
       * finivano entrambe in `startStream`, che SOVRASCRIVE la voce di
       * `activeStreams`: il `finally` del primo turno chiudeva il SECONDO, con
       * il messageId sbagliato. Costo doppio, e per un agente anche side effect
       * doppi — scrive gli stessi file due volte.
       *
       * Il 409 è il canale di STEERING della chat, ed è lo stesso patto che la
       * board ha già per i task (`dispatcher.resume` bufferizza il commento
       * umano e lo consegna al confine del turno): il client rimette il
       * messaggio IN TESTA alla coda (`requeueFront`/`unshiftTurn` in
       * `state/chatQueue.ts`, ramo `is409` di `useChat`) e lo spedisce appena
       * il turno in volo finisce. Prima quel ramo del client era codice morto —
       * nessun 409 su /api/chat esisteva in tutto il server.
       *
       * Non blocca per sempre: `isStreaming` considera morto uno stream fermo
       * da oltre 3 minuti, e lo sweeper `[StaleStream]` lo finalizza.
       * `reattach` è esente per costruzione — adottare il turno vivo È il suo
       * mestiere, e vale identico per `woken` (`adottaTurnoVivo`).
       */
      if (!adottaTurnoVivo) {
        const live = isStreaming(sessionKey);
        if (live) {
          console.log(`[HTTP] POST /api/chat 409 — turno già in volo su ${sessionKey} (messageId ${live.messageId})`);
          return json(
            { error: "a response is already streaming for this session", code: "stream_in_flight", messageId: live.messageId },
            409,
          );
        }
      }

      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg?.role === "user" && lastUserMsg?.content) {
        // L'AUTORE si stampa QUI, ed è l'unico posto in cui un prompt umano
        // entra nel database: `appendLocalMessage` da qualunque altro
        // chiamante (import di transcript, sotto-agenti) non ha un'identità di
        // richiesta da cui ricavarlo, e quelle righe restano senza autore —
        // che è la risposta giusta, non una mancanza.
        const storedUserMsg = appendLocalMessage(
          sessionKey, "user", lastUserMsg.content,
          autoreDaIdentita(ctx.db as never, ctx.requestIdentity?.(req) ?? null),
        );
        // ADESSO il messaggio esiste, e da adesso una ripetizione è un doppione.
        // Non un istante prima: la riga è la prova, e finché non c'è, ripetere è
        // l'unica cosa giusta da fare.
        if (idempotencySlot) chatIdempotency.remember(idempotencySlot, storedUserMsg.id);
        if (matchedTopic) {
          broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "user", messageId: storedUserMsg.id, content: lastUserMsg.content, preview: lastUserMsg.content.slice(0, 100) });
          // Bump the topic's own timestamp on every real message, not just
          // metadata edits (rename/archive/autoname/…). Without this the
          // sidebar's lastActivity (topicTimestamp) freezes at whatever
          // administrative touch happened last — a chat can be actively in use
          // for hours and still show its row from a day-old rename.
          bumpTopicActivity(matchedTopic);
        }

        // Handle board chat control commands (/ prefixed)
        if (lastUserMsg.content.trim().startsWith("/")) {
          const cmdText = lastUserMsg.content.trim();
          const cmdMatch = cmdText.match(/^\/(\w+)\s*(.*)/);
          if (cmdMatch) {
            const [, cmd, rest] = cmdMatch;
            let response: string | null = null;

            try {
              if (cmd === "project") {
                const subMatch = rest.match(/^(\w+)\s*(.*)/);
                const sub = subMatch ? subMatch[1] : "";
                const arg = subMatch ? subMatch[2].trim() : "";

                if (sub === "create" && arg) {
                  // Sanitize name: only alphanumeric, hyphens, underscores
                  const safeName = arg.replace(/[^a-zA-Z0-9_-]/g, "");
                  if (!safeName) {
                    response = `Invalid project name. Use alphanumeric characters, hyphens, and underscores.`;
                  } else {
                    const targetDir = join(WORKSPACE_DIR, safeName);
                    if (existsSync(targetDir)) {
                      response = `Project **${safeName}** already exists at \`${targetDir}\`. Use \`/project open ${safeName}\` to bind it.`;
                    } else {
                      mkdirSync(targetDir, { recursive: true });
                      writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
                      // Bind to current topic + open the project window.
                      if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
                      response = `Created project **${safeName}** at \`${targetDir}\` and bound to this topic.`;
                    }
                  }
                } else if (sub === "open" && arg) {
                  // Resolve against the user's real Topics projects, not just the workspace.
                  // Explicit local user command → raw absolute/~ paths are trusted.
                  const targetDir = resolveProjectRef(arg, { trustRawPaths: true });
                  if (!targetDir) {
                    response = `Project not found: \`${arg}\``;
                  } else {
                    const projectName = targetDir.split("/").pop() || arg;
                    if (matchedTopic) bindTopicToProject(matchedTopic.id, targetDir, { focus: true });
                    response = `Opened project **${projectName}**. It is now bound to this topic.`;
                  }
                } else {
                  // No subcommand: show current + list
                  const lines: string[] = [];
                  if (matchedTopic?.projectPath) {
                    lines.push(`**Current project:** \`${matchedTopic.projectPath}\``);
                  } else {
                    lines.push("No project bound to this topic.");
                  }
                  const wsProjects = getWorkspaceProjects();
                  if (wsProjects.length > 0) {
                    lines.push("", "**Workspace projects:**");
                    for (const p of wsProjects) {
                      const name = p.split("/").pop();
                      lines.push(`- \`${name}\` · ${p}`);
                    }
                  }
                  response = lines.join("\n");
                }
              }
            } catch (err: any) {
              console.warn("[ChatCommand] Error handling command:", err);
              response = `Command error: ${err.message}`;
            }

            // If a command produced a response, inject it as a synthetic assistant message
            if (response) {
              const storedCmdMsg = appendLocalMessage(sessionKey, "assistant", response);
              if (matchedTopic) {
                broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedCmdMsg.id, content: response, preview: response.slice(0, 100) });
              }
              // Return the response as an SSE payload so the client displays it
              const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(response)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
              return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
            }
          }
        }
      }

      // ─── Canonical context envelope ─────────────────────────────────
      // Replaces the inline finalMessages assembly that used to live here
      // (≈140 lines of category-aware splice() calls). The envelope is the
      // single source of truth for what the model will see — both the
      // `streamEditResponse` send path AND the inspector preview consume
      // it via `assembleTopicContext`.
      //
      // Provider-specific shaping (history vs inline preamble) happens
      // later via `adaptEnvelope`, after we resolve the actual provider.
      // For now we use a placeholder strategy; the *system block contents*
      // and *history* are strategy-independent so the FS reads happen once.
      //
      // `includeLastUserInHistory: false` — the new user turn (just persisted
      // by appendLocalMessage above) is passed separately via
      // `payload.userContent`, not duplicated inside `payload.history`.
      const envelope: ContextEnvelope = matchedTopic
        ? assembleTopicContext(ctx, {
            sessionKey,
            providerName: "(pending)",
            providerStrategy: "history-aware",
            userMessageOverride: { content: lastUserMsg?.content ?? "", messageId: lastUserMsg?.id },
            includeLastUserInHistory: false,
            planMode,
            // Per-turn flag OR topic-persisted preference — either opts in.
            // Mirrors the resolution logic for `fastModeActive` further down
            // (the route layer is the single authority on whether fast is on).
            fastMode: body.fastMode === true || matchedTopic.fastMode === true,
            // Lean envelope on a dispatcher resume/continuation (contextMode
            // "lean"), but ONLY when the session already has stored turns — a
            // resume onto an empty/lost conversation must re-ground with the
            // full envelope, not a bare role prompt.
            //
            // La soglia è `> 1`, non `> 0`, e non è un dettaglio: il turno
            // utente di QUESTA richiesta è già stato scritto in DB poco sopra
            // (`appendLocalMessage`, ~riga 279), quindi con `> 0` la
            // condizione era VERA sempre — anche su una conversazione persa,
            // che è esattamente il caso che questo guard doveva proteggere.
            // Il ramo «re-ground con l'inviluppo pieno» non è mai stato preso.
            //
            // E si conta, non si carica: `loadLocalMessages` ricostruisce
            // tutto il ramo attivo con blocks e tool_calls riparsati da JSON
            // (25 ms sulle sessioni agentiche grosse) — e `assembleTopicContext`
            // qui sotto lo rifà comunque per conto suo, quindi erano due
            // passate complete per rispondere a una domanda da COUNT.
            leanContext:
              body.contextMode === "lean" &&
              ((ctx.db
                .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?")
                .get(sessionKey) as { n: number } | undefined)?.n ?? 0) > 1,
          })
        : {
            // No topic bound to this sessionKey — emit a degenerate envelope
            // so the legacy HTTP fallback path still has *something* to
            // serialise. Mirrors the pre-refactor behaviour where
            // `if (matchedTopic)` skipped all the system block injection.
            topicId: "",
            sessionKey,
            providerName: "(pending)",
            providerStrategy: "history-aware",
            systemBlocks: [],
            history: messages
              .filter((m: any) => m.role === "user" || m.role === "assistant")
              .slice(0, -1)
              .map((m: any) => ({ role: m.role, content: m.content })),
            userMessage: { content: lastUserMsg?.content ?? "" },
            diagnostics: {
              totalTokens: 0, budgetLimit: DEFAULT_CONTEXT_WINDOW, budgetPercent: 0,
              droppedHistoryTurns: 0, historyEntries: [],
              warnings: [], assembledAt: Date.now(),
            },
          };

      // Build the legacy `finalMessages: { role; content }[]` array for the
      // HTTP fallback path further down. Composed from the envelope so the
      // shape matches what providers used to receive (system messages
      // followed by the full user/assistant transcript).
      const composedSystemMessages = composeSystemMessages(envelope.systemBlocks);
      const finalMessages: ChatMessage[] = [
        ...composedSystemMessages.map((m) => ({ role: m.role, content: m.content })),
        ...envelope.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: envelope.userMessage.content },
      ];

      // ─── Resolve provider for this topic (with optional per-message override) ───
      let topicProvider: AIProvider;
      const overrideProvider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
      if (overrideProvider) {
        try {
          topicProvider = getProvider(overrideProvider);
        } catch (err: any) {
          console.warn(`[Chat] Override provider "${overrideProvider}" not available, falling back: ${err.message}`);
          topicProvider = resolveProvider(matchedTopic);
        }
      } else {
        topicProvider = resolveProvider(matchedTopic);
      }

      /**
       * UN RIATTACCO NON SCEGLIE IL PROVIDER: LO EREDITA.
       *
       * `resolveProvider` risponde alla domanda «con chi vorrebbe parlare
       * questa topic?». Un riattacco fa una domanda diversa — «chi possiede il
       * turno che sta GIÀ girando?» — e le due risposte possono divergere: il
       * turno vivo è un figlio della CLI (`claude-code`, store del broker,
       * `claude_code_sessions`), mentre la preferenza cade sul default della
       * macchina, che qui è il runtime nativo (`topics`,
       * providers/native/provider.ts:89, DEFAULT_AGENT_RUNTIME in shared/types.ts).
       *
       * Il provider nativo non ha `reattach`, e più sotto il ternario cadeva su
       * `sendChat` con `userContent` = solo il preambolo `<context>` e NESSUNA
       * domanda (`messages: []` è il formato del riattacco, riga ~267). Il
       * risultato non era un degrado: era un turno FABBRICATO, pagato all'API
       * Anthropic, che rispondeva «Ciao! Come posso aiutarti con <nome del
       * topic>?» e si sedeva in chat al posto della risposta vera. Misurato il
       * 2026-08-18 su topic:9fe7a291: nove saluti, uno per riavvio del server,
       * mentre il turno CLI vero girava indisturbato e la sua risposta non
       * arrivava mai in `messages`.
       *
       * Due cose lo rendevano possibile insieme, e valgono come promemoria:
       * `isReattach` salta anche il cancello 409 «un turno per sessione» (riga
       * ~296, ed è giusto: adottare il turno vivo è il suo mestiere), quindi il
       * turno fantasma partiva su una sessione che ne aveva già uno in volo.
       *
       * Qui la regola è secca: chi non sa riattaccarsi non riattacca, e non
       * manda niente al suo posto. Il rifiuto arriva PRIMA della riga parziale,
       * dello stream e di qualunque chiamata al modello — non lascia traccia in
       * chat. 501 e non 409: un 409 `rejectedTurn` (server.ts:711) lo tradurrebbe
       * in «stream già in volo», che è un'altra storia; questo è un guasto di
       * cablaggio e deve leggersi come tale nel log del chiamante.
       */
      if (isReattach && typeof (topicProvider as unknown as { reattach?: unknown }).reattach !== "function") {
        console.warn(
          `[Chat] riattacco RIFIUTATO su ${sessionKey}: il provider "${topicProvider.name}" non sa riattaccarsi. ` +
          `Chi chiama un reattach deve dichiarare il provider che POSSIEDE il turno vivo (body.provider), ` +
          `altrimenti si cade sul default della macchina. Nessun messaggio inviato.`,
        );
        return json(
          { error: `provider "${topicProvider.name}" cannot reattach`, code: "reattach_unsupported", provider: topicProvider.name },
          501,
        );
      }
      /**
       * Stessa regola per il turno spontaneo, e stessa ragione: chi non sa
       * adottarlo non deve MANDARE qualcosa al suo posto (sarebbe il turno
       * fabbricato descritto sopra, per giunta addosso a uno che sta parlando).
       * Non può capitare da solo — la sveglia è di claude-code e di nessun altro
       * — ma chiude la via a chi chiamasse questa route a mano.
       */
      if (isWoken && typeof (topicProvider as unknown as { adoptWokenTurn?: unknown }).adoptWokenTurn !== "function") {
        console.warn(
          `[Chat] risveglio RIFIUTATO su ${sessionKey}: il provider "${topicProvider.name}" non sa adottare un turno spontaneo.`,
        );
        return json(
          { error: `provider "${topicProvider.name}" cannot adopt a woken turn`, code: "woken_unsupported", provider: topicProvider.name },
          501,
        );
      }

      /**
       * UNA CONVERSAZIONE TIENE IL CERVELLO CON CUI È NATA.
       *
       * `topics.provider` vuoto non vuol dire «qualunque»: vuol dire «non
       * l'abbiamo mai scritto». E siccome `resolveProvider` cade sul default
       * della MACCHINA, e il default si ricalcola a ogni boot
       * (`recomputeDefault`, providers/index.ts — dipende da quali provider
       * risultano `connected` in quel momento), una chat a metà può cambiare
       * runtime da sola, senza che nessuno abbia toccato niente.
       *
       * Non è teorico. Il 2026-08-18 su topic:9fe7a291: il primo turno gira su
       * `claude-code` (JSONL, store del broker, riga in `claude_code_sessions`,
       * modello claude-opus-5[1m]) e produce una risposta lunga e documentata;
       * venti minuti e una ventina di riavvii dopo, il runtime nativo `topics`
       * risulta connesso, si prende il default, e i messaggi successivi
       * dell'utente finiscono su un provider la cui memoria è una Map in RAM
       * azzerata a ogni riavvio. Alla domanda «fammi il report di fine
       * giornata» ha risposto «Non ho trovato messaggi nel topic "New Chat"»:
       * non era un guasto del modello, era un altro modello, senza la
       * conversazione.
       *
       * Quindi il primo turno vero SCRIVE la scelta. Da lì la chat è stabile
       * per costruzione, e resta modificabile a mano: il picker per-topic
       * (`ProviderModelPicker` → PATCH /api/topics/:id) è l'unica cosa che
       * cambia questo campo. Un riattacco non pinna niente — non è una scelta,
       * è un'eredità.
       */
      if (!adottaTurnoVivo && matchedTopic && !matchedTopic.provider && topicProvider.name) {
        matchedTopic.provider = topicProvider.name;
        saveSingleTopic(matchedTopic);
        broadcastToAll({ type: "topic:updated", topic: matchedTopic });
        console.log(`[Chat] ${sessionKey}: runtime fissato su "${topicProvider.name}" al primo turno (era il default della macchina, che si ricalcola a ogni boot)`);
      }

      // Per-message override wins; otherwise the topic's persisted model is
      // used (set by the picker via PUT /api/topics/:id and broadcast as
      // topic:updated). Falls through to the provider default when both unset.
      const requestedModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : (typeof matchedTopic?.model === "string" && matchedTopic.model.trim() ? matchedTopic.model.trim() : undefined);

      // Drop the override if the resolved provider no longer offers that
      // model — e.g. the user picked `gpt-5-codex` two months ago, then ChatGPT
      // auth changed plan and the cache no longer lists it. Without this check
      // the model name is forwarded to the CLI which fails with "exit 1" and
      // surfaces as a "Codex error" stub. If we can't resolve a model list
      // (manager not warmed yet, or provider has no listModels), trust the
      // override — the previous behavior. The validation is a guard, not a
      // contract.
      let overrideModel: string | undefined = requestedModel;
      if (requestedModel) {
        const snap = getSnapshotManager().getSnapshot();
        const entry = snap.providers.find(p => p.name === topicProvider.name);
        if (entry && entry.models.length > 0 && !entry.models.includes(requestedModel)) {
          console.warn(
            `[Chat] Dropping stale model override "${requestedModel}" — not offered by provider "${topicProvider.name}". ` +
            `Available: [${entry.models.slice(0, 5).join(", ")}${entry.models.length > 5 ? ", …" : ""}]`,
          );
          overrideModel = undefined;
        }
      }

      // ─── Fast Mode ────────────────────────────────────────────────────
      //
      // NON è più uno scambio di modello. Lo era: con il Fast acceso questa
      // route sostituiva il modello con quello «veloce» del provider (haiku),
      // che è l'opposto di ciò che la fast mode di Claude Code fa — stesso
      // modello (Opus), uscita più rapida, prezzo diverso. Un toggle che sotto
      // lo stesso nome faceva un'altra cosa, e in silenzio: chi lo accendeva
      // per andare più veloce si ritrovava un modello più debole.
      //
      // Ora la richiesta viaggia COME richiesta fino al provider, che la gira
      // alla CLI (`/fast on`) soltanto quando la CLI ha dichiarato di poterla
      // servire. Oggi non può: nelle chat giriamo `--print --input-format
      // stream-json`, cioè la via Agent SDK, e la CLI risponde
      // `fast_mode_disabled_reason: sdk_opt_in_required`. Il composer lo dice,
      // invece di far finta di aver fatto qualcosa — vedi providers/fast-mode.ts.
      //
      // Due opt-in, come prima: il flag per-turno del composer e la preferenza
      // persistita sulla topic.
      const fastModeActive = fastModeRequested || matchedTopic?.fastMode === true;

      // ─── Streaming ───
      const useWS = topicProvider.capabilities.has('streaming') && topicProvider.connected;

      // Il modello che servirà DAVVERO questo turno, suffisso compreso.
      //
      // Senza pin sul topic `overrideModel` è `undefined`, e per l'anello del
      // contesto quello voleva dire «non lo so»: restava il nome NUDO che la
      // CLI riporta nei suoi eventi (`claude-opus-5`, mai `[1m]`), cioè 200k di
      // denominatore su una chat che gira a un milione. L'anello segnava pieno
      // a un quinto del vero. Il default del provider è il nome giusto: è lo
      // stesso che `spawnPersistentProcess` passa alla CLI.
      const spawnedModel = overrideModel ?? topicProvider.defaultModel?.() ?? undefined;
      console.log(`[Chat] useWS=${useWS}, sessionKey=${sessionKey}`);
      // La riga assistente di QUESTO turno, raggiungibile anche dal `catch` in
      // fondo: se schiantiamo dopo averla aperta, va chiusa lì — vedi
      // crashedTurnNotice.ts. Dichiarata fuori dal `try` apposta.
      let crashedPartialId: string | null = null;
      /**
       * La riga com'è ADESSO, per decidere se un cartello d'errore può scriverci
       * sopra. Le tre colonne servono tutte: `content` da solo direbbe «vuota»
       * su una riga che a schermo è un turno intero, perché la prosa è
       * persistita anche in `blocks` ed è da lì che il client la rende.
       */
      const readRowForNotice = (rowId: string | null): CrashedTurnRow | null => {
        if (!rowId) return null;
        try {
          const r = db.prepare("SELECT content, tool_calls, blocks FROM messages WHERE id = ?")
            .get(rowId) as { content?: string; tool_calls?: string | null; blocks?: string | null } | undefined;
          return r ? { content: r.content ?? "", toolCallsJson: decodeCol(r.tool_calls), blocksJson: decodeCol(r.blocks) } : null;
        } catch { return null; }
      };
      /**
       * I blocchi della riga con in fondo il verdetto. `undefined` se non c'è
       * niente da scrivere (riga illeggibile e nessun blocco): passare un array
       * vuoto a `updateLastMessage` cancellerebbe la colonna.
       */
      const appendErrorBlock = (row: CrashedTurnRow | null, text: string): ContentBlock[] | undefined => {
        if (!row?.blocksJson) return [{ kind: "error", text }];
        try {
          const parsed = JSON.parse(decodeCol(row.blocksJson) ?? "null");
          if (Array.isArray(parsed)) return [...(parsed as ContentBlock[]), { kind: "error", text }];
        } catch { /* vedi sotto */ }
        // Colonna illeggibile: NON si riscrive. Rimpiazzarla col solo verdetto
        // butterebbe via un turno intero per non saperlo leggere — è la stessa
        // prudenza di `rowCarriesWork`. Il `undefined` fa scattare il COALESCE
        // in `updateMessage`, che lascia la colonna dov'è.
        return undefined;
      };
      /**
       * Chiude il turno quando non si è potuto GUIDARE: `sendChat` ha rigettato,
       * o il montaggio è morto prima di partire.
       *
       * Le due vie che finiscono qui scrivevano `content: errorMsg` senza
       * guardare la riga. Il commento che le accompagnava — «il turno non è mai
       * arrivato alla CLI» — descriveva l'unico caso per cui erano state
       * scritte, ma non è l'unico che ci arriva: `sendChat` resta pendente per
       * TUTTO il turno, quindi un rigetto tardivo cadeva nello stesso ramo e
       * cancellava lavoro vero.
       *
       * Ora il cartello si scrive solo su una riga che non porta niente. Se
       * porta qualcosa, quel qualcosa resta e l'errore viaggia comunque sul filo
       * e nel log: non si perde, e non si mangia il turno.
       *
       * Torna il testo da mandare sull'SSE — sempre, anche quando la riga non è
       * stata toccata: quello è il canale che chiude il client, e lasciarlo muto
       * lo terrebbe appeso.
       */
      const closeTurnWithFailure = (err: unknown, rowId: string): string => {
        const row = readRowForNotice(rowId);
        const notice = sendFailureNotice(row, err);
        const verdetto = `Non sono riuscito ad avviare il turno: ${shortErrorDetail(err)}`;
        // `updateLastMessage` scrive sull'ULTIMA riga della sessione, mentre qui
        // la riga si legge per ID. Di norma sono la stessa — il cancello a 409
        // impedisce un secondo turno mentre uno è in volo — ma "di norma" non è
        // "sempre": se nel frattempo ne fosse nata una più recente, scriverci
        // sopra il nostro esito metterebbe i blocchi del NOSTRO turno dentro
        // quello di un altro. Meglio saperlo che scoprirlo da una riga sbagliata.
        const ultima = (() => {
          try {
            return (db.prepare("SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
              .get(sessionKey) as { id?: string } | undefined)?.id;
          } catch { return undefined; }
        })();
        if (ultima === rowId) {
          // Il verdetto va nei blocchi in OGNI caso — anche, e soprattutto,
          // quando la riga porta già lavoro e il cartello non può toccare
          // `content`. È lì che sta la differenza fra «un turno giallo senza
          // spiegazione» e un errore che si legge.
          const conVerdetto = appendErrorBlock(row, verdetto);
          if (notice) {
            updateLastMessage(sessionKey, { content: notice, blocks: conVerdetto, partial: undefined, streamedAt: undefined });
          } else {
            // La riga si tiene il suo contenuto; cade solo il flag che la
            // dichiara ancora in volo, o il setaccio di boot la crederebbe viva.
            updateLastMessage(sessionKey, { blocks: conVerdetto, partial: undefined, streamedAt: undefined });
            console.warn(`[StreamWS] ${sessionKey}: turno fallito su una riga che porta già lavoro — contenuto preservato, errore aggiunto come blocco`);
          }
        } else {
          // Non è più l'ultima: si chiude solo la NOSTRA, per id, e non si tocca
          // il turno che è subentrato.
          try { db.run("UPDATE messages SET partial = 0 WHERE id = ?", [rowId]); } catch { /* best effort */ }
          console.warn(`[StreamWS] ${sessionKey}: la riga ${rowId} non è più l'ultima (${ultima ?? "nessuna"}) — chiusa per id, esito non riscritto`);
        }
        const wire = notice ?? `⚠️ ${verdetto}`;
        if (matchedTopic) {
          broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: wire });
          broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: rowId });
          finalizeTurnActivity(matchedTopic);
        }
        return wire;
      };
      // Dichiarato FUORI dal try apposta: anche il `catch` in fondo deve poterlo
      // chiudere. Chiuso non era, e il conto lo pagava un turno già finito —
      // un guasto sincrono nel montaggio finalizzava la riga, ma i timer del
      // watchdog restavano armati e due minuti dopo `handleGraceExpiry` la
      // riscriveva sopra con «Response timed out», cancellando il vero motivo.
      let streamState: "streaming" | "soft-timed-out" | "finalized" = "streaming";
      if (useWS) {
        // === WS-based chat: sends via chat.send, receives tool + text events ===
        try {
          const requestStartMs = Date.now();
          // L'inizio del TURNO — di norma è questo istante, ma su una
          // riadozione diventa l'ora di nascita della riga che stiamo
          // riprendendo (vedi sotto). `requestStartMs` resta l'inizio di
          // QUESTA gamba HTTP, che serve ad altro (i media nuovi, le durate
          // degli eventi).
          let turnStartMs = requestStartMs;
          let fullContent = "";
          let fullThinking = "";
          // Carry-over tail for the localhost auto-nav scan: instead of
          // re-scanning the whole accumulated fullContent every delta (O(n²) over
          // a stream), we scan only `carry + newDelta` where `carry` holds the
          // last few chars of what we already scanned — enough to catch a
          // `localhost:PORT` URL split across two chunks (max ~22 chars).
          let localhostScanCarry = "";
          // Cumulative marker-stripped content that has already been broadcast
          // to clients. Delta to broadcast on each chunk =
          //   currentMarkerStrippedFullContent - lastBroadcastClean
          // This closes the chunk-split + post-marker-tail leak (delta carrying
          // `…}} now check it out` after the close arrives) that pure regex
          // strip on `newText` cannot. See CLOSED_MARKER_REGEX comment above.
          let lastBroadcastClean = "";
          let chunkCount = 0;
          let lastSaveChunk = 0;
          const SAVE_INTERVAL = 10;
          const trackedToolCallIds: string[] = [];
          // Il tempo passato fermi su una domanda: si apre in `onUserInputRequired`,
          // si chiude quando quel tool consegna il risultato, e alla fine si
          // sottrae da `latencyMs`. Senza, la durata scritta sotto il messaggio è
          // il tempo che ci ha messo una persona a rispondere. Vedi lib/human-wait.ts.
          const humanWait = createHumanWaitLedger();
          // Chronological content timeline. Each event from the provider is
          // appended in arrival order; consecutive same-kind text/thinking
          // deltas grow the trailing block, while tool calls always start a
          // new block. Persisted on finalize so reload preserves ordering.
          // See `server/types.ts:ContentBlock` — same shape lives on
          // `StoredMessage.blocks` and (mirror-typed) on the client.
          const blocks: ContentBlock[] = [];
          const appendTextBlock = (delta: string) => {
            if (!delta) return;
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "text") last.text += delta;
            else blocks.push({ kind: "text", text: delta });
          };
          const appendThinkingBlock = (delta: string) => {
            if (!delta) return;
            const last = blocks[blocks.length - 1];
            if (last && last.kind === "thinking") last.text += delta;
            else blocks.push({ kind: "thinking", text: delta });
          };
          /**
           * L'unica porta da cui il CORPO del turno finisce sulla riga —
           * salvataggio periodico del testo e scatti dei tool passano di qui.
           *
           * Dentro una RIADOZIONE applica la regola di `reattachMerge.ts` a
           * OGNI scrittura, non solo all'ultima: quello che il replay non ha
           * ancora ri-emesso resta quello di prima. Serve perché la finestra
           * pericolosa è lunga quanto il replay, non quanto il finalize — un
           * riavvio (o un guasto) preso nel mezzo lasciava la riga con la metà
           * di quello che c'era. Fuori da una riadozione è la scrittura di
           * sempre, senza costi aggiunti.
           *
           * `withText` distingue le due chiamate: il salvataggio periodico
           * porta testo + blocchi, quello dopo un evento di tool solo i blocchi.
           */
          const persistTurnBody = (withText: boolean) => {
            const blocchi = blocks.length > 0 ? blocks : undefined;
            if (!adottaTurnoVivo || !reattachSnapshot) {
              updateLastMessage(sessionKey, withText
                ? { content: fullContent, thinking: fullThinking || undefined, blocks: blocchi }
                : { blocks: blocchi });
              return;
            }
            const merged = mergeReattachedRow(reattachSnapshot, {
              content: fullContent,
              thinking: fullThinking || undefined,
              trackedTools: trackedToolCallIds.length,
              blocks,
            }, "progress");
            updateLastMessage(sessionKey, {
              content: merged.content,
              thinking: merged.thinking,
              blocks: (merged.blocks as ContentBlock[] | undefined) ?? blocchi,
            });
          };
          // Persist `blocks` immediately on every tool lifecycle event (start,
          // result, abort). Without this, mid-stream reload misses tool calls:
          // `addToolCallToLastMessage` writes the legacy `tool_calls` column
          // synchronously but `blocks` only persists every SAVE_INTERVAL=10
          // text chunks. The renderer prefers `blocks` when present, so any
          // reload between text saves shows stale rows. This helper closes
          // that race — the cost is one extra UPDATE per tool event, which is
          // small relative to the model's tool-call cadence.
          const persistBlocks = () => persistTurnBody(false);
          const appendToolBlock = (tc: ToolCall) => {
            blocks.push({ kind: "tool", toolCall: tc });
            persistBlocks();
          };
          const updateBlockTool = (id: string, patch: Partial<ToolCall>) => {
            for (let i = 0; i < blocks.length; i++) {
              const b = blocks[i];
              if (b.kind === "tool" && b.toolCall.id === id) {
                // Replace the tool block with a fresh object holding a fresh
                // toolCall ref. Mutating in place looks tempting but breaks
                // any client-side React.memo that uses shallow prop equality
                // when we serialize the array — the toolCall ref is what
                // ToolCallRow keys off of in the legacy bucket too.
                blocks[i] = {
                  kind: "tool",
                  toolCall: { ...b.toolCall, ...patch },
                };
                persistBlocks();
                return;
              }
            }
          };
          // Captured at stream-end if the provider's final message includes
          // usage (claude-code SDK does; codex turn.completed will too).
          // finalizeStream() reads these and persists them on the message so
          // the UI footer can render `<duration>s · <tokens> · $<cost>`.
          let usagePromptTokens: number | undefined;
          let usageCompletionTokens: number | undefined;
          let costCents: number | undefined;
          // Il MODELLO del turno, salvato accanto al costo che ha determinato.
          // Qui e' l'unico punto in cui e' noto: piu' avanti resta solo il numero,
          // e un numero senza la tariffa che lo ha prodotto non e' correggibile
          // (vedi la bonifica 077, che ha dovuto dedurre il prezzo a ritroso).
          let usageModel: string | undefined;
          // Lo SCORPORO della cache, che finora esisteva solo dentro il calcolo del
          // prezzo e veniva buttato. In un turno agentico lungo la cache riletta è
          // la voce schiacciante — lo stesso prompt riletto a ogni chiamata al
          // modello arriva a milioni di token — quindi il totale da solo non
          // insegna niente: dice quanto è costato, non cosa l'ha reso costoso.
          //
          // Quote DISGIUNTE, come in usage/pricing.ts: `cacheCreationTokens` NON
          // include `cacheCreation1hTokens`. Sommarle sarebbe contarle due volte.
          let cacheReadTokens: number | undefined;
          let cacheCreationTokens: number | undefined;
          let cacheCreation1hTokens: number | undefined;
          // Il consumo del turno MENTRE cresce, chiamata per chiamata. Distinto
          // dai tre di sopra, che sono il consuntivo che arriva col `result`:
          // questo serve a far vedere qualcosa muoversi durante un turno agentico
          // lungo, dove prima non si vedeva niente fino alla fine.
          let live = emptyTurnUsage();
          let liveModel: string | undefined;
          // Set when a compaction boundary lands mid-turn, so onDone knows this
          // turn's `prompt_tokens` (the compacted context that was sent) is the
          // post-compaction size to backfill onto the just-created marker.
          let compactedThisTurn = false;
          // First per-call context size seen AFTER a compaction boundary — that
          // single measurement IS the post-compaction context. Latched so later
          // calls in the same turn (which grow again as work resumes) can't
          // overwrite it. See onContextSize below.
          let postCompactionFilled = false;
          // Last context size broadcast for the ring. `onContextSize` fires once
          // per model call, so a turn with thirty tool calls would otherwise
          // write the same row and push the same event thirty times.
          let lastContextUsed = -1;
          // Disfa la marcatura ottimistica del preambolo inline.
          //
          // Dichiarato QUI, prima dello stream handler, perché è `onError` a dover
          // chiamarlo: `sendChat` di claude-code non rigetta su nessun fallimento di
          // turno — TIMEOUT, RATE_LIMIT, PROCESS_DEAD e il doppio SESSION_RESET
          // chiamano tutti `handler.onError` e poi fanno `return { runId }`. Il
          // rollback che stava solo nel `.catch` di `drive` era quindi codice morto
          // per l'intera classe di errori per cui era stato scritto.
          //
          // Idempotente: `onError` e il `.catch` possono scattare entrambi.
          let rollbackInlineSent: (() => void) | null = null;
          const undoInlineMark = () => { rollbackInlineSent?.(); rollbackInlineSent = null; };
          // Reattach after a server restart continues the SAME bubble the client
          // was watching (reuse + in-place JSONL replay) instead of spawning a
          // duplicate turn / leaving a ghost spinner. Normal sends always get a
          // fresh row.
          // La riga com'è ADESSO, prima che il riattacco la svuoti per riusarla.
          // Serve a garantire l'unica regola che conta qui: una riadozione può
          // aggiungere, mai togliere. Vedi reattachMerge.ts.
          const reattachSnapshot: RowSnapshot | null = adottaTurnoVivo
            ? (() => {
                try {
                  const r = db.prepare(
                    "SELECT content, thinking, tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1",
                  ).get(sessionKey) as { content?: string; thinking?: string | null; tool_calls?: string | null; blocks?: string | null } | undefined;
                  return r ? {
                    content: r.content ?? "",
                    thinking: r.thinking ?? null,
                    toolCallsJson: decodeCol(r.tool_calls),
                    blocksJson: decodeCol(r.blocks),
                  } : null;
                } catch { return null; }
              })()
            : null;
          const partialMsg = adottaTurnoVivo
            ? reuseOrCreatePartialForReattach(sessionKey)
            : createPartialMessage(sessionKey, "assistant");
          // L'AbortController registrato insieme allo stream è l'unica maniglia
          // che chi finalizza da FUORI questa route ha sul client SSE. Lo
          // sweeper `[StaleStream]` (server.ts) chiudeva il turno in DB e
          // broadcastava `stream:end`, ma la risposta HTTP restava aperta per
          // sempre: il browser continuava ad aspettare `[DONE]` su un turno già
          // morto — la chat "appesa a caricare" che si sbloccava solo con un
          // reload. Il listener sotto trasforma quell'abort nella chiusura che
          // mancava.
          crashedPartialId = partialMsg.id;
          // Su una RIADOZIONE il turno non comincia adesso: è cominciato quando
          // l'ha aperto il turno vero, e noi ci stiamo solo riattaccando. Con
          // l'orologio che parte da qui la durata scritta sotto il messaggio
          // era quella del replay muto — 71ms, 100ms, 131ms su turni da minuti
          // — cioè un numero che non misura niente. La riga porta la sua ora di
          // nascita: quella è l'inizio.
          if (adottaTurnoVivo) {
            const born = Date.parse(partialMsg.timestamp);
            if (Number.isFinite(born) && born > 0 && born <= Date.now()) turnStartMs = born;
          }
          const externalAbort = new AbortController();
          // Un turno che regge un riavvio è un turno che gira in un processo
          // FIGLIO, cioè un provider che sa riadottare. Si chiede UNA volta, qui:
          // il provider di una sessione non cambia mentre il turno gira.
          startStream(sessionKey, partialMsg.id, externalAbort, providerSurvivesRestart(topicProvider));
          // `reattached` dice al client: questa bolla la stai già vedendo piena,
          // e sto per ricostruirla da capo — svuotala PRIMA che arrivino le
          // delta, o il replay si somma a quello che c'è già e il testo esce
          // doppio. È l'azzeramento che prima si faceva cancellando la riga in
          // DB: la vista si può rifare, il record no.
          broadcastToAll({
            type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id,
            ...(adottaTurnoVivo && "reusedBody" in partialMsg && partialMsg.reusedBody ? { reattached: true as const } : {}),
          });

          // Create SSE response for the HTTP client
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          const writer = writable.getWriter();
          let clientDisconnected = false;
          const encoder = new TextEncoder();

          const writeSSE = async (data: string) => {
            if (clientDisconnected) return;
            try { await writer.write(encoder.encode(`data: ${data}\n\n`)); } catch { clientDisconnected = true; }
          };
          const closeClient = async () => {
            if (clientDisconnected) return;
            try { await writer.close(); } catch { clientDisconnected = true; }
          };

          // ── Stream timeout state machine (resilience layer) ────────────
          //
          // We split the old single-timer design into three layered timers
          // because the previous "any 2 min of silence → kill the stream"
          // rule was too aggressive for multi-agent flows where the parent
          // legitimately waits on Task() sub-agents that may not emit events
          // for minutes at a time (e.g. a Bash inside a sub-agent).
          //
          //   SOFT (STREAM_TIMEOUT_MS, 2 min)
          //     The provider has gone quiet. Annotate the partial message
          //     with a "stream slow" marker, log a warn to activity_log,
          //     keep the handler registered, and start the GRACE timer.
          //     CRUCIAL: while ≥1 tool call is in `running` state, this
          //     timer is suspended (we are not in a true silence — we are
          //     waiting on a tool by design).
          //
          //   GRACE (STREAM_GRACE_MS, 60 s)
          //     Final window after a soft timeout to receive ANY provider
          //     event. If one arrives, we strip the annotation and resume
          //     normal streaming. Otherwise the stream is finalized as
          //     timed-out (the old behavior).
          //
          //   HARD (STREAM_HARD_TIMEOUT_MS, 30 min)
          //     Absolute upper bound, armed once at stream start and never
          //     reset. Protects against a provider that keeps emitting
          //     dust events forever; logs `error` to activity_log.
          //
          // The state variable below tracks where we are; resetStreamTimer
          // is the single entry point called by every onTextDelta /
          // onToolStart / onSubAgentUpdate / etc. handler.
          // 1 min soft: surface the "sta rallentando" cue after a minute of PURE
          // silence (the timer already suspends while tool calls run, so this
          // only counts genuine no-output gaps), instead of a 2-min apparent
          // freeze. Harmless if a healthy-but-slow turn trips it — the slow
          // annotation is stripped the moment output resumes (resetStreamTimer
          // recovery). Grace (recovery window) and the hard cap are unchanged.
          const STREAM_TIMEOUT_MS = 60_000;        // 1 min soft
          const STREAM_GRACE_MS = 60_000;          // 1 min grace
          const STREAM_HARD_TIMEOUT_MS = 30 * 60_000; // 30 min hard upper-bound
          let softTimer: ReturnType<typeof setTimeout> | null = null;
          let graceTimer: ReturnType<typeof setTimeout> | null = null;
          let hardTimer: ReturnType<typeof setTimeout> | null = null;
          let softTimedOutAtMs: number | null = null;

          const clearAllTimers = () => {
            if (softTimer) { clearTimeout(softTimer); softTimer = null; }
            if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
          };

          /**
           * Suspend while ≥1 tool call is `running`. The next resetStreamTimer
           * (fired on onToolResult / new event) will re-arm if needed.
           *
           * INVARIANT — this reads `trackedToolCallIds` as it is AT CALL TIME, so
           * every caller must have already applied the event it is reacting to.
           * Push before reset in `onToolStart`, splice before reset in every
           * completion path. Getting it backwards broke both ends of a turn:
           *
           *   - last tool result: the splice ran AFTER the reset, so the reset
           *     still saw one tool running, set `softTimer = null`, and nothing
           *     re-armed it. The watchdog stayed off for the rest of the turn —
           *     no soft timeout, no grace, no `stream:slow`.
           *   - first tool start: the push ran AFTER the reset, so the reset saw
           *     an empty set and armed a 60 s timer against a turn that was, by
           *     design, waiting on a tool. One minute later the user got a
           *     spurious "slowing down" banner on a perfectly healthy turn.
           */
          const armSoftTimer = () => {
            if (streamState !== "streaming") return;
            if (softTimer) clearTimeout(softTimer);
            if (trackedToolCallIds.length > 0) { softTimer = null; return; }
            softTimer = setTimeout(handleSoftTimeout, STREAM_TIMEOUT_MS);
          };

          const handleSoftTimeout = () => {
            if (streamState !== "streaming") return;
            console.warn(`[StreamWS] Soft timeout: no data for ${STREAM_TIMEOUT_MS / 1000}s on ${sessionKey} (grace ${STREAM_GRACE_MS / 1000}s)`);
            streamState = "soft-timed-out";
            softTimedOutAtMs = Date.now();
            // La lentezza si DICE, non si scrive nel messaggio.
            //
            // Prima qui si appendeva `STREAM_SLOW_ANNOTATION` a `fullContent` e si
            // riscriveva il messaggio. Funzionava come segnale visivo, ma il
            // segnale finiva nella STORIA: se il turno si chiudeva mentre era
            // lento, l'annotazione restava nel contenuto per sempre, e da quel
            // momento tornava al modello a OGNI turno successivo come se
            // l'assistente avesse detto «stream lento — il provider è ancora
            // connesso». Misurati 64 messaggi cosi' nel DB reale (bonificati
            // dalla migration 069).
            //
            // L'evento `stream:slow` qui sotto porta la stessa informazione, e
            // ora il client la rende: `TurnActivityIndicator` diventa ambra e
            // cambia frase finche' non arriva `stream:resumed` o la fine del
            // turno. Transitorio, come la cosa che descrive. Il messaggio resta
            // partial e lo stream resta aperto: non si chiude niente qui.
            if (matchedTopic) {
              broadcastToAll({
                type: "stream:slow",
                sessionKey,
                topicId: matchedTopic.id,
                messageId: partialMsg.id,
                graceMs: STREAM_GRACE_MS,
              });
            }
            logStreamSoftTimeout({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: Date.now() - requestStartMs,
              toolCallCount: trackedToolCallIds.length,
            });
            // Start grace window. If the provider emits ANYTHING in this
            // window, resetStreamTimer's recovery branch fires and we
            // return to "streaming". Otherwise we finalize as timeout.
            graceTimer = setTimeout(handleGraceExpiry, STREAM_GRACE_MS);
          };

          const handleGraceExpiry = () => {
            if (streamState !== "soft-timed-out") return;
            // Auto-compact resilience: the CLI emits NOTHING while it compacts
            // a full context (observed 3+ min of total silence), which is
            // indistinguishable from a dead provider on the stream alone.
            // While the child process is still ALIVE this is not a timeout —
            // extend the grace window instead of aborting a healthy turn (the
            // 30-min hard cap still bounds a truly wedged process). Bumping the
            // stream activity keeps the StaleStream sweeper (3-min inactivity)
            // from finalizing the vouched-for stream underneath us.
            if (topicProvider.isTurnProcessAlive?.(sessionKey)) {
              console.warn(`[StreamWS] Grace expired but provider process is alive on ${sessionKey} (compaction/long silence) — extending grace ${STREAM_GRACE_MS / 1000}s`);
              // "Alive but silent" has TWO causes that look identical here: the
              // child really is quiet (compaction, a long tool), or we stopped
              // hearing a child that never stopped talking (a broker attachment
              // lost to a reconnect / a spawn that acked without attaching).
              // Extending alone turns the second one into a turn that never
              // ends — the freeze this watchdog is supposed to catch. So ask
              // the provider to re-attach from the last byte we consumed first:
              // a no-op when we are attached, a full recovery when we are not
              // (the missed output arrives and resetStreamTimer strips the slow
              // annotation on its own).
              (topicProvider as { resyncStream?: (sk: string) => Promise<boolean> }).resyncStream?.(sessionKey)
                .then((did) => { if (did) console.warn(`[StreamWS] Resync issued for ${sessionKey} — recovering the stream if it was detached`); })
                .catch((err) => console.warn(`[StreamWS] Resync on grace-expiry failed for ${sessionKey}:`, err));
              updateStreamContent(sessionKey, fullContent, fullThinking);
              graceTimer = setTimeout(handleGraceExpiry, STREAM_GRACE_MS);
              return;
            }
            console.warn(`[StreamWS] Grace expired without recovery on ${sessionKey} → finalize as timeout`);
            streamState = "finalized";
            // Il figlio è morto e nessuno ha parlato: è il watchdog a fermare il
            // turno. Senza questo, chi guida un turno headless leggerebbe la fine
            // di default (`end_turn`) e crederebbe a una consegna riuscita.
            recordTurnEnd(sessionKey, cancelled("watchdog", "grace expired"));
            const timeoutMsg = "⚠️ Response timed out. The AI service took too long to respond. Please try again.";
            // Replace the soft annotation with the hard timeout marker.
            fullContent = stripSlowAnnotation(fullContent);
            if (!fullContent.trim()) fullContent = timeoutMsg;
            else fullContent += "\n\n---\n*[Response timed out]*";
            updateLastMessage(sessionKey, { content: fullContent, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            // Abort the underlying provider turn too. `unregisterStreamHandler` is
            // a no-op for providers that don't implement it (e.g. ClaudeCodeProvider),
            // so without this the spawned process keeps running and later fires
            // `onDone` → a second finalizeStream (now guarded) and, worse, a frozen
            // per-session turn queue. Mirrors `/api/chat/abort` in topics.ts.
            // reason "watchdog": the liveness check above means we only get here
            // with a DEAD child, but the abort must still never read "user stop".
            topicProvider.abort?.(sessionKey, undefined, "watchdog")?.catch((err: any) => console.warn(`[StreamWS] Provider abort on grace-expiry failed:`, err));
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: timeoutMsg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id, stopReason: "cancelled", stopCause: "watchdog" });
              finalizeTurnActivity(matchedTopic);
            }
            // No separate "grace expired" log line — the soft-timeout entry
            // already exists; recovery would have logged on the way out.
            // Failing to recover IS the absence of a recovery log entry.
            writeSSE("[DONE]").then(() => closeClient())
              .catch((err) => console.warn(`[StreamWS] DONE/close on grace-expiry failed:`, err));
            clearAllTimers();
          };

          const handleHardTimeout = () => {
            if (streamState === "finalized") return;
            // Match the interactive CLI: NEVER kill a turn whose child process is
            // still alive. A 40-minute refactor, a big test run, a slow-but-live
            // tool is doing real work — not wedged. The terminal `claude` has no
            // wall-clock session cap at all; a turn runs until the model finishes,
            // the process dies, or the human hits Ctrl+C. So here the hard cap is
            // symmetric with the grace window: while the process is ALIVE we
            // extend (never SIGKILL a live, working turn — that was the sole
            // reason a headless chat could "crash"); only a DEAD child is
            // finalized, non-destructively (accumulated content is kept). The
            // Stop button is the user's Ctrl+C for a genuinely stuck-but-alive
            // turn.
            if (topicProvider.isTurnProcessAlive?.(sessionKey)) {
              console.warn(`[StreamWS] Hard cap (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached but provider process is alive on ${sessionKey} — extending (a live turn is never killed)`);
              updateStreamContent(sessionKey, fullContent, fullThinking);
              hardTimer = setTimeout(handleHardTimeout, STREAM_HARD_TIMEOUT_MS);
              return;
            }
            console.error(`[StreamWS] Hard cap (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached and provider process is DEAD on ${sessionKey} → finalize`);
            streamState = "finalized";
            recordTurnEnd(sessionKey, cancelled("watchdog", "hard cap reached"));
            const msg = `⚠️ Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached. The provider stopped responding.`;
            fullContent = stripSlowAnnotation(fullContent);
            if (!fullContent.trim()) fullContent = msg;
            else fullContent += `\n\n---\n*[Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached]*`;
            updateLastMessage(sessionKey, { content: fullContent, partial: undefined, streamedAt: undefined });
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            // See handleGraceExpiry: abort the orphaned provider turn (no-op
            // unregister otherwise leaves the process running).
            topicProvider.abort?.(sessionKey, undefined, "watchdog")?.catch((err: any) => console.warn(`[StreamWS] Provider abort on hard-timeout failed:`, err));
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: msg });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id, stopReason: "cancelled", stopCause: "watchdog" });
              finalizeTurnActivity(matchedTopic);
            }
            logStreamHardTimeout({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: Date.now() - requestStartMs,
              toolCallCount: trackedToolCallIds.length,
            });
            writeSSE("[DONE]").then(() => closeClient())
              .catch((err) => console.warn(`[StreamWS] DONE/close on hard-timeout failed:`, err));
            clearAllTimers();
          };

          const recoverFromSoftTimeout = () => {
            // A provider event arrived during the grace window. Strip the
            // annotation and return to "streaming". Future events resume
            // normal handling.
            if (streamState !== "soft-timed-out") return;
            console.log(`[StreamWS] Recovered from soft timeout on ${sessionKey} after ${Date.now() - (softTimedOutAtMs ?? Date.now())}ms`);
            if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
            streamState = "streaming";
            fullContent = stripSlowAnnotation(fullContent);
            updateLastMessage(sessionKey, { content: fullContent });
            if (matchedTopic) {
              broadcastToAll({
                type: "stream:resumed",
                sessionKey,
                topicId: matchedTopic.id,
                messageId: partialMsg.id,
              });
            }
            logStreamRecovered({
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: softTimedOutAtMs ? Date.now() - softTimedOutAtMs : undefined,
            });
            softTimedOutAtMs = null;
          };

          /** Single entry point called by every provider event handler. */
          const resetStreamTimer = () => {
            if (streamState === "finalized") return;
            // Any provider event proves the stream is alive — bump the
            // in-memory registry so the StaleStream sweeper (3-min
            // lastActivity cutoff) doesn't finalize a healthy tool-heavy
            // turn: lastActivity was only ever bumped by TEXT deltas, so a
            // turn grinding through tools for minutes with no prose got its
            // partial flag force-cleared and the UI spinner killed mid-run.
            updateStreamContent(sessionKey, fullContent, fullThinking);
            if (streamState === "soft-timed-out") recoverFromSoftTimeout();
            armSoftTimer();
          };

          /**
           * Un tool ha finito: PRIMA esce dall'insieme, POI si riarma il timer.
           *
           * L'ordine è la regola scritta su `armSoftTimer`, e questo è l'unico
           * posto in cui si toglie un id: i cinque siti che facevano
           * `indexOf`+`splice` a mano (risultato del tool, i due esiti della
           * dispatch dei tool `browser_*`, i due dei control tool) erano cinque
           * occasioni di dimenticarsene — e tre di loro se n'erano già
           * dimenticate, lasciando il watchdog spento dopo l'ultimo tool.
           */
          const settleTrackedTool = (toolCallId: string) => {
            const idx = trackedToolCallIds.indexOf(toolCallId);
            if (idx >= 0) trackedToolCallIds.splice(idx, 1);
            resetStreamTimer();
          };

          /**
           * Tiene vive nel pannello Processi le shell che l'agente lascia in
           * background (3.5). Il transcript le mostra una volta e le dimentica;
           * qui diventano stato: si contano, si leggono, si fermano.
           *
           * Non butta mai il turno: un registro che non si aggiorna è una riga
           * mancante nel pannello, non un motivo per far fallire una chat.
           */
          const trackBackgroundShell = (
            detail: import("../types").ToolCallDetail | undefined,
            result: string,
            isError: boolean,
          ) => {
            try {
              const action = classifyShellToolResult(detail, result, isError);
              if (!action) return;
              if (action.kind === "start") {
                // La cwd della topic viene PRIMA di quella del tool: il pannello
                // raggruppa per progetto, e una shell lanciata in `client/`
                // appartiene comunque al progetto che l'utente sta guardando —
                // con la cwd del tool finirebbe in un gruppo che non esiste.
                const cwd = (matchedTopic ? ctx.resolveTopicCwd(matchedTopic) : null)
                  || action.cwd
                  || process.cwd();
                registerBackgroundShell({
                  sessionKey,
                  topicId: matchedTopic?.id ?? null,
                  shellId: action.shellId,
                  command: action.command,
                  cwd,
                  ownerPid: getSessionCliPid(sessionKey),
                });
              } else if (action.kind === "output") {
                noteBackgroundShellOutput(sessionKey, action.shellId, {
                  ...(action.output ? { output: action.output } : {}),
                  ...(action.status ? { status: action.status } : {}),
                  ...(action.exitCode != null ? { exitCode: action.exitCode } : {}),
                });
              } else {
                closeBackgroundShell(sessionKey, action.shellId, "killed");
              }
            } catch (err) {
              console.warn("[shell] registro non aggiornato:", err);
            }
          };

          // Hard timer is armed once at stream start and is the only timer
          // never reset by events.
          hardTimer = setTimeout(handleHardTimeout, STREAM_HARD_TIMEOUT_MS);
          // Il soft timer parte SUBITO, non al primo evento del provider. Prima
          // lo armava solo `resetStreamTimer`, quindi un turno che non emetteva
          // NULLA (CLI wedged, MCP che non risponde all'init, `--resume` che non
          // parte) non produceva né `stream:slow` né soft-timeout: nei log di
          // prod zero occorrenze di entrambi a fronte di turni finalizzati dallo
          // sweeper. Il silenzio iniziale è esattamente il caso da sorvegliare.
          armSoftTimer();

          // Finalizzazione decisa da FUORI (sweeper StaleStream): il turno è già
          // chiuso in DB e annunciato via WS, qui resta solo da liberare il
          // client SSE, che altrimenti aspetta `[DONE]` all'infinito.
          externalAbort.signal.addEventListener("abort", () => {
            if (streamState === "finalized") return;
            console.warn(`[StreamWS] finalizzazione esterna su ${sessionKey} — chiudo l'SSE`);
            // I BLOCCHI si salvano PRIMA di dichiarare finito il turno, ed è
            // l'ultimo momento in cui si può: da qui in poi `streamState` è
            // `finalized`, quindi `finalizeStream` esce subito e chi finalizza da
            // fuori scrive `content` ma non li tocca — `/api/chat/abort` passa a
            // `updateLastMessage` solo content/thinking, e il COALESCE tiene la
            // colonna vecchia (server/utils.ts).
            //
            // `content` lo tiene lo stream in memoria a ogni delta, i blocchi si
            // persistono ogni SAVE_INTERVAL=10: fermare un turno al quindicesimo
            // delta lasciava la riga con quindici delta in `content` e dieci in
            // `blocks` — e chi disegna legge `blocks`. Il finale della risposta
            // c'era, in una colonna che nessuno guarda.
            //
            // Solo i blocchi, non il testo: sulla via dello sweeper StaleStream la
            // riga porta già il cartello «Risposta interrotta» scritto in
            // `content`, e riscriverci sopra cancellerebbe la spiegazione. E i
            // flag di controllo non si toccano — `persistTurnBody` non passa
            // `partial`, quindi resta quello della riga.
            try { persistBlocks(); }
            catch (err) { console.warn(`[StreamWS] salvataggio dei blocchi su abort esterno fallito:`, err); }
            streamState = "finalized";
            clearAllTimers();
            topicProvider.unregisterStreamHandler?.(sessionKey);
            writeSSE("[DONE]").then(() => closeClient())
              .catch((err) => console.warn(`[StreamWS] DONE/close su abort esterno fallito:`, err));
          }, { once: true });

          // Helper: finalize the stream (called on done/error/abort)
          const finalizeStream = async (
            reason: "done" | "error" | "aborted",
            errorMsg?: string,
            /**
             * PERCHÉ il turno è finito, quando il provider lo sa. Manca solo
             * quando finalizza un timer nostro (soft/hard watchdog): lì la
             * ragione la conosce il chiamante e la passa esplicitamente.
             */
            turnEnd?: TurnEndInfo,
          ) => {
            // Idempotent. A timeout path (handleGraceExpiry/handleHardTimeout) may
            // have already finalized and aborted this stream; a late provider
            // callback — `onDone` from an orphaned turn, or `onAborted` from the
            // abort() those handlers now issue — must not re-persist content or
            // re-broadcast to clients that already closed the stream out.
            if (streamState === "finalized") return;
            // Always cancel pending timers — the stream is over.
            clearAllTimers();
            // Recovery path: if the provider succeeded after the soft
            // timeout fired, we want the user to see the real content,
            // not the "[stream slow]" annotation. Strip it and emit a
            // recovered log entry so we have telemetry on near-misses.
            if (streamState === "soft-timed-out") {
              const beforeStrip = fullContent;
              fullContent = stripSlowAnnotation(fullContent);
              if (beforeStrip !== fullContent && matchedTopic) {
                broadcastToAll({
                  type: "stream:resumed",
                  sessionKey,
                  topicId: matchedTopic.id,
                  messageId: partialMsg.id,
                });
              }
              logStreamRecovered({
                sessionKey,
                topicId: matchedTopic?.id,
                durationMs: softTimedOutAtMs ? Date.now() - softTimedOutAtMs : undefined,
                extra: { finalizeReason: reason },
              });
            }
            streamState = "finalized";

            // La ragione della fine, decisa UNA volta. Se il provider non l'ha
            // detta si ricava da com'è finito lo stream: `error` porta con sé il
            // testo, che è l'unico posto dove un limite di token o un rifiuto
            // possono ancora essere riconosciuti.
            const endInfo: TurnEndInfo = turnEnd
              ?? (reason === "error"
                ? classifyTurnError(errorMsg ?? "", "provider-error")
                : reason === "aborted"
                ? { end: "cancelled" }
                : { end: "end_turn" });
            // Depositata PRIMA di chiudere l'SSE: chi guida un turno headless la
            // ritira appena il drain finisce, e il drain finisce con `[DONE]`.
            recordTurnEnd(sessionKey, endInfo);

            if (reason === "error" && errorMsg) {
              // Il verdetto entra nei BLOCCHI, che sono ciò che il client rende.
              // Il testo in `fullContent` NON si decide qui: su una riadozione
              // `fullContent` è ancora vuoto (il replay è muto) e lo diventa solo
              // dopo la rifusione dello snapshot, più in basso. Deciderlo adesso
              // vorrebbe dire scrivere il cartello su un turno che c'è.
              blocks.push({ kind: "error", text: errorMsg });
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
              }
            }

            // «Nessuna risposta» solo se davvero non è arrivato NIENTE — e
            // "niente" si misura sulla RIGA, non su questa gamba HTTP.
            //
            // `trackedToolCallIds` conta i tool visti da QUESTO handler: su una
            // riadozione dopo un hot-reload il replay è muto, quindi resta vuoto
            // anche quando la riga in DB porta un turno intero di tool. Bastava
            // quello per riscrivere il messaggio col cartello di guasto: è così
            // che un pannello `ask_user_question` ancora a schermo è sparito,
            // sostituito da «No response received» (topic:ed2070df, 4 agosto).
            // La riga sa la verità: se ha dei tool O dei blocchi, il turno ha
            // prodotto qualcosa.
            //
            // `blocks` è stato aggiunto il 7 agosto, su una prova dal vivo:
            // topic:d04325fa portava DUE righe col cartello «Nessuna risposta:
            // il turno si è chiuso senza produrre niente» sopra 20 KB e 46 KB di
            // blocchi. Guardare i soli `tool_calls` non bastava — un turno di
            // solo testo e ragionamento non ha tool — e per giunta la rifusione
            // dello snapshot di riadozione, che è ciò che rimette quei blocchi,
            // gira DOPO questa decisione: qui `fullContent` è ancora vuoto e
            // `trackedToolCallIds` ancora vuoto, quindi il cartello si scriveva
            // su un turno intero. Finché viveva sepolto in `content` non si
            // vedeva; ora che il verdetto si legge, si leggerebbe una falsità.
            // La domanda è la STESSA che si fa la guardia dei cartelli d'errore,
            // e si pone con la stessa funzione: `content` qui è già misurato a
            // parte (`!fullContent.trim()`), quindi si passa vuoto e contano
            // solo tool e blocchi.
            // Valutata come FUNZIONE, non come valore: va chiamata dopo la
            // rifusione dello snapshot, quando `blocks` e la riga dicono la
            // verità. `content` è misurato a parte (`!fullContent.trim()`),
            // quindi qui si passa vuoto e contano solo tool e blocchi.
            const rowHasWorkDopoMerge = () => trackedToolCallIds.length > 0
              || blocks.length > 0
              || rowCarriesWork({ ...(readRowForNotice(partialMsg.id) ?? { toolCallsJson: null, blocksJson: null }), content: "" });
            // Il turno che ha PROPOSTO e non ha potuto consegnare.
            //
            // In plan mode la CLI 2.1.223 non espone più `ExitPlanMode`, quindi
            // il modello scrive il piano in `~/.claude/plans/` e resta fermo:
            // non può agire e non può chiedere l'approvazione. Se la CLI non ha
            // più il tool per chiederla, la chiede l'applicazione — con lo
            // STESSO pannello di `AskUserQuestion`, che è già il modo in cui
            // questa chat dice «tocca a te». Senza, il turno si chiudeva col
            // cartello «non ha prodotto niente» sopra una colonna di azioni
            // riuscite e un piano che nessuno vedeva.
            const pendingPlan = findPlanAwaitingApproval(blocks);
            const askingPlanApproval = shouldAskPlanApproval({
              reason,
              permissionMode: permissionModeForAutonomy(matchedTopic?.autonomyLevel),
              plan: pendingPlan,
            });
            if (askingPlanApproval && pendingPlan) {
              const schema = planApprovalSchema();
              updateToolCallFields(sessionKey, pendingPlan.toolCallId, {
                status: "waiting_for_input",
                userInputSchema: schema,
              });
              updateBlockTool(pendingPlan.toolCallId, { status: "waiting_for_input", userInputSchema: schema });
              broadcastToAll({
                type: "stream:tool_user_input_required",
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId: pendingPlan.toolCallId,
                schema,
              });
            }

            // Finalize any tool calls that the provider started but never
            // emitted a result for. Three failure modes share this loop:
            //   - "done":     fire-and-forget tools (ExitPlanMode, tools that
            //                 don't return a result). Mark as success but with
            //                 NO result string — the previous code passed
            //                 'success' as the result, which persisted the
            //                 literal "success" into the row's body.
            //   - "error":    a stream-level error. Tool was probably mid-run
            //                 when things broke — mark as error.
            //   - "aborted":  user clicked stop. Tools did not complete; mark
            //                 as error with reason so the UI doesn't show a
            //                 misleading green ✓.
            const finalizeStatus: 'success' | 'error' = reason === 'done' ? 'success' : 'error';
            const finalizeError = reason === 'aborted'
              ? 'Aborted by user'
              : reason === 'error'
              ? (errorMsg || 'Stream ended with error')
              : undefined;
            const finalizeEndedAt = Date.now();
            for (const tcId of trackedToolCallIds) {
              if (finalizeStatus === 'error') {
                // updateToolCallResult sets status='error' when error is provided.
                updateToolCallResult(sessionKey, tcId, '', finalizeError, { endedAt: finalizeEndedAt });
                updateBlockTool(tcId, { status: 'error', error: finalizeError, endedAt: finalizeEndedAt });
                broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'error', result: '', error: finalizeError, endedAt: finalizeEndedAt }, matchedTopic?.id);
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: tcId, status: 'error', error: finalizeError } } }] }));
              } else {
                // Fire-and-forget success. Empty result so the UI shows just
                // the green ✓ without a literal "success" body.
                updateToolCallResult(sessionKey, tcId, '', undefined, { endedAt: finalizeEndedAt });
                updateBlockTool(tcId, { status: 'success', endedAt: finalizeEndedAt });
                broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId: tcId, status: 'success', endedAt: finalizeEndedAt }, matchedTopic?.id);
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: tcId, status: 'success' } } }] }));
              }
            }

            // Una domanda ancora aperta a fine turno (tipico dello «ferma»
            // premuto col pannello a schermo) è attesa fino all'ultimo istante.
            humanWait.closeAll(Date.now());
            // La durata che resterà scritta sotto il messaggio è il LAVORO, non
            // il tempo che ci ha messo una persona a rispondere: un turno da otto
            // secondi non deve essere archiviato come «43m» perché la domanda è
            // arrivata durante il pranzo. Vedi lib/human-wait.ts.
            // Riadozione: quello che il replay NON ha ri-emesso torna dov'era.
            // Senza questo, un replay muto (coda chiusa nello store del broker)
            // lasciava la riga col solo testo finale e senza i tool — compreso
            // un `ask_user_question` ancora a schermo, che spariva a ogni
            // ricarica del server.
            if (adottaTurnoVivo && reattachSnapshot) {
              const merged = mergeReattachedRow(reattachSnapshot, {
                content: fullContent,
                thinking: fullThinking || undefined,
                trackedTools: trackedToolCallIds.length,
                blocks,
              });
              fullContent = merged.content;
              if (merged.thinking !== undefined) fullThinking = merged.thinking;
              if (merged.blocks && merged.blocks !== blocks) {
                blocks.length = 0;
                blocks.push(...(merged.blocks as ContentBlock[]));
              }
              if (merged.toolCallsJson !== undefined) {
                try { db.run("UPDATE messages SET tool_calls = ? WHERE id = ?", [merged.toolCallsJson, partialMsg.id]); }
                catch (err) { console.warn(`[chat-reattach] tool non ripristinati su ${sessionKey}:`, err); }
              }
              if (merged.nothingNew) {
                console.log(`[chat-reattach] ${sessionKey}: il riattacco non ha aggiunto niente — la riga resta com'era`);
              }
            }

            // Il cartello nel TESTO si decide qui, non prima: su una riadozione
            // `fullContent` diventa vero solo dopo la rifusione appena sopra, e
            // deciderlo a monte significava scriverlo su un turno che c'era.
            // Serve solo alla riga altrimenti vuota — `content` è l'unica colonna
            // che la ricerca ⌘K interroga, e i client vecchi (senza il blocco
            // `error`) leggono ancora da lì. Chi ha del testo se lo tiene: il
            // verdetto lo porta già il blocco.
            if (reason === "error" && errorMsg && !fullContent.trim()) {
              fullContent = `⚠️ ${errorMsg}`;
            }

            // «Nessuna risposta» si decide QUI, dopo la rifusione, per la stessa
            // ragione del cartello d'errore qui sopra — e per una ragione in
            // più, imparata dal vivo il 7 agosto.
            //
            // Su una riadozione la riga è già stata SVUOTATA per essere riusata
            // (`reuseOrCreatePartialForReattach`), e ciò che la riempiva torna
            // solo con il merge. Deciderlo prima significa guardare una riga che
            // qualcuno ha appena azzerato e concludere che il turno non ha
            // prodotto niente: è successo su un turno con 54 tool e 14 blocchi
            // di testo, riadottato dopo un hot-reload del server. Il fix
            // precedente guardava le colonne giuste ma nel momento sbagliato.
            // UNA COMPATTAZIONE NON È UNA RISPOSTA MANCATA.
            //
            // `/compact` chiude con `result: ""` per costruzione: la CLI non
            // produce testo, perché l'esito della compattazione è il divider
            // «Contesto compattato» che è già stato disegnato dal suo
            // `compact_boundary`. Senza questa esclusione, il turno che ora si
            // chiude correttamente (vedi il commento sul `result` vuoto in
            // `providers/claude-code.ts`) si prenderebbe subito il cartello
            // «Nessuna risposta: il turno si è chiuso senza produrre niente» —
            // cioè scambieremmo un successo per un guasto, che è esattamente il
            // modo in cui il vecchio bug si sarebbe ripresentato con un'altra
            // faccia.
            const soloCompattazione = compactedThisTurn;
            if (reason === "done" && !fullContent.trim() && !rowHasWorkDopoMerge() && !askingPlanApproval && !soloCompattazione) {
              const emptyErrorMsg = "⚠️ Nessuna risposta: il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.";
              fullContent = emptyErrorMsg;
              blocks.push({ kind: "error", text: "Nessuna risposta: il turno si è chiuso senza produrre niente." });
              console.warn(`[StreamWS] Empty response for ${sessionKey}`);
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: emptyErrorMsg });
              }
            }
            // UN TURNO ANNULLATO NON DALL'UTENTE DEVE DIRLO.
            //
            // `aborted` è sempre stato muto, e per l'unico caso che esisteva
            // quando fu scritto — l'umano preme Ferma — è giusto: sa già cos'ha
            // premuto, e la riga vuota che lascia viene buttata poco sotto.
            //
            // Ma ad annullare non è solo l'umano. Il 20/08 su topic:9f9e9629
            // ad annullare è stato lo SPEGNIMENTO del server (salvataggio in
            // `server/` → fswatch → `restart-when-idle` → SIGTERM →
            // `stopAllProviders()`), e il silenzio pensato per lo stop a mano è
            // finito sopra un turno che nessuno aveva fermato: risposta troncata
            // a metà, nessuna spiegazione, nessun «Riprova». La regola di CHI
            // merita il cartello sta in `lib/cancelled-notice.ts`, provata a
            // parte; qui si applica soltanto.
            //
            // Il cartello va nei BLOCCHI — che sono ciò che il client disegna —
            // e nel TESTO solo se il testo è vuoto, esattamente come fa il ramo
            // `error` qui sopra: chi ha già scritto della prosa se la tiene, il
            // verdetto lo porta il blocco.
            if (reason === "aborted") {
              const avviso = cancelledNotice(endInfo);
              if (avviso) {
                blocks.push({ kind: "error", text: avviso.replace(/^⚠️\s*/, "") });
                if (!fullContent.trim()) fullContent = avviso;
                if (matchedTopic) {
                  broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: avviso });
                }
              }
            }

            const latencyMs = Math.max(0, Date.now() - turnStartMs - humanWait.totalMs());
            const finalizedMsg = updateLastMessage(sessionKey, {
              content: fullContent,
              thinking: fullThinking || undefined,
              blocks: blocks.length > 0 ? blocks : undefined,
              partial: undefined,
              streamedAt: undefined,
              latencyMs,
              usagePromptTokens,
              usageCompletionTokens,
              costCents,
              model: usageModel,
              cacheReadTokens,
              cacheCreationTokens,
              cacheCreation1hTokens,
            });
            // "Un turno che non ha prodotto niente non lascia niente": stop
            // premuto prima che il modello dicesse qualsiasi cosa. Il segnaposto
            // creato all'inizio dello stream restava in chat finalizzato vuoto —
            // e rientrava nella history rimandata al modello a ogni turno dopo.
            // Solo su `aborted`: `done` ed `error` scrivono comunque il loro ⚠️,
            // quindi vuoti non sono mai. Vedi shared/empty-turn.ts.
            // …e la riga vuota che quel turno lascia non deve restare in chat.
            // `/compact` non ha prodotto nulla di mostrabile — il divider vive
            // in una tabella sua — quindi il segnaposto dell'assistente è una
            // bolla vuota, che oltre a sporcare il trascritto rientrerebbe nella
            // history rimandata al modello a ogni turno successivo. Stessa
            // regola dello stop-prima-di-qualsiasi-cosa, stesso predicato
            // (`shared/empty-turn.ts`): se non c'è NIENTE dentro, non resta.
            const discardedMessageId = (reason === "aborted" || (reason === "done" && compactedThisTurn))
              ? discardIfEmptyTurn(sessionKey, finalizedMsg)
              : null;
            if (discardedMessageId) console.log(`[StreamWS] ${sessionKey}: turno vuoto scartato (${discardedMessageId})`);
            endStream(sessionKey);
            topicProvider.unregisterStreamHandler?.(sessionKey);

            // Detect sub-agent launches
            if (matchedTopic && /sub.?agent|subagent|lanciato|spawned|sessions_spawn/i.test(fullContent)) {
              watchSessionForSubagents(matchedTopic.id, sessionKey);
            }

            if (matchedTopic) {
              // Niente `message:new` per un turno scartato: annuncerebbe agli
              // altri client un messaggio assistente vuoto — cioè ricreerebbe in
              // pagina la bolla che il DB non ha più.
              if (!discardedMessageId) {
                broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: fullContent, preview: fullContent.slice(0, 100) });
              }
              broadcastToAll({
                type: "stream:end",
                sessionKey,
                topicId: matchedTopic?.id,
                messageId: partialMsg.id,
                ...(discardedMessageId ? { discardedMessageId } : {}),
                latencyMs,
                usagePromptTokens,
                usageCompletionTokens,
                costCents,
                ...(usageModel ? { model: usageModel } : {}),
                // Lo scorporo della cache va anche sul filo, non solo nella riga
                // salvata: la UI mostra il piede del messaggio appena il turno
                // finisce, senza rileggere la history.
                cacheReadTokens,
                cacheCreationTokens,
                cacheCreation1hTokens,
                // Vocabolario ACP sul filo. `error` NON è una ragione ACP: resta
                // fuori da `stopReason` e viaggia come `reason` dello stream.
                ...(isAcpStopReason(endInfo.end) ? { stopReason: endInfo.end } : {}),
                ...(endInfo.cause ? { stopCause: endInfo.cause } : {}),
                // Marcatore POSITIVo di fine pulita, letto SOLO dalla push di
                // fine risposta (push-triggers): `end_turn` = il modello ha
                // chiuso da solo. Su max_tokens/refusal/cancelled/error resta
                // assente, così un turno morto non annuncia "risposta pronta"; e
                // nemmeno un turno VUOTO (segnaposto scartato = nessuna risposta).
                // `dispatched` esclude i turni d'agente guidati dalla board.
                completed: endInfo.end === "end_turn" && !discardedMessageId,
                ...(dispatched ? { dispatched: true } : {}),
              });
              finalizeTurnActivity(matchedTopic);
            }

            // Activity log (Fix E): one row per stream lifecycle event so
            // future timeouts/aborts/errors leave a queryable trail. The
            // helper swallows DB errors so a logging failure can never
            // break the stream finalization path.
            const logCtx = {
              sessionKey,
              topicId: matchedTopic?.id,
              durationMs: latencyMs,
              toolCallCount: trackedToolCallIds.length,
              promptTokens: usagePromptTokens,
              completionTokens: usageCompletionTokens,
              costCents,
            };
            if (reason === "done") logStreamComplete(logCtx);
            // Il titolo dice CHI ha annullato, non «l'utente» sempre. Un
            // registro che attribuisce a una persona ciò che ha fatto una
            // macchina manda a cercare dalla parte sbagliata: il 20/08 la riga
            // «stream aborted by user» era l'unica traccia di uno spegnimento
            // del server, e diceva il contrario di quello che era successo.
            else if (reason === "aborted") logStreamAborted({ ...logCtx, title: abortLogTitle(endInfo) });
            else if (reason === "error") logStreamError({ ...logCtx, errorMessage: errorMsg });

            // (Topic switching is now a tool — `switch_topic`/`new_topic` —
            // which switches the UI mid-turn; the old marker path's message
            // migration to the target topic was removed with the markers.)

            // I media prodotti da QUESTO turno.
            //
            // `findNewMediaFiles` sa solo QUANDO un file è cambiato, e la
            // cartella è condivisa per contratto (il dispatcher dice a ogni
            // agente di depositare lì). Da sola, quella lista è «tutto ciò che
            // chiunque ha scritto mentre lavoravo» — e più il turno è lungo,
            // più larga è la rete. Il 7 agosto un turno da 11 minuti si è
            // portato in fondo due screenshot di una spec E2E che girava in
            // un'altra sessione. Qui passa dal cancello dell'attribuzione: è
            // suo solo ciò che ha nominato in una sua chiamata.
            const toolsDelTurno: TurnToolTrace[] = blocks
              .filter((b): b is Extract<ContentBlock, { kind: "tool" }> => b.kind === "tool")
              .map((b) => ({ name: b.toolCall.name, args: b.toolCall.args, result: b.toolCall.result }));
            setTimeout(async () => {
              try {
                const candidati = await findNewMediaFiles(requestStartMs);
                const { propri, altrui } = attribuisciMedia(candidati, toolsDelTurno);
                if (altrui.length > 0) {
                  console.log(`[Media] ${sessionKey}: ${altrui.length} file scartati, non nominati da questo turno — ${altrui.map((p) => p.split("/").pop()).join(", ")}`);
                }
                if (propri.length > 0 && sessionKey) {
                  updateLastMessageWithMedia(sessionKey, propri);
                  broadcastToAll({ type: "message:media", sessionKey, topicId: matchedTopic?.id, media: propri });
                }
              } catch {}
            }, 1000);

            if (matchedTopic && !matchedTopic.projectPath) {
              setTimeout(() => {
                try {
                  autoBindProject(matchedTopic!);
                } catch (err) {
                  console.error("[AutoBind] failed:", err);
                }
              }, 500);
            }

            // Close SSE response
            await writeSSE("[DONE]");
            await closeClient();
          };

          // Register event handler for this session
          const handler: StreamHandler = {
            onTextDelta: (text: string, _fullText: string) => {
              resetStreamTimer();
              // Il primo argomento È il pezzo nuovo, sempre: lo dice il contratto
              // su `StreamHandler.onTextDelta` e lo rispettano tutti e cinque i
              // provider. L'unico cumulativo — il gateway OpenClaw — si
              // normalizza da sé con `nextTextDelta` (server/providers/text-delta.ts).
              //
              // Qui prima si indovinava: prefisso tagliato se il testo cominciava
              // per quello di prima, evento SCARTATO se era identico. Su quattro
              // provider su cinque quella seconda regola perdeva un token ripetuto
              // — «the the», due `\n` di fila, un `= =` in una tabella — e la
              // perdita era muta, perché la riga salvata e lo schermo dicevano
              // esattamente la stessa cosa sbagliata.
              const newText = text;
              if (newText) {
                fullContent += newText;
                appendTextBlock(newText);

                // Topic/project/browser are now driven by tools, not markers.
                // The only surviving heuristic is auto-opening the browser pane
                // when the model mentions a localhost:PORT dev server in prose.
                // Scan only the new delta plus a small carry-over tail (a URL can
                // straddle two chunks) — not the whole accumulated fullContent.
                const localhostScanWindow = localhostScanCarry + newText;
                detectLocalhostAutoNav(localhostScanWindow, matchedTopic);
                // Keep enough trailing context for a `localhost:PORT` split across
                // the boundary (`http://localhost:65535` ≈ 22 chars).
                localhostScanCarry = localhostScanWindow.slice(-24);

                // Broadcast clean content as a true delta against the cumulative
                // marker-stripped state. See computeCleanBroadcastDelta() for
                // the three observable cases this handles (closed marker
                // spanning chunks, close+tail in same chunk, multiple markers
                // in one chunk). Unit-tested in
                // server/routes/topics-marker-strip.test.ts.
                const { cumulativeClean, delta: deltaToBroadcast } =
                  computeCleanBroadcastDelta(fullContent, lastBroadcastClean);
                lastBroadcastClean = cumulativeClean;
                if (deltaToBroadcast) {
                  const chunk = { type: "stream:content_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: deltaToBroadcast };
                  if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, chunk);
                  else broadcastToAll(chunk);
                  writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: deltaToBroadcast } }] }));
                }
              }

              chunkCount++;
              updateStreamContent(sessionKey, fullContent, fullThinking);
              if (chunkCount - lastSaveChunk >= SAVE_INTERVAL) {
                lastSaveChunk = chunkCount;
                // Persist blocks alongside content so a mid-stream
                // GET /api/history (e.g. another window attaching) sees
                // the chronological timeline up to this point, not just
                // the bucket fields. Without this the attaching window
                // has no blocks until finalize, and falls back to the
                // legacy bucket render for the duration of the stream.
                persistTurnBody(true);
              }
            },

            onThinkingDelta: (text: string) => {
              resetStreamTimer();
              fullThinking += text;
              appendThinkingBlock(text);
              const thinkingChunk = { type: "stream:thinking_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: text };
              if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, thinkingChunk);
              else broadcastToAll(thinkingChunk);
              updateStreamContent(sessionKey, fullContent, fullThinking);
            },

            onToolStart: (toolCallId: string, name: string, args?: Record<string, unknown>) => {
              console.log(`[StreamWS] Tool start: ${name} (${toolCallId.slice(0,8)}) for ${sessionKey}`);
              // Build a typed `detail` at the boundary so the renderer doesn't
              // have to JSON-grovel `args`. Bash → shell, Read → read, Task →
              // sub_agent (empty actions, populated later by SidechainTracker
              // updates), `mcp__*` → mcp with namespace stripped, etc. See
              // `providers/claude/tool-detail.ts`. Unknown names fall through
              // to `{ type: 'unknown' }` so the legacy generic row still works.
              const detail = deriveToolDetail(name, args);
              const toolCall: ToolCall = {
                id: toolCallId, name, args: args || {},
                status: 'running', contentOffset: fullContent.length,
                detail,
                // Real-usage window opens NOW. With partial-message streaming
                // (claude-code) this is when the model starts WRITING the
                // input — the UI's duration covers generation + execution.
                startedAt: Date.now(),
              };
              // IL TURNO È VIVO. `lastActivity` lo scriveva SOLO
              // `updateStreamContent`, cioè prosa e thinking: un turno che
              // macina tool senza dire una frase era indistinguibile da un
              // processo morto, e lo spazzino degli stream fermi lo uccideva a
              // tre minuti. È il guasto dell'8 agosto 2026 — 17 tool eseguiti,
              // zero caratteri di testo, e in chat «⚠️ Risposta interrotta:
              // nessuna attività per 3 minuti» mentre il figlio girava ancora.
              // Con gli schemi MCP deferiti (ToolSearch → mount → tool) quei
              // tratti muti si sono allungati, quindi il difetto è passato da
              // raro a quotidiano. Una tool call È attività: si dichiara qui.
              updateStreamActivity(sessionKey);
              trackedToolCallIds.push(toolCallId);
              // DOPO la push, mai prima: `armSoftTimer` si sospende sull'insieme
              // che vede in questo istante. Vedi l'invariante su `armSoftTimer`.
              resetStreamTimer();
              addToolCallToLastMessage(sessionKey, toolCall);
              appendToolBlock(toolCall);
              broadcastStreamToTopic({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall }, matchedTopic?.id);

              // Also send as SSE for the HTTP client
              writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: toolCallId, function: { name, arguments: JSON.stringify(args || {}) }, contentOffset: fullContent.length }] } }] }));

              // Track sessions_spawn
              if (name === 'sessions_spawn' && matchedTopic) {
                watchSessionForSubagents(matchedTopic.id, sessionKey);
                console.log(`[SubagentPoll] sessions_spawn detected via WS in topic ${matchedTopic.id.slice(0,8)}`);
              }

              // Phase 30 BROWSER-CHAT-04 — server-side dispatch for native browser_* tools.
              // When the LLM emits a tool call with name starting with "browser_", call
              // the canonical handler directly (no HTTP roundtrip). The handler wraps
              // its action in withLock so agent_active broadcasts on entry and exit
              // (try/finally guaranteed unlock even if it throws). Result is fed back
              // through the same onToolResult update path used by every other tool, so
              // the chat UI shows identical lifecycle (running -> success/error).
              if (name.startsWith('browser_') && matchedTopic && browserService) {
                dispatchBrowserToolCall(name, args || {}, matchedTopic, browserService)
                  .then((result) => {
                    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                    // Mirror the onToolResult flow inline so the UI / SSE / persisted
                    // state updates happen consistently. Same surface as the existing
                    // onToolResult callback below.
                    const browserEndedAt = Date.now();
                    updateToolCallResult(sessionKey, toolCallId, resultStr, undefined, { endedAt: browserEndedAt });
                    updateBlockTool(toolCallId, { status: 'success', result: resultStr, endedAt: browserEndedAt });
                    broadcastStreamToTopic({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: resultStr, endedAt: browserEndedAt }, matchedTopic?.id);
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result: resultStr } } }] }));
                    settleTrackedTool(toolCallId);

                    // Close the tool→UI loop: browser_open navigates Playwright server-side,
                    // but until now nothing opened the user-visible pane. Broadcast the same
                    // `browser:navigate` event the legacy `{{BROWSER:url}}` marker path emits
                    // (see detectAndBroadcastBrowserMarker above) so usePaneOrdering's WS
                    // listener (client/src/components/Layout/hooks/usePaneOrdering.ts) opens
                    // or focuses the pane and navigates it. Also seed browserNavigatedTopics
                    // so the localhost fallback at line 443+ doesn't fire a duplicate
                    // navigate when the model later mentions the same URL in plain text.
                    if (name === 'browser_open' && matchedTopic) {
                      const urlArg = typeof (args as any)?.url === 'string' ? (args as any).url : undefined;
                      // Prefer the resolved URL the handler returns (final URL after any
                      // redirects). Fall back to the input URL if the result shape changes.
                      const resolvedUrl = (result && typeof (result as any).url === 'string')
                        ? (result as any).url as string
                        : urlArg;
                      if (resolvedUrl) {
                        // contextId so the visible pane registers under the SAME id
                        // the SDK browser_* tools resolve to (resolveContextIdForTopic),
                        // not a random one → no invisible Playwright phantom.
                        broadcastToAll({ type: "browser:navigate", topicId: matchedTopic.id, contextId: resolveContextIdForTopic(matchedTopic), url: resolvedUrl });
                        browserNavigatedTopics.add(matchedTopic.id);
                      }
                    }
                  })
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[browser-tool-dispatcher] ${name} failed: ${msg}`);
                    const errResult = JSON.stringify({ error: msg });
                    const browserErrEndedAt = Date.now();
                    updateToolCallResult(sessionKey, toolCallId, errResult, undefined, { endedAt: browserErrEndedAt });
                    updateBlockTool(toolCallId, { status: 'error', result: errResult, endedAt: browserErrEndedAt });
                    broadcastStreamToTopic({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result: errResult, endedAt: browserErrEndedAt }, matchedTopic?.id);
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'error', result: errResult } } }] }));
                    settleTrackedTool(toolCallId);
                  });
              }

              // SDK-passthrough control tools (open/create-project, switch/new-topic
              // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers).
              // Same in-turn flow as the browser dispatch above: run the side-effect
              // in-process (reuses the closure-local project helpers + AppContext
              // topic ops), then feed the confirmation (or error) back through the
              // shared onToolResult update path so the chat UI shows the normal
              // running→success/error lifecycle. Fire-and-forget: single-turn SDK
              // providers don't need the result back to continue.
              if (isControlTool(name) && matchedTopic) {
                dispatchControlToolCall(name, args || {}, matchedTopic, controlDispatchDeps)
                  .then((confirmation) => {
                    const controlEndedAt = Date.now();
                    updateToolCallResult(sessionKey, toolCallId, confirmation, undefined, { endedAt: controlEndedAt });
                    updateBlockTool(toolCallId, { status: 'success', result: confirmation, endedAt: controlEndedAt });
                    broadcastStreamToTopic({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: confirmation, endedAt: controlEndedAt }, matchedTopic?.id);
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result: confirmation } } }] }));
                    settleTrackedTool(toolCallId);
                  })
                  .catch((err: unknown) => {
                    const msg = err instanceof ControlToolError ? err.message : (err instanceof Error ? err.message : String(err));
                    console.warn(`[control-tool] ${name} failed: ${msg}`);
                    const errResult = JSON.stringify({ error: msg });
                    const controlErrEndedAt = Date.now();
                    updateToolCallResult(sessionKey, toolCallId, errResult, undefined, { endedAt: controlErrEndedAt });
                    updateBlockTool(toolCallId, { status: 'error', result: errResult, endedAt: controlErrEndedAt });
                    broadcastStreamToTopic({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result: errResult, endedAt: controlErrEndedAt }, matchedTopic?.id);
                    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'error', result: errResult } } }] }));
                    settleTrackedTool(toolCallId);
                  });
              }

              // Phase 30 BROWSER-CHAT-03 — OpenClaw browser tool profile monitoring.
              // The bridge that injected targetId+profile system messages was removed;
              // this block remains as logging-only telemetry for OpenClaw browser tool
              // calls coming through other routes (sees what profile the model picked).
              if (name === 'browser' && matchedTopic) {
                const profile = args?.profile;
                if (profile === 'topics') {
                  console.log(`[BrowserMonitor] ✓ Topic ${matchedTopic.id.slice(0,8)} using isolated browser (action: ${args?.action})`);
                } else {
                  console.warn(`[BrowserMonitor] ⚠ Topic ${matchedTopic.id.slice(0,8)} used browser with profile="${profile || 'default'}" instead of "topics"`);
                }
              }
            },

            onToolUpdate: (toolCallId: string, _partialResult: string) => {
              resetStreamTimer();
              // Broadcast partial result to clients
              broadcastStreamToTopic({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult: _partialResult }, matchedTopic?.id);
            },

            onToolActivity: (_toolCallId: string) => {
              // A tool's input is actively streaming (input_json_delta) — the
              // turn is alive even with no new field to show. Reset the stream
              // timer so a minutes-long Write/Edit input doesn't trip the false
              // "stream slow" annotation. No persistence, no broadcast.
              resetStreamTimer();
            },

            onToolArgsUpdate: (toolCallId: string, args: Record<string, unknown>) => {
              resetStreamTimer();
              // The tool was announced EARLY (input still streaming, args {})
              // and its input is now complete. Upsert the full args + a fresh
              // derived detail onto the same ToolCall — persisted row, blocks
              // timeline, and clients (stream:tool_call merges by id in
              // useChat's addToolCallToLastMessage).
              let merged: ToolCall | undefined;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === "tool" && b.toolCall.id === toolCallId) {
                  merged = { ...b.toolCall, args, detail: deriveToolDetail(b.toolCall.name, args) };
                  break;
                }
              }
              if (!merged) return; // never announced (shouldn't happen)
              updateToolCallFields(sessionKey, toolCallId, { args, detail: merged.detail });
              updateBlockTool(toolCallId, { args, detail: merged.detail });
              broadcastStreamToTopic({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall: merged }, matchedTopic?.id);
              writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: toolCallId, function: { name: merged.name, arguments: JSON.stringify(args) }, contentOffset: merged.contentOffset }] } }] }));
            },

            onUserInputRequired: (toolCallId, _toolName, schema) => {
              // A tool paused the stream to ask the user a question. The
              // detector in `server/providers/ask-user-detector.ts` already
              // validated the shape; here we just (1) mutate the on-disk
              // ToolCall row to flip status + persist the schema so a mid-
              // pause refresh re-renders the form, (2) update the chat
              // blocks timeline in-memory for the current stream, and
              // (3) broadcast a typed WS event so connected clients open
              // the form immediately. The soft inactivity timer stays
              // suspended naturally because `trackedToolCallIds` still
              // contains this id — see the `running` invariant in
              // `stream-timer.test.ts`.
              // Da qui in poi il turno non lavora: aspetta noi. Il cronometro
              // dell'attesa parte, e quel pezzo non finirà nella durata del turno.
              humanWait.open(toolCallId, Date.now());
              updateToolCallFields(sessionKey, toolCallId, {
                status: 'waiting_for_input',
                userInputSchema: schema,
              });
              updateBlockTool(toolCallId, {
                status: 'waiting_for_input',
                userInputSchema: schema,
              });
              broadcastToAll({
                type: 'stream:tool_user_input_required',
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId,
                schema,
              });
            },

            onSubAgentUpdate: (parentToolCallId, snapshot) => {
              resetStreamTimer();
              // Patch the parent Task tool's `detail` with the latest sub-agent
              // snapshot. Each call replaces the full actions[] (snapshot, not
              // delta) so the renderer always shows the current truth. Same
              // callId used as the regular tool_call channel — the client
              // matches by id and merges. We also persist via updateBlockTool
              // so a mid-stream reload sees the in-progress sub-agent activity.
              const detail: import("../types").ToolCallDetail = {
                type: "sub_agent",
                ...(snapshot.subAgentType ? { subAgentType: snapshot.subAgentType } : {}),
                ...(snapshot.description ? { description: snapshot.description } : {}),
                actions: snapshot.actions,
                ...(snapshot.result ? { result: snapshot.result } : {}),
              };
              updateBlockTool(parentToolCallId, { detail });
              // Alla topic, non a tutti. Questo è lo snapshot INTERO del
              // sotto-agente — actions[] ricostruito a ogni colpo, i frame più
              // grossi del turno — ed era l'unico callback di tool rimasto su
              // `broadcastToAll` mentre i vicini passavano già da
              // `broadcastStreamToTopic`. Ogni finestra aperta su un'altra topic
              // li riceveva tutti per instradarli su `topicId` e buttarli.
              broadcastStreamToTopic({
                type: "stream:tool_detail",
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId: parentToolCallId,
                detail,
                finished: snapshot.finished,
              }, matchedTopic?.id);
            },

            onToolResult: (toolCallId: string, result: string, isError?: boolean) => {
              // IL TURNO È VIVO, e lo si dichiara SUBITO — come in `onToolStart`,
              // e per la stessa ragione: lo spazzino degli stream fermi guarda
              // `lastActivity`, e un risultato di tool è attività. Il riarmo del
              // watchdog invece va in fondo, con `settleTrackedTool`: farlo qui
              // vorrebbe dire riarmarlo mentre questo tool risulta ancora in
              // corso, cioè non riarmarlo affatto (vedi `armSoftTimer`).
              updateStreamActivity(sessionKey);
              // Se questo tool stava aspettando una risposta, l'attesa finisce
              // qui: da adesso è di nuovo lavoro. Sui tool che non hanno mai
              // chiesto niente non fa nulla.
              humanWait.close(toolCallId, Date.now());
              const status = isError ? 'error' : 'success';
              console.log(`[StreamWS] Tool result: ${toolCallId.slice(0,8)} ${status} for ${sessionKey}`);

              // Re-derive detail with result so per-kind body fields (shell.output,
              // read.content, fetch.result) are populated for the renderer. We
              // need the original tool name + args to build it — read them off
              // the in-memory blocks (the running ToolCall is already there
              // courtesy of onToolStart).
              let detail: import("../types").ToolCallDetail | undefined;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === "tool" && b.toolCall.id === toolCallId) {
                  detail = deriveToolDetail(b.toolCall.name, b.toolCall.args, result);
                  break;
                }
              }

              const endedAt = Date.now();
              if (isError) {
                // Pass result as the error so updateToolCallResult sets status='error'
                // and the row renders red ✗ + error body. The Claude SDK puts the
                // failure message inside `tool_result.content` so `result` IS the
                // error text — passing it as both result and error is intentional.
                updateToolCallResult(sessionKey, toolCallId, result, result, { endedAt });
                updateBlockTool(toolCallId, { status: 'error', result, error: result, endedAt, ...(detail ? { detail } : {}) });
                broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result, error: result, detail, endedAt }, matchedTopic?.id);
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'error', result, error: result } } }] }));
              } else {
                updateToolCallResult(sessionKey, toolCallId, result, undefined, { endedAt });
                updateBlockTool(toolCallId, { status: 'success', result, endedAt, ...(detail ? { detail } : {}) });
                broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result, detail, endedAt }, matchedTopic?.id);
                writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: { id: toolCallId, status: 'success', result } } }] }));
              }
              // Le shell in background non finiscono col tool: restano.
              // Registrarle qui è l'unico punto in cui passano — dopo, esistono
              // solo nel transcript. Vedi `providers/claude/background-shell.ts`.
              trackBackgroundShell(detail, result, isError === true);

              // Fuori dall'insieme dei tool in corso, e solo ORA il watchdog
              // torna armato: era l'ultimo, e il silenzio che segue è silenzio.
              settleTrackedTool(toolCallId);
            },

            onToolUsage: (toolCallId, u) => {
              // Il costo di UNA azione, non del turno. Il provider ha già
              // spartito la quota della chiamata fra i suoi tool_use; qui si
              // traduce in prezzo con le STESSE tariffe del consuntivo, così la
              // somma delle azioni combacia col totale in fondo al messaggio.
              // Il client non fa aritmetica: riceve costo e token già pronti.
              const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
              let costCents: number | undefined;
              try {
                const parts = turnUsageParts(accumulateTurnUsage(emptyTurnUsage(), u));
                const usd = calculateCostWithCache({
                  model: u.model || liveModel || overrideModel || "unknown",
                  freshInputTokens: parts.fresh,
                  outputTokens: parts.output,
                  cacheReadTokens: parts.cacheRead,
                  cacheCreationTokens: parts.cacheCreation5m,
                  cacheCreation1hTokens: parts.cacheCreation1h,
                });
                if (usd > 0) costCents = Math.round(usd * 100);
              } catch { /* modello sconosciuto: si mostrano i token senza prezzo */ }
              const patch: Partial<ToolCall> = { tokens };
              if (costCents != null) patch.costCents = costCents;
              updateToolCallFields(sessionKey, toolCallId, patch);
              updateBlockTool(toolCallId, patch);
              broadcastStreamToTopic({
                type: "stream:tool_usage",
                sessionKey,
                topicId: matchedTopic?.id,
                toolCallId,
                tokens,
                ...(costCents != null ? { costCents } : {}),
              }, matchedTopic?.id);
            },

            onCompaction: (marker) => {
              // CHAT-COMPACT-01: surface + persist a context-compaction boundary
              // as a display-only divider. Render-only — no model resume, and
              // the marker never re-enters provider history (separate table).
              try {
                resetStreamTimer();
                compactedThisTurn = true;
                const stored = insertCompactionMarkerIfNew(ctx.db, {
                  sessionKey,
                  topicId: matchedTopic?.id ?? null,
                  afterMessageId: partialMsg?.parentId ?? null,
                  marker,
                });
                const evt = {
                  type: "stream:compaction" as const,
                  sessionKey,
                  topicId: matchedTopic?.id,
                  markerId: stored.id,
                  afterMessageId: stored.afterMessageId,
                  trigger: stored.trigger,
                  ...(stored.preTokens != null ? { preTokens: stored.preTokens } : {}),
                  createdAt: stored.createdAt,
                };
                if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, evt);
                else broadcastToAll(evt);
              } catch (err) {
                console.error("[compaction] persist/broadcast failed:", err);
              }
            },

            onPlan: (steps) => {
              // 3.4: il piano dell'agente diventa i PASSI del goal della topic,
              // non testo del trascritto — così sopravvive alla compattazione
              // (l'envelope lo re-inietta) invece di scorrere via con la chat.
              //
              // Senza un goal attivo NON se ne inventa uno: un obiettivo
              // dedotto da un elenco di passi è esattamente il tipo di
              // deduzione che poi l'umano si ritrova iniettata nel contesto
              // senza averla mai scritta. Il piano resta comunque visibile
              // nella chat come TodoCard; qui non ha dove attaccarsi.
              try {
                resetStreamTimer();
                const topicId = matchedTopic?.id;
                if (!topicId) return;
                const goal = getActiveGoal(ctx.db, topicId);
                if (!goal) return;
                replaceSteps(ctx.db, goal.id, steps);
                broadcastToAll({
                  type: "goal:updated" as const,
                  topicId,
                  goal: getActiveGoal(ctx.db, topicId),
                });
              } catch (err) {
                console.error("[goal] plan persist failed:", err);
              }
            },

            onCallUsage: (u) => {
              // Si ACCUMULA: il provider manda l'usage di UNA chiamata, e il
              // `result` finale somma già tutto — sommare anche quello sarebbe
              // contare due volte. Il client non fa aritmetica: riceve i totali.
              live = accumulateTurnUsage(live, u);
              if (u.model) liveModel = u.model;
              if (!matchedTopic) return;
              // Lo SCORPORO, una volta sola e FUORI dal try.
              //
              // `live` porta le quote come le manda l'API: annidate, cioè
              // `cacheCreation` è il TOTALE e `cacheCreation1h` una sua parte.
              // Le colonne di `messages` e i campi del filo vogliono l'opposto
              // (quote disgiunte, migration 070). Prima questa traduzione stava
              // dentro il `try` del prezzo e serviva solo a lui: la riga salvata
              // e il frame WS prendevano i grezzi, cioè sommavano due volte la
              // scrittura in cache. Sta fuori perché è pura e non può lanciare,
              // e perché un fallimento del PREZZO non deve poter rimettere in
              // giro i numeri annidati.
              const parts = turnUsageParts(live);
              // La stessa cosa nella forma di `messages` e del frame WS: una
              // porta sola per la riga salvata e per il filo.
              const wire = turnUsageWire(live);
              // Costo corrente, con le stesse tariffe del consuntivo: il fresco è
              // il RESTO (mai negativo), le due durate di cache pagano la loro.
              let liveCost: number | undefined;
              try {
                const usd = calculateCostWithCache({
                  model: liveModel || overrideModel || "unknown",
                  freshInputTokens: parts.fresh,
                  outputTokens: parts.output,
                  cacheReadTokens: parts.cacheRead,
                  cacheCreationTokens: parts.cacheCreation5m,
                  cacheCreation1hTokens: parts.cacheCreation1h,
                });
                if (usd > 0) liveCost = Math.round(usd * 100);
              } catch { /* modello sconosciuto: si mostrano i token senza prezzo */ }
              // Gli stessi numeri, anche SULLA RIGA e non solo sul filo.
              //
              // Il broadcast lo vede chi è collegato in quel momento; chi apre
              // la chat dopo, o ricarica, o guarda un turno fermo su una
              // domanda, leggeva una riga senza consumo — e la striscia di
              // chiusura restava con la sola durata, senza token né prezzo.
              // Scriverli qui li rende durevoli: la finalizzazione poi li
              // sovrascrive coi totali definitivi del provider.
              try {
                updateLastMessage(sessionKey, {
                  usagePromptTokens: wire.promptTokens,
                  usageCompletionTokens: wire.completionTokens,
                  cacheReadTokens: wire.cacheReadTokens,
                  cacheCreationTokens: wire.cacheCreationTokens,
                  cacheCreation1hTokens: wire.cacheCreation1hTokens,
                  ...(liveCost != null ? { costCents: liveCost } : {}),
                  ...(liveModel ? { model: liveModel } : {}),
                });
              } catch (err) { console.warn(`[usage] consumo vivo non scritto su ${sessionKey}:`, err); }
              broadcastToAll({
                type: "stream:usage",
                sessionKey,
                topicId: matchedTopic.id,
                calls: live.calls,
                ...wire,
                ...(liveCost != null ? { costCents: liveCost } : {}),
                ...(liveModel ? { model: liveModel } : {}),
              });
            },
            onContextSize: (tokens, model, windowTokens) => {
              // 1) Il ring del contesto reale (1b.5). Questo numero — il
              //    prompt di UNA chiamata — è l'unica misura onesta di "quanto
              //    ha in pancia il modello", e fino a ieri moriva qui dentro:
              //    serviva solo a riempire il marker di compaction. La barra
              //    che l'umano vedeva misura un'altra cosa (il preventivo
              //    dell'envelope che iniettiamo NOI), quindi di fatto il dato
              //    più guardato a ogni turno non era da nessuna parte.
              try {
                // Forma standard `usage_update` ACP (3.1): il payload lo
                // costruisce un posto solo, così l'evento vivo e
                // `GET /api/context/live` non possono divergere.
                const update = buildContextUpdate({ tokens, model, fallbackModel: spawnedModel, windowTokens });
                // Scrittura solo quando il numero cambia davvero: in un turno
                // lungo questo handler scatta a ogni chiamata al modello.
                if (update.usage.used !== lastContextUsed) {
                  lastContextUsed = update.usage.used;
                  recordSessionContext(ctx.db, {
                    sessionKey,
                    usedTokens: update.usage.used,
                    windowTokens: update.usage.size,
                    estimated: update.estimated,
                    model: model ?? spawnedModel ?? null,
                  });
                  const uevt = {
                    type: "stream:context" as const,
                    sessionKey,
                    topicId: matchedTopic?.id,
                    ...update,
                  };
                  if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, uevt);
                  else broadcastToAll(uevt);
                }
              } catch (err) { console.error("[context] ring update failed:", err); }

              // 2) Post-compaction context size. The FIRST model call after the
              // boundary is the only honest measurement: its prompt IS the
              // compacted context. Previously this was backfilled from the
              // final `result` usage, which AGGREGATES every call in the turn —
              // so a long turn reported a post-compaction size far bigger than
              // the pre one and the divider read "48.9k → 1.2M token", i.e. the
              // context appeared to EXPLODE during compaction.
              if (!compactedThisTurn || postCompactionFilled) return;
              postCompactionFilled = true;
              try {
                const filled = backfillPostTokens(ctx.db, sessionKey, tokens);
                if (!filled) return;
                const cevt = {
                  type: "stream:compaction" as const,
                  sessionKey,
                  topicId: matchedTopic?.id,
                  markerId: filled.id,
                  afterMessageId: filled.afterMessageId,
                  trigger: filled.trigger,
                  ...(filled.preTokens != null ? { preTokens: filled.preTokens } : {}),
                  ...(filled.postTokens != null ? { postTokens: filled.postTokens } : {}),
                  createdAt: filled.createdAt,
                };
                if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, cevt);
                else broadcastToAll(cevt);
              } catch (err) { console.error("[compaction] backfill failed:", err); }
            },

            onDone: (message?: any) => {
              // Extract final content from message if available
              if (message) {
                const finalText = extractFinalText(message);
                if (finalText && finalText.length > fullContent.length) {
                  const extra = finalText.slice(fullContent.length);
                  if (extra) {
                    fullContent = finalText;
                    if (extra) {
                      const extraChunk = { type: "stream:content_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: extra };
                      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, extraChunk);
                      else broadcastToAll(extraChunk);
                    }
                  }
                }
                // Capture provider-reported usage so the message footer can
                // render. Different providers shape this slightly differently:
                // claude-code → `{ input_tokens, output_tokens, ... }`,
                // codex → `{ inputTokens, outputTokens, totalTokens }`.
                const usage = message.usage;
                if (usage && typeof usage === "object") {
                  const inTok = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
                  const outTok = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
                  if (typeof inTok === "number") usagePromptTokens = inTok;
                  if (typeof outTok === "number") usageCompletionTokens = outTok;
                  // Lo scorporo della cache si calcola SEMPRE, prima e a
                  // prescindere dal costo.
                  //
                  // Prima viveva solo dentro il ramo `else if` qui sotto — quello
                  // che deriva il prezzo quando il provider non lo dà — e
                  // claude-code il prezzo lo dà quasi sempre (`total_cost_usd`).
                  // Quindi nel caso NORMALE lo split non veniva nemmeno calcolato,
                  // e la quota di cache era invisibile proprio sui turni dove è
                  // enorme. Ma la composizione dei token è un FATTO del turno, non
                  // un sottoprodotto del calcolo del prezzo: si misura sempre.
                  if (typeof inTok === "number") {
                    try {
                      const s = splitPromptTokens({
                        promptTokensTotal: inTok,
                        cacheReadTokens: usage.cacheRead,
                        cacheCreationTokens: usage.cacheCreation,
                      });
                      // Le due durate sono quote disgiunte: quel che non è a un'ora
                      // è a cinque minuti. `min` perché il provider potrebbe
                      // riportare un 1h maggiore del totale di scrittura scorporato
                      // (arrotondamenti fra chiamate), e un negativo qui
                      // avvelenerebbe sia la resa sia il prezzo.
                      const w1h = Math.min(usage.cacheCreation1h ?? 0, s.cacheCreation);
                      cacheReadTokens = s.cacheRead;
                      cacheCreationTokens = s.cacheCreation - w1h;
                      cacheCreation1hTokens = w1h;
                    } catch { /* modello sconosciuto o usage incoerente: nessuno scorporo */ }
                  }
                  // NB: `inTok` here is the TURN AGGREGATE (the CLI sums usage
                  // across every model call in the turn), which is fine for
                  // cost/tokens accounting below but is NOT a context size.
                  // The post-compaction size is filled by onContextSize above,
                  // from the first single call after the boundary.
                  // Cost: try the provider field first, then derive via the
                  // existing per-model price table when both token counts exist.
                  // Il modello vale a prescindere da CHI ha calcolato il costo:
                  // serve tanto per attribuire la spesa quanto per sapere, se un
                  // domani la tariffa cambia, quale riga rifare.
                  //
                  // `liveModel` in mezzo NON è un ornamento: l'evento `result`
                  // della CLI non porta il modello (vedi `RESULT_OK` in
                  // events.fixture.ts), e su un topic che non ne fissa uno
                  // `overrideModel` è vuoto. Senza questo anello il consuntivo
                  // risolveva "unknown", `calculateCostWithCache` tornava 0, il
                  // `if (usd > 0)` non scattava e il COALESCE della UPDATE
                  // lasciava in piedi qualunque costo ci fosse già.
                  //
                  // Misurato sulla riga b26bd2e2 (topic ec3137d0, 13/08): 111
                  // centesimi salvati contro 132 calcolati sulle sue quote
                  // vere. La differenza è 21 centesimi, cioè ESATTAMENTE gli
                  // 8.216 token di risposta a 25$/M: il numero salvato era il
                  // costo del solo input. Quale scrittura l'abbia lasciato lì
                  // non è ricostruibile a posteriori e non serve saperlo: con
                  // il modello risolto il consuntivo ricalcola e sovrascrive,
                  // che è la proprietà che mancava.
                  //
                  // Da non ripetere: il contatore di output VIVO non è un
                  // segnaposto, contrariamente a quanto sembrava leggendo una
                  // riga `partial=1` a metà turno. Ricostruito dal transcript
                  // (eventi `assistant` deduplicati per `message.id`) l'accumulo
                  // per chiamata di quella sessione fa 32.195 token di risposta,
                  // e la somma dei `usage_completion_tokens` finalizzati nel DB
                  // fa 32.195: combacia al token.
                  const modelOfTurn = message.model || liveModel || overrideModel || undefined;
                  if (typeof modelOfTurn === "string" && modelOfTurn) usageModel = modelOfTurn;
                  // ── IL COSTO DELLA CLI: TROVATO, E LASCIATO DOV'È ─────────
                  // `usage.costUsd` non esiste per claude-code: il provider
                  // consegna il costo come FRATELLO di `usage`
                  // (`claude-code.ts` passa `costUsd: event.total_cost_usd`
                  // accanto a `usage: readResultUsage(event)`). Questo ramo
                  // quindi non è mai scattato in produzione, e ogni prezzo
                  // che l'app ha mai mostrato lo ha calcolato la nostra
                  // tabella. Non è un bug che valga la pena "riparare" al
                  // buio: leggere il livello giusto significherebbe sostituire
                  // il numero mostrato ovunque con uno mai messo alla prova.
                  //
                  // ── COSA DICE LA MISURA (probe controllate, 13/08/2026) ────
                  // Due `claude --print` su haiku, sessione nuova poi ripresa:
                  //     chiamata 1 ....  $0,080838   (cc 40.015, cr 0)
                  //     chiamata 2 ....  $0,0042665  (cr 40.015, cc 60)
                  // Il secondo è VENTI VOLTE più piccolo del primo, quindi
                  // `total_cost_usd` è PER TURNO, non cumulativo di sessione.
                  // Su quella coppia combacia con la nostra tabella a cinque
                  // decimali ($0,00427 calcolati contro $0,0042665 riportati).
                  //
                  // Ma su un turno che DELEGA non si riconcilia più, e in un
                  // modo che non sappiamo ancora leggere: una sola invocazione
                  // col tool `Task` ha emesso DUE eventi `result` (entrambi
                  // `subtype: success`, nessun evento con `parentToolUseId`), e
                  // il costo di ognuno stava fra 1,3× e 7,8× sopra il prezzo
                  // dei token che quel `result` dichiara. Cioè il numero del
                  // provider comprende lavoro che il suo stesso `usage` non
                  // mostra — probabilmente le sotto-sessioni, che è la stessa
                  // cosa che ha fatto nascere `services/dispatch-usage.ts`.
                  //
                  // Il nostro numero invece riconcilia sempre: combacia al
                  // centesimo con la nostra tabella su 5 turni veri su 5 del
                  // 13/08 (`usage/pricing.ts`, sotto test). Quindi resta il
                  // nostro, con un limite DICHIARATO: su un turno che delega,
                  // il costo mostrato è un PAVIMENTO, non il totale. Adottare
                  // `total_cost_usd` va fatto quando si sa spiegare il doppio
                  // `result` — non prima, perché significherebbe sostituire
                  // ovunque un numero verificabile con uno che non lo è.
                  //
                  // (Il secondo `result` non ci fa doppio conteggio: `onDone`
                  // azzera `pp.streamHandler`, quindi l'evento dopo trova un
                  // handler nullo e cade — `claude-code.ts:2773`.)
                  //
                  // Resta letto per gli altri provider, che il costo lo
                  // mettono davvero dentro `usage`.
                  const usdFromProvider = typeof usage.costUsd === "number" ? usage.costUsd : undefined;
                  if (usdFromProvider != null) {
                    costCents = Math.round(usdFromProvider * 100);
                  } else if (typeof inTok === "number" && typeof outTok === "number") {
                    try {
                      // Riusa lo scorporo già calcolato sopra invece di rifarlo: era
                      // duplicato, e due copie della stessa aritmetica sullo stesso
                      // usage sono due occasioni di divergere.
                      //
                      // Perché lo scorporo serve al PREZZO: `inTok` comprende i token
                      // letti DALLA CACHE, e in un turno agentico lungo sono la quota
                      // schiacciante. Tariffarli come input fresco moltiplicava il
                      // costo per ~10 (un turno da ~$9 mostrato a $90). Le due durate
                      // di scrittura hanno tariffe diverse (2× a un'ora, 1.25× a
                      // cinque minuti) e vanno pagate ognuna la sua.
                      const fresh = inTok - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0) - (cacheCreation1hTokens ?? 0);
                      const usd = calculateCostWithCache({
                        model: modelOfTurn || "unknown",
                        freshInputTokens: Math.max(0, fresh),
                        outputTokens: outTok,
                        cacheReadTokens: cacheReadTokens ?? 0,
                        cacheCreationTokens: cacheCreationTokens ?? 0,
                        cacheCreation1hTokens: cacheCreation1hTokens ?? 0,
                      });
                      if (usd > 0) costCents = Math.round(usd * 100);
                    } catch { /* unknown model — skip cost, keep tokens */ }
                  }
                }
              }
              finalizeStream("done", undefined, message?.turnEnd);
            },

            onError: (error: string) => {
              console.error(`[StreamWS] Error for ${sessionKey}: ${error}`);
              // Il turno e' fallito: il preambolo marcato come consegnato potrebbe
              // non esserlo mai stato (PROCESS_DEAD rigetta PRIMA di scrivere su
              // stdin). Nel dubbio si rimanda: due token in piu' contro un modello
              // che non sa in che progetto si trova.
              undoInlineMark();
              finalizeStream("error", error);
            },

            onAborted: (message?: any) => {
              // Extract content from aborted message
              if (message) {
                const abortedText = extractFinalText(message);
                if (abortedText && abortedText.length > fullContent.length) {
                  fullContent = abortedText;
                }
              }
              finalizeStream("aborted", undefined, message?.turnEnd);
            },
          };

          // Helper to extract text from final/aborted message
          function extractFinalText(message: any): string | null {
            if (!message) return null;
            if (typeof message.text === "string") return message.text;
            if (typeof message.content === "string") return message.content;
            if (Array.isArray(message.content)) {
              return message.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("");
            }
            return null;
          }

          resetStreamTimer();

          // Send chat via WS
          try {
            // Re-shape the canonical envelope for the actual provider strategy.
            // The system blocks and history were already assembled in one
            // pass by `assembleTopicContext` above (with a placeholder
            // strategy); `adaptEnvelope` is a pure function so the second
            // call is essentially free.
            //
            // The dual-output here mirrors what the legacy supportsHistory
            // branch produced:
            //   - history-aware (claude, openai, codex):
            //       payload.history = [composed system msgs..., ...stripped DB history]
            //       payload.userContent = the new user turn verbatim
            //   - inline-system (claude-code):
            //       payload.userContent = "<context>...</context>\n\n${user}"
            //       payload.history = undefined (CLI session keeps its own state)
            //   - gateway-stateful (openclaw):
            //       same shape as history-aware; gateway may ignore `history`
            //       on the happy path and use its session state instead.
            const envForProvider: ContextEnvelope = {
              ...envelope,
              providerName: topicProvider.name,
              providerStrategy: getProviderStrategy(topicProvider),
            };
            // Push the envelope to the in-memory snapshot ring BEFORE the
            // adapter so what the inspector shows is exactly what we hand
            // to the provider. Best-effort — never throws.
            try { pushSnapshot(envForProvider); } catch (e) { console.warn("[Context] pushSnapshot failed:", e); }

            // Deduplicazione del preambolo inline: la CLI process-resident ha
            // già in conversazione ciò che le abbiamo detto ai turni scorsi, e
            // riappenderlo costa in modo COMPOSTO (i token del turno k li
            // rilegge ogni chiamata successiva). Lo scope lega la memoria a UNA
            // conversazione CLI: sessione nuova o compattazione ⇒ mappa vuota ⇒
            // il contesto completo riparte da solo.
            const dedupOff = process.env.TOPICS_INLINE_CONTEXT_DEDUP === "0";
            const sentScope = dedupOff ? null : inlineScope(
              readClaudeSessionId(ctx, sessionKey),
              countCompactions(ctx, sessionKey),
            );
            const payload = adaptEnvelope(
              envForProvider,
              sentScope ? { alreadySent: getInlineSentState(sessionKey, sentScope) } : undefined,
            );
            // Marcatura OTTIMISTICA: `sendChat` risolve a turno avviato, e un
            // secondo messaggio accodato prima di allora si comporrebbe con la
            // mappa vecchia, riemettendo tutto. Il caso speculare — marcato ma mai
            // arrivato — lo chiude `undoInlineMark`, chiamato da `onError` (dove
            // finiscono TIMEOUT, RATE_LIMIT, PROCESS_DEAD: `sendChat` non rigetta
            // su nessuno di quelli) e dal `.catch` per i throw sincroni.
            rollbackInlineSent = (sentScope && payload.inlineSlots)
              ? markInlineSent(sessionKey, sentScope, payload.inlineSlots)
              : null;
            const userContent = payload.userContent;
            const historyForProvider = payload.history;

            // Register handler BEFORE sendChat so tool events arriving during the await aren't lost.
            // Use undefined runId initially — the sentinel filter in gateway-ws.ts handles stale events.
            topicProvider.registerStreamHandler?.(sessionKey, undefined, handler);
            const sendOptions: { model?: string; history?: ChatMessage[]; tools?: Tool[]; resetFallbackContent?: string; fastMode?: boolean } = {};
            if (overrideModel) sendOptions.model = overrideModel;
            // La richiesta di fast mode viaggia COME richiesta: decide il
            // provider, che la gira alla CLI solo se la CLI ha detto di poterla
            // servire. Qui non si sceglie nessun modello al posto suo.
            if (fastModeActive) sendOptions.fastMode = true;
            // Se abbiamo deduplicato, diamo al provider anche la versione integra:
            // gli serve se la sessione CLI muore e deve rispedire su una appena
            // coniata, che il preambolo non l'ha mai visto. `adaptEnvelope` è pura,
            // quindi ricomporlo senza `alreadySent` costa quanto una join di stringhe.
            if (sentScope && payload.inlineSlots) {
              const full = adaptEnvelope(envForProvider).userContent;
              if (full !== userContent) sendOptions.resetFallbackContent = full;
            }
            if (historyForProvider) sendOptions.history = historyForProvider;
            // Phase 30 BROWSER-CHAT-04 — register browserTools for SDK-driven providers.
            // CLI/gateway providers (codex, claude-code, openclaw) ignore this field
            // (their tool surfaces are managed upstream).
            //
            // Also register the control tools (open/create-project, switch/new-topic
            // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers;
            // spec: replace-markers-with-tools). Unlike browserTools these don't need
            // browserService, so a passthrough provider always gets AI-initiated
            // control even in a build without the browser pane.
            if (isPassthroughProvider(topicProvider.name)) {
              sendOptions.tools = [
                ...(browserService ? browserTools : []),
                ...controlTools,
              ];
            }
            // Fire-and-forget: kick off sendChat WITHOUT awaiting so the
            // Response can be returned immediately. The provider's stream
            // for-await loop drives handler callbacks → writeSSE → flushes
            // deltas live to the client. Awaiting here would buffer the
            // whole stream into the TransformStream and release it all at
            // once when the Response is finally returned.
            // Reattach mode (ai-bridge restart recovery): adopt the turn still
            // running in the broker and drive it to completion, instead of
            // starting a new one. No user message is sent; everything else
            // (handler, partial row, SSE, finalize) is reused.
            //
            // NIENTE RIPIEGO SU `sendChat`. Qui c'era un ternario che, se il
            // provider non sapeva riattaccarsi, mandava un turno normale — e su
            // un riattacco `userContent` è il solo preambolo `<context>` con
            // NESSUNA domanda (`messages: []` è il suo formato). Non era un
            // degrado, era un turno fabbricato: una chiamata pagata al modello
            // che rispondeva «Ciao! Come posso aiutarti con <nome del topic>?»
            // e finiva in chat al posto della risposta vera, su una sessione
            // che aveva già un turno in volo (il cancello 409 è disattivato per
            // i riattacchi, ed è giusto così). Il caso ora è respinto a monte,
            // prima della riga parziale e di qualunque stream: vedi la guardia
            // `reattach_unsupported` alla risoluzione del provider. `!` qui è
            // sostenuto da quella guardia, non da un'assunzione.
            const reattachFn = (topicProvider as unknown as { reattach?: (sk: string, h: StreamHandler) => Promise<string> }).reattach;
            // Il turno spontaneo si adotta in modo SINCRONO: i suoi eventi sono
            // già nel provider, non c'è nessuno store da rileggere. `false` = fra
            // la sveglia e adesso qualcun altro ha preso la sessione (o il figlio
            // è morto): il turno non è nostro e questa gamba finisce subito,
            // senza scrivere niente sopra la riga.
            const adoptWoken = (topicProvider as unknown as { adoptWokenTurn?: (sk: string, h: StreamHandler) => boolean }).adoptWokenTurn;
            const drive = isWoken
              ? (adoptWoken!.call(topicProvider, sessionKey, handler)
                  ? Promise.resolve({ runId: "woken" })
                  : Promise.reject(new Error("WOKEN_TURN_GONE")))
              : isReattach
              ? reattachFn!.call(topicProvider, sessionKey, handler).then((outcome) => ({ runId: outcome }))
              : topicProvider.sendChat(
                  sessionKey,
                  userContent,
                  handler,
                  Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
                );
            drive.then((result) => {
              topicProvider.registerStreamHandler?.(sessionKey, result.runId, handler);
              // Il primo turno di una sessione CLI ha composto lo scope quando la
              // riga di `claude_code_sessions` non esisteva ancora — la crea lo
              // spawn, dentro questa stessa sendChat. Ora l'id c'è: sposta lo stato
              // sotto lo scope definitivo, invece di lasciarlo sotto `(none)#N` e
              // farlo buttare al turno successivo (un preambolo intero in più,
              // inchiodato nella conversazione e riletto per sempre).
              // Solo a pari conteggio di compattazioni: se ne è arrivata una, il
              // preambolo se l'è portato via e rimandarlo è l'esito corretto.
              if (sentScope && payload.inlineSlots) {
                try {
                  const settled = inlineScope(readClaudeSessionId(ctx, sessionKey), countCompactions(ctx, sessionKey));
                  rekeyInlineSent(sessionKey, sentScope, settled);
                } catch { /* best-effort: al peggio si rimanda il contesto */ }
              }
              console.log(`[StreamWS] chat.send OK for ${sessionKey}, runId: ${result.runId}`);
            }).catch(async (err: any) => {
              // «IL RISVEGLIO NON È PIÙ MIO» NON È UN GUASTO.
              //
              // `adoptWokenTurn` torna `false` quando fra la sveglia e adesso
              // qualcun altro ha preso la sessione — tipicamente l'utente che
              // scrive mentre il Monitor consegna — o il figlio è morto. Nel
              // primo caso la risposta arriva lo stesso, sull'ALTRO turno:
              // scriverci sopra «⚠️ Non sono riuscito ad avviare il turno»
              // sarebbe un allarme in mezzo a una chat che funziona, per un
              // turno che l'utente non ha nemmeno chiesto.
              //
              // Si chiude in silenzio, quindi: la riga aperta viene tolta di
              // mezzo (a questo punto è sempre vuota — non è arrivato un byte) e
              // il log dice cos'è successo. Ogni ALTRO errore resta rumoroso.
              if (isWoken && err?.message === "WOKEN_TURN_GONE") {
                console.log(`[StreamWS] ${sessionKey}: il turno spontaneo era già stato preso da qualcun altro — chiudo senza scrivere niente`);
                undoInlineMark();
                topicProvider.unregisterStreamHandler?.(sessionKey);
                endStream(sessionKey);
                streamState = "finalized";
                // `discardIfEmptyTurn` vuole la RIGA, non un id, e verifica in
                // SQL che non ci siano blocchi o tool (una riga di soli tool non
                // è vuota). Qui non è arrivato un byte: la riga sparisce.
                try {
                  const vuota = updateLastMessage(sessionKey, { partial: undefined, streamedAt: undefined });
                  const scartata = discardIfEmptyTurn(sessionKey, vuota);
                  if (scartata) console.log(`[StreamWS] ${sessionKey}: riga del risveglio non adottato scartata (${scartata})`);
                } catch (e) { console.warn(`[StreamWS] ${sessionKey}: riga del risveglio non ripulita:`, e); }
                await writeSSE("[DONE]");
                await closeClient();
                return;
              }
              console.error(`[StreamWS] chat.send failed for ${sessionKey}:`, err);
              // Il turno non è mai arrivato alla CLI: quel preambolo non è in
              // sessione, e il prossimo messaggio deve tornare a portarlo. Qui
              // restano i throw sincroni; la classe grossa passa da `onError`.
              undoInlineMark();
              topicProvider.unregisterStreamHandler?.(sessionKey);
              endStream(sessionKey);
              // Il turno è chiuso: un `onDone` in ritardo non deve riaprirlo e
              // riscrivere la riga da `finalizeStream`. Mancava, ed era un buco
              // — non una decisione.
              streamState = "finalized";
              const errorMsg = closeTurnWithFailure(err, partialMsg.id);
              await writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }));
              await writeSSE("[DONE]");
              await closeClient();
            });
          } catch (err: any) {
            console.error(`[StreamWS] sync setup error for ${sessionKey}:`, err);
            topicProvider.unregisterStreamHandler?.(sessionKey);
            endStream(sessionKey);
            // Come il gemello asincrono: il turno è chiuso, e i timer del
            // watchdog sono ancora armati.
            streamState = "finalized";
            const errorMsg = closeTurnWithFailure(err, partialMsg.id);
            await writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: "stop" }] }));
            await writeSSE("[DONE]");
            await closeClient();
            return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
          }

          // Return SSE response — events will be pushed by the handler.
          // `no-transform` + `X-Accel-Buffering: no` tell every proxy in
          // the chain (vite-dev, electron, nginx) NOT to coalesce the
          // body into chunks of their own. Without these the user sees
          // the whole message arrive at once on stream-end instead of
          // progressive deltas.
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });

        } catch (err: any) {
          console.error(`[StreamWS] Unexpected error for ${sessionKey}:`, err);
          // Uscire di qui con un 502 e basta lasciava tre cose sul campo: la
          // riga assistente APERTA (e `partial` è il perno che il setaccio di
          // boot legge per decidere chi è vivo), lo stream registrato in
          // memoria — quindi la chat che gira per sempre nelle altre finestre —
          // e nessuna traccia del perché. Il 3 agosto quella riga è finita
          // etichettata «No response received. The AI service may be
          // temporarily unavailable»: generico, e falso, perché il guasto era
          // nostro. Si chiude qui, dicendo cosa è successo davvero.
          try {
            endStream(sessionKey);
            if (crashedPartialId) {
              const notice = crashedTurnNotice(readRowForNotice(crashedPartialId), err);
              // Il flag `partial` cade comunque: aperta, quella riga farebbe
              // credere a un turno in volo che non esiste più.
              if (notice) db.prepare("UPDATE messages SET content = ?, partial = 0 WHERE id = ?").run(notice, crashedPartialId);
              else db.prepare("UPDATE messages SET partial = 0 WHERE id = ?").run(crashedPartialId);
              if (matchedTopic) {
                broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: notice ?? `Errore interno di Topics: ${shortErrorDetail(err)}` });
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: crashedPartialId });
              }
            }
          } catch (cleanupErr) {
            // La pulizia non deve mai coprire il guasto vero.
            console.error(`[StreamWS] anche la chiusura del turno è fallita su ${sessionKey}:`, cleanupErr);
          }
          return json({ error: "Gateway WS error: " + err.message }, 502);
        }

      } else {
        // === Fallback: HTTP SSE (original approach — no tool visibility) ===
        console.log(`[Stream] Using HTTP SSE fallback (provider ${topicProvider.connected ? 'connected but no WS' : 'disconnected'})`);
        try {
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 300000);

          let resp: Response;
          if (topicProvider.streamHTTP) {
            resp = await topicProvider.streamHTTP(finalMessages, { sessionKey, signal: abortController.signal });
          } else {
            // Provider doesn't support streamHTTP — use complete() as fallback
            const result = await topicProvider.complete(finalMessages);
            clearTimeout(timeoutId);
            const content = result.content;
            const storedFallback = appendLocalMessage(sessionKey, "assistant", content);
            if (matchedTopic) {
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedFallback.id, content, preview: content.slice(0, 100) });
            }
            const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
            return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
          }
          clearTimeout(timeoutId);

          if (!resp.ok) {
            const text = await resp.text();
            const isRateLimit = resp.status === 429 || /rate.?limit/i.test(text);
            const errorMsg = isRateLimit
              ? "⚠️ Rate limit reached. The AI service is temporarily overloaded. Please wait a moment and try again."
              : `⚠️ AI service error (${resp.status}). Please try again.`;
            const errorPartial = createPartialMessage(sessionKey, "assistant");
            updateLastMessage(sessionKey, { content: errorMsg, partial: undefined, streamedAt: undefined });
            if (matchedTopic) {
              broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: errorMsg });
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: errorPartial.id, content: errorMsg, preview: errorMsg.slice(0, 100) });
              broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: errorPartial.id });
              finalizeTurnActivity(matchedTopic);
            }
            return new Response(
              `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(errorMsg)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
              { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
            );
          }

          const contentType = resp.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await resp.json() as any;
            const content = data?.choices?.[0]?.message?.content || "";
            detectLocalhostAutoNav(content, matchedTopic);
            if (data?.usage) {
              const model = data.model || "unknown";
              const inputTokens = data.usage.prompt_tokens || 0;
              const outputTokens = data.usage.completion_tokens || 0;
              appendUsageRecord({
                timestamp: Date.now(), sessionKey, topicId: matchedTopic?.id, model, inputTokens, outputTokens,
                totalTokens: inputTokens + outputTokens, costUsd: calculateCost(model, inputTokens, outputTokens),
              }).catch(err => console.warn("[Usage] Failed to record usage:", err));
            }
            // Only broadcast message:new when we actually persisted the
            // assistant turn — otherwise receivers would see a row with no
            // messageId AND no content (current dedupe falls back to
            // last-of-role/content matching, which would silently dedupe
            // against an unrelated previous message). Empty completions are
            // recoverable on next turn; a phantom broadcast is not.
            const storedJsonAssistant = content ? appendLocalMessage(sessionKey, "assistant", content) : null;
            if (matchedTopic && storedJsonAssistant) {
              broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: storedJsonAssistant.id, content, preview: content.slice(0, 100) });
              finalizeTurnActivity(matchedTopic);
            }
            if (matchedTopic && !matchedTopic.projectPath) setTimeout(() => autoBindProject(matchedTopic!), 100);
            const ssePayload = `data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
            return new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
          }

          // Streaming fallback — simplified version (no tool visibility)
          const originalBody = resp.body!;
          const SAVE_INTERVAL = 10;
          const partialMsg = createPartialMessage(sessionKey, "assistant");
          startStream(sessionKey, partialMsg.id, abortController, providerSurvivesRestart(topicProvider));
          broadcastToAll({ type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id });

          // Mutable state via refs so that both the WS onToolStart callback and
          // the shared SSE processor read from the same up-to-date value.
          const contentRef = { value: "" };
          const thinkingRef = { value: "" };
          const inThinkingRef = { value: false };
          const chunkCountRef = { value: 0 };

          // Always register WS handler for tool events — even if WS appears disconnected,
          // it may reconnect during the HTTP request. Tool events arrive via WS agent events.
          const httpRunId = `http:${crypto.randomUUID()}`;
          {
            topicProvider.registerStreamHandler?.(sessionKey, httpRunId, {
              onTextDelta() {},  // Handled by HTTP SSE processLine
              onThinkingDelta() {},
              onToolStart(toolCallId: string, name: string, args?: Record<string, unknown>) {
                const toolCall = { id: toolCallId, name, args: args ?? {}, status: 'running' as const, contentOffset: contentRef.value.length };
                addToolCallToLastMessage(sessionKey, toolCall);
                broadcastStreamToTopic({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall }, matchedTopic?.id);
              },
              onToolUpdate(toolCallId: string, partialResult: string) {
                broadcastStreamToTopic({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult }, matchedTopic?.id);
              },
              onToolResult(toolCallId: string, result: string) {
                updateToolCallResult(sessionKey, toolCallId, result);
                broadcastStreamToTopic({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result }, matchedTopic?.id);
              },
              onDone() {},      // Handled by HTTP SSE [DONE]
              onError() {},
              onAborted() {},
            });
          }

          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          const writer = writable.getWriter();
          let clientDisconnected = false;
          const encoder = new TextEncoder();
          const forwardToClient = async (chunk: Uint8Array) => { if (clientDisconnected) return; try { await writer.write(chunk); } catch { clientDisconnected = true; } };
          const closeClient = async () => { if (clientDisconnected) return; try { await writer.close(); } catch { clientDisconnected = true; } };

          const { consumeGateway } = makeGatewaySseProcessor({
            sessionKey,
            matchedTopic,
            partialMsgId: partialMsg.id,
            contentRef,
            thinkingRef,
            inThinkingRef,
            chunkCountRef,
            forwardToClient,
            closeClient,
            isClientDisconnected: () => clientDisconnected,
            encoder,
            writeExtra: (payload: string) => {
              if (!clientDisconnected) { try { writer.write(encoder.encode(payload)); } catch { clientDisconnected = true; } }
            },
            broadcastToAll,
            broadcastToTopicSubscribers,
            updateStreamContent,
            updateLastMessage,
            endStream,
            isStreaming,
            addToolCallToLastMessage,
            updateToolCallResult: (sk, id, result) => updateToolCallResult(sk, id, result),
            saveInterval: SAVE_INTERVAL,
            onDone: () => {
              // chat.ts-specific: unregister handler, broadcast message:new,
              // and mark stream:end as completed (overrides the shared broadcast).
              topicProvider.unregisterStreamHandler?.(sessionKey);
              if (matchedTopic) {
                broadcastToAll({ type: "message:new", topicId: matchedTopic.id, sessionKey, role: "assistant", messageId: partialMsg.id, content: contentRef.value, preview: contentRef.value.slice(0, 100) });
                // The shared module already broadcast stream:end; re-broadcast
                // with the chat-specific completed/dispatched fields.
                broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id, completed: true, ...(dispatched ? { dispatched: true } : {}) });
                finalizeTurnActivity(matchedTopic);
              }
            },
            onStreamEnd: () => {
              // chat.ts-specific: unregister handler + finalize activity (abrupt end).
              topicProvider.unregisterStreamHandler?.(sessionKey);
              if (matchedTopic) finalizeTurnActivity(matchedTopic);
            },
            logTag: "[Stream]",
            abortController,
          });

          consumeGateway(originalBody).catch(err => console.error('[consumeGateway:chat] error:', err));
          return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
        } catch (err: any) {
          if (err.name === "AbortError") return json({ error: "Request timeout (5 min)" }, 504);
          return json({ error: "Gateway unreachable: " + err.message }, 502);
        }
      }
    }

    return null;
  };
}
