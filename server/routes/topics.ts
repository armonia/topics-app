import { restoreToolCallsFromBlocks } from "../utils";
import { canonicalProjectPath } from "../lib/canonical-project-path";
import { clientProjectPathRefused, CLIENT_PROJECT_PATH_ERROR } from "../lib/client-project-path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import type { AppContext, RouteHandler, Topic, UnreadData } from "../types";
import { getProvider, getDefaultProvider, getDefaultProviderName, type AIProvider } from "../providers";
import { withBackgroundWork, type TurnStatusRow } from "../providers/background-probes";
import { createTopicProviderResolver } from "../providers/topic-provider-resolver";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { declaredProviderName, fallbackModelFor } from "./commandRouting";
import { createAutoNameRouter } from "./autoname";
import { createHistoryRouter, createHistoryFindRouter, createToolDetailRouter } from "./history";
import { blocksForDisk, leanMessagesForWire, toolCallsColumnForRow } from "../../shared/lean-tool-call";
import { goalContinuationForChatRoute, type ChatGoalLoop } from "../services/goal-continuation";
import { createEditRouter } from "./edit";
import { createForkRouter } from "./fork";
import { isSideQuestionTopicId } from "../../shared/chat-fork";
import { createChatRouter } from "./chat";
import { commandBackgroundWork, commandServices, commandWakeState } from "./processes";
import type { LifecycleHookRunner } from "../services/lifecycle-hooks";
import { e2eRoutesEnabled } from "./e2e";
import { createPermissionRouter } from "./permission";
import { createOutboundRouter } from "./outbound";
import { createBrowserBridgeRouter } from "./browser-bridge";
import type { BrowserService } from "../browser-service";
import { resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { getTerminalSessionById, setSubAgentExitHandler } from "./terminal";
import { getSessionContext } from "../db/session-context";
import { noteUnreadChanged, setClosed } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import { classifyContext, windowForMeasure } from "../usage/context-window";
import { contextUpdateFromUsage } from "../usage/usage-update";
import { createTaskService } from "../services/tasks";
import { isEligibleGlobalOrchestratorSession, isGlobalOrchestratorSession, isGlobalOrchestratorTopic, presentGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { persistAgentTaskTab, attachLoginHandleToTaskTab } from "../services/task-tab-persist";
import { bumpUnreadCount } from "../lib/unread-count";
import { createSubagentWatcher } from "../lib/subagent-watch";
import { subagentWakeState } from "../lib/subagent-runtime";
import { rootSessionKeyOf } from "../lib/subagent-store";
import { requestSubagentWake } from "../services/subagent-wake";
import { computeTopicChanges, resolveTopicChangeTarget, revsOfTarget } from "../lib/topic-changes";
import { gitDiffBundle, gitDiffStat } from "../lib/git-diff-stat";
import { gitDiffFilePatch, serveDiffBlob } from "../services/task-diff-file";
import type { ChangeSet } from "../../shared/change-set";
import { clearRetirement, recordRetirement } from "../services/retirement";
import { resolveOutputLanguage } from "../services/app-settings";
import { parkTopicSession } from "../lib/session-parking";
import { parseTranscriptToMessages } from "../lib/claude-transcript-import";
import { parseTranscriptFacts } from "../lib/external-claude-sessions";
import { autonomyForPermissionMode } from "../lib/autonomy-mode";
import { EFFORT_TIERS } from "../../shared/effort";
import { sessionHasOpenQuestion } from "../lib/question-outlives-asker";
import { createAnswerRelay, type AnswerRelay } from "../lib/answer-relay";
import { markAnswerNotOwed } from "../lib/owed-answers";
// "Waiting on you" is also read off the ROW: the panel's questions travel over
// the MCP bridge, not the provider's native channel, and after a restart no
// in-memory map remembers them. See lib/waiting-ask.ts.
import { waitingAskStartedAt } from "../lib/waiting-ask";
import { humanHoldAgeMs } from "../lib/human-hold";
import { readSlashCommandSource, isValidSlashCommandName } from "../lib/slash-command-source";
import { slashMenuEntries } from "../lib/slash-command-menu";
import { listResumableClaudeSessions } from "../lib/resumable-claude-sessions";
import { decodeCol } from "../../shared/message-blob";
import { splitStoredToolOutputs } from "../lib/tool-output-store";
import { purgeTopicFromUiState, restoreTopicInUiState } from "./topics-ui-state";
import { createTopicPreviews } from "./topics-preview";
import { createProjectBinding } from "./topics-projects";
import { createTopicUpdateRoutes } from "./topics-update";
import { createSessionControlRoutes } from "./topics-session-control";
import { createChatAbortRoutes } from "./topics-abort";
import { createToolResponseRoutes } from "./topics-tool-response";
import { createCommandRoutes } from "./topics-commands";


export { removeTopicFromUiStateValue, retractTopicTombstoneFromUiStateValue, purgeTopicFromUiState, reopenDepsFor } from "./topics-ui-state";
export { topicPreviewText } from "./topics-preview";

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
  /** What the chat route needs from the outside and this closure does not own. */
  extra: {
    hooks?: LifecycleHookRunner;
    exposeGoalLoop?: (loop: ChatGoalLoop) => void;
    /**
     * The queue that carries an answer whose asker is gone to the model
     * (`lib/answer-relay.ts`), handed out so the boot can put back the answers
     * a restart found still owed.
     */
    exposeAnswerRelay?: (relay: AnswerRelay) => void;
    /**
     * The chat route the relay posts to. This router's own by default; a test
     * hands in one over a recording model, to see exactly what it receives.
     */
    answerRelayRoute?: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;
    /**
     * How long an open-pane waits for a pane to attach, per window.
     * Forwarded to the browser bridge; tests shrink it to a few ms.
     */
    paneWaitMs?: number;
    stopTopicProcesses?: (topicId: string) => void;
  } = {},
): RouteHandler {
  const {
    broadcastToAll,
    loadTopics, saveSingleTopic,
    getTopicById, getTopicBySessionKey,
    loadUnread,
    loadLocalMessages, loadThreadWindow, hydrateMessageBodies, saveLocalMessages, appendLocalMessage,
    updateToolCallFields,
    readJSON, json, matchRoute, errorResponse, slugify,
    searchTranscripts,
    activeStreams,
    worktreeStore,
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

  /**
   * Resolve the AI provider for a topic. Uses topic.provider if set, else default.
   *
   * Passa dalla fabbrica e non dal resolver nudo: senza la lista dei modelli nativi che porta lei, il cancello sul modello risponde sempre "servito". allow-italian: perche' la fabbrica non e' opzionale
   */
  const resolveProviderForTopic = createTopicProviderResolver({
    getProvider,
    getDefaultProvider,
    getSnapshot: () => getSnapshotManager().getSnapshot(),
  });
  function resolveProvider(topic?: Topic | null): AIProvider {
    return resolveProviderForTopic(topic);
  }

  /** Look up the topic owning a sessionKey and resolve its provider. */
  function providerForSessionKey(sessionKey: string): AIProvider {
    const topic = getTopicBySessionKey(sessionKey);
    if (topic && isGlobalOrchestratorTopic(db, topic.id)) {
      if (!isEligibleGlobalOrchestratorSession(db, sessionKey)) {
        throw new Error("global coordinator topic invariant violated");
      }
      // The coordinator never inherits the mutable/default provider choice.
      return getProvider("codex");
    }
    return resolveProvider(topic);
  }

  /** The folder a chat's slash menu reads: its topic's project (`?topicId=`), else the server's. */
  function slashCommandProjectRoot(url: URL): string {
    const topicId = url.searchParams.get("topicId");
    const projectPath = topicId ? getTopicById(topicId)?.projectPath : null;
    return projectPath || process.cwd();
  }

  /** `/status` model of an unpinned topic (`fallbackModelFor`); `getProvider` throws for «not here». */
  function defaultModelOfDeclaredProvider(topicProvider: string | null | undefined): string | null {
    return fallbackModelFor(topicProvider, getDefaultProviderName(), (name) => {
      try { return getProvider(name); } catch { return undefined; }
    });
  }

  // ── Recapito dei risultati dei sub-agent ────────────────────────────────
  // Estratto in `server/lib/subagent-watch.ts`: erano trecento righe con uno
  // stato proprio (mappa delle sessioni osservate, timer, cursore in byte per
  // file) dentro un file di ROTTE, e chiuse lì non erano testabili — né un giro
  // di polling, né un transcript finto, né le guardie di rotazione. La closure
  // gli serviva per nove valori, che ora sono dipendenze scritte.
  const subagents = createSubagentWatcher({
    getTopicById,
    getTopicBySessionKey,
    saveSingleTopic,
    appendLocalMessage,
    broadcastToAll,
    bumpUnread: updateUnreadCount,
    reportLanguage: () => (resolveOutputLanguage() === "en" ? "en" : "it"),
    // The result wakes the parent chat (SUBAGENT-12); the wakes start going out
    // once the boot has re-adopted the surviving turns (`startSubagentWakes`).
    requestWake: requestSubagentWake,
  });
  const watchSessionForSubagents = subagents.watch;
  // La registrazione della strada B resta QUI: così il modulo non importa
  // `routes/terminal` e la dipendenza fra i due resta a senso unico.
  setSubAgentExitHandler(subagents.deliverExit);

  /** Politica di lettura e incremento: `server/lib/unread-count.ts`. */
  function updateUnreadCount(topicId: string) {
    if (isSideQuestionTopicId(topicId)) return;
    bumpUnreadCount(
      { bumpUnread: ctx.bumpUnread, announce: noteUnreadChanged, isArchived: (id) => getTopicById(id)?.archived === true },
      topicId,
    );
  }

  // Track which topics already had a browser navigate this session to avoid duplicate triggers
  const browserNavigatedTopics = new Set<string>();

  // Phase 30 BROWSER-CHAT-03 — the gateway browser bridge was removed; agent now
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

  const projects = createProjectBinding(ctx);
  const { resolveProjectRef, knownProjectPaths, bindTopicToProject, autoBindProject, getProjectIdForTopic, WORKSPACE_DIR, getWorkspaceProjects, detectProjectPathFromMessages, moveTerminalPaneToProject } = projects;

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


  // Auto-naming endpoint extracted to its own router  // Auto-naming endpoint extracted to its own router; it needs two closure
  // helpers injected (they close over this scope), so it's instantiated here.
  const autoNameRouter = createAutoNameRouter(ctx, { resolveProvider, detectProjectPathFromMessages });
  const historyRouter = createHistoryRouter(ctx, { matchHistoryRoute, providerForSessionKey });
  // Il rovescio dello sfoltimento di `/api/history`: la riga di tool arriva col
  // testo svuotato e se lo riprende da qui, la prima volta che qualcuno la apre.
  const toolDetailRouter = createToolDetailRouter(ctx);
  const historyFindRouter = createHistoryFindRouter(ctx);
  const editRouter = createEditRouter(ctx, { resolveProvider, updateUnreadCount });
  // «Fork into a new chat»: a branch in a chat of its own, next to the in-chat branches of edit.ts.
  const forkRouter = createForkRouter(ctx, { resolveProvider, stopTopicProcesses: extra.stopTopicProcesses });
  // Il canale umano non chiede niente a questa closure: solo ctx.
  const permissionRouter = createPermissionRouter(ctx);
  // The two doors that leave the machine (mail and Google): same treatment as
  // the human channel, because the confirmation they impose IS that channel.
  const outboundRouter = createOutboundRouter(ctx);
  const goalLoop = goalContinuationForChatRoute({
    ctx, resolveProvider, commandWakeState, subagentWakeState, log: (m) => console.log(`[goal] ${m}`),
    hasOpenQuestion: (sk) => sessionHasOpenQuestion(ctx, sk, decodeCol),
  });
  extra.exposeGoalLoop?.(goalLoop);
  // An answer whose asker is gone, owed to the model until the chat route takes
  // it (`lib/answer-relay.ts`). Settled on the question's own row, by id. The
  // chat route below holds it too: it is where the answer is taken, so a
  // message the person writes later never gets in front of it.
  const answerRelay = createAnswerRelay({
    isBusy: (sk) => !!ctx.isStreaming(sk),
    route: extra.answerRelayRoute ?? (async (...a) => chatRouter(...a)),
    settle: (owed) => {
      // The mark and the index move together: `owed_answers` is what the boot loads.
      ctx.db.transaction(() => {
        if (owed.rowId) updateToolCallFields(owed.sessionKey, owed.toolCallId, { answerRelay: 'sent' }, { rowId: owed.rowId });
        markAnswerNotOwed(ctx.db, owed.sessionKey, owed.toolCallId);
      })();
      broadcastToAll({
        type: 'stream:tool_update', sessionKey: owed.sessionKey,
        topicId: getTopicBySessionKey(owed.sessionKey)?.id, toolCallId: owed.toolCallId, answerRelay: 'sent',
      });
    },
    log: (m) => console.warn(`[answer-relay] ${m}`),
  });
  extra.exposeAnswerRelay?.(answerRelay);
  const chatRouter = createChatRouter(ctx, {
    resolveProvider, detectLocalhostAutoNav, bindTopicToProject, resolveProjectRef, knownProjectPaths,
    getProjectIdForTopic, getWorkspaceProjects, autoBindProject,
    watchSessionForSubagents, updateUnreadCount, browserNavigatedTopics, WORKSPACE_DIR,
    hooks: extra.hooks, goalLoop, answerRelay,
  }, browserService);
  goalLoop.useRoute(async (...a) => chatRouter(...a)); // now: a boot check-in may come before any request

  /**
   * A new chat's first message, sent by the server through `POST /api/chat`
   * like any typed message: same user row, same turn, and no client window
   * has to stay open for it. It is never stored on the topic, so a reload or
   * a restart has nothing to send a second time; from here on the chat row is
   * its only copy. The SSE body is drained so the turn runs to its end.
   */
  async function sendInitialMessage(sessionKey: string, content: string): Promise<void> {
    const url = new URL("http://localhost/api/chat");
    try {
      const resp = await chatRouter(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
        }),
        url, "/api/chat", "POST",
      );
      if (!resp?.ok) {
        console.warn(`[topics] initial message of ${sessionKey} refused by the chat route: ${resp?.status ?? "no response"}`);
        return;
      }
      const reader = resp.body?.getReader();
      if (reader) while (!(await reader.read()).done) { /* drain */ }
    } catch (err) {
      console.warn(`[topics] initial message of ${sessionKey} failed:`, err);
    }
  }
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
    paneWaitMs: extra.paneWaitMs,
    browserHostTopicOf: (topic) => {
      const root = rootSessionKeyOf(ctx.db, topic.sessionKey);
      return root === topic.sessionKey ? null : getTopicBySessionKey(root)?.id;
    },
  }, browserService);

  const { topicPreviewsPayload } = createTopicPreviews(db);

  /**
   * The topics as a LIST carries them: everything except the two fields only
   * the open topic ever reads.
   *
   * `systemPrompt` is 255,905 bytes on this machine and `browserState` 20,964,
   * across 1,471 topics of which 1,448 are archived - a quarter of the boot
   * payload, re-sent on every WS reconnect and re-serialised whole into
   * localStorage, for text no list draws. `GET /api/topics/:id` serves them for
   * the one topic that is being looked at, archived or not.
   */
  function listShape(topics: Record<string, Topic>): Record<string, Topic> {
    const out: Record<string, Topic> = {};
    for (const [id, topic] of Object.entries(topics)) {
      if (isSideQuestionTopicId(id)) continue;
      const { systemPrompt, browserState: _browser, ...rest } = topic;
      // The one thing a list DOES ask about the prompt: whether there is one.
      // The empty state of a chat draws a badge from it, and a boolean answers
      // that for a byte instead of a page of text.
      out[id] = (systemPrompt ? { ...rest, hasSystemPrompt: true } : rest) as Topic;
    }
    return out;
  }

  /**
   * What both changes routes read a topic's changes from: its folder, its
   * messages and, on a card's topic, the task's anchors. `null` = no such topic.
   */
  function topicChangeInputs(topicId: string) {
    const topic = getTopicById(topicId);
    if (!topic) return null;
    // The worktree wins over the project folder: a topic bound to one has
    // its own checkout, and the project path would answer for another tree.
    const worktree = topic.worktreeId ? worktreeStore.get(topic.worktreeId) : null;
    const cwd = worktree?.absPath || topic.projectPath || null;
    const messages = loadLocalMessages(topic.sessionKey);
    // A task topic reads its task's diff range first, the drawer's: it outlives the pruned
    // worktree and sees what no write tool call named (a shell command, a sub-agent). Without
    // a task nothing says whose a worktree's range is, so the tool calls answer.
    const task = taskSvc.taskForTopic(topic.id);
    const anchors = task ? { task, worktree, repoPath: topic.projectPath ?? null } : null;
    return { cwd, messages, anchors };
  }

  const topicUpdateRoutes = createTopicUpdateRoutes(ctx, {
    resolveProvider, broadcastContextForModelChange, browserService, stopTopicProcesses: extra.stopTopicProcesses,
  });
  const sessionControlRoutes = createSessionControlRoutes(ctx, { projects });
  const chatAbortRoutes = createChatAbortRoutes(ctx, { resolveProvider, goalLoop });
  const toolResponseRoutes = createToolResponseRoutes(ctx, { resolveProvider, answerRelay });
  const commandRoutes = createCommandRoutes(ctx, { resolveProvider, providerForSessionKey, defaultModelOfDeclaredProvider, projects });

  return async function topicsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- Topics CRUD ---
    // GET /api/topics            - the LIVE topics + workspaceProjects: the boot payload.
    // GET /api/topics?archived=1 - the archived ones, same list shape, no projects.
    // (The orphan-parent repair that used to run in here runs once at boot,
    // in createAppContext: server/utils.ts.)
    if (method === "GET" && pathname === "/api/topics") {
      // THE LIST DOES NOT CARRY WHAT ONLY ONE TOPIC AT A TIME NEEDS. This is
      // the boot payload, remade on every WS reconnect and written whole into
      // localStorage, and it used to ship `system_prompt` and `browser_state`
      // for all 1,471 topics of this machine - 1,448 of them archived - for
      // 277 KB of the 1.07 MB that nothing in a list draws: the prompt is read
      // by the settings panel and the empty state of the OPEN topic, the
      // browser state by the pane that restores it. Both now come from
      // `GET /api/topics/:id`, one topic, when it is looked at.
      //
      // AND IT DOES NOT CARRY THE ARCHIVE. Measured on 2026-09-05 with the
      // prompts already out: 1,554 topics, 1,535 archived, 872 KB, 1.4 s on a
      // loaded machine, for 19 rows the sidebar draws. The archive is its own
      // request (`?archived=1`) that the client makes in idle or when a surface
      // asks for it: the archived section of the sidebar, the search palette,
      // a link to a closed chat. `GET /api/topics/:id` still serves any one of
      // them whole.
      // Gate: tests/integration/topics-list-weight.test.ts.
      const wantArchived = url.searchParams.get("archived");
      if (wantArchived === "1" || wantArchived === "true") {
        return json({ topics: listShape(loadTopics({ archived: true }).topics) });
      }
      return json({ topics: listShape(loadTopics({ archived: false }).topics), workspaceProjects: getWorkspaceProjects() });
    }


    // Streaming-session snapshot for cross-reload loading hydration. The client
    // (useSignalsSync) polls this so a chat that was mid-reply when the page
    // (re)loaded shows its spinner even before its window mounts — the live WS
    // stream only drives the foreground session. Sourced from the authoritative
    // in-memory activeStreams registry (an entry lives until the sweep ends it),
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
      const sessions: TurnStatusRow[] = [];
      for (const sessionKey of activeStreams.keys()) {
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
      // `services`: the servers a chat runs, shown as servers and not waited on (BGVIS-08).
      return json({ sessions: withBackgroundWork(sessions, getTopicBySessionKey, commandBackgroundWork), services: commandServices() });
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
     *
     * AND IT DOES NOT CARRY THE ARCHIVE, for the same reason `GET /api/topics`
     * stopped carrying it. Measured read-only on the production database
     * (2026-09-07): 300,355 bytes at every boot for 1,482 previews, of which
     * the sidebar draws 17; the live ones alone are 1,671 bytes. So the
     * default is `?archived=0` and the archived previews come with the
     * archived list, from the one deduplicated point the client already has
     * (`ensureArchivedTopics`).
     * Gate: tests/integration/topics-list-weight.test.ts.
     */
    if (method === "GET" && pathname === "/api/topics/previews") {
      const wantArchived = url.searchParams.get("archived");
      const archived = wantArchived === "1" || wantArchived === "true";
      return json({ previews: topicPreviewsPayload(archived) });
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
      const src = readSlashCommandSource(name, { cwd: slashCommandProjectRoot(url) });
      if (!src) return errorResponse(404, "comando non trovato");
      return json(src);
    }

    if (method === "GET" && pathname === "/api/slash-commands") {
      // Which files are commands and skills, and which one wins a shared name,
      // is decided in ONE place: `listSlashCommandFiles`, the same folders and
      // precedence `readSlashCommandSource` opens.
      //
      // The project's commands come from the TOPIC's project (`?topicId=`),
      // the folder its CLI runs in (SKILL-01 «then the project's»). And the
      // list is the one of the engine the topic DECLARES (CMDUI-01): the
      // engine's own group and «your skills» only where the engine expands
      // them (`slash-command-menu.ts`). A draft passes its `?provider=`.
      const topicId = url.searchParams.get("topicId");
      const topic = topicId ? getTopicById(topicId) : null;
      const asked = url.searchParams.get("provider");
      const provider = topic ? declaredProviderName(topic.provider, getDefaultProviderName()) ?? null
        : asked ? declaredProviderName(asked) ?? null : null;
      return json(slashMenuEntries({
        provider,
        sessionKey: topic?.sessionKey ?? null,
        projectPath: topic?.projectPath ?? null,
        cwd: slashCommandProjectRoot(url),
      }));
    }

    // GET /api/topics/:id/resumable-sessions — `/resume` (CMDUI-03): the
    // Claude Code sessions of this topic's project that no chat holds, one
    // page at a time (`?before=` is the previous page's cursor). Its own
    // reading and its own cache: the census of external sessions is not
    // touched (`resumable-claude-sessions.ts`).
    {
      const m = method === "GET" ? /^\/api\/topics\/([^/]+)\/resumable-sessions$/.exec(pathname) : null;
      if (m) {
        const topic = getTopicById(decodeURIComponent(m[1]!));
        if (!topic) return json({ error: "topic not found", code: "not_found" }, 404);
        if (!topic.projectPath) return json({ error: "this chat has no project", code: "no_project" }, 404);
        const owned = new Set(
          (ctx.db.prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE claude_session_id IS NOT NULL`).all() as Array<{ claude_session_id: string }>)
            .map((r) => r.claude_session_id),
        );
        const page = await listResumableClaudeSessions({ projectPath: topic.projectPath, ownedSessionIds: owned, before: url.searchParams.get("before") });
        return json(page);
      }
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
      // One-call create: model and effort are accepted here with the same rules
      // as PATCH, so a chat with its model, effort and first prompt
      // (`initialMessage`) is a single POST instead of POST + PATCH + /api/chat.
      if (typeof body.model === "string" && body.model) topic.model = body.model;
      if (body.effort !== undefined && body.effort !== null && body.effort !== "" && body.effort !== "default") {
        const tier = String(body.effort).trim().toLowerCase();
        if (!(EFFORT_TIERS as readonly string[]).includes(tier)) return json({ error: "invalid effort tier" }, 400);
        topic.effort = tier;
      }
      // Set projectPath if explicitly provided (e.g. creating from within a project).
      // CANONICO: la stessa cartella raggiunta da un link non deve diventare un
      // secondo progetto (due board, due voci in sidebar). Vedi canonical-project-path.
      if (body.projectPath) {
        // Same gate as PATCH below: `topic.projectPath` is source 2 of the
        // allowlist (`services/known-project-dirs.ts`), so a topic created
        // rooted at `~/.ssh` opens the file routes on it.
        if (clientProjectPathRefused(req, body.projectPath, ctx)) {
          return json({ error: CLIENT_PROJECT_PATH_ERROR }, 400);
        }
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
      // Validation: ≤ 8000 chars, control-char strip. Empty or whitespace-only
      // sends nothing.
      let initialMessage: string | null = null;
      if (body.initialMessage !== undefined && body.initialMessage !== null) {
        // eslint-disable-next-line no-control-regex -- removes control characters from text that came from outside, on purpose
        const cleaned = String(body.initialMessage).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
        if (cleaned.length > 8000) return json({ error: "initialMessage too long (max 8000)" }, 400);
        if (cleaned.length > 0) initialMessage = cleaned;
      }

      data.topics[id] = topic;
      topic.sessionKey = "topic:" + id.slice(0, 8);
      saveSingleTopic(topic);
      broadcastToAll({ type: "topic:created", topic });
      if (initialMessage) void sendInitialMessage(topic.sessionKey, initialMessage);
      return json(topic, 201);
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
        // `/resume` already knows where it is (`transcriptPath` of its row),
        // and is believed only for a file named after the id, one folder
        // under the store: never a path the client made up.
        const projectsDir = join(homedir(), ".claude", "projects");
        let transcriptPath: string | null = null;
        const hinted = typeof body?.transcriptPath === "string" ? resolve(body.transcriptPath) : null;
        if (hinted && dirname(dirname(hinted)) === resolve(projectsDir) && basename(hinted) === `${sessionId}.jsonl` && existsSync(hinted)) transcriptPath = hinted;
        if (!transcriptPath) try {
          for (const dir of readdirSync(projectsDir)) {
            const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
            if (existsSync(candidate)) { transcriptPath = candidate; break; }
          }
        } catch { /* projects dir missing → handled below */ }
        if (!transcriptPath) return json({ error: "session transcript not found" }, 404);

        const text = readFileSync(transcriptPath, "utf-8");
        // The session's real cwd is stamped on its transcript entries.
        const facts = parseTranscriptFacts(text);
        const cwd = facts.cwd;
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
          // Carry on with the permissions the session already ran with, instead
          // of the default level: see `autonomyForPermissionMode`.
          const inherited = autonomyForPermissionMode(facts.permissionMode);
          if (inherited) t.autonomyLevel = inherited;
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

    {
      const updateResp = await topicUpdateRoutes(req, url, pathname, method);
      if (updateResp) return updateResp;
    }

    // POST /api/topics/bulk-archive
    if (method === "POST" && pathname === "/api/topics/bulk-archive") {
      const body = await readJSON(req);
      if (!body || !body.projectPath || typeof body.archived !== 'boolean') {
        return json({ error: "projectPath and archived (boolean) required" }, 400);
      }
      const { projectPath, archived } = body;
      const data = loadTopics();
      const unread: UnreadData = {};
      const updatedTopics: Topic[] = [];
      const now = new Date().toISOString();
      for (const topic of Object.values(data.topics)) {
        // A globally registered coordinator stays durable even if a manual DB
        // corruption gave it a matching project path. Bulk archive is project
        // lifecycle control, not a path around the coordinator invariant.
        if (isGlobalOrchestratorTopic(db, topic.id)) continue;
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
      // mid-archive can't leave half the project archived. The unread reset
      // of the archived topics is included so it commits with the archive
      // flip; only their rows are written, not the whole table.
      ctx.db.transaction(() => {
        for (const topic of updatedTopics) saveSingleTopic(topic);
        if (archived) ctx.saveUnreadEntries(unread);
      })();
      const purgeFailures: { topicId: string; error: string }[] = [];
      for (const topic of updatedTopics) {
        broadcastToAll({ type: "topic:archived", topic });
        if (archived) {
          extra.stopTopicProcesses?.(topic.id);
          // Stesso passo 4 del percorso singolo (services/archive-topic.ts).
          // È QUESTA la strada che ha prodotto la perdita misurata: le 28
          // sessioni rimaste vive su chat chiuse portavano tutte la data di
          // un'archiviazione di progetto in blocco.
          parkTopicSession(topic.sessionKey);
          const purgeResult = purgeTopicFromUiState(ctx.db, broadcastToAll, topic.id, (c) =>
            browserService?.destroyContext(c),
          );
          if (!purgeResult.ok) {
            purgeFailures.push({ topicId: topic.id, error: purgeResult.error });
          }
          // Il fatto, come nel percorso singolo. Un'archiviazione in blocco che
          // non timbra e' esattamente la strada da cui sono usciti i topic
          // «aperti» chiusi da settimane: il flag c'era, la data no.
          recordRetirement(ctx.db, "topic", topic.id, now, "bulk-archive");
          // The same step as the single path (T13): idle, rows seen.
          setClosed(topicSubject(topic.id), { archived: true });
        } else {
          // Bulk UNarchive — same reopen symmetry as the single-topic DELETE.
          restoreTopicInUiState(ctx.db, broadcastToAll, topic.id);
          clearRetirement(ctx.db, "topic", topic.id);
          setClosed(topicSubject(topic.id), { archived: false });
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
        const sk = decodeURIComponent(bySession.sessionKey);
        if (isGlobalOrchestratorSession(db, sk)) {
          return json({ error: "the global coordinator cannot be moved into a project", code: "orchestrator_topic_invariant" }, 403);
        }
        const body = (await readJSON(req)) as { projectPath?: unknown } | null;
        const rawPath = typeof body?.projectPath === "string" ? body.projectPath : "";
        if (!rawPath) return json({ error: "projectPath (string) is required" }, 400);
        const dir = resolveProjectRef(rawPath, { trustRawPaths: true });
        if (!dir) return json({ error: "project path does not exist" }, 404);

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

    // Mail and Google: the human confirmation, the account roster and the trace
    // on the card all live in server/routes/outbound.ts. Mounted after the human
    // channel because that is the channel it asks through.
    {
      const outResp = await outboundRouter(req, url, pathname, method);
      if (outResp) return outResp;
    }

    {
      const sessionControlResp = await sessionControlRoutes(req, url, pathname, method);
      if (sessionControlResp) return sessionControlResp;
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

    // GET /api/topics/:id - ONE topic, whole, heavy fields included.
    // The other half of the cut above: whoever needs the system prompt or the
    // browser state of a topic asks for that topic. Placed after the literal
    // `/api/topics/...` routes so it cannot swallow them.
    {
      const params = matchRoute(pathname, "/api/topics/:id");
      if (params && method === "GET") {
        const topic = getTopicById(params.id);
        if (!topic) return json({ error: "Topic not found" }, 404);
        // `getTopicById` builds the row without relations, so the coordinator
        // marker is projected here: the settings modal hydrates the open topic
        // from this read, and without the marker its archive/provider/prompt
        // controls would silently unlock.
        return json({ topic: presentGlobalOrchestratorTopic(db, topic) });
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

        // The window is chosen on a SKELETON of the thread (four columns) and the
        // real rows are read only for the messages that go out; the body (blocks,
        // tool_calls) is put back by `hydrateMessageBodies` for those alone. The
        // route used to read and decode the WHOLE session to keep `limit` of it.
        // Same road as `/api/history`.
        // Gate: tests/integration/topic-messages-window-cost.test.ts.
        const { messages: windowLean, total } = loadThreadWindow(topic.sessionKey, limit, offset);
        const window = hydrateMessageBodies(windowLean);
        // A partial goes out whole and `hydrateMessageBodies` does not rebuild its
        // toolCalls from the blocks (the fat read did, for every row).
        for (const m of window) if (m.partial) restoreToolCallsFromBlocks(m);
        const result = leanMessagesForWire(window);

        return json({ messages: result, total, topicName: topic.name });
      }
    }

    // GET /api/topics/:id/messages/:messageId - one row as it is, partial and empty included (the list
    // hides those): send_chat_message waits on it after a cut stream. 404 means gone, not unseen.
    {
      const params = matchRoute(pathname, "/api/topics/:id/messages/:messageId");
      if (params && method === "GET") {
        const topic = getTopicById(params.id);
        const row = topic && ctx.getMessageSessionKey(params.messageId) === topic.sessionKey ? ctx.getMessageById(params.messageId) : null;
        return row ? json({ message: leanMessagesForWire([row])[0] }) : json({ error: "Message not found" }, 404);
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
        const read = topicChangeInputs(params.id);
        if (!read) return json({ error: "Topic not found" }, 404);
        return json(await computeTopicChanges(read.cwd, read.messages, read.anchors));
      }
    }

    // GET /api/topics/:id/changes/diff - the topic's CHANGESET (`shared/change-set.ts`)
    // on the same target `/changes` counted its rows on (`resolveTopicChangeTarget`):
    // a card's topic reads its task's range, the drawer's; any other topic `HEAD`
    // against the working tree, limited to the paths its write tool calls name.
    // `?file=` (with `context=full` and a rename's `orig`, or `blob=` for the bytes)
    // reads one file of it, and only of it: the checkout of a topic without a
    // worktree is the project's, and this route is no window on the whole repository.
    {
      const params = matchRoute(pathname, "/api/topics/:id/changes/diff");
      if (params && method === "GET") {
        const read = topicChangeInputs(params.id);
        if (!read) return json({ error: "Topic not found" }, 404);
        const target = await resolveTopicChangeTarget(read.cwd, read.messages, read.anchors);
        const scope = target ? { includeUntracked: target.live, paths: target.kind === "head" ? target.paths : undefined } : null;
        const q = url.searchParams;
        const onlyFile = q.get("file");
        if (onlyFile !== null) {
          const listed = target && scope ? (await gitDiffStat(target.cwd, target.range, scope)).stat : [];
          const members = new Set(listed.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])));
          const orig = q.get("orig");
          if (!target || !members.has(onlyFile) || (orig !== null && !members.has(orig))) {
            return json({ error: "file not in this topic's changeset", code: "not_in_changeset" }, 404);
          }
          const blob = q.get("blob");
          if (blob !== null) return serveDiffBlob(target, onlyFile, blob);
          const one = await gitDiffFilePatch(target.cwd, target.range, onlyFile, {
            includeUntracked: target.live, fullContext: q.get("context") === "full", origPath: orig,
          });
          return one ? json(one) : json({ error: "invalid file path", code: "invalid_input" }, 400);
        }
        if (!target || !scope) return json({ stat: [], patch: "", truncated: false, revs: null } satisfies ChangeSet);
        const [bundle, revs] = await Promise.all([gitDiffBundle(target.cwd, target.range, scope), revsOfTarget(target)]);
        return json({ ...bundle, revs } satisfies ChangeSet);
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
        // The row as an old closed row is on disk, outputs moved apart (find-in-pane e2e).
        if (body.splitToolOutputs === true) splitStoredToolOutputs(db, id);
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

    {
      const abortResp = await chatAbortRoutes(req, url, pathname, method);
      if (abortResp) return abortResp;
    }

    {
      const toolResponseResp = await toolResponseRoutes(req, url, pathname, method);
      if (toolResponseResp) return toolResponseResp;
    }

    // --- Edit message --- (handler extracted to server/routes/edit.ts)
    {
      const editResp = await editRouter(req, url, pathname, method);
      if (editResp) return editResp;
      const forkResp = await forkRouter(req, url, pathname, method);
      if (forkResp) return forkResp;
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

    // --- Find inside one conversation --- (POST /api/history-find, CHAT-FIND-01)
    {
      const findResp = await historyFindRouter(req, url, pathname, method);
      if (findResp) return findResp;
    }

    // --- Media serving ---
    // Media serving + uploads (/api/media, /api/upload, /api/upload-image,
    // /api/context-upload, DELETE /api/context-file) live in server/routes/media.ts now.

    // --- Auto-name --- (handler extracted to server/routes/autoname.ts)
    {
      const autoNameResp = await autoNameRouter(req, url, pathname, method);
      if (autoNameResp) return autoNameResp;
    }

    {
      const commandResp = await commandRoutes(req, url, pathname, method);
      if (commandResp) return commandResp;
    }

    return null;
  };
}
