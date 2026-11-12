/**
 * tasks.ts (route) — session-scoped task API for the MCP/agent surface.
 *
 * Rebuilds the task endpoints removed with the Master/Board subsystem
 * (commits 42e92c1d + 827f6b6e), but session-scoped instead of
 * `/api/projects/:id/...` or `/api/boards/...`: the caller is a Claude session
 * (`--session-key`), so the server derives the project AND the agent identity
 * from it — the agent never passes (or can spoof) a project id or author.
 *
 * Two surfaces, one service (server/services/tasks.ts):
 *   - `/api/sessions/:key/...` — the AGENT surface (MCP). actor="agent": can
 *     reach `review` but never `done` (the human review gate). Project + author
 *     are derived from the session key, never passed by the caller.
 *   - `/api/boards/:projectId/...` — the HUMAN board surface (the board UI).
 *     actor="human": may move to `done`, archive, and approve/reject reviews.
 *
 * Both go through the service's projectId guard, so a caller can only touch
 * tasks on the project it named/owns (no cross-project IDOR).
 */
import { STAGE_AI_REVIEW } from "../../shared/workflow";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import type { AppContext, RouteHandler } from "../types";
import { readableTaskIds, levelFor, meetsLevel } from "../lib/grants-query";
import { resolvePrincipals } from "../lib/principals";
import { liveAgentStartCapability, queueDelegatedRun } from "../lib/delegated-agent-start";
import { budgetShare, capMode, PARKED_WAITED_OUT, type DispatchAdmission, type DispatchMemoryQueueSnapshot, type GlobalDispatchCap } from "../../shared/board";
import { toFeedTask } from "../../shared/board-feed";
import { selectTaskSessionPeek } from "../../shared/task-session-peek";
import { parseTaskPatch, unapplicableFieldsBody } from "./task-patch";
import { createBoardRoutes } from "./tasks-board";
import { applySpendCapPatch, hasSpendCapPatch, spendCapFields, spendSnapshot } from "./task-spend-caps";
import { decodeMemoryQueueRef } from "../services/dispatch-memory-reference";
import { confirmCardOrigin } from "../services/card-origin-notice";
import { logActivity } from "../db/activity-log";
import { listPickerProjects, loadRegisteredProjects } from "../services/project-display-name";

/**
 * The global cap as the client reads it, in ONE place for the GET, the PATCH
 * response and the `board:global-cap` broadcast: three copies of the field
 * names are three ways for the panel to show a mode the dispatcher is not in.
 * Mode and budget go through `capMode` / `budgetShare`, so what travels is
 * always the applied value (clamped, defaulted), never the raw row.
 */
function globalCapFields(cap: GlobalDispatchCap): {
  maxAgentsAuto: boolean;
  maxAgents: number;
  maxAgentsMode: "count" | "resources";
  budgetShare: number;
} {
  return { maxAgentsAuto: cap.auto, maxAgents: cap.max, maxAgentsMode: capMode(cap), budgetShare: budgetShare(cap) };
}

/** The checks memory floor on the wire, in ONE place for the GET, the PATCH
 *  answer and the broadcast — same reason as `globalCapFields` above. What
 *  travels is the APPLIED value (clamped, defaulted), so a panel can never show
 *  a floor the brake is not using. */
const checksFloorFields = (svc: TaskService): { checksMemFloorGB: number } =>
  ({ checksMemFloorGB: svc.getChecksMemFloorGB() });
import { deliverAnswer } from "../lib/ask-user-bridge";
import { resolveCreatedSource } from "../lib/created-by";
import { createTaskService, projectIdForPath, type TaskService } from "../services/tasks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";
import { activeFrozenCount } from "../services/budget-governor";
import { swapFrozenCount } from "../lib/swap-freeze-hold";
import { dispatchBrakes, liftClaudeEarlyStop, planUsage } from "../lib/provider-hold";
import { resolveAgentRuntime } from "../services/app-settings";
import { newProjectParentDir, scaffoldNewProject } from "../services/project-path-resolver";
import { parkedEdgeEvent, type TaskDispatcher } from "../services/task-dispatcher";
import { clampLegMs } from "../services/checks-gate";
import { createTaskAttemptStore } from "../services/task-attempts";
import { conditionalJson } from "../lib/conditional-json";
import { attemptHasWork, formatAttemptStat } from "../../shared/task-attempt";
import { makeSheetWriter } from "../services/delivery-sheet";
import { resolveTaskDiffRange, revsOfRange } from "../services/task-diff-range";
import { gitDiffFilePatch, serveDiffBlob } from "../services/task-diff-file";
import { gitDiffBundle } from "../lib/git-diff-stat";
import { isTaskLabel, normalizeLabels } from "../../shared/task-labels";
import { createTasksReap } from "./tasks-reap";
import { createTasksIntake } from "./tasks-intake";
import { createTasksChecksDelivery } from "./tasks-checks-delivery";
import { createTasksLand } from "./tasks-land";
import { createTasksDeploy } from "./tasks-deploy";
import { createTasksGuards } from "./tasks-guards";
import { createTasksGuests } from "./tasks-guests";
import type { TasksCore, TasksLate } from "./tasks-scope";
import type { TasksRouterOpts } from "./tasks-opts";
import { gitRunner, runGitCap } from "./tasks-git";
import { emitReviewReadyEdge, requestCardProcessStop } from "./tasks-shared";
import { matchGuestTaskAction } from "./tasks-guests";

// These moved to sibling modules; this path stays their public home.
export { runGitCap, ownCommitFiles, ownBranchFiles } from "./tasks-git";
export { matchGuestTaskAction } from "./tasks-guests";
export type { TasksRouterOpts } from "./tasks-opts";
export { emitReviewReadyEdge, pendingQuestion } from "./tasks-shared";

/**
 * How many CLOSED cards the global feed carries.
 *
 * `GET /api/all-boards/tasks` is re-read by every open window on every `task:*`
 * event and on every WS reconnect, and it only ever grew: 1.44 MB over 467 rows
 * in August, 1.60 MB over 777 rows in September, 754 of them `done`. Nothing
 * retires a closed card, so the cost of watching the board went up every day
 * for a payload the columns do not draw - beyond the last few dozen, a done
 * card is looked at through the archive, which is its own query.
 *
 * 120: more than a screen of the `done` column at any zoom, small enough that
 * the feed stops tracking the lifetime of the installation.
 */
const DONE_FEED_LIMIT = 120;


/**
 * Cap for AGENT-authored comments (the session surface only — humans are
 * uncapped). Generous enough for 2-3 dense sentences or a question block,
 * tight enough to reject log dumps; the 400 message coaches a retry.
 */
const AGENT_COMMENT_MAX_CHARS = 600;




/** `/api/all-boards/publish-status` answers from here for a short while; a publish empties it. */
const PUBLISH_STATUS_TTL_MS = 30_000;
let publishStatusCache: { key: string; until: number; body: { projects: unknown[] } } | null = null;





