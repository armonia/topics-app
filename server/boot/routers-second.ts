/**
 * The second batch of API routers and the Claude hooks / session recovery they start.
 */
import { applyPaneCascade, retiredIds } from "../services/retirement";
import { computeCascade } from "../services/pane-retirement-cascade";
import { createOpenRouter } from "../routes/open";
import { projectIdForPath } from "../services/tasks";
import { buildBranchInventory, scanBranchesOutsideBase, summarizeInventory } from "../services/branch-inventory";
import { createPushRouter } from "../routes/push";
import { createClientTraceRouter } from "../routes/client-trace";
import { createNotificationsRouter } from "../routes/notifications";
import { createUiStateRouter } from "../routes/ui-state";
import { createProvidersRouter } from "../routes/providers";
import { createAppSettingsRouter } from "../routes/app-settings";
import { createReasoningTranslationRouter } from "../routes/reasoning-translation";
import { createCalendarRouter } from "../routes/calendar";
import { createTopicsCheckRouter } from "../routes/topics-check";
import { createHeavySlotRouter } from "../routes/heavy-slot";
import { createScheduledJobsRouter } from "../routes/scheduled-jobs";
import { createAgentChannelsRouter } from "../routes/agent-channels";
import { createAgentConfigRouter } from "../routes/agent-config";
import { createAgentPermissionsRouter } from "../routes/agent-permissions";
import { createAgentsRouter } from "../routes/agents";
import { createMemoryStoresRouter } from "../routes/memory-stores";
import { createSystemHealthRouter } from "../routes/system-health";
import { createProfileRouter } from "../routes/profile";
import { createPublicProfileHandler } from "../routes/public-profile";
import { createClaudeHooksRouter } from "../routes/claude-hooks";
import { createE2eRouter } from "../routes/e2e";
import { createTabsRouter } from "../routes/tabs";
import { createViewsRouter } from "../routes/views";
import { createProjectsRouter } from "../routes/projects";
import { createWorktreesRouter } from "../routes/worktrees";
import { createRegistrationDoor } from "./worktree-register-wiring";
import { createRelocateService } from "./worktree-relocate-wiring";
import { toPlanPayload } from "../services/worktree-plan-payload";
import { createMachinesRouter } from "../routes/machines";
import { createNodesRouter } from "../routes/nodes";
import { createNodeWorktreesRouter } from "../routes/nodes-worktrees";
import { createNodePrimaryRouter } from "../routes/nodes-primary";
import { restartThisServerSoon } from "../lib/primary-fence";
import { createMachineWorktreesRouter } from "../routes/machine-worktrees";
import { createWorktreeReportDeps } from "./worktree-node-wiring";
import { createDelegatedRevocationRetry } from "../services/delegated-revocation-retry";
import { internalRequest, STOP_CAUSE_HEADER } from "../lib/abort-cause";
import type { AfterTasksRouter } from "./scope";
import { late } from "./late";

