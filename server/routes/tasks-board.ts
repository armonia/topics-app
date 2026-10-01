/**
 * The human board API: `/api/boards/:projectId/...`, project-scoped, actor
 * "user". Moved out of `createTasksRouter` (server/routes/tasks.ts) as one
 * block, unchanged: the router still decides `isBoard` and hands the request
 * here, and every closure value the block used arrives through
 * `BoardRouteDeps` under the same name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { titoloMigliore } from "../services/task-title";
import { isLandedWork, NOTE_ARCHIVED_BY_HUMAN, NOTE_STOPPED_BY_HUMAN, NOTE_UNQUEUED_BY_HUMAN, PARKED_STOPPED, pressedADeadQuickReply, type TaskStatus } from "../../shared/board";
import { findDuplicateGroups } from "../../shared/task-similarity";
import { parseTaskPatch, unapplicableFieldsBody, type FieldRead } from "./task-patch";
import { answerRoutedAsk, pendingRoutedAsk, DEAD_QUESTION_LINE, type AskRoutingDeps } from "../services/board-ask-routing";
import { isPublishActionLabel, projectIdForPath, UNASSIGNED_PROJECT_ID, type Task, type TaskService } from "../services/tasks";
import { interceptBoardAction } from "../services/board-actions";
import { FRESH_SESSION_NOTE } from "../../shared/task-comment-service";
import type { TaskDispatcher } from "../services/task-dispatcher";
import type { LandingQueue, LandingTicket } from "../services/landing-queue";
import { MAX_CHECKS, STATIC_RAILS_CHECK, parseReviewChecks } from "../services/review-checks";
import { linkNotes, proposeLink, type LinkKind } from "../services/task-intake";
import { isTaskLabel } from "../../shared/task-labels";
import { stopCauseOf, STOP_CAUSE_HEADER, type StopCause } from "../lib/abort-cause";
import { invalidateProbeCache } from "../services/url-probe-cache";
import type { TasksRouterOpts, emitReviewReadyEdge } from "./tasks";

/**
 * The board's `deployCommand` setting is empty, but the project ALREADY HAS a
 * `deploy` script in its `package.json` — the same shape as `dispatchAutoMerge`
 * suggesting nothing, except here there is something concrete to point at.
 * Returns the command to SUGGEST (never writes it), or `null` when there is no
 * `package.json`, it has no `scripts.deploy`, or it fails to parse.
 *
 * The runner prefix follows `packageManager` (Corepack's field) when present —
 * a `yarn@`/`pnpm@` project suggesting a `npm run` command that happens to work
 * by luck is worse than no suggestion, because it looks authoritative.
 */
function deploySuggestionFromPackageJson(projectPath: string): string | null {
  try {
    const raw = readFileSync(join(projectPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown>; packageManager?: string };
    if (typeof pkg?.scripts?.deploy !== "string") return null;
    const pm = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
    const runner = pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm run" : pm === "bun" ? "bun run" : "npm run";
    return `${runner} deploy`;
  } catch { return null; }
}

/**
 * `?labels=visibile,bugfix` → la lista, filtrata dal vocabolario chiuso. Ciò che
 * non è un'etichetta nota si scarta in silenzio: un filtro sconosciuto deve
 * restituire "tutto", non un 400 che rompe una board aperta da una versione
 * precedente. Il servizio lo rifiltra comunque (una porta sola non basta se
 * l'altra la si può aprire da fuori).
 */
function parseLabelsParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(",").map((s) => s.trim()).filter(isTaskLabel);
  return wanted.length ? wanted : undefined;
}

/**
 * Everything the board routes read from `createTasksRouter`'s closure, passed
 * explicitly. Same objects, same functions: the router builds this once.
 */
export interface BoardRouteDeps {
  ctx: AppContext;
  dispatcher: TaskDispatcher | undefined;
  opts: TasksRouterOpts | undefined;
  matchRoute: AppContext["matchRoute"];
  json: AppContext["json"];
  readJSON: AppContext["readJSON"];
  broadcastToAll: AppContext["broadcastToAll"];
  svc: TaskService;
  askRouting: AskRoutingDeps;
  landings: LandingQueue;
  emitReviewReadyEdge: typeof emitReviewReadyEdge;
  titoloInSottofondo: (task: { id: string; text: string; description: string | null }, projectId: string) => void;
  resolveBoardId: (projectId: string, text: unknown, description: unknown) => string;
  sweepRemoteDelivery: (
    projectId: string, taskId: string, reason: string,
    over?: { cwd?: string | null; landed?: string | null; extra?: Array<string | null | undefined> },
  ) => Promise<void>;
  captureDelivery: <T extends { id: string; status: string }>(task: T, prevStatus?: string) => Promise<T>;
  triggerUrlProbe: (taskId: string, outputUrl: string | null, projectId?: string) => void;
  cutLiveTurn: (t: { id: string; assignedTopicId: string | null; dispatchState: string | null }, reason: string, cause: StopCause) => boolean;
  enqueueLand: (projectId: string, taskId: string) => LandingTicket;
  enqueueLandOnDone: (projectId: string, taskId: string, branch: string) => LandingTicket | null;
  proposeDeployIfConfigured: (projectId: string, taskId: string) => void;
  runDeploy: (projectId: string, taskId: string, command: string) => Promise<void>;
  publishProject: (projectId: string) => Promise<{ ok: boolean; branch?: string; output?: string; error?: string; code?: string }>;
  filterMedia: (raw: unknown) => string[] | undefined;
  acceptPreview: (raw: unknown) => FieldRead;
  rejectDeliveryPatch: (body: unknown) => Response | null;
  asTaskStatus: (raw: string | null | undefined) => TaskStatus | undefined;
  fail: (e: unknown) => Response;
  checksRedGate: (projectId: string, taskId: string, force: unknown) => Response | null;
}