export function createTasksRouter(ctx: AppContext, dispatcher?: TaskDispatcher, opts?: TasksRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, broadcastToTopicSubscribers, getTopicBySessionKey, isPathAllowed } = ctx;
  // La SCHEDA DI CONSEGNA (l'anteprima disegnata quando non ce n'e' nessuna)
  // si scrive sotto `<dati>/media/`, cioe' dentro l'allowlist che la serve.
  const svc = createTaskService(db, {
    writeDeliverySheet: makeSheetWriter(ctx.APP_DATA_DIR),
    repoRootFor: opts?.repoRootFor,
    listRepoRoots: opts?.listRepoRoots,
    listProjectDirs: opts?.listProjectDirs,
    probeFor: opts?.probeFor,
    // The delivery note that waited on git lands after the PATCH broadcast:
    // the same second emit every other late `addComment` in this file makes.
    onLateDeliveryNote: (taskId, projectId) => {
      const noted = svc.get(taskId, { projectId })?.task;
      if (noted) broadcastToAll({ type: "task:updated", projectId, task: noted });
    },
  });
  const attempts = createTaskAttemptStore(db);

  const late = {} as TasksLate;
  const core: TasksCore = {
    ctx, opts, dispatcher, svc, attempts, db, json, readJSON, matchRoute,
    broadcastToAll, broadcastToTopicSubscribers, getTopicBySessionKey, isPathAllowed,
  };
  const intake = createTasksIntake(core);
  Object.assign(late, intake);
  const { titoloInSottofondo, resolveBoardId } = intake;
  // Il lato «risposta» dell'instradamento delle domande (board-ask-routing.ts).
  // Qui serve solo `deliver`: il commento con la domanda lo scrive l'altra
  // sponda, la gamba dell'attesa in routes/permission.ts.
  const askRouting = {
    db,
    comment: () => null,
    deliver: (sessionKey: string, answers: Record<string, string>) => deliverAnswer(sessionKey, answers),
  };


  const reap = createTasksReap(core);
  Object.assign(late, reap);
  const { sweepRemoteDelivery, reapAttemptWorkspace, captureDelivery, capturaConsegna, triggerUrlProbe } = reap;


  const checks = createTasksChecksDelivery(core, late);
  Object.assign(late, checks);
  const { resumePendingDeliveries } = checks;
  const land = createTasksLand(core, late);
  Object.assign(late, land);
  const { cutLiveTurn, landings, enqueueLand, autoLander, enqueueLandOnDone } = land;

  const deploy = createTasksDeploy(core);
  Object.assign(late, deploy);
  const { proposeDeployIfConfigured, runDeploy, publishProject } = deploy;

  const guards = createTasksGuards(core, late);
  Object.assign(late, guards);
  const { filterMedia, acceptPreview, rejectDeliveryPatch, provenSession, provenGlobalOrchestrator, resolveGlobalTask, resolveExplicitGlobalBoard, rejectUnexpectedGlobalFields, asTaskStatus, fail, checksRedGate, fanOutGate, reviewDeliveryGate, patchGlobalOrchestratorTask } = guards;
  const guests = createTasksGuests(core);
  Object.assign(late, guests);
  const { handleGuestComment, handleGuestEdit } = guests;
  // The human board routes live in tasks-board.ts; same closure values, passed by name.
  const boardRoutes = createBoardRoutes({
    ctx, dispatcher, opts, matchRoute, json, readJSON, broadcastToAll, svc, scheduledCards: opts?.scheduledCards, askRouting, landings,
    emitReviewReadyEdge, titoloInSottofondo, resolveBoardId, sweepRemoteDelivery, captureDelivery,
    triggerUrlProbe, cutLiveTurn, enqueueLand, enqueueLandOnDone, proposeDeployIfConfigured, runDeploy,
    publishProject, filterMedia, acceptPreview, rejectDeliveryPatch, asTaskStatus, fail, checksRedGate,
  });
  const tasksRouter = async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    const sessionActionOrigin = req.headers.get("X-Topics-Action-Origin") === "mcp" ? "mcp" : "api";
    // Fast reject: only task paths — agent (session-scoped) or human (board-scoped),
    // plus the machine-wide dispatch-capacity probe (a /api/system/ path that this
    // router owns because it reads the same dispatch config).
    // ── OSPITI: il filtro sta QUI, prima dello smistamento, e non copiato in
    // ogni ramo. È la stessa lezione di `resolveProjectPath`, il cui commento
    // dice «il fix sta QUI e non sui 47 chiamanti: metterlo lì significherebbe
    // dimenticarne uno, e quello dimenticato sarebbe il buco».
    //
    // Un ospite vede SOLO i task che gli sono stati condivisi, e li vede in sola
    // lettura. Tutto il resto di questo router — board, dispatch, commenti,
    // capacità, publish — non è roba sua: non è nascosto, è negato.
    const identita = ctx.requestIdentity?.(req) ?? null;
    // SOLO sui percorsi che QUESTO router serve. Il blocco intercettava anche
    // `/api/topics/...`, che è di un altro router, e rispondeva «non condiviso»
    // a una chat regolarmente concessa: un router che nega per conto di un altro
    // è un guasto che si manifesta lontano dalla sua causa.
    const miePath = pathname.startsWith("/api/tasks/")
      || pathname.startsWith("/api/all-boards/")
      || pathname.startsWith("/api/boards/")
      || pathname.startsWith("/api/orchestrator-sessions/")
      || pathname === "/api/system/dispatch-capacity"
      || pathname === "/api/dispatch/memory-queue"
      || pathname === "/api/dispatch/brakes"
      || pathname === "/api/dispatch/brakes/lift";
    if (identita?.role === "guest" && miePath) {
      if (pathname === "/api/dispatch/memory-queue" || pathname === "/api/dispatch/brakes" || pathname === "/api/dispatch/brakes/lift") {
        return json({ error: "dispatch data is not available to guests", code: "guest_forbidden" }, 403);
      }
      const deviceId = identita.deviceId;
      if (!deviceId) return json({ error: "guest without an identity", code: "forbidden" }, 403);

      // TUTTI i principali, come il cancello in `server.ts` e come
      // `/api/auth/shared`: il solo `deviceP` rendeva invisibile in questo
      // elenco una scheda condivisa con la PERSONA — che è il soggetto che
      // l'interfaccia offre — pur restando apribile per id dal cancello.
      const guestPrincipals = resolvePrincipals(ctx.db, deviceId).list;
      // `readableTaskIds` and not the direct rows alone: a card inside a
      // shared PROJECT carries no grant row of its own, and the gate has
      // followed the container since 20260816230500 - so this feed answered
      // with an empty board about cards the same guest could open by id.
      const condivisi = new Set(readableTaskIds(ctx.db, guestPrincipals));

      // L'elenco: solo i suoi, e il PREDICATO ARRIVA FINO A SQL. Prima si
      // idratava ogni task del database — ogni etichetta, ogni bloccante, ogni
      // conto di coda — per poi tenerne i due condivisi in JS: l'ospite pagava
      // l'intera board per vedere le sue due schede. `ids` rende quel filtro una
      // clausola, e un insieme vuoto esce senza interrogare niente.
      if (pathname === "/api/all-boards/tasks") {
        if (method !== "GET") return json({ error: "read only", code: "guest_read_only" }, 403);
        return json({ tasks: svc.list({ scope: "all", rootsOnly: true, ids: [...condivisi], doneLimit: DONE_FEED_LIMIT }).map(toFeedTask) });
      }

      // A single task: reads the level — not just whether it's shared, as it
      // was when `deny`/`read` were the only scale — via `levelFor`, which
      // also follows the containing project (a card shared only through its
      // project used not to show up here, while still visible elsewhere).
      const idInPath = pathname.match(/\/api\/tasks\/([^/]+)/)?.[1];
      const idTask = idInPath ? decodeURIComponent(idInPath) : null;
      if (!idTask) return json({ error: "not shared", code: "not_shared" }, 403);
      const level = levelFor(ctx.db, guestPrincipals, "task", idTask);
      if (level === null || level === "deny") {
        return json({ error: "not shared", code: "not_shared" }, 403);
      }

      // The ONLY writes granted to a guest, each with its own minimum level -
      // everything else on this router (run, stop, retitle, label, move,
      // merge, land, publish, deploy, ...) stays out of reach: those are
      // "start an agent / code change / approval / publishing", never implicit
      // in a collaboration level.
      const guestAction = matchGuestTaskAction(pathname, idInPath!, method);
      if (guestAction === "unsupported") return json({ error: "read only", code: "guest_read_only" }, 403);
      if (guestAction !== "read" && guestAction !== "run" && !meetsLevel(level, guestAction)) {
        return json({ error: "insufficient level", code: "guest_level_denied", need: guestAction, have: level }, 403);
      }
      if (guestAction === "run") {
        const rawBody = await req.text();
        let body: unknown = null;
        if (rawBody.trim()) {
          try { body = JSON.parse(rawBody); }
          catch { return json({ error: "body must be empty", code: "guest_run_body_not_empty" }, 400); }
        }
        if (body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body as object).length !== 0)) {
          return json({ error: "body must be empty", code: "guest_run_body_not_empty" }, 400);
        }
        const loaded = svc.get(idTask);
        if (!loaded) return json({ error: "not shared", code: "not_shared" }, 403);
        let capability;
        try {
          capability = liveAgentStartCapability(ctx.db, {
            principals: guestPrincipals,
            projectId: loaded.task.projectId,
            canonicalLocalMachineId: ctx.machineStore?.upsertLocal().id ?? null,
          });
        } catch {
          capability = null;
        }
        if (!capability) return json({ error: "agent start not authorized", code: "agent_start_denied" }, 403);
        const personId = resolvePrincipals(ctx.db, deviceId).personId;
        try {
          queueDelegatedRun(ctx.db, {
            taskId: idTask,
            capability,
            initiatorPersonId: personId,
            initiatorDeviceId: deviceId,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "task_not_executable";
          return json({ error: "task cannot be started", code }, code === "task_not_executable" ? 409 : 403);
        }
        const task = svc.get(idTask)!.task;
        broadcastToAll({ type: "task:updated", projectId: task.projectId, task });
        dispatcher?.onEnterTodo(task.projectId, task.id);
        return json({ task, queued: true }, 202);
      }
      if (guestAction === "comment") {
        return await handleGuestComment(idTask, deviceId, req);
      }
      if (guestAction === "edit") {
        return await handleGuestEdit(idTask, deviceId, req);
      }
      // "read": the task by id, with its thread — no other handler further
      // down answers `/api/tasks/:id` (that prefix only ever served as an
      // entry gate so far, never as a real route).
      const loaded = svc.get(idTask);
      if (!loaded) return json({ error: "task not found", code: "not_found" }, 404);
      return json({ ...loaded.task, comments: loaded.comments });
    }

    const isSession = pathname.startsWith("/api/sessions/");
    const isOrchestratorSession = pathname.startsWith("/api/orchestrator-sessions/");
    const isBoard = pathname.startsWith("/api/boards/");
    const isAllBoards = pathname.startsWith("/api/all-boards/");
    const isCapacity = pathname === "/api/system/dispatch-capacity";
    const isMemoryQueue = pathname === "/api/dispatch/memory-queue";
    const isBrakes = pathname === "/api/dispatch/brakes";
    const isBrakeLift = pathname === "/api/dispatch/brakes/lift";
    if (!isSession && !isOrchestratorSession && !isBoard && !isAllBoards && !isCapacity && !isMemoryQueue && !isBrakes && !isBrakeLift) return null;

    const brakesBody = () => ({
      brakes: dispatchBrakes(),
      ...(dispatcher?.dispatchWork?.() ?? { held: [], working: {} }),
      claudeFiveHour: planUsage()?.fiveHour?.utilization ?? null,
    });

    // POST /api/dispatch/brakes/lift: «Togli il freno a Claude» (HUBBR-20).
    // Only Claude's early stop, Topics' own margin under the five-hour wall,
    // can be lifted; a hold is the provider's wall and answers 409. The answer
    // is the same body as the GET, so the chip redraws from it at once.
    if (isBrakeLift) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      if (!liftClaudeEarlyStop()) return json({ error: "no early stop to lift", code: "not_liftable" }, 409);
      return json(brakesBody());
    }

    // GET /api/dispatch/brakes: the providers whose cards wait in Todo right
    // now, with the window, its share and when they start again (HUBBR-20).
    if (isBrakes) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      // The walls, and the cards behind them as the dispatcher judges each
      // one: a wall that holds no card (every card on Automatic found another
      // runtime) is a wall the chip does not name as a brake.
      return json(brakesBody());
    }

    // GET /api/dispatch/memory-queue — the dispatcher's read-only memory view.
    // Keep this route on the same global identity and origin gate as every API
    // request; guests are rejected above because this is machine-wide data.
    if (isMemoryQueue && method === "GET") {
      const memoryQueueDispatcher = dispatcher as (TaskDispatcher & {
        memoryQueueSnapshot?: () => DispatchMemoryQueueSnapshot;
      }) | undefined;
      try {
        const snapshot = memoryQueueDispatcher?.memoryQueueSnapshot?.();
        return snapshot
          ? json(snapshot)
          : json({ error: "dispatch memory queue unavailable", code: "dispatcher_unavailable" }, 503);
      } catch (error) { return fail(error); }
    }

    // GET /api/all-boards/tasks — the global cross-project feed (human overview).
    // Read-only: per-task mutations still go to /api/boards/:projectId/... using
    // each task's own projectId.
    if (pathname === "/api/all-boards/tasks" && method === "GET") {
      const status = new URL(req.url).searchParams.get("status") || undefined;
      // Columns show ROOT tasks only — steps live in the parent's detail tree.
      // Tranne gli ORFANI (padre chiuso, archiviato o sparito): quello non è
      // l'albero di nessuno, e fuori dalle colonne non lo guarda più niente.
      // The `done` column of the global feed is capped: see DONE_FEED_LIMIT.
      // An explicit `?status=done` is a request for that column and is served
      // capped too - it is the same rows the board would draw.
      // The feed drops the fields no client reads (shared/board-feed.ts).
      // Revalidatable: an unchanged feed answers 304 with no body (see the helper).
      try { return conditionalJson(req, { tasks: svc.list({ scope: "all", status: asTaskStatus(status), rootsOnly: true, includeOrphanSubtasks: true, doneLimit: DONE_FEED_LIMIT }).map(toFeedTask) }); }
      catch (e) { return fail(e); }
    }

    // GET /api/all-boards/tasks/:taskId — LA PORTA UNICA «da un id al suo task, a
    // qualunque profondità». Il feed qui sopra è `rootsOnly` (le colonne mostrano
    // le radici) ed è l'unico risolutore cross-progetto che il client abbia: da un
    // id di SOTTOTASK non si arrivava a niente — click su uno step nell'albero del
    // drawer, deep-link `/task/<id>`, click su una notifica. Questa rotta non
    // filtra né per profondità né per progetto: dato un id, restituisce il task e
    // il suo `projectId`, che è quanto serve per aprirlo con le rotte normali.
    //
    // Risponde SEMPRE 200: «quest'id non esiste» è una risposta legittima di un
    // risolutore, non un errore di trasporto. Un 404 arriva al client come la
    // stessa `Error` di una rete caduta, e il chiamante deve distinguere i due
    // casi (smettere di aspettare / tenere vivo il deep-link).
    //
    // Non filtra `archived`: è la stessa semantica di `svc.get`, che serve la
    // porta per-progetto già esistente — un deep-link vecchio a un task archiviato
    // apre il suo drawer invece di restare appeso.
    //
    // Ospiti: negata due volte e per costruzione. Il cancello esterno
    // (`isGuestAllowedPath`) confronta `/api/all-boards/tasks` per uguaglianza,
    // quindi questo percorso non è in allowlist; e il ramo ospite di questo router
    // riconosce solo `/api/tasks/:id` fra i concessi, quindi cade su 403.
    // GET /api/all-boards/tasks/by-topic/:topicId — from a CHAT TOPIC back to the
    // card it belongs to. The terminal pane of a dead session asks it to say why
    // it is dormant (`dormantCause.ts`): without this door the pane knows its
    // topic and nothing else, and "Session ended" is all it can say.
    //
    // It does NOT collide with `/api/all-boards/tasks/:taskId` below, and the
    // order of the two is therefore free: `matchRoute` compares the number of
    // segments FIRST (`server/utils.ts`), and six can never match five. Pinned
    // by `tasks.by-topic.test.ts`, which seeds a card whose id is literally
    // "by-topic" and still gets this handler's answer.
    //
    // Always 200: "no card for this topic" is a legitimate answer from a
    // resolver, and the caller draws its plain overlay on it. Same reasoning as
    // the by-id door below.
    const byTopic = matchRoute(pathname, "/api/all-boards/tasks/by-topic/:topicId");
    if (byTopic && method === "GET") {
      try {
        const taskId = svc.taskIdOfTopic(byTopic.topicId);
        return json({ task: taskId ? (svc.get(taskId)?.task ?? null) : null });
      } catch (e) { return fail(e); }
    }

    const sessionPeek = matchRoute(pathname, "/api/all-boards/tasks/:taskId/peek");
    if (sessionPeek && method === "GET") {
      try {
        const taskId = decodeMemoryQueueRef(sessionPeek.taskId);
        if (!taskId) return json({ error: "invalid task reference", code: "invalid_reference" }, 400);
        const task = svc.get(taskId)?.task;
        if (!task?.assignedTopicId) return json({ peek: null });
        const topic = ctx.getTopicById(task.assignedTopicId);
        if (!topic) return json({ peek: null });
        const message = ctx.db.query(
          `SELECT content, timestamp FROM messages
           WHERE session_key = ? AND role = 'assistant' AND TRIM(content) <> ''
           ORDER BY sort_order DESC, rowid DESC LIMIT 1`,
        ).all(topic.sessionKey) as Array<{ content: string; timestamp: string | null }>;
        const stream = ctx.activeStreams.get(topic.sessionKey);
        const runningTool = stream ? ctx.getMessageById(stream.messageId)?.toolCalls?.find((call) => call.status === "running") : null;
        return json({ peek: selectTaskSessionPeek(task, message, runningTool?.name ?? null, stream ?? null) });
      } catch (e) { return fail(e); }
    }

    const allTaskItem = matchRoute(pathname, "/api/all-boards/tasks/:taskId");
    if (allTaskItem && method === "GET") {
      try {
        const taskId = decodeMemoryQueueRef(allTaskItem.taskId);
        if (!taskId) return json({ error: "invalid task reference", code: "invalid_reference" }, 400);
        return json({ task: svc.get(taskId)?.task ?? null });
      }
      catch (e) { return fail(e); }
    }

    // GET /api/system/dispatch-capacity — the auto concurrency cap this machine
    // can sustain right now (CPU/load), shown in the board settings' "Auto" option.
    if (pathname === "/api/system/dispatch-capacity" && method === "GET") {
      // `running` viene dal dispatcher, non dal sistema operativo: è il numero
      // che rende il consiglio leggibile («ne girano 4, ne reggo 2») invece di
      // un tetto astratto. Senza dispatcher (host degradato) vale 0.
      let running = 0;
      try { running = dispatcher?.busyCount() ?? 0; } catch { /* best-effort */ }
      // The budget knob travels with the reading: the gauge, the panel and the
      // gate have to answer from ONE number, or the slider promises a share the
      // dispatcher is not applying.
      let admission: DispatchAdmission | null = null;
      // `?board=<id>` asks the same question for one board's price: a light
      // board (in place, no local check) and a repo board are not held by the same line.
      const board = new URL(req.url).searchParams.get("board");
      try { admission = dispatcher?.admissionPreview?.(board) ?? null; } catch { /* best-effort */ }
      return json({
        ...computeDispatchCapacity(running, undefined, resolveAgentRuntime() === "cli", undefined, {
          share: budgetShare(svc.getGlobalCap()),
          frozen: activeFrozenCount(),
          swapFrozen: swapFrozenCount(),
          resources: capMode(svc.getGlobalCap()) === "resources",
        }),
        admission,
      });
    }

    // GET /api/all-boards/publish-status — per-project "commits not yet pushed"
    // summary that feeds the board's Publish control (primarily the GLOBAL board,
    // where every project shows up together). Best-effort git, never throws.
    if (pathname === "/api/all-boards/publish-status" && method === "GET") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      // Twenty git spawns per project, on every bootstrap of every window:
      // measured at 3.0s alone and 3.8s under load on 2026-09-03. The answer
      // only moves on a commit or a push, so a short cache is honest; the
      // publish route below drops it when it pushes.
      const cacheKey = dirs.join("\n");
      const hit = publishStatusCache;
      if (hit && hit.key === cacheKey && hit.until > Date.now()) return json(hit.body);
      const projects = (await Promise.all(dirs.map(async (path) => {
        const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
        const remotes = (await runGitCap(path, ["remote"])).out.trim();
        if (!branch || !remotes) return null; // detached HEAD or no remote → not publishable
        const upstream = (await runGitCap(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim();
        const range = upstream && !upstream.includes("fatal") ? `${upstream}..HEAD` : `origin/${branch}..HEAD`;
        const aheadRaw = (await runGitCap(path, ["rev-list", "--count", range])).out.trim();
        const ahead = Number.parseInt(aheadRaw || "0", 10);
        // The actual commit list that a push would ship — so the UI can show WHAT
        // goes out (subject + author + short hash) instead of a blind count, and
        // the human can spot a wrong-project / un-approved commit before pushing.
        // %x1f = unit separator (safe field delimiter); one commit per line, newest first.
        let commits: { hash: string; subject: string; author: string; when: string }[] = [];
        if (ahead > 0) {
          const logRaw = (await runGitCap(path, ["log", range, "--pretty=format:%h%x1f%s%x1f%an%x1f%ar", "--max-count=50"])).out;
          commits = logRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, subject, author, when] = line.split("\x1f");
            return { hash: hash ?? "", subject: subject ?? "", author: author ?? "", when: when ?? "" };
          });
        }
        return { projectId: projectIdForPath(path), name: basename(path), branch, ahead: Number.isFinite(ahead) ? ahead : 0, commits };
      }))).filter((p): p is NonNullable<typeof p> => !!p);
      publishStatusCache = { key: cacheKey, until: Date.now() + PUBLISH_STATUS_TTL_MS, body: { projects } };
      return json({ projects });
    }

    // POST /api/boards/:projectId/publish — push the project's current branch to
    // its remote. On repos with deploy CI (demoapp's deploy.yml runs on push to
    // main) this IS the deploy trigger — a deliberate, human-initiated action
    // (the board UI gates it behind a confirm).
    const bPublish = matchRoute(pathname, "/api/boards/:projectId/publish");
    if (bPublish && method === "POST") {
      publishStatusCache = null;
      const res = await publishProject(bPublish.projectId);
      if (!res.ok) {
        const code = res.error === "progetto non trovato" ? 404 : res.branch ? 502 : 400;
        return json({ ...res, code: res.branch ? undefined : "invalid_input" }, code);
      }
      return json(res);
    }

    // GET /api/boards/:projectId/publish-diff — the unified diff of the commits a
    // publish would push (the SAME range as publish-status' `ahead`). Lets the UI
    // show WHAT ships, line by line, before pushing.
    const bPubDiff = matchRoute(pathname, "/api/boards/:projectId/publish-diff");
    if (bPubDiff && method === "GET") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      const path = dirs.find((d) => projectIdForPath(d) === bPubDiff.projectId);
      if (!path) return json({ error: "project not found", code: "not_found" }, 404);
      const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
      if (!branch) return json({ error: "detached HEAD", code: "invalid_input" }, 400);
      const upstream = (await runGitCap(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim();
      const range = upstream && !upstream.includes("fatal") ? `${upstream}..HEAD` : `origin/${branch}..HEAD`;
      // `?file=` (with `context=full` and a rename's `orig`, or `blob=` for the bytes): one file, on the same range.
      const q = new URL(req.url).searchParams;
      const onlyFile = q.get("file");
      const blob = q.get("blob");
      if (onlyFile !== null && blob !== null) return serveDiffBlob({ cwd: path, range, live: false }, onlyFile, blob);
      if (onlyFile !== null) {
        const one = await gitDiffFilePatch(path, range, onlyFile, { fullContext: q.get("context") === "full", origPath: q.get("orig") });
        return one ? json({ branch, range, ...one }) : json({ error: "invalid file path", code: "invalid_input" }, 400);
      }
      const [bundle, revs] = await Promise.all([gitDiffBundle(path, range), revsOfRange(gitRunner, path, range, false)]);
      return json({ branch, range, revs, ...bundle });
    }

    // GET /api/boards/:projectId/tasks/:taskId/diff — il diff di ciò che questa
    // card ha cambiato.
    //
    // Tre ancoraggi in ordine (`task-diff-range.ts`): il worktree VIVO — e lì la
    // gamma è quella dei commit PROPRI della card, non `merge-base main HEAD`,
    // che su un ramo nato dall'HEAD del checkout condiviso le intestava i commit
    // di un'altra sessione — poi il merge che il land ha scritto su main, poi il
    // commit di consegna. Gli ultimi due sono ciò che fa sopravvivere il pannello
    // alla potatura del worktree: prima del land la risposta spariva a cose fatte.
    //
    // Quando non c'è un diff, il PERCHÉ viaggia in `code` e sono tre risposte
    // diverse — `no_changes` (verificato: niente codice), `unreadable` (non
    // ricostruibile) e `not_dispatched` (nessuno ci ha lavorato). Prima erano un
    // silenzio solo, e chi rivedeva non poteva distinguerle.
    const bTaskDiff = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/diff");
    if (bTaskDiff && method === "GET") {
      const empty = { stat: [], patch: "", truncated: false, base: null, source: null, revs: null };
      const miss = (code: string, branch: string | null = null) => json({ code, branch, ...empty });
      let found: ReturnType<typeof svc.get> | null = null;
      try { found = svc.get(bTaskDiff.taskId, { projectId: bTaskDiff.projectId }) ?? null; }
      catch { found = null; }
      if (!found) return miss("not_dispatched");
      // `?attempt=<id>` → il diff di QUEL tentativo del fan-out invece che del
      // task: è come si confrontano N alternative prima di sceglierne una (il
      // task punta ancora al tentativo 1, che può non essere il vincitore).
      // Il vincolo `taskId` sul tentativo è la guardia: un id di un altro task
      // non può farsi leggere il diff da questa board.
      const attemptId = new URL(req.url).searchParams.get("attempt");
      let topicId: string | null | undefined = found.task.assignedTopicId;
      if (attemptId) {
        const a = attempts.get(attemptId);
        topicId = a && a.taskId === bTaskDiff.taskId ? a.topicId : null;
      }
      const worktreeId = topicId ? ctx.getTopicById(topicId)?.worktreeId : null;
      const wt = worktreeId ? ctx.worktreeStore.get(worktreeId) : null;
      const live = wt && wt.mode === "branch" && wt.absPath && existsSync(wt.absPath)
        ? { cwd: wt.absPath, branch: wt.branchName ?? null }
        : null;

      // Un TENTATIVO vive solo nel suo worktree: i riferimenti durevoli (il merge
      // su main, il commit di consegna) parlano della CARD, cioè del tentativo
      // scelto — mostrarli sotto un perdente sarebbe il diff di un altro.
      let repoPath: string | null = null;
      if (!attemptId) {
        let dirs: string[] = [];
        try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        repoPath = dirs.find((d) => projectIdForPath(d) === bTaskDiff.projectId) ?? null;
      }
      const delivery = attemptId
        ? null
        : { branch: found.task.deliveryBranch, commit: found.task.deliveryCommit };

      const range = await resolveTaskDiffRange({
        taskId: bTaskDiff.taskId, worktree: live, repoPath, delivery, runGit: gitRunner,
      });
      const q = new URL(req.url).searchParams;
      const onlyFile = q.get("file");
      const blob = q.get("blob");
      if (onlyFile !== null && blob !== null) return serveDiffBlob(range, onlyFile, blob);
      const branch = live?.branch ?? wt?.branchName ?? found.task.deliveryBranch ?? null;
      if (!range) {
        const everWorked = attemptId
          ? !!topicId
          : !!topicId || !!found.task.deliveryBranch || !!found.task.deliveryCommit;
        return miss(everWorked ? "unreadable" : "not_dispatched", branch);
      }
      // includeUntracked solo sulla gamma VIVA: una card il cui unico frutto è un
      // file mai committato deve comunque mostrare un diff. Su due commit (un land
      // è già storia) l'albero di lavoro non c'entra niente.
      // `?file=<path>`: the patch of ONE file, on the same range the bundle
      // used. It is how a file past the bundle's cap gets read, and with
      // `context=full` how the panel shows the whole file; `orig` names a
      // rename's old path (see `gitDiffFilePatch`). The bundle is untouched.
      if (onlyFile !== null) {
        const one = await gitDiffFilePatch(range.cwd, range.range, onlyFile, {
          includeUntracked: range.live, fullContext: q.get("context") === "full", origPath: q.get("orig"),
        });
        if (!one) return json({ error: "invalid file path", code: "invalid_input" }, 400);
        return json({ branch, base: range.range, source: range.source, ...one });
      }
      const [bundle, revs] = await Promise.all([
        gitDiffBundle(range.cwd, range.range, { includeUntracked: range.live }),
        revsOfRange(gitRunner, range.cwd, range.range, range.live),
      ]);
      const body = { branch, base: range.range, source: range.source, revs, ...bundle };
      return json(bundle.stat.length === 0 ? { code: "no_changes", ...body } : body);
    }

    // PUT /api/boards/:projectId/tasks/:taskId/labels — la porta UMANA.
    //
    // PUT e non PATCH: la board manda l'insieme che vuole vedere, così togliere
    // l'ultima etichetta è una richiesta come le altre e non un verbo a parte.
    // Attilio può correggere qualunque etichetta, `invisibile` compresa — è il
    // punto: la derivazione è una misura, non un verdetto, e la sua correzione
    // resta (`source: 'human'` la mette al riparo dalla consegna successiva).
    const bLabels = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/labels");
    if (bLabels && (method === "PUT" || method === "POST")) {
      const body = (await readJSON(req)) as any;
      const raw = Array.isArray(body?.labels) ? body.labels : [];
      const unknown = raw.filter((l: unknown) => typeof l === "string" && !isTaskLabel(l));
      if (unknown.length) {
        return json({
          error: `unknown labels: ${unknown.join(", ")}. The vocabulary is closed (shared/task-labels.ts).`,
          code: "invalid_input",
        }, 400);
      }
      try {
        const task = svc.setLabels({
          taskId: bLabels.taskId,
          projectId: bLabels.projectId,
          labels: normalizeLabels(raw),
          actor: "human",
          source: "human",
        });
        broadcastToAll({ type: "task:updated", projectId: bLabels.projectId, task });
        return json(task);
      } catch (e) { return fail(e); }
    }

    // GET /api/boards/:projectId/tasks/:taskId/attempts — i tentativi di un
    // fan-out. Lista vuota per un task dispatchato normalmente: il drawer non
    // disegna il pannello e nessuno si accorge che questa route esiste.
    const bAttempts = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/attempts");
    if (bAttempts && method === "GET") {
      try {
        if (!svc.get(bAttempts.taskId, { projectId: bAttempts.projectId })) {
          return json({ error: "task not found", code: "not_found" }, 404);
        }
        return json({ attempts: attempts.list(bAttempts.taskId) });
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/attempts/:attemptId/select — la
    // scelta umana del vincitore di un fan-out.
    //
    // Tutto il peso sta in UNA riga (`svc.bindTopic`): `worktreeOfTask` in
    // server.ts risolve task → assigned_topic_id → topic.worktreeId → worktree,
    // e su quella indirezione viaggiano già diff, gate sullo sporco, checks,
    // fotografia di consegna, land, anteprima e reap. Ri-puntarla è la scelta;
    // il resto di questa route è conseguenza (fotografia, pulizia dei perdenti,
    // nota nel thread), non idraulica nuova.
    const bAttemptPick = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/attempts/:attemptId/select");
    if (bAttemptPick && method === "POST") {
      const { projectId, taskId, attemptId } = bAttemptPick;
      try {
        if (!svc.get(taskId, { projectId })) return json({ error: "task not found", code: "not_found" }, 404);

        // Un tentativo ancora vivo può committare tra un istante: scegliere
        // adesso vorrebbe dire potare un worktree mentre ci lavora un agente.
        if (attempts.runningCount(taskId) > 0) {
          return json({
            error: "the fan-out is not settled yet: wait for every attempt to finish",
            code: "fanout_running",
          }, 409);
        }

        const target = attempts.get(attemptId);
        if (!target || target.taskId !== taskId) return json({ error: "attempt not found", code: "not_found" }, 404);
        if (!target.topicId) {
          return json({
            error: "this attempt never had a session: there is nothing to keep",
            code: "invalid_input",
          }, 409);
        }

        // ── LA SCELTA SI FA UNA VOLTA SOLA ────────────────────────────────
        //
        // `attempts.select` è atomico DENTRO di sé (una transazione: mai due
        // `selected`), ma non ha una PRECONDIZIONE: una seconda `select` su un
        // tentativo diverso ripuntava il task su un worktree che la prima aveva
        // già potato — `reapAttemptWorkspace` sui perdenti gira fuori dalla
        // transazione, e da lì in poi diff, checks, land e anteprima seguivano
        // un'indirezione morta. Due click su due schede, o un doppio invio, e
        // il lavoro scelto per primo non è più raggiungibile.
        //
        // Il cancello sta QUI, alla porta, con la stessa forma del 409
        // `fanout_running` qui sopra: si nomina il tentativo che ha già vinto,
        // così chi legge sa cosa è stato deciso invece di riprovare. Ripremere
        // sullo STESSO tentativo resta idempotente: non c'è niente da rifare,
        // ma neanche niente di sbagliato da dire.
        const giaScelto = attempts.list(taskId).find((a) => a.state === "selected");
        if (giaScelto && giaScelto.id !== attemptId) {
          return json({
            error: `the fan-out of this task is already decided: attempt #${giaScelto.idx} won, and the other worktrees were pruned`,
            code: "fanout_already_decided",
            attemptId: giaScelto.id,
          }, 409);
        }

        const picked = attempts.select(taskId, attemptId);
        if (!picked) return json({ error: "attempt not found", code: "not_found" }, 404);
        const winner = picked.winner;

        let task = svc.bindTopic({ taskId, topicId: winner.topicId! });

        // La consegna è di ADESSO: branch e commit dell'audit sono quelli del
        // vincitore, non quelli del tentativo 1 a cui il task era legato un
        // istante fa. `captureDelivery` non scatta (il task è in review da
        // quando il fan-out ha chiuso), quindi la fotografia si prende qui.
        if (await capturaConsegna(taskId)) {
          task = svc.get(taskId, { projectId })?.task ?? task;
        }

        const losers = picked.losers;
        await Promise.all(losers.map((l) => reapAttemptWorkspace(l)));

        // Stesso formato del confronto e del pannello (`formatAttemptStat`): due
        // modi di scrivere lo stesso numero si leggono come due numeri diversi.
        const stat = attemptHasWork(winner)
          ? ` (${formatAttemptStat(winner)})`
          : ", che però non ha modificato niente";
        const tail = losers.length
          ? ` Gli altri ${losers.length} tentativi sono stati buttati: worktree, branch e chat.`
          : "";
        svc.addComment({
          taskId, projectId, author: "system",
          content: `Scelto il **tentativo ${winner.idx}**${winner.branch ? ` · \`${winner.branch}\`` : ""}${stat}.${tail}`,
        });

        // Ora che il worktree del task È quello del vincitore, l'anteprima ha
        // qualcosa di vero da mostrare (alla chiusura del fan-out non l'aveva).
        if (opts?.preparePreview) void opts.preparePreview(taskId).catch(() => { /* best-effort */ });

        task = svc.get(taskId, { projectId })?.task ?? task;
        broadcastToAll({ type: "task:updated", projectId, task });
        return json({ task, attempts: attempts.list(taskId) });
      } catch (e) { return fail(e); }
    }

    // /api/all-boards/settings — the GLOBAL auto-dispatch switch (one for every
    // board, reserved board_settings row '*'). The header pill on any board —
    // including the global one — reads and flips this. `board:dispatch` (no
    // projectId) tells every open board header to update.
    if (pathname === "/api/all-boards/settings") {
      if (method === "GET") {
        try {
          // The spend travels with the caps and is read even when they are off:
          // `task-spend-caps.ts` says why, and owns the field names.
          return json({
            autoDispatch: svc.getGlobalAutoDispatch(),
            ...globalCapFields(svc.getGlobalCap()),
            ...checksFloorFields(svc),
            ...spendSnapshot(svc),
          });
        } catch (e) { return fail(e); }
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        const hasAuto = typeof body?.autoDispatch === "boolean";
        const hasCapAuto = typeof body?.maxAgentsAuto === "boolean";
        const hasCapMax = Number.isFinite(body?.maxAgents);
        // The "by resources" mode and its knob. An out-of-range share is NOT
        // refused: `setGlobalCap` clamps it with the same reader the gate
        // applies, and the response carries the value that will actually rule.
        const hasCapMode = body?.maxAgentsMode === "count" || body?.maxAgentsMode === "resources";
        const hasBudget = Number.isFinite(body?.budgetShare);
        // Out of range is not refused here either: `setChecksMemFloorGB` clamps
        // with the same reader the brake applies, and the answer carries the
        // value that will actually rule.
        const hasFloor = Number.isFinite(body?.checksMemFloorGB);
        const hasSpend = hasSpendCapPatch(body);
        if (!hasAuto && !hasCapAuto && !hasCapMax && !hasCapMode && !hasBudget && !hasFloor && !hasSpend) {
          return json({ error: "autoDispatch, maxAgentsAuto (boolean), maxAgents, maxAgentsMode ('count'|'resources'), budgetShare, checksMemFloorGB, agentCostCapCents and/or agentCostCapCents24h (number) required", code: "invalid_input" }, 400);
        }
        try {
          let autoDispatch = svc.getGlobalAutoDispatch();
          if (hasAuto) {
            autoDispatch = svc.setGlobalAutoDispatch(body.autoDispatch);
            broadcastToAll({ type: "board:dispatch", autoDispatch });
          }
          // The ONE machine-wide cap lives on the reserved '*' row; the dispatcher
          // reads it via getGlobalCap() and enforces it across every board.
          if (hasCapAuto || hasCapMax || hasCapMode || hasBudget) {
            svc.setGlobalCap({
              auto: hasCapAuto ? body.maxAgentsAuto : undefined,
              max: hasCapMax ? body.maxAgents : undefined,
              mode: hasCapMode ? body.maxAgentsMode : undefined,
              budgetShare: hasBudget ? body.budgetShare : undefined,
            });
          }
          // The checks floor is written by a PERSON too, from the same panel.
          // Zero switches the memory brake off in front of every check command.
          if (hasFloor) svc.setChecksMemFloorGB(body.checksMemFloorGB);
          // The spend caps are written by a PERSON, from here. Zero clears a cap.
          if (hasSpend) applySpendCapPatch(svc, body);
          const capFields = globalCapFields(svc.getGlobalCap());
          const floor = checksFloorFields(svc);
          const caps = spendCapFields(svc);
          broadcastToAll({ type: "board:global-cap", ...capFields, ...floor, ...caps });
          return json({ autoDispatch, ...capFields, ...floor, ...caps });
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // /api/all-boards/projects — the board index (task-detail project selector).
    //   GET  → every project dir the server knows, as {projectId, name, path}
    //          (projectId = the same hash the boards key on), PIÙ `newProjectDir`:
    //          la cartella in cui nascerebbe un progetto creato per nome. Il
    //          client la MOSTRA sulla riga «Crea "x"… in <cartella>» — è dedotta
    //          (`newProjectParentDir`), e una deduzione che crea cartelle sul
    //          disco altrui va detta prima, non scoperta dopo.
    //   POST → scaffold a NEW project (same contract as the session create-project
    //          route: sanitized name, dir + CLAUDE.md, 409 on collision) so
    //          "Nuovo progetto…" works from the board too.
    if (pathname === "/api/all-boards/projects") {
      const knownDirs = (): string[] => {
        try { return opts?.listProjectDirs?.() ?? []; } catch { return []; /* best-effort */ }
      };
      const newDir = (): string | null => (opts?.workspaceDir
        ? newProjectParentDir(knownDirs(), { workspaceDir: opts.workspaceDir, homeDir: homedir() })
        : null);
      if (method === "GET") {
        const { projects, labelOnly } = listPickerProjects(loadRegisteredProjects(db), knownDirs());
        return json({ projects, labelOnly, newProjectDir: newDir() });
      }
      if (method === "POST") {
        if (!opts?.workspaceDir) return json({ error: "workspace not configured", code: "invalid_input" }, 500);
        const body = (await readJSON(req)) as any;
        const safeName = (typeof body?.name === "string" ? body.name.trim() : "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required", code: "invalid_input" }, 400);
        // In the projects folder, not the workspace: the workspace is the
        // agent's plumbing, and a hand-typed project that lands there
        // dispatches but can no longer be found. Creation and registration live
        // in `scaffoldNewProject`, the same one chat and sessions use.
        let dir: string;
        try {
          const r = scaffoldNewProject(safeName, {
            workspaceDir: opts.workspaceDir, homeDir: homedir(), knownDirs: knownDirs(), projectStore: ctx.projectStore,
          });
          if (r.exists) return json({ error: `project "${safeName}" already exists`, code: "project_exists" }, 409);
          dir = r.dir;
        } catch (e) { return fail(e); }
        return json({ projectId: projectIdForPath(dir), name: safeName, path: dir }, 201);
      }
      return null;
    }

    // ── Human board API (project-scoped, actor="human") ─────────────────────
    // The board UI knows its projectId and drives these directly. A human MAY
    // move a task to 'done' (the review gate only blocks agents), archive it,
    // and approve/reject a pending review.
    if (isBoard) return await boardRoutes(req, pathname, method);

    // The global coordinator is intentionally a separate, registry-gated
    // surface. Do not add these cross-board powers to `/api/sessions`: ordinary
    // Topic sessions remain bound to their own project by `resolveSession`.

    // POST/GET /api/orchestrator-sessions/:sessionKey/tasks
    const globalCollection = matchRoute(pathname, "/api/orchestrator-sessions/:sessionKey/tasks");
    if (globalCollection) {
      const sk = decodeURIComponent(globalCollection.sessionKey);
      const globalSession = provenGlobalOrchestrator(req, sk);
      if (globalSession instanceof Response) return globalSession;

      if (method === "GET") {
        const status = new URL(req.url).searchParams.get("status") || undefined;
        try {
          // This is a real cross-board read, not a client-side union of
          // project-scoped calls. Detail actions below re-read their task.
          //
          // THE SAME CUT THE HUMAN BOARD MAKES, and it was not: this list was
          // `{ scope: "all", status }` with nothing else, so the coordinator's
          // orientation snapshot carried every subtask of every card and every
          // done task ever closed. Measured on the live board 2026-09-10:
          // 3.673 rows and 6,3 MB out of this route, against 48 rows and 113 KB
          // out of the feed the board itself reads. That payload is what the
          // model pays for, on a plan it can exhaust.
          //
          // Narrowing loses no capability. A subtask is a parent's checklist,
          // never its own card, and the coordinator coordinates CARDS; the done
          // column is capped for the same reason it is capped for a person. And
          // the detail read below resolves an id at ANY depth, which is exactly
          // what the server prompt already tells the coordinator to do before
          // acting ("re-read a task before a detailed action").
          const tasks = svc.list({
            scope: "all",
            status: asTaskStatus(status),
            rootsOnly: true,
            includeOrphanSubtasks: true,
            doneLimit: DONE_FEED_LIMIT,
          });
          return json({ tasks });
        } catch (e) { return fail(e); }
      }

      if (method === "POST") {
        const body = (await readJSON(req)) as {
          board_id?: unknown;
          text?: unknown;
          description?: unknown;
          priority?: unknown;
          assignee?: unknown;
          idempotency_key?: unknown;
          allow_duplicate?: unknown;
          bar?: unknown;
        } | null;
        // Tolerant on purpose: the contract fields a caller may send (who,
        // where from, the bar) are accepted or ignored, never a 400, because a
        // card born incomplete is flagged, not refused. The identity is the
        // session's, so `createdBy`-like fields are dropped, not believed.
        const unexpected = rejectUnexpectedGlobalFields(
          body,
          ["board_id", "text", "description", "priority", "assignee", "idempotency_key", "allow_duplicate",
            "bar", "source", "createdSource", "created_source", "origin_topic_id", "originTopicId", "createdBy", "created_by"],
        );
        if (unexpected) return unexpected;
        if (typeof body?.board_id !== "string" || !body.board_id.trim()) {
          return json({ error: "board_id is required", code: "invalid_input" }, 400);
        }
        const projectId = resolveExplicitGlobalBoard(body.board_id);
        if (!projectId) {
          return json({
            error: "board_id must name a known explicit board; auto, unassigned, and catch-all boards are not valid targets",
            code: "invalid_input",
          }, 400);
        }

        // Same duplicate gate as the ordinary agent surface. A global task is
        // still a normal task on one real board, so collision detection belongs
        // to that board and an explicit override remains auditable in the body.
        if (body?.allow_duplicate !== true && typeof body?.text === "string" && body.text.trim()) {
          const twins = svc
            .findDuplicates({ projectId, text: body.text, limit: 3, rootsOnly: true })
            .filter((near) => near.duplicate);
          if (twins.length > 0) {
            return json({
              error: `a card already says it: "${twins[0]!.task.text}". Read that one and comment on it with comment_global_task; if it really is different work, create again with allow_duplicate: true.`,
              code: "duplicate",
              duplicates: twins.map((near) => ({
                id: near.task.id,
                text: near.task.text,
                score: Number(near.score.toFixed(3)),
              })),
            }, 409);
          }
        }

        try {
          const task = svc.create({
            projectId,
            // Narrated here rather than cast: the service is the one that
            // says "task text is required", and an empty string is how a
            // missing (or non-string) field asks it that question.
            text: typeof body?.text === "string" ? body.text : "",
            description: typeof body?.description === "string" ? body.description : null,
            priority: typeof body?.priority === "number" ? body.priority : undefined,
            assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
            // A coordinator records work; a human still decides when a card is
            // runnable. This preserves normal board lifecycle accounting.
            status: "backlog",
            idempotencyKey: typeof body?.idempotency_key === "string" ? body.idempotency_key : null,
            createdByTopicId: globalSession.topicId,
            createdSource: resolveCreatedSource(req, body as Record<string, unknown> | null) ?? "coordinator",
            originTopicId: globalSession.topicId,
            bar: typeof body?.bar === "string" ? body.bar : null,
            createdBy: "agent:coordinator",
          });
          broadcastToAll({ type: "task:created", projectId, task });
          confirmCardOrigin({ db, broadcast: broadcastToAll, recordActivity: logActivity }, {
            taskId: task.id, projectId, title: task.text, createdBy: "agent:coordinator",
            sessionKey: sk, topicId: globalSession.topicId,
          });
          titoloInSottofondo(task, projectId);
          return json(task, 201);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/orchestrator-sessions/:sessionKey/tasks/:taskId/comments
    const globalCommentsRoute = matchRoute(pathname, "/api/orchestrator-sessions/:sessionKey/tasks/:taskId/comments");
    if (globalCommentsRoute && method === "POST") {
      const sk = decodeURIComponent(globalCommentsRoute.sessionKey);
      const globalSession = provenGlobalOrchestrator(req, sk);
      if (globalSession instanceof Response) return globalSession;
      const gated = fanOutGate(globalCommentsRoute.taskId, "do NOT write in the shared thread");
      if (gated) return gated;
      const body = (await readJSON(req)) as { content?: unknown; options?: unknown } | null;
      const unexpected = rejectUnexpectedGlobalFields(body, ["content", "options"]);
      if (unexpected) return unexpected;
      if (typeof body?.content === "string" && body.content.length > AGENT_COMMENT_MAX_CHARS) {
        return json({
          error: `comment too long (${body.content.length} chars, max ${AGENT_COMMENT_MAX_CHARS}). Summarize: 1-2 short sentences, no logs or code dumps`,
          code: "comment_too_long",
        }, 400);
      }
      // Resolve the target's board at the point of mutation. No project id in
      // the payload is used or accepted by this focused surface.
      const target = resolveGlobalTask(globalCommentsRoute.taskId);
      if (!target) return json({ error: "task not found", code: "not_found" }, 404);
      try {
        const prevStage = target.got.task.stage ?? null;
        const comment = svc.addComment({
          taskId: globalCommentsRoute.taskId,
          author: globalSession.actor,
          origin: sessionActionOrigin,
          content: typeof body?.content === "string" ? body.content : "",
          projectId: target.projectId,
          questionOptions: Array.isArray(body?.options)
            ? body.options.filter((option: unknown): option is string => typeof option === "string")
            : undefined,
        });
        const task = svc.get(globalCommentsRoute.taskId, { projectId: target.projectId })?.task;
        broadcastToAll({ type: "task:updated", projectId: target.projectId, task });
        // A question on a card in AI review sends it to the person.
        emitReviewReadyEdge(broadcastToAll, target.projectId, task, "review", undefined,
          () => svc.get(globalCommentsRoute.taskId)?.comments, prevStage);
        return json(comment, 201);
      } catch (e) { return fail(e); }
    }

    // GET/PATCH /api/orchestrator-sessions/:sessionKey/tasks/:taskId
    const globalItem = matchRoute(pathname, "/api/orchestrator-sessions/:sessionKey/tasks/:taskId");
    if (globalItem) {
      const sk = decodeURIComponent(globalItem.sessionKey);
      const globalSession = provenGlobalOrchestrator(req, sk);
      if (globalSession instanceof Response) return globalSession;

      if (method === "GET") {
        const target = resolveGlobalTask(globalItem.taskId);
        if (!target) return json({ error: "task not found", code: "not_found" }, 404);
        return json(target.got);
      }
      if (method === "PATCH") {
        const gated = fanOutGate(globalItem.taskId, "do NOT change the task's status, title or assignee");
        if (gated) return gated;
        const body = (await readJSON(req)) as Record<string, unknown> | null;
        // Re-read from storage for every detailed mutation, then pass the
        // server-resolved board id into the ordinary agent lifecycle gates.
        const target = resolveGlobalTask(globalItem.taskId);
        if (!target) return json({ error: "task not found", code: "not_found" }, 404);
        return patchGlobalOrchestratorTask(
          globalItem.taskId,
          target.projectId,
          { ...globalSession, sessionKey: sk },
          body,
          pathname,
          sessionActionOrigin,
        );
      }
      return null;
    }

    // POST/GET /api/sessions/:sessionKey/tasks
    const collection = matchRoute(pathname, "/api/sessions/:sessionKey/tasks");
    if (collection) {
      const sk = decodeURIComponent(collection.sessionKey);
      const sess = provenSession(req, sk);
      if (sess instanceof Response) return sess;

      if (method === "GET") {
        const params = new URL(req.url).searchParams;
        const scope = params.get("scope") === "all" ? "all" : "project";
        const status = params.get("status") || undefined;
        try {
          // La lista di un AGENTE porta la descrizione intera: la board umana
          // ne manda solo l'anteprima perché la card la taglia comunque a due
          // righe, ma un agente legge, e 240 caratteri senza dirlo si leggono
          // come «descrizione corta» invece che come «descrizione tagliata».
          const tasks = svc.list({ scope, projectId: sess.projectId, status: asTaskStatus(status), withDescription: true });
          return json({ tasks });
        } catch (e) { return fail(e); }
      }
      if (method === "POST") {
        const body = (await readJSON(req)) as any;
        // Il cancello contro la 321esima card. In 24h gli agenti ne hanno
        // aperte 320 contro le 45 dell'umano, e il modo in cui il backlog
        // cresce non è che qualcuno chiuda male: è che nessuno CERCA prima di
        // aprire. Qui la ricerca è obbligatoria, e la risposta dice quale card
        // lo dice già, così l'agente può commentare quella invece di clonarla.
        //
        // Non è un divieto: `allow_duplicate: true` passa comunque, perché il
        // giudizio ha un falso positivo noto (vedi shared/task-similarity.ts) e
        // un cancello che non si può scavalcare diventa un cancello che si
        // aggira scrivendo il titolo storto. La differenza è che scavalcarlo
        // ora è una SCELTA scritta nella richiesta.
        //
        // Vale solo per le card di PRIMO LIVELLO, e per due motivi. Il primo è
        // di merito: i sottotask sono i passi di un lavoro, e passi identici
        // sotto padri diversi sono la norma, non un doppione ("cancelli",
        // "barra verde", "prova video" tornano a ogni tornata). Il secondo è di
        // precedenza: un `parent_task_id` di un'altra board deve rispondere 404
        // come ha sempre fatto, e un cancello che parla per primo trasformava
        // quel 404 in un 409 (preso da `tasks.test.ts`, che era verde).
        const wantsParent = typeof body?.parent_task_id === "string" && body.parent_task_id;
        if (body?.allow_duplicate !== true && !wantsParent && typeof body?.text === "string" && body.text.trim()) {
          const twins = svc
            .findDuplicates({ projectId: sess.projectId, text: body.text, limit: 3, rootsOnly: true })
            .filter((n) => n.duplicate);
          if (twins.length > 0) {
            return json(
              {
                // Gli id NON stanno in questa stringa: stanno in `duplicates[]`,
                // e il client MCP li appende al messaggio (`httpJson`). Qui si
                // dice cosa FARE, e si nomina il parametro esatto: un agente che
                // legge «rimanda con allow_duplicate» e non sa come si scrive
                // finisce per riscrivere il titolo storto finché passa.
                error: `a card already says it: "${twins[0]!.task.text}". Read that one and comment on it with add_comment; if it really is another job, recreate with allow_duplicate: true.`,
                code: "duplicate",
                duplicates: twins.map((n) => ({ id: n.task.id, text: n.task.text, score: Number(n.score.toFixed(3)) })),
              },
              409,
            );
          }
        }
        try {
          const task = svc.create({
            projectId: sess.projectId,
            // Narrated here rather than cast: the service is the one that
            // says "task text is required", and an empty string is how a
            // missing (or non-string) field asks it that question.
            text: typeof body?.text === "string" ? body.text : "",
            description: typeof body?.description === "string" ? body.description : null,
            priority: typeof body?.priority === "number" ? body.priority : undefined,
            assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
            // Agents/MCP always create into `backlog` (intake), never straight into
            // the "todo" run-queue: a task only becomes dispatch-eligible when a
            // HUMAN moves it to todo. Symmetric to the agent-cannot-mark-done gate.
            status: "backlog",
            idempotencyKey: typeof body?.idempotency_key === "string" ? body.idempotency_key : null,
            parentTaskId: typeof body?.parent_task_id === "string" ? body.parent_task_id : null,
            // PROVENIENZA (migration 093): chi sta scrivendo. Viene dal topic
            // risolto server-side dalla sessione, mai dal body — è la prova
            // durevole che uno step è della TUA checklist, e regge il requeue
            // che azzera `assigned_topic_id` mentre il turno gira.
            createdByTopicId: sess.topicId,
            createdBy: "agent:session",
            // The session is the source, resolved server-side; the chat is
            // shown on the card (display only, same id as the provenance).
            createdSource: resolveCreatedSource(req, body) ?? `session:${sk}`,
            originTopicId: sess.topicId,
            bar: typeof body?.bar === "string" ? body.bar : null,
          });
          broadcastToAll({ type: "task:created", projectId: sess.projectId, task });
          // The chat's request became a card: the chat is told, the coordinator
          // reads it in the log (`services/card-origin-notice.ts`).
          if (sess.topicId) {
            confirmCardOrigin({ db, broadcast: broadcastToAll, recordActivity: logActivity }, {
              taskId: task.id, projectId: sess.projectId, title: task.text, createdBy: "agent:session",
              sessionKey: sk, topicId: sess.topicId,
            });
          }
          // ANCHE QUI, ed e' la meta' che la prima versione aveva scordato.
          // `create_task` (MCP) e' l'altro creatore di card: lo schema chiede
          // «Task title / one-line description» e di solito viene rispettato,
          // ma sul database vivo 267 titoli creati da agenti superavano gli 80
          // caratteri. Lo stesso difetto, meno visibile.
          titoloInSottofondo(task, sess.projectId);
          return json(task, 201);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/sessions/:sessionKey/tasks/:taskId/comments
    const commentsRoute = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId/comments");
    if (commentsRoute && method === "POST") {
      const sk = decodeURIComponent(commentsRoute.sessionKey);
      const sess = provenSession(req, sk);
      if (sess instanceof Response) return sess;
      const gated = fanOutGate(commentsRoute.taskId, "do NOT write in the shared thread");
      if (gated) return gated;
      const body = (await readJSON(req)) as any;
      // Agent comments must stay SHORT and useful — the thread is a status
      // trail for the human, not a log sink. The cap only applies to the agent
      // surface (humans on /api/boards are uncapped); the error text coaches
      // the model to summarize and retry.
      if (typeof body?.content === "string" && body.content.length > AGENT_COMMENT_MAX_CHARS) {
        return json({
          error: `comment too long (${body.content.length} chars, max ${AGENT_COMMENT_MAX_CHARS}). Summarize: 1-2 short sentences, no logs or code dumps`,
          code: "comment_too_long",
        }, 400);
      }
      // Attachments outside the allowlist must FAIL LOUDLY for an agent: the
      // silent drop shipped a "PDF allegato qui" comment with no PDF and
      // nobody knew why. Coach the remedy (same pattern as comment_too_long).
      const requestedMedia = Array.isArray(body?.media) ? body.media.filter((m: unknown) => typeof m === "string").length : 0;
      const media = filterMedia(body?.media);
      if (requestedMedia > 0 && (media?.length ?? 0) < requestedMedia) {
        return json({
          error:
            "some attachments are outside the allowed dirs. Copy the file(s) into ~/.topics/media/ (or the workspace) and re-attach from there",
          code: "media_path_not_allowed",
        }, 400);
      }
      try {
        const prevStage = svc.get(commentsRoute.taskId, { projectId: sess.projectId })?.task.stage ?? null;
        const comment = svc.addComment({
          taskId: commentsRoute.taskId,
          // The same identity the status row carries. What a person reads on
          // the card is derived from it (`shared/comment-author.ts`).
          author: sess.actor,
          origin: sessionActionOrigin,
          content: body?.content,
          mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
          // The agent can attach files too (screenshots/artifacts it produced).
          media,
          projectId: sess.projectId,
          // Structured human-decision request: the service composes the
          // canonical ```question``` block from these (KANBAN-07 quick-reply).
          questionOptions: Array.isArray(body?.options)
            ? body.options.filter((o: unknown) => typeof o === "string")
            : undefined,
          // WHERE THE AGENT WAS WHEN IT SAID THIS: the assistant row being
          // streamed right now, the same reading the chat route makes for its
          // `stream_in_flight` 409. Absent outside a turn, which is honest.
          messageId: ctx.isStreaming?.(sk)?.messageId ?? null,
        });
        const task = svc.get(commentsRoute.taskId, { projectId: sess.projectId })?.task;
        broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
        // A question on a card in AI review sends it to the person.
        emitReviewReadyEdge(broadcastToAll, sess.projectId, task, "review", undefined,
          () => svc.get(commentsRoute.taskId)?.comments, prevStage);
        return json(comment, 201);
      } catch (e) { return fail(e); }
    }

    // PUT /api/sessions/:sessionKey/tasks/:taskId/labels — la porta dell'AGENTE.
    //
    // Esiste per UNA cosa: alzare la mano. Un agente che ha toccato solo il
    // server ma sa che il suo lavoro cambia qualcosa che si vede può chiedere
    // `visibile`, e `decisione` se quello che ha prodotto è un giudizio da far
    // dare a una persona — e le etichette di genere (`bugfix`…) le mette come
    // gli pare, perché non decidono niente. `invisibile` no, mai: il servizio risponde
    // `label_forbidden` → 403. Se un agente potesse marcare invisibile il
    // proprio lavoro, l'etichetta non sarebbe una misura di ciò che si vede:
    // sarebbe il modulo con cui si autorizza a chiudersi le card da solo.
    const sLabels = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId/labels");
    if (sLabels && (method === "PUT" || method === "POST")) {
      const sess = provenSession(req, decodeURIComponent(sLabels.sessionKey));
      if (sess instanceof Response) return sess;
      const body = (await readJSON(req)) as any;
      const raw = Array.isArray(body?.labels) ? body.labels : [];
      const unknown = raw.filter((l: unknown) => typeof l === "string" && !isTaskLabel(l));
      if (unknown.length) {
        return json({
          error: `unknown labels: ${unknown.join(", ")}. The labels an agent may write are visibile, decisione, bugfix, feature, chore, misura`, // allow-italian: the label vocabulary IS the data, compared by value
          code: "invalid_input",
        }, 400);
      }
      try {
        const task = svc.setLabels({
          taskId: sLabels.taskId,
          projectId: sess.projectId,
          labels: normalizeLabels(raw),
          actor: "agent",
          source: "agent",
        });
        broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
        return json(task);
      } catch (e) { return fail(e); }
    }

    // POST /api/sessions/:sessionKey/tasks/:taskId/defer
    // The dispatched agent DECLARES an external-condition wait: release the slot,
    // park the task back in todo with a note + `waiting` chip + retry window. The
    // dispatcher owns the state mutation (and clears any pending grace timer);
    // when it's absent (degraded host) the service still parks the task directly.
    const deferRoute = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId/defer");
    if (deferRoute && method === "POST") {
      const sk = decodeURIComponent(deferRoute.sessionKey);
      const sess = provenSession(req, sk);
      if (sess instanceof Response) return sess;
      const gatedDefer = fanOutGate(deferRoute.taskId, "do NOT park the shared task");
      if (gatedDefer) return gatedDefer;
      const body = (await readJSON(req)) as any;
      if (typeof body?.reason !== "string" || !body.reason.trim()) {
        return json({ error: "'reason' (string) is required", code: "invalid_input" }, 400);
      }
      // Same project guard as every other agent write: only defer a task on this
      // session's board.
      const owned = svc.get(deferRoute.taskId, { projectId: sess.projectId })?.task;
      if (!owned) return json({ error: "task not found", code: "not_found" }, 404);
      const minutes = typeof body?.minutes === "number" && Number.isFinite(body.minutes) ? body.minutes : undefined;
      try {
        const task = dispatcher
          ? dispatcher.deferWait(deferRoute.taskId, body.reason, minutes)
          : svc.deferForWait({ taskId: deferRoute.taskId, reason: body.reason, minutes, by: "agent" });
        if (!dispatcher) {
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          // Anche l'host degradato annuncia il park: qui la board è l'unico
          // posto dove il task si ferma, quindi restare muti sarebbe peggio che
          // altrove. Stessa funzione del dispatcher, così la decisione su
          // «cosa è un fronte terminale» resta in un punto solo.
          const parked = task.dispatchState === PARKED_WAITED_OUT
            ? parkedEdgeEvent(task, { requeue: false, parkState: PARKED_WAITED_OUT })
            : null;
          if (parked) broadcastToAll(parked);
        }
        return json(task);
      } catch (e) { return fail(e); }
    }

    // GET/PATCH /api/sessions/:sessionKey/tasks/:taskId
    const item = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId");
    if (item) {
      const sk = decodeURIComponent(item.sessionKey);
      const sess = provenSession(req, sk);
      if (sess instanceof Response) return sess;

      if (method === "GET") {
        const got = svc.get(item.taskId, { projectId: sess.projectId });
        if (!got) return json({ error: "task not found", code: "not_found" }, 404);
        return json(got);
      }
      if (method === "PATCH") {
        const gatedPatch = fanOutGate(item.taskId, "do NOT change the task's status, title or assignee");
        if (gatedPatch) return gatedPatch;
        const body = (await readJSON(req)) as any;
        const noDelivery = rejectDeliveryPatch(body);
        if (noDelivery) return noDelivery;
        // `legMs` è trasporto, non un campo del task: dice quanto questa gamba è
        // disposta ad aspettare i check. Si toglie dal corpo PRIMA di
        // `parseTaskPatch`, che risponde 400 a ogni campo che non conosce.
        const legMs = clampLegMs(body?.legMs);
        if (body && typeof body === "object") delete body.legMs;
        // Structural review gate: a DELIVERY with work still uncommitted in the
        // task's worktree is not reviewable — approve would find nothing to
        // merge and the work would strand ("implementato, NON committato").
        // Questions are exempt: an agent asking mid-work legitimately has a
        // dirty worktree. Prompt instructions alone never fixed this; the 409
        // coaches the retry like review_needs_summary does.
        //
        // "Is it a question" is `commentAsksHuman`, NOT the presence of the
        // ```question fence: the kickoff envelope orders a landable delivery to
        // attach `options=["Landa su main"]`, and the server wraps options in
        // that fence, so the exemption swallowed the deliveries it exists to
        // check. Measured on 13/08 against the live board db: of the 437 agent
        // comments carrying that fence, 331 are deliveries, not questions —
        // three exemptions out of four went to the very shape being gated.
        const gatedDelivery = await reviewDeliveryGate(item.taskId, sess.projectId, body, legMs, pathname, {
          sessionKey: sk,
          topicId: sess.topicId,
        });
        if (gatedDelivery) return gatedDelivery;
        // La superficie AGENTE ha meno campi di quella umana (ordine in colonna,
        // modello, dipendenze e annidamento sono leve dell'umano): finivano
        // scartati in silenzio, il che li faceva sembrare disponibili. Ora sono
        // un 400 che li nomina, come `archived` sulla rotta della board.
        // L'ANTEPRIMA passa dallo stesso fence della rotta umana
        // (`acceptPreview`: allowlist dei path E tipo mostrabile, stringa vuota
        // = azzera) e i due nomi che circolano nei prompt, `previewImage` e
        // `preview_image`, valgono entrambi: era già sparita una volta perché
        // la rotta leggeva solo l'altro.
        const parsed = parseTaskPatch(body, "agent", acceptPreview);
        if (!parsed.ok) return json(unapplicableFieldsBody(parsed.errors), 400);
        try {
          const prev = svc.get(item.taskId, { projectId: sess.projectId })?.task;
          const prevStatus = prev?.status;
          let task = svc.update({
            taskId: item.taskId,
            actor: "agent",
            // L'ATTORE, non il nome da mostrare: questo finisce nello storico
            // di stato, dove serve sapere CHI ha mosso il task.
            by: sess.actor,
            origin: sessionActionOrigin,
            projectId: sess.projectId,
            agentTopicId: sess.topicId,
            patch: parsed.patch,
            // The delivery line is said DURING a turn, and this is the row it
            // was said in: same anchor as `comment_task`, so the reviewer's
            // thread can put the summary under the step that produced it.
            messageId: ctx.isStreaming?.(decodeURIComponent(item.sessionKey))?.messageId ?? null,
          });
          if (prevStatus !== "done" && task.status === "done") requestCardProcessStop(opts, item.taskId);
          task = await captureDelivery(task, prevStatus);
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          if (task.status === "review" && prevStatus !== "review") void autoLander.tryLand(sess.projectId, item.taskId);
          // È QUESTA la porta che conta per i tasti del banner: l'agente commenta
          // la domanda con `options` e poi si sposta in review da qui (MCP
          // update_task). Al momento del fronte la domanda è l'ultima riga del
          // thread — esattamente ciò che la card mostra come quick-reply.
          emitReviewReadyEdge(broadcastToAll, sess.projectId, task, prevStatus, undefined,
            () => svc.get(task.id)?.comments, prev?.stage ?? null);
          triggerUrlProbe(item.taskId, task.outputUrl ?? null, sess.projectId);
          // AN AI REVIEW CLOSED BY WHOEVER OPENED THE CARD is the same «done»
          // a person's approval is: what was waiting on it starts, and the
          // delivery lands if the board lands on done.
          if (prevStatus === "review" && prev?.stage === STAGE_AI_REVIEW && task.status === "done") {
            dispatcher?.onBlockerDone(item.taskId);
            if (task.deliveryBranch) enqueueLandOnDone(sess.projectId, item.taskId, task.deliveryBranch);
          }
          return json(task);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    return null;
  };
  // HERE, and not a line earlier: the re-issue goes back in through
  // `tasksRouter`, which only exists from the statement above. Same instant as
  // `clearStaleChecksRuns` in spirit - this is the one moment when every
  // in-flight round of this process is, by construction, of a DEAD process.
  // The re-issue of a delivery enters through the router just built.
  late.tasksRouter = tasksRouter;
  resumePendingDeliveries();
  return tasksRouter;
}