export function bootRoutersSecond(scope: AfterTasksRouter) {
  const { browserService, claudeSessionTracker, ctx, nodeClient, retirementConsequences, scheduleEngine, scheduledJobs, taskDispatcher, tasksRouter, tickScheduledCards, worktreeGc, worktreeOfTask } = scope;
  const pushRouter = createPushRouter(ctx);

  // La CRONOLOGIA delle notifiche: leggerla, scriverci (il banner del client
  // registra qui la sua riga), segnarla vista. Vedi migration 101.
  const notificationsRouter = createNotificationsRouter(ctx);

  // The client's `[pane-attach]` trace, written into this log (card c5c1c68f).
  const clientTraceRouter = createClientTraceRouter(ctx);

  // Chiudere una tab E' il ritiro di cio' che contiene, deciso lato server.
  //
  // Il client gia' archivia la chat e chiude la sessione quando e' LUI a chiudere.
  // Questa e' la strada per tutte le volte in cui quelle chiamate non partono o
  // non arrivano — la tab chiusa su un altro dispositivo, la `keepalive` persa in
  // un `pagehide`, la finestra chiusa con la fetch in volo. Il tombstone, che e'
  // sincronizzato, arriva comunque: da qui in poi arrivano anche le conseguenze.
  // Vedi `services/pane-retirement-cascade.ts` per perche' il segnale e' il
  // tombstone e non «la pane non c'e' piu'».
  const uiStateRouter = createUiStateRouter(ctx, {
    onPaneSnapshot: (prev, next) => {
      const decision = computeCascade({ prev, next, alreadyRetired: retiredIds(ctx.db, "pane") });
      if (decision.retire.length === 0 && decision.reopen.length === 0) return;
      const applied = applyPaneCascade(ctx.db, retirementConsequences, decision);
      if (applied.topics > 0 || applied.terminals > 0) {
        console.log(`[retirement] tab chiuse: ${applied.panes} → ${applied.topics} chat archiviate, ${applied.terminals} sessioni ritirate`);
      }
    },
  });

  // `GET /api/open` — la query sola su «cosa è aperto». Sola lettura.
  const openRouter = createOpenRouter(ctx);

  const providersRouter = createProvidersRouter(ctx);

  const appSettingsRouter = createAppSettingsRouter(ctx);

  // The reasoning text in the chat language, for a row the person opens.
  const reasoningTranslationRouter = createReasoningTranslationRouter(ctx);

  // L'agenda del calendario configurato, e la prova di un indirizzo prima di salvarlo.
  const calendarRouter = createCalendarRouter(ctx);
  const topicsCheckRouter = createTopicsCheckRouter(ctx);

  // The machine-wide queue for heavy commands, asked by every harness on this Mac.
  const heavySlotRouter = createHeavySlotRouter(ctx);

  // The scheduled jobs: create, change, run now, history (R25).
  const scheduledJobsRouter = createScheduledJobsRouter(ctx, scheduledJobs, {
    pauseStarts: () => scheduleEngine.pauseStarts(), resumeStarts: () => scheduleEngine.resumeStarts(),
    isPaused: () => scheduleEngine.isPaused(), inFlight: () => scheduleEngine.inFlight(),
  });

  // The titles of the agents' Discord and WhatsApp chats, read from jarvis-channels.
  const agentChannelsRouter = createAgentChannelsRouter(ctx);

  // Anagrafica di Jarvis e Visione: legge e scrive i file di jarvis-channels.
  const agentConfigRouter = createAgentConfigRouter(ctx);

  // What the channel engine applies for each agent (policy, owners, trusted,
  // senders/denied) and its own log of stopped turns (AGENTS-NAV-01).
  const agentPermissionsRouter = createAgentPermissionsRouter(ctx);

  // The agents registry: who exists, and creating a new one.
  const agentsRouter = createAgentsRouter(ctx);

  // Memory stores (T6): every agent's own memory folder plus project memories found, read/searched/edited from one place.
  const memoryStoresRouter = createMemoryStoresRouter(ctx);

  // System health (T7): every problem of the agents system in one list.
  const systemHealthRouter = createSystemHealthRouter(ctx);

  const profileRouter = createProfileRouter(ctx);

  // Pagina pubblica del profilo — senza autenticazione, prima del gate.
  const publicProfileHandler = createPublicProfileHandler(ctx);

  // Risoluzione dei permalink alle tab (`/tab/…`) — SOLA LETTURA.
  const tabsRouter = createTabsRouter(ctx, browserService);

  // Generative views (`show_view`): the store behind the chat block and `/v/<id>`.
  const viewsRouter = createViewsRouter(ctx);

  // Reset della suite E2E. Si auto-disarma (risponde 404) se TOPICS_E2E ≠ "1",
  // che è il caso di ogni server non di test — vedi server/routes/e2e.ts.
  const e2eRouter = createE2eRouter(ctx, {
    reapClaudeSessions: (t) => claudeSessionTracker.reapOnce(t),
    advanceScheduledCards: (value) => {
      late.scheduledCardTestNow = value;
      return value ? tickScheduledCards() : { created: [], skipped: [], started: [] };
    },
  });


  const claudeHooksRouter = createClaudeHooksRouter(ctx, claudeSessionTracker);

  // Replay JSONL tails for any session whose state was lost on the previous
  // shutdown, then start the reaper and the LIVE transcript tail. All three are
  // fire-and-forget — they advance state independently of the live hook stream.
  // The live tail is what tracks turns no hook announces (a Monitor firing, a
  // background task completing, a teammate message waking a parked session).
  claudeSessionTracker.recoverFromJsonl().catch((err) => {
    console.error("[claude-session-tracker] Boot recovery failed", err);
  });

  claudeSessionTracker.startReaper();

  claudeSessionTracker.startJsonlTail();

  // Import sweep: pull terminal turns of ADOPTED sessions into their chat, so an
  // adopted conversation no longer freezes at the adoption snapshot.
  claudeSessionTracker.startImportSweep();

  const projectsRouter = createProjectsRouter(ctx);

  const worktreesRouter = createWorktreesRouter(ctx, {
    // I rami locali non su main, col task a cui appartengono. Due letture: git
    // per QUALI rami e quanti commit, il DB per DI CHI sono.
    branchInventory: async (projectPath) => {
      // The git half lives in `scanBranchesOutsideBase`, which also answers the
      // question this closure used to get wrong: a repo without `main` is not a
      // broken repo. See the comment on `BranchScan`.
      const scan = await scanBranchesOutsideBase(projectPath);
      // The only failure left is a path that is NOT THERE: a project pointing at
      // a folder that has vanished hides branches, and "none" would be a lie.
      if (scan.kind === "no-path") throw new Error(`git: ${projectPath} non esiste`);
      // A folder without git, or a checkout without a base branch: the question
      // has an empty answer, and it says which of the two it was instead of a 500
      // in the middle of somebody's test output.
      if (scan.kind !== "ok") {
        const empty = buildBranchInventory([], []);
        return { entries: empty, summary: summarizeInventory(empty), base: null, reason: scan.kind };
      }
      const branches = scan.branches;
      // I task del board di QUESTO percorso: e' l'unico insieme che puo'
      // reclamare quei rami.
      const boardId = projectIdForPath(projectPath);
      const rows = ctx.db.prepare(
        `SELECT t.id AS taskId, t.text AS taskText, t.status AS taskStatus,
              t.delivery_branch AS deliveryBranch, w.branch_name AS worktreeBranch
         FROM tasks t
    LEFT JOIN topics tp ON tp.id = t.assigned_topic_id
    LEFT JOIN worktrees w ON w.id = tp.worktree_id
        WHERE t.project_id = ? AND t.archived = 0`,
      ).all(boardId) as Array<{ taskId: string; taskText: string; taskStatus: string; deliveryBranch: string | null; worktreeBranch: string | null }>;
      const entries = buildBranchInventory(branches, rows);
      return { entries, summary: summarizeInventory(entries) };
    },
    // `worktreeGc` è costruito più sotto (dopo `taskAutoMerge`): questa closure
    // quindi la closure è valida anche se il router nasce prima.
    runGc: () => worktreeGc.runWorktreeGc(),
    planGc: async ({ weigh }) => {
      const plan = await worktreeGc.planWorktreeGc({ weigh });
      return plan ? toPlanPayload(plan, (id) => ctx.projectStore.get(id)?.name ?? null) : null;
    },
    relocate: createRelocateService(ctx, worktreeGc),
    registration: createRegistrationDoor(ctx),
  });

  // The ingress of a card mirrored from another machine (KANBAN-76). The DELETE
  // goes through the board's own route so "stop the agent, then archive" has one
  // implementation: a second copy here would be the one that forgets the stop.
  // The revocation is the machine's, and the stop it causes says so (card C9).
  const deleteDelegatedBoardTask = (projectId: string, taskId: string) => {
    const url = new URL(`http://localhost/api/boards/${projectId}/tasks/${taskId}`);
    const req = internalRequest(url, { method: "DELETE", headers: { [STOP_CAUSE_HEADER]: "superseded" } });
    return tasksRouter(req, url, url.pathname, "DELETE");
  };

  const delegatedRevocations = createDelegatedRevocationRetry({
    db: ctx.db,
    nodeClient,
    deleteBoardTask: deleteDelegatedBoardTask,
    log: (message, error) => console.error(`[delegated-revoke] ${message}`, error),
  });

  // The worktrees of every machine (worktree-standard T12): in the route table right before
  // `machinesRouter` and `nodesRouter`, whose `/api/machines/:id` would claim the same paths.
  const worktreeReports = createWorktreeReportDeps(ctx, { worktreeGc, nodeClient });
  const machineWorktreesRouter = createMachineWorktreesRouter(ctx, worktreeReports.machine);
  const nodeWorktreesRouter = createNodeWorktreesRouter(ctx, worktreeReports.node);
  const nodePrimaryRouter = createNodePrimaryRouter(ctx, { stateDir: ctx.STATE_DIR, restart: restartThisServerSoon });

  const machinesRouter = createMachinesRouter(ctx, { revocations: delegatedRevocations });

  const nodesRouter = createNodesRouter(ctx, {
    deleteBoardTask: deleteDelegatedBoardTask,
    revocations: delegatedRevocations,
    onEnterTodo: (projectId, taskId) => taskDispatcher.onEnterTodo(projectId, taskId),
    worktreeOfTask: (taskId) => {
      const wt = worktreeOfTask(taskId);
      return wt ? { absPath: wt.absPath, branchName: wt.branchName, mode: wt.mode } : null;
    },
    // The browser acceptance server intentionally has no live coding account.
    // Give only that hermetic process one inert catalogue value so it can prove
    // the authorization handshake without probing or invoking an LLM.
    taskModels: process.env.TOPICS_E2E === "1" ? () => ["e2e-coding-model"] : undefined,
  });

  void delegatedRevocations.tick({ force: true }).catch((err) => console.error("[delegated-revoke] boot retry failed", err));

  return { agentChannelsRouter, agentConfigRouter, agentPermissionsRouter, agentsRouter, appSettingsRouter, calendarRouter, claudeHooksRouter, clientTraceRouter, delegatedRevocations, e2eRouter, heavySlotRouter, machineWorktreesRouter, machinesRouter, memoryStoresRouter, scheduledJobsRouter, systemHealthRouter, nodePrimaryRouter, nodeWorktreesRouter, nodesRouter, notificationsRouter, openRouter, profileRouter, projectsRouter, providersRouter, publicProfileHandler, pushRouter, reasoningTranslationRouter, tabsRouter, topicsCheckRouter, uiStateRouter, viewsRouter, worktreesRouter };
}