export function createBoardRoutes(deps: BoardRouteDeps) {
  const {
    ctx,
    dispatcher,
    opts,
    matchRoute,
    json,
    readJSON,
    broadcastToAll,
    svc,
    askRouting,
    landings,
    emitReviewReadyEdge,
    titoloInSottofondo,
    resolveBoardId,
    sweepRemoteDelivery,
    captureDelivery,
    triggerUrlProbe,
    cutLiveTurn,
    enqueueLand,
    enqueueLandOnDone,
    proposeDeployIfConfigured,
    runDeploy,
    publishProject,
    filterMedia,
    acceptPreview,
    rejectDeliveryPatch,
    asTaskStatus,
    fail,
    checksRedGate,
  } = deps;

  return async function boardRoutes(req: Request, pathname: string, method: string): Promise<Response | null> {
    const HUMAN = "user";
    // Presentation metadata only. A caller cannot claim MCP/system through
    // this header, and it never participates in the human permission gates.
    const actionOrigin = req.headers.get("X-Topics-Action-Origin") === "interface" ? "interface" : "api";

    /**
     * Stacca l'agente vivo da un task e taglia il suo turno.
     *
     * L'ordine conta, ed è quello dello "stop" umano: si PARCHEGGIA prima
     * (release, che azzera il legame col topic) e si taglia dopo — così
     * quando l'`onTurnEnd` del turno abortito arriva trova il task già
     * spostato e lascia cadere la chip, invece di rimetterlo in coda per un
     * tentativo nuovo.
     *
     * Vive qui, in una funzione sola, perché ha DUE chiamanti che devono
     * comportarsi identici: il bottone "Ferma" e l'archiviazione. Prima
     * l'archiviazione non lo faceva affatto — la riga spariva dalla board e
     * l'agente continuava a girare fino al timeout, invisibile: `list()`
     * filtra `archived = 0`, quindi né `reconcile` lo spazzava né il
     * contatore del tetto di concorrenza lo contava (`claim` conta anche lui
     * solo le righe non archiviate). Risultato: token bruciati su un task che
     * non esiste più, e una macchina che crede di avere uno slot libero in
     * più di quanti ne ha davvero.
     *
     * Un FAN-OUT ha N agenti, non uno: `assigned_topic_id` ne punta uno solo
     * (il tentativo 1), quindi tagliare quello lasciava gli altri N-1 a
     * girare, ciascuno nel suo worktree, dopo che l'umano aveva già detto
     * «basta». Si abortiscono tutte le sessioni dei tentativi ancora
     * `running`, e le loro righe si chiudono a `failed`: un tentativo che
     * resta `running` per sempre tiene il task dentro il gate del fan-out
     * (`fanOutGuard`) e fa credere a `reconcile` che ci sia un giro da
     * recuperare.
     *
     * Ritorna il task parcheggiato, o null se non c'era nessun agente da
     * fermare (nel qual caso il chiamante non deve toccare niente).
     */
    const detachLiveAgent = (
      t: { id: string; assignedTopicId: string | null; dispatchState: string | null },
      reason: string,
      cause: StopCause,
    ): Task | null => {
      if (!cutLiveTurn(t, reason, cause)) return null;
      // `stopped` e non NULL: un park senza stato è indistinguibile da un task
      // mai dispacciato, e la card tornava in Backlog senza dire perché.
      return svc.release({ taskId: t.id, requeue: false, by: HUMAN, reason, parkState: PARKED_STOPPED });
    };

    // GET/PATCH /api/boards/:projectId/settings — per-board dispatch config
    // (concurrency cap, effort, worktree, timeout). `autoDispatch` in the
    // patch routes to the GLOBAL switch (see /api/all-boards/settings).
    // Lo STATO della modalità notturna: accesa sì, ma sta dispacciando o
    // aspettando, e per quale motivo. È la differenza fra un interruttore e un
    // pannello di gestione — senza, l'unico modo di sapere perché non parte
    // niente è leggere i log del server. Passa dallo stesso calcolo del gate
    // del dispatcher, così le due cose non possono divergere.
    const bNight = matchRoute(pathname, "/api/boards/:projectId/night-status");
    if (bNight && method === "GET") {
      if (!dispatcher?.nightStatus) return json({ enabled: false, action: "off" });
      try { return json(dispatcher.nightStatus(bNight.projectId)); }
      catch (e) { return fail(e); }
    }

    const bSettings = matchRoute(pathname, "/api/boards/:projectId/settings");
    if (bSettings) {
      const projectId = bSettings.projectId;
      if (method === "GET") {
        try {
          const settings = svc.getBoardSettings(projectId);
          // `worktreeReady` NON è un'impostazione: è un fatto sul progetto,
          // che il pannello mostra accanto all'interruttore che ne dipende.
          // `deployCommandSuggestion`: same idea — only when the command is
          // missing AND the project's `package.json` already has a `deploy` script.
          let deployCommandSuggestion: string | null = null;
          if (!settings.deployCommand) {
            let dirs: string[] = [];
            try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
            const path = dirs.find((d) => projectIdForPath(d) === projectId);
            if (path) deployCommandSuggestion = deploySuggestionFromPackageJson(path);
          }
          // `admissionHolds`: same nature as the two above - a fact, not a
          // setting. It says how many times the resource floor held the queue
          // and for how long, so "the board is slow" can be told apart from
          // "the board is stopped" without reading the log by hand. `null`
          // when there is no dispatcher: absent is not zero.
          let admissionHolds: ReturnType<NonNullable<typeof dispatcher>["admissionHolds"]> | null = null;
          try { admissionHolds = dispatcher?.admissionHolds?.() ?? null; } catch { /* best-effort: una misura non blocca le impostazioni */ }
          return json({ ...settings, worktreeReady: opts?.worktreeReady?.(projectId) ?? true, deployCommandSuggestion, admissionHolds });
        } catch (e) { return fail(e); }
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        // Più check del tetto: si dice, non si tronca. Il 12/08 una board ha
        // dichiarato i suoi sei gate, ne sono stati salvati cinque, e il
        // troncato era `test:unit` — l'unico che quella notte trovava i rossi.
        // La board ha continuato a mostrare "verde" su consegne rotte.
        if (Array.isArray(body?.reviewChecks) && body.reviewChecks.length > MAX_CHECKS) {
          return json(
            {
              error:
                `too many checks: you sent ${body.reviewChecks.length}, the maximum is ${MAX_CHECKS}. ` +
                "I do not save a subset of them: you would have a gate you believe you have and do not. " +
                "Drop a few, or join two commands into one with `&&`: the first red stops the chain " +
                "and its exit code arrives whole, the way `" + STATIC_RAILS_CHECK.name + "` does: `" + STATIC_RAILS_CHECK.cmd + "`.",
              code: "review_checks_too_many",
            },
            400,
          );
        }
        try {
          const settings = svc.updateBoardSettings(projectId, {
            autoDispatch: typeof body?.autoDispatch === "boolean" ? body.autoDispatch : undefined,
            // NIENTE `maxAgents` per board: il tetto è uno solo e si scrive su
            // PATCH /api/all-boards/settings (riga '*'). Qui era accettato,
            // salvato, rimostrato — e non limitava niente.
            dispatchEffort: typeof body?.dispatchEffort === "string" ? body.dispatchEffort : undefined,
            dispatchUseWorktree: typeof body?.dispatchUseWorktree === "boolean" ? body.dispatchUseWorktree : undefined,
            dispatchAutoMerge: typeof body?.dispatchAutoMerge === "boolean" ? body.dispatchAutoMerge : undefined,
            // Empty = off, same reading as `dispatchMcp`/`dispatchModel`: an
            // empty string is an EXPLICIT value ("no command"), not "leave
            // alone" — that one is `undefined`.
            deployCommand: typeof body?.deployCommand === "string" ? body.deployCommand : undefined,
            dispatchTimeoutMin: typeof body?.dispatchTimeoutMin === "number" ? body.dispatchTimeoutMin : undefined,
            dispatchIdleMin: typeof body?.dispatchIdleMin === "number" ? body.dispatchIdleMin : undefined,
            dispatchMcp: typeof body?.dispatchMcp === "string" ? body.dispatchMcp : undefined,
            dispatchModel: typeof body?.dispatchModel === "string" ? body.dispatchModel : undefined,
            // AICTRL-05: nullable, non "auto"-a-stringa come dispatchModel —
            // la chiave assente lascia il valore stare (undefined), la
            // chiave presente ma non booleana torna al default "nessuna
            // scelta" (null), mai a "leave alone".
            dispatchTopicsRouting: body?.dispatchTopicsRouting === undefined
              ? undefined
              : (typeof body.dispatchTopicsRouting === "boolean" ? body.dispatchTopicsRouting : null),
            dispatchFanOut: typeof body?.dispatchFanOut === "number" ? body.dispatchFanOut : undefined,
            // I QUATTRO CHE LA ROTTA NON INOLTRAVA. Esistono nel servizio, nella
            // tabella e nel tipo, e due di loro li LEGGE il dispatcher a ogni
            // giro — ma qui non passavano, quindi restavano al default per
            // sempre e il PATCH rispondeva 200 con il valore vecchio.
            //
            // `dispatchPaused` ha un interruttore VERO nel pannello
            // (`BoardSettingsPanel.tsx:84-85`, `patch({ dispatchPaused })`):
            // era un interruttore morto, che e' peggio di un interruttore
            // assente perche' promette. Misurato il 18/08: PATCH
            // `{"dispatchPaused":true}` -> risposta 200 con `false`.
            // `dispatchRetryCap` decide quanti turni ha un agente prima che il
            // sistema gli tolga la card: bloccato a 2 e non alzabile da nessuna
            // porta.
            dispatchPaused: typeof body?.dispatchPaused === "boolean" ? body.dispatchPaused : undefined,
            dispatchRetryCap: typeof body?.dispatchRetryCap === "number" ? body.dispatchRetryCap : undefined,
            dispatchRetryBackoffS: typeof body?.dispatchRetryBackoffS === "number" ? body.dispatchRetryBackoffS : undefined,
            language: typeof body?.language === "string" ? body.language : undefined,
            nightMode: typeof body?.nightMode === "boolean" ? body.nightMode : undefined,
            nightModeUntil: typeof body?.nightModeUntil === "string" ? body.nightModeUntil : undefined,
            // Passa dal parser tollerante: il pannello manda una lista di
            // stringhe (una riga = un comando), la board può averne una lunga
            // salvata a mano. Una sola forma canonica esce da qui.
            //
            // Il TRONCAMENTO oltre `MAX_CHECKS` resta giusto in LETTURA (una
            // config vecchia non deve rompere la board) ed è rifiutato in
            // SCRITTURA appena sopra: chi ne manda sette e ne vede salvati
            // cinque crede di avere un cancello che non ha.
            reviewChecks: body?.reviewChecks !== undefined
              ? parseReviewChecks(JSON.stringify(body.reviewChecks))
              : undefined,
          });
          broadcastToAll({ type: "board:settings", projectId, settings });
          // autoDispatch is global — every board header (not just this
          // project's) must flip its pill.
          if (typeof body?.autoDispatch === "boolean") {
            broadcastToAll({ type: "board:dispatch", autoDispatch: settings.autoDispatch });
          }
          return json(settings);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/boards/:projectId/intake/suggest — "dove va questo testo?".
    // Sola LETTURA: guarda la board e restituisce al massimo UNA proposta di
    // collegamento (o niente, che è la risposta giusta quasi sempre). Non
    // tocca un solo task: l'attribuzione la decide l'umano nel composer e
    // viaggia dentro la create. Sta fuori dal prefisso `/tasks` di proposito,
    // così non compete mai con `/tasks/:taskId`.
    const bIntake = matchRoute(pathname, "/api/boards/:projectId/intake/suggest");
    if (bIntake && method === "POST") {
      const body = (await readJSON(req)) as any;
      try {
        const text = typeof body?.text === "string" ? body.text : "";
        const description = typeof body?.description === "string" ? body.description : null;
        if (!text.trim()) return json({ proposal: null });
        const boardId = resolveBoardId(bIntake.projectId, text, description);
        if (boardId === UNASSIGNED_PROJECT_ID) return json({ proposal: null });
        // rootsOnly: un sottotask è la checklist di qualcun altro, non una
        // destinazione — appenderci sotto un feedback lo seppellirebbe.
        // `withDescription`: qui il testo intero è il DATO su cui si decide
        // (proposeLink confronta le descrizioni), non qualcosa da disegnare.
        const candidates = svc.list({ scope: "project", projectId: boardId, rootsOnly: true, withDescription: true });
        const proposal = proposeLink({
          text,
          description,
          candidates: candidates.map((t) => ({
            id: t.id, text: t.text, description: t.description, status: t.status, updatedAt: t.updatedAt,
          })),
          excludeTaskId: typeof body?.excludeTaskId === "string" ? body.excludeTaskId : null,
        });
        return json({ proposal, projectId: boardId });
      } catch (e) { return fail(e); }
    }

    const bCol = matchRoute(pathname, "/api/boards/:projectId/tasks");
    if (bCol) {
      const projectId = bCol.projectId;
      if (method === "GET") {
        const params = new URL(req.url).searchParams;
        const status = params.get("status") || undefined;
        // `?archived=1` = l'archivio di questa board, e SOLO quello: la lista
        // di default resta i vivi. Stessa lettura dei progetti — un filtro,
        // non una colonna in più.
        const archived = params.get("archived") === "1" || params.get("archived") === "true";
        // Root tasks only: a step never renders as its own card (drawer tree).
        // PIÙ gli step orfani: un padre chiuso non ha più una checklist, e
        // quello che ci era rimasto dentro non lo dispaccia nessuno e non lo
        // apre più nessuno. Tenerlo fuori dalla colonna non lo rimanda, lo
        // perde — è la metà opposta dello stesso difetto.
        try {
          return json({
            tasks: svc.list({
              scope: "project", projectId, status: asTaskStatus(status), rootsOnly: true,
              includeOrphanSubtasks: true,
              labels: parseLabelsParam(params.get("labels")),
              archived,
            }),
          });
        }
        catch (e) { return fail(e); }
      }
      if (method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const effectiveProjectId = resolveBoardId(projectId, body?.text, body?.description);
          const task = svc.create({
            projectId: effectiveProjectId,
            text: body?.text,
            description: body?.description ?? null,
            priority: typeof body?.priority === "number" ? body.priority : undefined,
            assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
            status: typeof body?.status === "string" ? body.status : undefined,
            parentTaskId: typeof body?.parentTaskId === "string" ? body.parentTaskId : null,
            planFirst: body?.planFirst === true,
            model: typeof body?.model === "string" ? body.model : null,
            topicsRouting: typeof body?.topicsRouting === "boolean" ? body.topicsRouting : null,
            blockedByTaskId: typeof body?.blockedByTaskId === "string" ? body.blockedByTaskId : null,
            reuseBlockerContext: body?.reuseBlockerContext === true,
          });
          // THE BIRTH ATTACHMENTS, BEFORE THE DISPATCH.
          //
          // The board composer now takes images and files (paste, drop,
          // paperclip): they arrive inside the create and not through a
          // separate POST /comments, for one reason only. The dispatch fires
          // a few lines below, so a comment sent after the response would
          // race the kickoff and the agent would read the card without the
          // screenshot the task exists for. Written here, the files are on
          // the card before anybody picks it up.
          const bornMedia = filterMedia(body?.media) ?? [];
          if (bornMedia.length) {
            try {
              svc.addComment({
                taskId: task.id, author: HUMAN, content: "Allegati al task.",
                media: bornMedia, projectId: effectiveProjectId, origin: actionOrigin,
              });
            } catch (err) { console.warn(`[Tasks] birth attachments failed for ${task.id}:`, err); }
          }
          broadcastToAll({ type: "task:created", projectId: effectiveProjectId, task });
          // Il titolo leggibile: vedi `titoloInSottofondo`. Vale per
          // ENTRAMBI i creatori — questa rotta e quella di `create_task`.
          titoloInSottofondo(task, effectiveProjectId);
          // Intake: il collegamento accettato si SCRIVE, nei due thread. Un
          // link muto è il modo in cui un feedback si perde — chi apre la card
          // bloccata deve leggere perché è ferma, e chi apre il bloccante deve
          // sapere che qualcuno lo aspetta. Best-effort: la nota non può far
          // fallire una create già andata a buon fine.
          try {
            const kind: LinkKind | null = task.parentTaskId ? "subtask" : task.blockedByTaskId ? "chain" : null;
            const targetId = task.parentTaskId ?? task.blockedByTaskId;
            if (kind && targetId && body?.intakeLink === true) {
              const target = svc.get(targetId, { projectId: effectiveProjectId });
              if (target) {
                const notes = linkNotes({
                  kind,
                  newTaskText: task.text,
                  targetText: target.task.text,
                  reason: typeof body?.intakeReason === "string" && body.intakeReason.trim()
                    ? body.intakeReason.trim()
                    : "Collegamento scelto dall'intake al momento della creazione.",
                });
                svc.addComment({ taskId: task.id, author: "system", content: notes.onNewTask, projectId: effectiveProjectId });
                svc.addComment({ taskId: targetId, author: "system", content: notes.onTargetTask, projectId: effectiveProjectId });
                const updatedTarget = svc.get(targetId, { projectId: effectiveProjectId });
                if (updatedTarget) broadcastToAll({ type: "task:updated", projectId: effectiveProjectId, task: updatedTarget.task });
              }
            }
          } catch (err) { console.warn(`[Tasks] intake link note failed for ${task.id}:`, err); }
          // A task born directly in Todo is the same "vai" signal as a drag
          // into Todo: same chip, same grace window — not a silent 10s wait
          // for the reconcile poll. No-op when auto-dispatch is off.
          if (dispatcher && task.status === "todo") dispatcher.onEnterTodo(effectiveProjectId, task.id);
          // Adding a STEP under an agent-bound root in review IS the
          // assignment — no "please also do X" comment ceremony: re-kick the
          // same agent with the new step. (Root mid-turn: the step just lands
          // in the tree; the open_subtasks gate keeps approve honest and the
          // resume prompt tells the agent to re-read its task.)
          try {
            if (dispatcher && task.parentTaskId) {
              const root = svc.boundRootOf(task.id);
              if (root && root.status === "review" && root.assignedTopicId) {
                const rejected = svc.reviewDecision({ taskId: root.id, by: "user", decision: "reject", projectId, origin: actionOrigin });
                broadcastToAll({ type: "task:updated", projectId, task: rejected });
                dispatcher.resume(root.id, `L'umano ha aggiunto un nuovo step al tuo task: "${task.text.slice(0, 80)}" (id=${task.id}). Lavoralo e marcalo done prima della consegna.`)
                  .catch((err) => console.warn(`[Tasks] resume after add-step failed for ${root.id}:`, err));
              }
            }
          } catch { /* best-effort — the step itself is already created */ }
          return json(task, 201);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/boards/:projectId/tasks/:taskId/restore — il ritorno dalla
    // DELETE, che qui archivia. Stessa forma di `POST /api/projects/:id/restore`:
    // una rotta dedicata, non un campo della PATCH. Il broadcast è
    // `task:created` perché per chi guarda la board quella card NON c'era:
    // un `task:updated` su un id sconosciuto non fa comparire niente.
    const bRestore = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/restore");
    if (bRestore && method === "POST") {
      try {
        const task = svc.restore({ taskId: bRestore.taskId, projectId: bRestore.projectId });
        if (!task) return json({ error: "task not found", code: "not_found" }, 404);
        broadcastToAll({ type: "task:created", projectId: bRestore.projectId, task });
        return json(task);
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/stop — the human pulls the
    // plug on a running dispatch ("ho sbagliato qualcosa"). Order matters:
    // park FIRST (backlog + reason), THEN cut the turn — so when the aborted
    // turn's onTurnEnd fires it finds the task already moved and just drops
    // the chip instead of auto-requeueing a fresh attempt.
    const bStop = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/stop");
    if (bStop && method === "POST") {
      try {
        const got = svc.get(bStop.taskId, { projectId: bStop.projectId });
        if (!got) return json({ error: "task not found", code: "not_found" }, 404);
        // «Ferma» copre due fatti diversi: tagliare un turno che gira, e
        // togliere dalla coda una card che non e' mai partita. La riga nel
        // thread lo dice, perche' e' l'unica traccia che resta a chi torna a
        // guardare la card domani.
        const parked = detachLiveAgent(
          got.task,
          got.task.dispatchState === "queued" ? NOTE_UNQUEUED_BY_HUMAN : NOTE_STOPPED_BY_HUMAN,
          "user",
        );
        if (!parked) return json({ error: "no active agent on this task", code: "invalid_transition" }, 409);
        broadcastToAll({ type: "task:updated", projectId: bStop.projectId, task: parked });
        return json(parked);
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/move — send the task (and its
    // subtree) to another board. Both boards get a broadcast so the source
    // drops the card and the target picks it up live.
    const bMove = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/move");
    if (bMove && method === "POST") {
      const body = (await readJSON(req)) as any;
      try {
        const task = svc.moveToProject({
          taskId: bMove.taskId,
          projectId: bMove.projectId,
          toProjectId: typeof body?.toProjectId === "string" ? body.toProjectId : "",
        });
        broadcastToAll({ type: "task:updated", projectId: bMove.projectId, task });
        if (task.projectId !== bMove.projectId) {
          broadcastToAll({ type: "task:updated", projectId: task.projectId, task });
          // A project-less (or re-homed) task sitting in todo becomes
          // dispatchable the moment it lands on a real board — same "vai"
          // signal as a drag into todo. No-op for the unassigned sentinel.
          if (dispatcher && task.status === "todo") dispatcher.onEnterTodo(task.projectId, task.id);
        }
        return json(task);
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/merge — fonde questa card
    // dentro `intoTaskId`. La card fusa esce dalla board (archiviata), quindi
    // il client la toglie sull'evento e ridisegna la superstite col thread
    // cresciuto.
    const bMerge = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/merge");
    if (bMerge && method === "POST") {
      const body = (await readJSON(req)) as any;
      const into = typeof body?.intoTaskId === "string" ? body.intoTaskId : "";
      if (!into) return json({ error: "intoTaskId is required", code: "invalid_input" }, 400);
      try {
        const esito = svc.merge({
          taskId: bMerge.taskId,
          intoTaskId: into,
          projectId: bMerge.projectId,
          by: HUMAN,
        });
        broadcastToAll({ type: "task:deleted", projectId: bMerge.projectId, taskId: bMerge.taskId });
        broadcastToAll({ type: "task:updated", projectId: bMerge.projectId, task: esito.survivor });
        return json(esito);
      } catch (e) { return fail(e); }
    }

    // GET /api/boards/:projectId/duplicates — i gruppi di card che dicono la
    // stessa cosa, superstite in testa. È una LETTURA: non fonde niente.
    const bDupes = matchRoute(pathname, "/api/boards/:projectId/duplicates");
    if (bDupes && method === "GET") {
      const params = new URL(req.url).searchParams;
      // Di default solo le card APERTE. Misurato il 12/08: sulle 1.447 vive di
      // topics-app tutti i 14 gruppi stanno fra le `done`, cioè fra la storia.
      // Fondere la storia non alleggerisce il lavoro di nessuno, e allunga la
      // lista che un umano deve leggere prima di premere.
      const includeDone = params.get("includeDone") === "1";
      try {
        const tasks = svc.list({ scope: "project", projectId: bDupes.projectId });
        const scope = includeDone ? tasks : tasks.filter((t) => t.status !== "done");
        const groups = findDuplicateGroups(scope.map((t) => ({ id: t.id, text: t.text, createdAt: t.createdAt })));
        return json({
          groups: groups.map((g) => ({
            survivor: { id: g.survivor.id, text: g.survivor.text },
            duplicates: g.duplicates.map((d) => ({ id: d.id, text: d.text })),
            minScore: Number(g.minScore.toFixed(3)),
          })),
          scanned: scope.length,
          includeDone,
        });
      } catch (e) { return fail(e); }
    }

    const bReview = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/review");
    if (bReview && method === "POST") {
      const body = (await readJSON(req)) as any;
      const decision = body?.decision === "approve" ? "approve" : body?.decision === "reject" ? "reject" : null;
      if (!decision) return json({ error: "decision must be 'approve' or 'reject'", code: "invalid_input" }, 400);
      // A task with red checks is not accepted by inattention: see
      // `checksRedGate`, which is the land's gate too.
      if (decision === "approve") {
        const gate = checksRedGate(bReview.projectId, bReview.taskId, body?.force);
        if (gate) return gate;
      }
      try {
        const comment = typeof body?.comment === "string" ? body.comment : undefined;
        // "Landa e pubblica" = go online: accept + merge to main + push (deploy CI).
        // The agent may offer it at delivery; picking it runs the whole chain.
        // Publishing is a human PICK (this click), executed server-side — the agent
        // never pushes. Check BEFORE the land label (this is the superset action).
        if (isPublishActionLabel(comment)) {
          const { projectId, taskId } = bReview;
          // Publishing is landing plus the push: same gate, all the more so
          // (this is where the work leaves the machine).
          const gate = checksRedGate(projectId, taskId, body?.force);
          if (gate) return gate;
          // NIENTE approvazione qui: pubblicare è landare + spingere, e la
          // card la chiude il land quando main lo conferma (`settleLanded`).
          // Approvare adesso sarebbe di nuovo dire l'esito prima dei fatti.
          const before = svc.get(taskId, { projectId })?.task;
          if (!before) return json({ error: "task not found", code: "not_found" }, 404);
          // Land + push nello STESSO turno di coda: la pubblicazione spinge il
          // ramo corrente del checkout, quindi non deve mai partire mentre un
          // altro land ci sta mergiando sopra.
          const ticket = enqueueLand(projectId, taskId);
          void landings.whenSettled(taskId)?.then(async (t) => {
            if (t.phase !== "settled") return; // il land è fallito: ha già parlato lui
            // …e «settled» vuol dire che il turno di coda è finito senza
            // eccezioni, non che il lavoro sia atterrato: un land `skipped`
            // arriva qui identico. Si spinge solo ciò che main ha confermato.
            const landedNow = svc.get(taskId, { projectId })?.task;
            if (landedNow?.landingState !== "landed") {
              svc.addComment({
                taskId, author: "system",
                content: "Pubblicazione NON eseguita: il land non è arrivato su main, quindi non c'è niente di nuovo da spingere.",
              });
              const cur0 = svc.get(taskId, { projectId })?.task;
              if (cur0) broadcastToAll({ type: "task:updated", projectId, task: cur0 });
              return;
            }
            const pub = await publishProject(projectId);
            svc.addComment({
              taskId, author: "system",
              content: pub.ok
                ? `Pubblicato: push di \`${pub.branch}\` su origin (deploy CI dove configurato).`
                : `Pubblicazione FALLITA: ${pub.error}. Il merge locale (se avvenuto) resta. Ripeti la pubblicazione col bottone Pubblica.`,
            });
            const cur = svc.get(taskId, { projectId })?.task;
            if (cur) broadcastToAll({ type: "task:updated", projectId, task: cur });
          });
          const queued = svc.get(taskId, { projectId })?.task ?? before;
          return json({ ...queued, landing: ticket }, 202);
        }
        // The agent offers "Landa su main" as a quick-reply at delivery; picking
        // it arrives here as a reject-with-that-text. It is not a rejection and
        // not an approval: it is the answer to a question the SYSTEM asked, and
        // the system runs it. The five labels and what each one does live in
        // `interceptBoardAction`, because the drawer draws the same buttons on
        // a card that never reached review and they arrive on the comments
        // route instead of this one.
        {
          const intercepted = interceptBoardAction(
            { svc, dispatcher, broadcast: broadcastToAll, enqueueLand, checksRedGate, json, by: HUMAN },
            { projectId: bReview.projectId, taskId: bReview.taskId },
            comment,
            { force: body?.force },
          );
          if (intercepted) return intercepted;
        }
        // The rejection text is written HERE first, so the row exists and has
        // an id before the resume that delivers it. `reviewDecision` writes
        // the same comment right after and the author+content dedupe makes
        // that second write a no-op, which is why the review_comment it keeps
        // is untouched.
        let rejectCommentId: string | null = null;
        if (decision === "reject" && comment) {
          try {
            rejectCommentId = svc.addComment({
              taskId: bReview.taskId, author: HUMAN, content: comment,
              projectId: bReview.projectId, origin: actionOrigin,
            }).id;
          } catch { rejectCommentId = null; }
        }
        const task = svc.reviewDecision({
          taskId: bReview.taskId, by: HUMAN, decision, comment,
          projectId: bReview.projectId, origin: actionOrigin,
        });
        broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task });
        // Reject re-kicks the SAME agent tab with the human's feedback (a
        // "Serve te" answer routes through here too), so the conversation
        // resumes instead of a fresh agent spawning. reviewDecision already
        // moved it back to in_progress.
        if (dispatcher && decision === "reject" && task.assignedTopicId) {
          dispatcher.resume(bReview.taskId, comment ?? "", rejectCommentId ? { commentIds: [rejectCommentId] } : undefined)
            .catch((err) => console.warn(`[Tasks] resume after reject failed for ${bReview.taskId}:`, err));
        } else if (dispatcher && decision === "reject") {
          // No session to resume: the binding was released (a restart with
          // dispatch off, a requeue) before the human rejected. Left here the
          // card sits in_progress with nobody on it and nothing that will ever
          // claim it: `resume` returns on a missing topic, and the reconcile
          // skips a card with no dispatch chip. Read on 2026-09-04, four cards
          // at once, 40 minutes each before anyone noticed. Back to todo, where
          // the dispatcher claims it fresh with the thread (feedback included).
          try {
            const backInQueue = svc.update({
              taskId: bReview.taskId, actor: "human", by: HUMAN, projectId: bReview.projectId,
              patch: { status: "todo" }, origin: actionOrigin,
            });
            try {
              svc.addComment({
                taskId: bReview.taskId, author: "system", kind: "service",
                content: FRESH_SESSION_NOTE,
              });
            } catch { /* the requeue is what matters */ }
            broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: backInQueue });
            if (backInQueue.status === "todo") dispatcher.onEnterTodo(bReview.projectId, bReview.taskId);
            return json(backInQueue);
          } catch (err) {
            console.warn(`[Tasks] requeue after unbound reject failed for ${bReview.taskId}:`, err);
          }
        }
        // Approve = ACCEPT the task only (→ done, dependents claimable). It no
        // longer merges/builds/reaps "da sotto": landing is now an EXPLICIT step
        // — the agent's "Landa su main" option above, or POST …/land.
        // CHIUSA APPOSTA SENZA LANDARE, e la card deve poterlo dire.
        //
        // Un `approve` che non atterra lascia la card `unlanded` con un commit
        // vero: da fuori e' identico a una dimenticanza, quindi accende il chip
        // «non su main» e il contatore rosso in cima alla board, per sempre.
        // Misurato il 18/08/2026: tre card chiuse deliberatamente — due il cui
        // ramo portava il doppione di un cancello gia' su main, una in cui fra
        // due rimedi allo stesso guasto era stato scelto l'altro — tutte e tre
        // contate come debito. Un debito che nessuno intende pagare rende
        // inguardabile il contatore di quelli veri.
        //
        // `superseded: true` e' un gesto ESPLICITO di chi rivede, non una
        // deduzione: nessuno puo' sapere dal repo se un ramo fuori da main sia
        // stato scartato o dimenticato. L'audit poi non lo tocca piu'.
        if (decision === "approve" && body?.superseded === true) {
          try {
            svc.recordLandingState({
              taskId: bReview.taskId, state: "superseded", checkedAt: new Date().toISOString(),
            });
          } catch { /* la decisione conta piu' del suo timbro */ }
          // The one review door that says out loud "these branches will never
          // land": the drafts they opened and the branches they pushed go with
          // them, all of them, with no `landed` to spare.
          // A plain approval does not come through here, and must not - its
          // branch still holds work nobody has merged.
          void sweepRemoteDelivery(bReview.projectId, bReview.taskId,
            "Closed by the Topics board: the card was approved as superseded, this branch will not land.")
            .catch((err) => console.warn(`[land] remote cleanup after a superseded approval failed for ${bReview.taskId}:`, err));
        }
        if (dispatcher && decision === "approve" && task.status === "done") {
          dispatcher.onBlockerDone(bReview.taskId);
          // Accepted (not landed): the preview server is no longer needed.
          void opts?.teardownPreview?.(bReview.taskId).catch(() => {});
        }
        // Post-approve deploy PROPOSAL (never automatic): a board with
        // `deployCommand` set gets a comment + "Deploya ora" button here, the
        // same edge `enqueueLandOnDone` watches for the land side. No-op when
        // the board has no command configured.
        if (decision === "approve" && task.status === "done") {
          proposeDeployIfConfigured(bReview.projectId, bReview.taskId);
        }
        return json(task);
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/land — explicit landing (merge
    // the branch to main, reap the worktree, rebuild the client if it changed).
    // Decoupled from approve: landing implies acceptance, so approve if still in
    // review, then land. Never online — publish stays a separate human action.
    //
    // Risponde `202`, non `200`, e la differenza non è cosmetica: il land è
    // ACCETTATO, non ancora avvenuto. Il `200` con la card dentro sembrava un
    // successo — ed è così che una raffica ne perdeva 16 su 20 senza che
    // nessuno se ne accorgesse. Nel corpo c'è `landing`, il ticket: la
    // posizione in coda adesso, e l'esito quando ci sarà (GET qui sotto).
    const bLand = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/land");
    if (bLand && method === "POST") {
      try {
        const task = svc.get(bLand.taskId, { projectId: bLand.projectId })?.task;
        if (!task) return json({ error: "task not found", code: "not_found" }, 404);
        // The body may be absent (a bare `POST` stays valid): it only
        // carries `force`.
        const landBody = (await readJSON(req)) as { force?: unknown } | null;
        // Same gate as `approve`, for the same reason said backwards:
        // landing is not a weaker acceptance, it is a stronger one. See
        // `checksRedGate`.
        const gate = checksRedGate(bLand.projectId, bLand.taskId, landBody?.force);
        if (gate) return gate;
        // ── L'ORDINE È IL DIFETTO ──────────────────────────────────────────
        //
        // Qui una card in `review` veniva APPROVATA — cioè portata a `done`,
        // subito e per sempre — e solo dopo si accodava il land, che è
        // asincrono e può non avvenire mai. Lo stato raccontava l'INTENZIONE.
        // Il 13/08 tre card (`92d61427`, `274d5425`, `95a6794f`) sono finite
        // in `done` coi rami mai arrivati su main, senza una riga di errore da
        // nessuna parte: sparite da review, nessuno le riguarda, e la potatura
        // delle worktree può portarsi via il ramo.
        //
        // Adesso la card NON si muove: resta dove sta finché il merge non è
        // confermato su main, e a quel punto la chiude `settleLanded` dentro
        // `landTask`. Un land che fallisce, o che non parte affatto, lascia la
        // card in review col motivo scritto nel thread.
        const ticket = enqueueLand(bLand.projectId, bLand.taskId);
        const fresh = svc.get(bLand.taskId, { projectId: bLand.projectId })?.task ?? task;
        return json({ ...fresh, landing: ticket }, 202);
      } catch (e) { return fail(e); }
    }
    // GET …/land — com'è andata? Il ticket resta interrogabile anche molto
    // dopo che la richiesta di land si è chiusa: è la controparte del 202.
    if (bLand && method === "GET") {
      const ticket = landings.status(bLand.taskId);
      if (!ticket) return json({ error: "no land was requested for this task", code: "not_found" }, 404);
      return json({ landing: ticket, pending: landings.pending(bLand.projectId) });
    }

    // POST /api/boards/:projectId/tasks/:taskId/deploy — the HUMAN CLICK that
    // confirms a proposed deploy. This is the only door that runs a deploy
    // command: `proposeDeployIfConfigured` (post-approve) only ever writes the
    // proposal, never gets here on its own. 409 when there is nothing pending
    // (never proposed, or already running/deployed) — same shape as `/land`
    // when nothing needs landing.
    const bDeploy = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/deploy");
    if (bDeploy && method === "POST") {
      const { projectId, taskId } = bDeploy;
      try {
        const before = svc.get(taskId, { projectId })?.task;
        if (!before) return json({ error: "task not found", code: "not_found" }, 404);
        const claim = svc.beginDeploy({ taskId });
        if (!claim) {
          return json({
            error: "no deploy pending on this card (never proposed, or already running/done)",
            code: "invalid_transition",
          }, 409);
        }
        const running = svc.get(taskId, { projectId })?.task ?? before;
        broadcastToAll({ type: "task:updated", projectId, task: running });
        void runDeploy(projectId, taskId, claim.command);
        return json(running, 202);
      } catch (e) { return fail(e); }
    }

    // POST /api/boards/:projectId/tasks/:taskId/preview — «Ricattura evidenza»
    // su una card che è GIÀ in review. Fino a qui `prepareForReview` girava in
    // un punto solo, il bordo d'ingresso in review: una card che l'evidenza
    // l'ha persa (o non l'ha mai avuta) poteva riaverla solo uscendo da review
    // e rientrandoci — cioè svegliando un agente e bruciando un turno per una
    // foto. L'incidente dell'11/08 (i due cancelli hanno RITIRATO l'evidenza
    // falsa a 23 card, sei in attesa di giudizio) l'ha reso concreto.
    //
    // Questa route fa quella cosa e nient'altro: nessun `resume`, nessun
    // `dispatch`, nessun cambio di stato, `dispatch_attempts` intatto. L'esito
    // arriva sul canale `review-note`, che NON sveglia l'agente — un commento
    // umano invece farebbe reject+resume, cioè esattamente ciò che questa
    // azione esiste per evitare.
    const bPreview = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/preview");
    if (bPreview && method === "POST") {
      try {
        const before = svc.get(bPreview.taskId, { projectId: bPreview.projectId })?.task;
        if (!before) return json({ error: "task not found", code: "not_found" }, 404);
        if (before.status !== "review") {
          return json({
            error: "la ricattura dell'evidenza vale solo su un task in review",
            code: "invalid_transition",
          }, 409);
        }
        if (!opts?.preparePreview) {
          return json({ error: "preview manager unavailable", code: "unavailable" }, 503);
        }
        await opts.preparePreview(bPreview.taskId, { explain: true });
        // Rileggo DOPO: previewImage/output_url li scrive il preview manager
        // direttamente sul db, e la card deve aggiornarsi su ogni device.
        const task = svc.get(bPreview.taskId, { projectId: bPreview.projectId })?.task ?? before;
        broadcastToAll({ type: "task:updated", projectId: bPreview.projectId, task });
        return json({ task, previewImage: task.previewImage ?? null, outputUrl: task.outputUrl ?? null });
      } catch (e) { return fail(e); }
    }

    // RIGENERA IL TITOLO di una card che ce l'ha ancora mozzato.
    //
    // Il titolo leggibile lo ricava la board alla NASCITA della card
    // (`services/task-title.ts`), ma le card che c'erano gia' tengono quello
    // vecchio: sul database vivo erano 24, di cui 2 in review — le stesse due
    // che hanno fatto nascere questo lavoro. Una migration non serviva (il
    // titolo lo deve scrivere un modello, non uno UPDATE), e riscriverlo a
    // mano nel database sarebbe stato un gesto che nessuno puo' ripetere.
    //
    // Le guardie sono quelle della creazione, perche' e' la stessa decisione:
    // un titolo corto non si tocca, una risposta storta si scarta, e senza
    // modello non succede niente.
    const bTitle = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/retitle");
    if (bTitle && method === "POST") {
      const t = svc.get(bTitle.taskId, { projectId: bTitle.projectId })?.task;
      if (!t) return json({ error: "not_found" }, 404);
      const prov = opts?.namingProvider?.();
      if (!prov) return json({ ok: false, reason: "no_provider" });
      const migliore = await titoloMigliore(prov, { text: t.text, description: t.description });
      if (!migliore) return json({ ok: false, reason: "nothing_better", text: t.text });
      const aggiornata = svc.update({
        taskId: t.id, actor: "agent", by: "system",
        projectId: bTitle.projectId, patch: { text: migliore },
      });
      if (aggiornata) broadcastToAll({ type: "task:updated", projectId: bTitle.projectId, task: aggiornata });
      return json({ ok: true, text: migliore, before: t.text });
    }

    const bComments = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/comments");
    if (bComments && method === "POST") {
      const body = (await readJSON(req)) as any;
      try {
        let delivery: import('../../shared/task-comment-ack').TaskCommentAcknowledgement['delivery'] = 'note';
        const comment = svc.addComment({
          taskId: bComments.taskId, author: HUMAN, content: body?.content,
          mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
          media: filterMedia(body?.media),
          projectId: bComments.projectId, origin: actionOrigin,
          // THE GESTURE BELONGS ON THE ROW, not only in this handler.
          //
          // Until 2026-09-12 `quiet` existed solely as the early return a few
          // lines below: the agent stayed asleep, and the stored row came out
          // identical to a reply. A reader coming back to the thread could no
          // longer tell them apart - and `pendingQuestionComment` stops at the
          // first human word, so a note left under an open question took its
          // buttons away. Card f5805e88.
          quiet: body?.quiet === true,
        });
        const task = svc.get(bComments.taskId, { projectId: bComments.projectId })?.task;
        broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task });
        // `quiet` = il commento è una ANNOTAZIONE, non una consegna all'agent.
        //
        // Tutto ciò che viene dopo questa riga esiste per DARE il commento a
        // chi lavora: la risposta a una domanda aperta, e per un task in
        // review il reject+resume che rimette la card in In Progress. È il
        // comportamento giusto per «rispondi all'agent», ed è l'unico che
        // c'era: chi voleva solo lasciare traccia di aver verificato una
        // consegna la rigettava senza saperlo, perché il bottone diceva
        // «Commenta» e faceva un'altra cosa.
        //
        // Con `quiet` il commento si salva e si trasmette (le due righe qui
        // sopra restano: la nota si vede sulla card e su ogni device) e la
        // rotta si ferma. Nessun reviewDecision, nessun resume, per qualunque
        // stato del root — il gesto quieto è quieto anche quando il task è in
        // corso o quando c'è una domanda in sospeso, perché una nota non è la
        // risposta a una domanda che nessuno ha detto di voler chiudere.
        if (body?.quiet === true) return json({ ...comment, delivery }, 201);
        // C'È UNA DOMANDA APERTA SU QUESTO TASK? Allora questo commento è la
        // RISPOSTA, e va a chi sta fermo ad aspettarla — che può essere il
        // coordinatore o una delle sue sessioni di lavoro. La consegna sblocca
        // quel rendez-vous e il turno riparte da solo: nessun tab da aprire,
        // nessun re-kick.
        //
        // ESCE QUI E NON PROSEGUE. Il blocco sotto è la strada dei commenti
        // normali, e per un task in review passa da `reviewDecision(reject)`:
        // su una sessione che sta già aspettando questa risposta sarebbe un
        // secondo canale che dice la stessa cosa in un altro modo, cioè la
        // risposta consegnata due volte.
        //
        // AND THE ANSWER NAMES THE QUESTION. `answerTo` is the id of the
        // comment the person clicked: if that is no longer the open question,
        // the yes is NOT delivered. Without this comparison a consent read on
        // one message sent another - two sessions of one task open two
        // confirmations, and the registry is keyed by TASK. A caller that
        // sends no `answerTo` (an older route, a comment written by hand)
        // answers the open question, which is the only one there can be: a
        // second question on a card that already has a live one is refused
        // upstream.
        //
        // AND A CLICK ON A BLOCK THAT IS NO LONGER ANSWERABLE IS NOT SILENCE.
        // When there is no open question at all, `answerTo` still names a
        // quick-reply block the person could see and press: the rendez-vous
        // behind it died (the send was refused and took its entry, the turn
        // was interrupted) while the comment kept its buttons. Left to fall
        // through, "Conferma" became an ordinary comment that re-kicked the
        // agent, and the card said nothing - measured, the person had every
        // reason to believe they had confirmed. Decided here, said after the
        // board actions below, which are quick replies of their own.
        let deadQuestionClick = false;
        {
          const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
          const target = root?.id ?? bComments.taskId;
          const answerTo = typeof body?.answerTo === "string" ? body.answerTo : undefined;
          const open = pendingRoutedAsk(target);
          if (!open && answerTo) {
            deadQuestionClick = pressedADeadQuickReply(
              svc.get(bComments.taskId, { projectId: bComments.projectId })?.comments,
              answerTo,
              typeof body?.content === "string" ? body.content : "",
            );
          }
          if (open) {
            const outcome = answerRoutedAsk(askRouting, target, String(body?.content ?? ""), { askId: answerTo });
            if (outcome.delivered) return json({ ...comment, delivery: 'answered' });
            if (outcome.stale) {
              // THE CARD SAYS SO. The comment is already saved, so without
              // this line the person clicked "Conferma" and nothing visible
              // happened: they would believe they had confirmed.
              try {
                svc.addComment({
                  taskId: bComments.taskId,
                  author: "agent",
                  content: "Questa risposta era per una domanda che non e' piu' quella aperta su questa card: non e' stata consegnata e non e' partito niente. La domanda aperta adesso e' un'altra.",
                  projectId: bComments.projectId,
                  origin: actionOrigin,
                });
                const aggiornata = svc.get(bComments.taskId, { projectId: bComments.projectId })?.task;
                if (aggiornata) broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task: aggiornata });
              } catch { /* the line is an explanation: it never fails the saved comment */ }
              return json({ ...comment, delivery: 'note' });
            }
          }
        }
        // A SYSTEM LABEL CLICKED FROM THE DRAWER IS AN UPDATE, NEVER A TURN.
        // The quick replies of an open question are now drawn in every column,
        // so «Landa su main» (and the four parked-subtask answers) can arrive
        // on THIS route instead of the review one. Left to fall through, the
        // block below would hand the label's text to the agent and pay a whole
        // turn to move two cards. After `quiet` and after the routed
        // rendez-vous, because both of those are answers to somebody waiting.
        {
          const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
          const intercepted = interceptBoardAction(
            { svc, dispatcher, broadcast: broadcastToAll, enqueueLand, checksRedGate, json, by: HUMAN },
            { projectId: bComments.projectId, taskId: root?.id ?? bComments.taskId },
            typeof body?.content === "string" ? body.content : "",
            { force: body?.force },
          );
          if (intercepted) return intercepted;
        }
        if (deadQuestionClick) {
          try {
            svc.addComment({
              taskId: bComments.taskId,
              author: "agent",
              content: DEAD_QUESTION_LINE,
              projectId: bComments.projectId,
              origin: actionOrigin,
            });
            const aggiornata = svc.get(bComments.taskId, { projectId: bComments.projectId })?.task;
            if (aggiornata) broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task: aggiornata });
          } catch { /* the line is an explanation: it never fails the saved comment */ }
          return json({ ...comment, delivery: 'note' });
        }
        // Answering on a STEP is answering the agent: when the subtree's
        // dispatch root sits in review ("serve te"), a human comment anywhere
        // under it re-kicks the same agent tab with the step reference — the
        // specific reply lives on the step's own thread, not necessarily on
        // the main task's. Best-effort: the comment above is already saved.
        try {
          const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
          // A human comment on a dispatched task is DELIVERED to the agent, not
          // left as an unread note. Two live cases, both through resume():
          //  • review       → the agent is waiting: reject-with-text re-kicks it;
          //  • in_progress   → the agent is working: resume() BUFFERS the message
          //    mid-turn (pendingResume) and hands it over at the next turn
          //    boundary; if idle it continues immediately. This is the
          //    Claude-Code steering path — add a message while it runs and it
          //    picks it up.
          // …UNLESS THAT CARD IS ALREADY ON MAIN. The reject that re-kicks the
          // agent also wipes `landing_state`, so a comment on a landed card
          // (or on one of its steps) put an agent back to work over merged
          // content AND made the card stop saying it had landed. The comment
          // is already saved and broadcast above: on a landed card it stays a
          // note, and the card stays in review, where it is approvable.
          if (dispatcher && root && root.assignedTopicId && !isLandedWork(root)
              && (root.status === "review" || root.status === "in_progress")) {
            if (root.status === "review") {
              const rejected = svc.reviewDecision({
                taskId: root.id, by: HUMAN, decision: "reject", projectId: bComments.projectId, origin: actionOrigin,
              });
              broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task: rejected });
            }
            const text = typeof body?.content === "string" ? body.content : "";
            let msg = root.id === bComments.taskId
              ? text
              : `Commento sul tuo sottotask "${(task?.text ?? "").slice(0, 60)}" (id=${bComments.taskId}): ${text}`;
            // Attachments ride along as disk paths — the agent reads them
            // directly (screenshots, docs, mockups the human dropped in).
            if (comment.media.length) msg += `\nAllegati (file su disco, leggili): ${comment.media.join(" ")}`;
            // The envelope carries the id of the comment it delivers: those
            // words are already a row in the thread, and the anchor is what
            // lets a reader draw them once instead of twice.
            dispatcher.resume(root.id, msg, { commentIds: [comment.id] })
              .catch((err) => console.warn(`[Tasks] resume after comment failed for ${root.id}:`, err));
            delivery = 'queued';
          }
        } catch { /* the root may have moved meanwhile */ }
        return json({ ...comment, delivery }, 201);
      } catch (e) { return fail(e); }
    }

    const bItem = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId");
    if (bItem) {
      const { projectId, taskId } = bItem;
      if (method === "GET") {
        const got = svc.get(taskId, { projectId });
        if (!got) return json({ error: "task not found", code: "not_found" }, 404);
        // `?fields=children` is what a CARD asks for: it already has the row
        // and the window of comments that travels with the list, so the whole
        // thread is bytes it throws away. Measured on the live board on
        // 2026-09-07: 25 GET at board mount weighed 1.122.652 B, of which
        // 664.282 were comments, and the group repeats on every updatedAt
        // bump. The children stay WHOLE tasks: the card renders the work and
        // queue chips off `subtaskWork` and `queueReason`.
        if (new URL(req.url).searchParams.get("fields") === "children") return json({ children: got.children });
        return json(got);
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        // I campi della CONSEGNA per primi: `parseTaskPatch` li rifiuterebbe
        // comunque, ma come "campo sconosciuto". Qui il rifiuto dice anche cosa
        // fare al posto suo (ripremere «Landa su main», che riallinea il ramo da
        // sé), e quella riga vale più del codice di stato.
        const noDelivery = rejectDeliveryPatch(body);
        if (noDelivery) return noDelivery;
        // Ogni altra chiave la legge `parseTaskPatch`, che conosce i nomi doppi
        // (`parent_task_id`, `output_url`) e rifiuta con 400 ciò che questa
        // rotta non sa applicare: `archived` archiviava zero card rispondendo
        // 200, ed è indistinguibile dall'aver funzionato. Vedi task-patch.ts.
        const parsed = parseTaskPatch(body, "human", acceptPreview);
        if (!parsed.ok) return json(unapplicableFieldsBody(parsed.errors), 400);
        // THE MACHINE MUST EXIST. `machine_id` has a FK to `machines`, so an
        // unknown id would surface as a 500 with SQLite's own words; and a
        // TYPO would be worse than an error - the card would sit in the queue
        // waiting for a node nobody ever paired (KANBAN-76).
        if (typeof parsed.patch.machineId === "string" && parsed.patch.machineId) {
          if (!ctx.machineStore.get(parsed.patch.machineId)) {
            return json(
              { error: `machineId "${parsed.patch.machineId}" is not a known machine`, code: "unknown_machine" },
              400,
            );
          }
        }
        try {
          const prevStatus = svc.get(taskId, { projectId })?.task.status;
          // Invalidate probe cache when output_url changes (new URL needs a fresh probe).
          if (parsed.patch.outputUrl !== undefined) {
            const old = svc.get(taskId, { projectId })?.task.outputUrl;
            if (old) invalidateProbeCache(old);
          }
          let task = svc.update({
            taskId, actor: "human", by: HUMAN, projectId, origin: actionOrigin,
            patch: parsed.patch,
          });
          task = await captureDelivery(task, prevStatus);
          broadcastToAll({ type: "task:updated", projectId, task });
          emitReviewReadyEdge(broadcastToAll, projectId, task, prevStatus, undefined,
            () => svc.get(taskId)?.comments);
          triggerUrlProbe(taskId, task.outputUrl ?? null, projectId);
          // Auto-dispatch trigger: the human dragging a task INTO todo is the
          // "vai" signal; dragging it back OUT while still queued cancels it.
          // The dispatcher itself no-ops when auto_dispatch is off for the board.
          if (dispatcher && prevStatus !== task.status) {
            if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
            else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
            // Reaching done releases whatever was waiting on this task.
            if (task.status === "done") dispatcher.onBlockerDone(taskId);
          }
          // `done` deve voler dire ATTERRATO. Il land era un'azione a parte, e
          // chi trascinava una card in Done — il gesto più naturale che ci sia —
          // chiudeva il lavoro lasciandolo sul suo ramo, in silenzio. Misurato
          // il 10/08: 17 card chiuse in otto ore col contenuto NON su main,
          // verificato applicando i loro commit e guardando se restava qualcosa.
          //
          // …but the decision belongs to the BOARD, and it goes through
          // `enqueueLandOnDone`: this line took it as already made, citing a
          // `dispatchAutoMerge` that nobody consulted on this path. If the
          // land does start and fails (conflict, missing piece) `landTask`
          // writes that on the card and hands it back to the agent, which
          // beats a mute closure. Fire-and-forget: the PATCH does not wait on
          // git, or dragging a card would block the interface.
          if (prevStatus !== "done" && task.status === "done" && task.deliveryBranch) {
            enqueueLandOnDone(projectId, taskId, task.deliveryBranch);
          }
          return json(task);
        } catch (e) { return fail(e); }
      }
      if (method === "DELETE") {
        try {
          // Un task che sparisce dalla board si porta dietro il suo agente:
          // archiviare senza tagliare il turno lascia un agente che lavora per
          // nessuno (vedi `detachLiveAgent`). Prima di archiviare, quindi.
          const got = svc.get(taskId, { projectId });
          if (got) {
            // The server sends this DELETE itself for a delegation another
            // machine revoked, and says so: that stop is not a person's (C9).
            detachLiveAgent(got.task, NOTE_ARCHIVED_BY_HUMAN, stopCauseOf(req, req.headers.get(STOP_CAUSE_HEADER)));
          }
          // Read BEFORE the archive: the sweep needs the delivery branch, and
          // it runs after, when the card is already off the board.
          const deliveryBranch = got?.task.deliveryBranch ?? null;
          const task = svc.archive({ taskId, projectId });
          void opts?.teardownPreview?.(taskId).catch(() => {}); // reap preview on close
          // A card that leaves the board leaves its draft pull requests and its
          // origin branches too: nothing will ever land them, and nobody will
          // ever look at them again. No `landed` here - not one of these
          // branches is on its way into main, so every draft gets closed.
          void sweepRemoteDelivery(projectId, taskId,
            "Closed by the Topics board: the card was archived, this branch will not land.",
            { extra: [deliveryBranch] })
            .catch((err) => console.warn(`[land] remote cleanup after an archive failed for ${taskId}:`, err));
          // Le tab del task se ne vanno con lui: un task archiviato è fuori
          // dalla board e la sua evidenza durevole è l'anteprima, non la tab
          // viva. DOPO l'archiviazione perché il sottoalbero è quello che
          // `archive` ha appena marcato, e PRIMA del broadcast perché il
          // frame porta gli id da dimenticare.
          const torn = opts?.teardownTaskBrowserState?.(taskId);
          broadcastToAll({ type: "task:deleted", projectId, taskId, taskIds: torn?.taskIds ?? [taskId] });
          return json({ ok: true, task });
        } catch (e) { return fail(e); }
      }
      return null;
    }
    return null;
  };
}
