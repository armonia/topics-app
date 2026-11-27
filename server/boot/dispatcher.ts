/**
 * The task dispatcher itself.
 */
import { basename, join } from "path";
import { existsSync, mkdirSync } from "fs";
import { countAttachedTerminalSessions } from "../routes/terminal";
import { createAgentWorktree, worktreeReadyMs } from "../services/worktree-for-agent";
import { mainRedStop, realMainCiPort } from "../services/main-ci-watch";
import { createTaskDispatcher } from "../services/task-dispatcher";
import { dispatcherLogLine } from "../services/task-dispatcher-support";
import { budgetSample, computeDispatchCapacity } from "../services/dispatch-capacity";
import { createDispatchResourceBlockFromInputs } from "../services/dispatch-memory-inputs";
import { fleetLoadSync, fleetSessionCoreUnits } from "../lib/fleet-usage";
import { cardLiveTreeGB, cardMemPeakGB, recentCardMemPeaksGB } from "../lib/card-memory-peaks";
import { machineCores } from "../lib/machine-cores";
import { worktreeRealDirt } from "../services/task-automerge";
import { branchStatusFromRepo, worktreeDiffStat } from "../services/branch-status";
import { createDetachedTopic } from "../lib/session-control-core";
import { buildProjectCandidates, canonicalProjectFor, resolveProjectPath } from "../services/project-path-resolver";
import { worktreeRootDir } from "../services/worktree-manager";
import { getDefaultProviderName, tryGetProvider, resolveTurnAlive } from "../providers";
import { readNativeUsage } from "../providers/native-usage-registry";
import { automaticDispatchHooks } from "../services/task-auto-model";
import { dispatchTopicBinding, resolveDispatchTopicIdentity } from "../services/dispatch-topic-identity";
import { commandWakeState, stopCardCommandProcesses } from "../routes/processes";
import { subagentWakeOwed } from "../lib/subagent-runtime";
import { defaultLifecycleHooks } from "../services/lifecycle-hooks";
import { resolveAgentRuntime } from "../services/app-settings";
import { totalmem as osTotalmem } from "node:os";
import { readDelegatedNodeToken } from "../services/node-client";
import { appendDelegatedRunAudit, delegatedPolicyForTask } from "../lib/delegated-agent-start";
import { isCloudBaseUrl, resolveGithubSlug } from "../providers/claude-cloud/node";
import { bundleBranchForNode, ensureBranchOnOrigin } from "../services/branch-on-origin";
import { repoIdentity } from "../lib/git-identity";
import { githubOriginFrom, overflowMachinesFrom } from "../services/dispatch-overflow";
import { NODE_BREAKERS_FILE, persistNodeBreakers } from "../services/wake-breaker";
import { TURN_ERROR_PREFIX } from "../../shared/board";
import type { AfterHeadlessTurns } from "./scope";
import { late } from "./late";
import { isThisServerPrimary } from "../lib/primary-role";
import { sessionHasOpenQuestion } from "../lib/question-outlives-asker";
import { decodeCol } from "../../shared/message-blob";

/** Project id -> GitHub owner/repo, filled by the overflow's origin lookup: the cloud's per-repository refusals are read through it. */
const projectSlugs = new Map<string, string>();

export function bootDispatcher(scope: AfterHeadlessTurns) {
  const { DISPATCH_AUTONOMY, DISPATCH_WORKSPACE_DIR, abortHeadlessTurn, activeStreams, agentWorktreeDeps, claudeSessionTracker, cloudEnabled, cloudNode, ctx, deliveryIsOnMain, dispatchExtraPaths, dispatchMemoryInputs, dispatchUsageReader, dispatcherSvc, externalSessions, liveTurnOwner, memSignal, memoryOwners, nodeBranchPlanter, nodeClient, projectPathForNode, remoteNodeRoad, retirementConsequences, runHeadlessReattach, runHeadlessTurn, scheduleEngine, tickScheduledCards, announceTick, taskAttemptStore, turniInVolo, worktreeGc } = scope;
  // Before the first tick: a node whose breaker was open stays out after the restart every land of server/ causes.
  persistNodeBreakers(join(ctx.STATE_DIR, NODE_BREAKERS_FILE));
  const taskDispatcher = createTaskDispatcher({
    isActive: isThisServerPrimary,
    stopCardProcesses: stopCardCommandProcesses,
    captureDelivery: (taskId) => late.capturaConsegna ? late.capturaConsegna(taskId) : Promise.resolve(false),
    measureDelivery: (taskId) => late.misuraConsegnaNodo ? late.misuraConsegnaNodo(taskId) : Promise.resolve(),
    uncommittedInWorktree: (taskId) =>
      late.sondaLavoroNonCommittato ? late.sondaLavoroNonCommittato(taskId) : Promise.resolve(null),
    svc: dispatcherSvc,
    delegatedPolicyForTask: (taskId) => delegatedPolicyForTask(ctx.db, taskId, Date.now(), ctx.machineStore.upsertLocal().id),
    isDelegatedTask: (taskId) => {
      try { return !!ctx.db.query("SELECT 1 FROM delegated_node_runs WHERE run_id = ?").get(taskId); }
      catch { return false; }
    },
    recordDelegatedPhase: (input) => appendDelegatedRunAudit(ctx.db, input, {
      canonicalLocalMachineId: ctx.machineStore.upsertLocal().id,
    }),
    abortTurn: abortHeadlessTurn,
    // Self-heal dead bindings: a todo task linked to a topic that was reaped
    // (agent tab deleted after a prior run) would never dispatch. tick() clears
    // the dead link so the task runs again.
    topicExists: (id) => !!ctx.getTopicById(id),
    // Which runtime a selection resolves to, whether an unconstrained Auto task
    // has a runtime that is not held, and the automatic pick itself (AGPT-01).
    // Built in task-auto-model.ts, where the dispatcher tests drive the same hooks.
    ...automaticDispatchHooks({
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy like the `await import` of the same module at boot: static, it would move the snapshot manager (and the provider registry it imports) up the boot's module order
      snapshot: () => (require("../providers/snapshot-manager") as typeof import("../providers/snapshot-manager")).getSnapshotManager().getSnapshot(),
      getProvider: tryGetProvider,
      log: (message) => console.log(dispatcherLogLine(message)),
    }),
    setTopicRouting: (id, topicsRouting) => {
      const topic = ctx.getTopicById(id);
      if (!topic || topic.topicsRouting != null) return;
      topic.topicsRouting = topicsRouting;
      ctx.saveSingleTopic(topic);
    },
    topicModelSelection: (id) => {
      const topic = ctx.getTopicById(id);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy like the `await import` of the same module at boot: static, it would move the snapshot manager (and the provider registry it imports) up the boot's module order
      return topic ? dispatchTopicBinding(topic, getDefaultProviderName(), (require("../providers/snapshot-manager") as typeof import("../providers/snapshot-manager")).getSnapshotManager().getSnapshot()) : null;
    },
    // Il cancello contro il lavoro rifatto: se il commit della consegna è già
    // dentro main, la card si chiude invece di far ripartire un agente sopra
    // codice che c'è già. Stessa risposta che legge l'audit degli atterraggi.
    deliveryLanded: (repoPath, commit) => deliveryIsOnMain(repoPath, commit),
    // The empty-node-run guard reads THIS machine's checkout, same resolver the cloud node lane
    // already uses for its own repo lookup (`dispatch-prep.ts`, `cloudNode`).
    mainIsRed: async (repoPath) => (await mainRedStop(realMainCiPort(repoPath))) !== null,
    repoPathOfTask: (taskId) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      return projectId ? projectPathForNode(projectId) ?? null : null;
    },
    // Must match the catch-all dir tasks.ts scaffolds (join(workspaceDir,
    // "generale")): a session resolved here renders standalone, not as a project.
    catchAllProjectPath: join(DISPATCH_WORKSPACE_DIR, "generale"),
    // Private per-task cwd for a catch-all task: a unique dir under the workspace
    // so the task's topic gets a unique projectPath (→ its own splittable
    // workspace claims the agent's browser panes). Non-git, like the shared
    // catch-all dir, so the worktree guard behaves identically.
    catchAllTaskDir: (taskId) => {
      const dir = join(DISPATCH_WORKSPACE_DIR, "tasks", taskId.slice(0, 8));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    // Auto concurrency cap: live machine capacity for boards on `maxAgentsAuto`.
    //
    // I turni in volo vanno passati: il freno vivo è un credito (budget di CPU
    // della flotta meno quello che gli agenti vivi già bruciano), e senza sapere
    // quanti sono si sottrarrebbe il loro costo dal tetto TOTALE invece che dai
    // posti residui. Letto dentro la closure, non alla costruzione: il dispatcher
    // esiste solo dopo questa chiamata.
    recommendedCap: () => computeDispatchCapacity(turniInVolo()).recommended,
    // The cap "by resources": load, cores, memory and the turns in flight, from
    // the SAME reading the auto cap and the night mode use. One probe for three
    // readers, or the settings panel could draw a load the gate did not decide on.
    // The runtime flag only shapes `recommended` (which this reader ignores); it
    // is passed anyway so the reading is the one the panel gets from the route.
    budgetSample: () => {
      try {
        // The lowest reading of the window, not the instant: the budget axis
        // reserves every local turn's price against it (`null` while measuring,
        // and the floor holds meanwhile).
        return budgetSample(
          fleetLoadSync(),
          memSignal.held().heldGB,
          machineCores(),
          osTotalmem() / 1e9,
          turniInVolo(),
        );
      } catch { return null; }
    },
    // What the last agents really cost, read from the per-session CPU the fleet
    // probe already attributes: a price list measured on this machine beats a
    // constant, and the median of it beats the mean (one delivery running four
    // shards would otherwise price every future agent as if it were that one).
    agentCostSamples: () => {
      try { return fleetSessionCoreUnits(); } catch { return []; }
    },
    // The same price list in gigabytes, and it is priced per CARD: the peak of
    // the process tree of each card's pre-review checks. The per-session
    // footprint it used to read cannot see a native card, whose tools and checks
    // are children of this server (server/lib/card-memory-peaks.ts).
    agentMemSamples: () => {
      try { return recentCardMemPeaksGB(); } catch { return []; }
    },
    cardCheckPeakGB: cardMemPeakGB,
    cardLiveTreeGB,
    ...dispatchMemoryInputs,
    // Corse di check pre-review in volo: ogni barra vale uno slot nel freno.
    // Letto dalla closure: il checksGate nasce dentro `createTasksRouter`, che e'
    // dopo questa chiamata, ma prima del primo tick o resume. Zero finche' non
    // esiste: stesso pattern di `capturaConsegna`.
    checksRunning: () => late.checksGateRunningCount?.() ?? 0,
    checksOffLane: (taskId) => late.checksGateIsOffLane?.(taskId) ?? false,
    // Don't drop an agent into a repo somebody is already working by hand.
    externalSessionsAt: (path) =>
      externalSessions.activeAt(path).map((s) => ({ cwd: s.cwd, branch: s.branch })),
    resolveProject: (projectId) => {
      const found = resolveProjectPath(
        projectId,
        buildProjectCandidates({
          projectStore: ctx.projectStore,
          workspaceDir: DISPATCH_WORKSPACE_DIR,
          extraPaths: dispatchExtraPaths,
        }),
      );
      if (!found) return null;
      // A worktree is never a project: a card keyed by a worktree folder (or by
      // an alias of the repo) dispatches on the project that owns the repository,
      // so the auto-registration below cannot mint a board out of a checkout.
      const owner = canonicalProjectFor(found.path, ctx.projectStore.list(), {
        worktreeOwner: (abs) => ctx.worktreeStore.getByAbsPath(abs)?.projectId ?? null,
        worktreeRoot: worktreeRootDir(),
      });
      const c = owner && owner.id !== found.projectStoreId
        ? { path: owner.path, projectStoreId: owner.id }
        : found;
      // Worktrees require a ProjectStore row. Ad-hoc projects (path-only
      // candidates) that are git repos get registered on demand, so the default
      // "isola in un worktree" board setting actually works for them instead of
      // parking every task with "progetto non registrato".
      let storeId = c.projectStoreId;
      if (!storeId && existsSync(join(c.path, ".git"))) {
        try {
          const existing = ctx.projectStore.getByPath(c.path);
          if (existing) {
            storeId = existing.id;
          } else {
            const name = basename(c.path);
            let slug = ctx.projectStore.slugify(name);
            // Slug is UNIQUE; a same-named project at another path gets a suffix.
            if (ctx.projectStore.getBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`.slice(0, 64);
            storeId = ctx.projectStore.create({ name, slug, path: c.path }).id;
            console.log(dispatcherLogLine(`auto-registered project "${name}" (${c.path}) for worktree dispatch`));
          }
        } catch (err) {
          console.error(`[dispatcher] project auto-register failed for ${c.path}`, err);
        }
      }
      return { path: c.path, projectStoreId: storeId };
    },
    createTopic: (o) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy like the `await import` of the same module at boot: static, it would move the snapshot manager (and the provider registry it imports) up the boot's module order
      const { getSnapshotManager } = require("../providers/snapshot-manager") as typeof import("../providers/snapshot-manager");
      const snapshot = getSnapshotManager().getSnapshot();
      // AICTRL-01: ON e' instradamento, non identita'. Bersaglio e switch restano scritti sul topic, chi esegue lo decide `resolveTopicProvider` a ogni turno. allow-italian: la regola che questa chiamata applica
      const { provider, model, topicsRouting, executor } = resolveDispatchTopicIdentity(o, snapshot);
      // Si verifica chi ESEGUE: con ON il bersaglio non parte, e pretenderne la CLI collegata bloccherebbe task sani. allow-italian: perche' il controllo e' su `executor`
      if (executor && !tryGetProvider(executor)?.connected) {
        throw new Error(`Provider "${executor}" non disponibile: collegalo da «Provider e chiavi», in fondo al selettore del modello, prima di avviare il task.`);
      }
      const { topic } = createDetachedTopic(
        // background: an agent session never pops a tab — it lives in the
        // sidebar; the task drawer's "apri tab" un-archives it on demand.
        { name: o.name, projectPath: o.projectPath, worktreeId: o.worktreeId, systemPrompt: o.systemPrompt, effort: o.effort, model, provider, topicsRouting, background: true, standalone: o.standalone, mcpPolicy: o.mcpPolicy, autonomyLevel: o.autonomyLevel ?? DISPATCH_AUTONOMY },
        {
          getTopicById: ctx.getTopicById,
          loadTopics: ctx.loadTopics,
          saveSingleTopic: ctx.saveSingleTopic,
          slugify: ctx.slugify,
          broadcastToAll: ctx.broadcastToAll,
        },
      );
      return { topicId: topic.id, sessionKey: topic.sessionKey };
    },
    // ── Fan-out (dispatchFanOut > 1) ─────────────────────────────────────────
    // Le quattro dipendenze che trasformano "un agente" in "N tentativi": dove si
    // scrivono le righe, come si misura cosa ha prodotto ognuno, come si chiama il
    // suo branch, e come si spegne la chat di un perdente. Assenti ⇒ il dispatcher
    // resta al path storico, un agente per task.
    attempts: taskAttemptStore,
    attemptStats: async (worktreeId) => {
      const wt = ctx.worktreeStore.get(worktreeId);
      if (!wt || wt.mode !== "branch" || !wt.absPath || !existsSync(wt.absPath)) return null;
      // Il branch va DETTO: è la chiave con cui si separa il lavoro del tentativo
      // da quello che ha soltanto ereditato dal checkout condiviso.
      return worktreeDiffStat(wt.absPath, { branch: wt.branchName ?? undefined });
    },
    worktreeBranch: (worktreeId) => ctx.worktreeStore.get(worktreeId)?.branchName ?? null,
    // Potatura dei topic dei tentativi a fine task. Passa dal servizio condiviso,
    // non da una terza implementazione: qui si archiviava e basta, e ogni task
    // dispacciato lasciava dietro un badge di non letti su una conversazione non
    // più apribile e un id fantasma in `ui_state` che risuscitava al reload.
    archiveTopic: (topicId) => retirementConsequences.archiveTopic(topicId, "task-release"),
    // Il pavimento sulle risorse, misurato sul volume che ospita davvero le
    // worktree. Serve da quando il tetto sugli agenti si può togliere: senza,
    // «nessun limite» vuol dire che la coda si ferma a disco pieno, cioè quando
    // le scritture del DB cominciano a fallire.
    // Il pavimento di RAM dipende da COSA costa un agente, e questa è l'unica
    // riga che lo sa: `cli` significa un processo Node per sessione (240-420 MB,
    // margine 12 GB), il runtime nativo significa un array di messaggi dentro
    // questo stesso server (2,3 MB misurati, margine 2 GB). Tenere il margine
    // delle CLI per agenti che non sono processi ferma la coda su una macchina
    // che sta benissimo — osservato il 2026-08-16 con 8,7 GB liberi.
    //
    // Si rilegge a ogni tick invece di fissarlo al boot: chi cambia runtime in
    // Impostazioni si aspetta che valga da subito, e questa lettura costa una
    // riga di SQLite già in cache.
    // `hold` is the dispatcher's: the price of one card, the memory kept for the
    // turns in flight, and whether any of our work is on the machine.
    resourceBlock: createDispatchResourceBlockFromInputs({
      worktreesPath: () => ctx.worktreeManager.worktreesDir(),
      inputs: dispatchMemoryInputs,
      memoryOwners: () => memoryOwners.latest(),
    }),
    // Il ramo di una card nasce da MAIN, non dall'HEAD del checkout condiviso, e
    // da qui in poi la stessa nascita la usa anche un sotto-agente isolato
    // (WORKTREE-14): il corpo sta in `worktree-for-agent.ts`, il perché del
    // ripiego su HEAD in `worktree-base-ref.ts`.
    createWorktree: (projectStoreId, opts) =>
      createAgentWorktree(agentWorktreeDeps("dispatch"), projectStoreId, worktreeReadyMs(), opts),
    worktreeSetupResult: (worktreeId) => ctx.worktreeManager.setupResult(worktreeId),
    deleteWorktree: async (worktreeId) => { await ctx.worktreeManager.delete(worktreeId); },
    // C'e' qualcosa da perdere in questo worktree? Serve al dispatcher per NON
    // cancellare il branch di un tentativo rimesso in coda che pero' aveva gia'
    // committato (turno troncato dall'infrastruttura dopo il commit: il task
    // torna in `todo`/`backlog` e il cleanup portava via anche i commit).
    //
    // Due domande, entrambe: commit non su main (letti per CONTENUTO, quindi
    // reggono anche a un land in squash) e sporco reale nell'albero (junk
    // escluso). In caso di dubbio si risponde SI': non sapere non autorizza a
    // distruggere.
    // Carico vivo per la modalità notturna. Stessa fonte del tetto "Auto", così
    // le due decisioni non possono divergere leggendo due misure diverse.
    capacity: () => {
      const c = computeDispatchCapacity(turniInVolo(), undefined, resolveAgentRuntime() === "cli");
      return { load1: c.load1, cores: c.cores, reason: c.reason };
    },
    // Il carico che è NOSTRO, per il freno dei task pesanti. Non è un'altra
    // lettura di `capacity()`: quello è il load average della macchina intera, e
    // la notte del 12/08 su questo host valeva fra 37 e 48 mentre i nostri agenti
    // usavano 0,75% su 1200% di CPU. Il carico erano le app dell'umano, e il freno
    // le addebitava a noi tenendo ferma la board per ore.
    ownLoad: () => {
      try { return fleetLoadSync(); } catch { return null; }
    },
    // Sessioni di terminale con un client ATTACCATO: è il segnale «c'è qualcuno».
    // Una sessione viva ma senza nessuno che la guarda non conta come presenza —
    // altrimenti un agente dimenticato terrebbe il turno notturno bloccato.
    humanSessionsLive: () => {
      try { return countAttachedTerminalSessions(); } catch { return 0; }
    },
    worktreeHasWork: async (worktreeId) => {
      const wt = ctx.worktreeStore.get(worktreeId);
      if (!wt) return false;               // riga sparita: non c'e' nulla da tutelare
      if (wt.mode !== "branch") return false; // niente branch proprio, niente commit da perdere
      try {
        if (wt.absPath && existsSync(wt.absPath)) {
          const dirt = await worktreeRealDirt(wt.absPath);
          if (dirt.length > 0) return true;
        }
        if (!wt.branchName) return false;
        const repoPath = ctx.projectStore.get(wt.projectId)?.path;
        if (!repoPath) return true;        // non so leggere il repo -> tutelo
        return (await branchStatusFromRepo(repoPath, wt.branchName)) === "unmerged";
      } catch {
        return true;
      }
    },
    runTurn: runHeadlessTurn,
    hasOpenQuestion: (sessionKey) => sessionHasOpenQuestion(ctx, sessionKey, decodeCol),
    // ai-bridge restart recovery: the provider answers whether a turn survived in
    // the broker (returns false when the flag is off / provider lacks it), and
    // runHeadlessReattach drives the adopted turn. Both are safe no-ops off-broker.
    hasLiveSession: async (sessionKey) => (await liveTurnOwner(sessionKey)) !== null,
    reattach: async (sessionKey, opts) => runHeadlessReattach(sessionKey, opts, (await liveTurnOwner(sessionKey)) ?? "claude-code", { dispatched: true }),
    // Liveness net: is the agent CHILD of this session still there? Same probe the
    // stream watchdog uses to tell a thinking-but-mute turn from a dead one (it
    // covers direct AND broker mode — the daemon's `exit` frame flips pp.alive).
    // A provider that doesn't own the session answers null = "can't tell", and the
    // dispatcher never buries a turn on ignorance.
    //
    // Si chiede al provider che POSSIEDE la sessione, non sempre a claude-code.
    // Chiedere a lui di una sessione altrui otteneva `false` — «l'ho guardato ed
    // è morto» invece di «non è roba mia» — e sul `false` il dispatcher
    // seppellisce dopo due sweep. Finché ogni agente dispacciato era claude-code
    // i due casi coincidevano; col runtime `jcode` di default ogni sessione
    // dispacciata è di un altro provider, quindi la confusione passa da
    // impossibile a sistematica. Vedi `resolveTurnAlive`.
    isTurnAlive: (sessionKey) => resolveTurnAlive(sessionKey),
    // A card whose turn ends on a `run_command` waits for its wake, as a goal does
    // (`goal-continuation.ts`), and for the turn that wake opens.
    awaitsCommandWake: (sessionKey) => commandWakeState(sessionKey) !== "none",
    // The same for a `spawn_agent` child: the kickoff tells the card agent its result wakes the session.
    awaitsSubagentWake: (sessionKey) => subagentWakeOwed(sessionKey),
    isSessionBusy: (sessionKey) => activeStreams.has(sessionKey),
    // After a restart that wait starts again from the session's last row, not
    // from the boot: this machine reloads the server at every save in server/.
    lastSessionRowAt: (sessionKey) => {
      const row = ctx.db.query(
        "SELECT timestamp, streamed_at FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1",
      ).get(sessionKey) as { timestamp?: string | null; streamed_at?: string | null } | null;
      const times = [row?.timestamp, row?.streamed_at].map((v) => Date.parse(v ?? "")).filter(Number.isFinite);
      return times.length ? Math.max(...times) : null;
    },
    // THE REMOTE LANE (KANBAN-76, KANBAN-77): where a paired node answers, the
    // device token this machine holds for it, and the branch its bundle becomes
    // in this checkout.
    //
    // The token is read from disk at every call and never cached here: a machine
    // deleted from the board, or a token file removed by hand, has to STOP being
    // usable at once, and a copy held in a closure would keep the node reachable
    // long after somebody decided it should not be.
    // The «Cloud Claude» machine is a node too: same lane, but its four calls go to the
    // Claude Code sessions API (`providers/claude-cloud/node.ts`), never to a paired Topics.
    node: {
      createRun: (input) => isCloudBaseUrl(input.baseUrl) ? cloudNode.createRun(input) : nodeClient.createRun(input),
      readRun: remoteNodeRoad.readRun,
      fetchBundle: (input) => isCloudBaseUrl(input.baseUrl) ? cloudNode.fetchBundle(input) : nodeClient.fetchBundle(input),
      cancelRun: remoteNodeRoad.cancelRun,
      baseUrlOf: remoteNodeRoad.baseUrlOf,
      tokenOf: remoteNodeRoad.tokenOf,
      delegatedTokenOf: (machineId, capabilityId) =>
        readDelegatedNodeToken(ctx.STATE_DIR, machineId, capabilityId),
      nameOf: (machineId) => ctx.machineStore.get(machineId)?.name ?? null,
      localMachineId: () => ctx.machineStore.upsertLocal().id,
      originUrlOf: (projectId) => nodeBranchPlanter.originUrlOf(projectId),
      // The same checkout the planter reads origin from: the node must sign the
      // run's commits with it, or the land (LAND-13) refuses them as a foreign author.
      gitIdentityOf: (projectId) => {
        const path = projectPathForNode(projectId);
        return path ? repoIdentity(path) : Promise.resolve(null);
      },
      // The Claude cloud signs its own branch: no checkout identity to pass or to require.
      skipsGitIdentity: (baseUrl) => isCloudBaseUrl(baseUrl),
      plantBranch: (input) => nodeBranchPlanter.plantBranch(input),
      // A card that already has a branch carries it to the node: pushed first,
      // from this machine's checkout (`branch-on-origin.ts`).
      ensureBranchOnOrigin: ({ projectId, branch }) => ensureBranchOnOrigin(projectPathForNode(projectId), branch),
      // A node that cannot reach origin gets the same branch as a bundle with the run.
      bundleBranch: ({ projectId, branch }) => bundleBranchForNode(projectPathForNode(projectId), branch),
      // The `node-run` hook starts in the project's checkout on this machine,
      // the same path the planter reads the origin from and plants into.
      projectPathOf: projectPathForNode,
    },
    // THE OVERFLOW (`dispatch-overflow.ts`): where a card held by this Mac's
    // memory floor can go. The cloud has no heartbeat: it is there while its
    // login is; a paired node only while its heartbeat says online.
    // Cloud Claude clones only from GitHub: the overflow asks before choosing it.
    githubOriginOf: async (projectId) => {
      const origin = await nodeBranchPlanter.originUrlOf(projectId);
      const slug = origin ? await Promise.resolve(resolveGithubSlug(origin)).catch(() => null) : null;
      if (slug) projectSlugs.set(projectId, slug); else projectSlugs.delete(projectId);
      return githubOriginFrom(origin, resolveGithubSlug);
    },
    cloudRefusesProject: (projectId) => {
      const slug = projectSlugs.get(projectId);
      return !!slug && cloudNode.repoRefused(slug);
    },
    // The cloud row is online only while the account has an active cloud
    // environment (the heartbeat asks, `tickHeartbeat`); a node asleep is still a
    // choice when a `node-run` hook is there to wake it.
    overflowMachines: () => overflowMachinesFrom({
      rows: ctx.machineStore.list(),
      isCloud: isCloudBaseUrl,
      cloudEnabled,
      environmentOk: cloudNode.environmentReady()?.ok ?? null,
      wakeable: defaultLifecycleHooks().declares?.("node-run") ?? false,
    }),
    // Usage consumed by the dispatched session so far, from its Claude Code
    // transcript (jsonl_path is kept fresh by the session tracker). The reader
    // (transcript-usage.ts) is incremental (per-path byte offset — the live
    // ticker polls every 4s) and DEDUPLICATES usage rows by message.id (Claude
    // Code writes one per content block; the old inline sum overcounted ~2.4x).
    // Best-effort — a missing/unparsable transcript reads as zeros, and the
    // dispatcher only books per-turn deltas.
    //
    // LE FIGLIE SONO DENTRO. Il coordinatore delega il lavoro a sessioni proprie,
    // e il loro consumo è consumo DI QUESTA CARD: senza sommarlo, la card che
    // spende di più risulterebbe la più economica. Vedi dispatch-usage.ts, che
    // tiene anche il ledger delle figlie ormai chiuse (una somma sulle sole vive
    // scenderebbe, e un calo il dispatcher lo appiattisce a zero).
    // IL NATIVO PRIMA, IL TRANSCRIPT COME RIPIEGO — e l'ordine e' il punto.
    // `dispatchUsageReader` legge i JSONL di Claude Code; il runtime nativo gira
    // in processo e non ne scrive nessuno, quindi per lui quel lettore rispondeva
    // sempre zero. Misurato il 18/08: 43 card con turni registrati e costo zero,
    // cioe' tutte quelle lavorate dal nativo. `readNativeUsage` torna `null` (non
    // zero) quando il nativo non ha mai girato su quella sessione: e' cio' che
    // lascia intatto il ripiego per le sessioni CLI.
    getSessionUsage: (sessionKey: string) => readNativeUsage(sessionKey) ?? dispatchUsageReader.read(sessionKey),
    // What the session is running RIGHT NOW, for the card's «Bash · bun run
    // test:unit · 3m» line. The tracker learns it from the CLI hooks (PreToolUse
    // sets `lastTool`, PostToolUse clears it); a runtime that posts no hooks
    // reads as `null`, and the card simply draws no line.
    sessionActivity: (sessionKey: string) => {
      const s = claudeSessionTracker.getSessionByKey(sessionKey);
      return s?.lastTool ? { name: s.lastTool.name, input: s.lastTool.input, since: s.lastTool.startedAt } : null;
    },
    // Last assistant prose in the session — the dispatcher mirrors it into a task
    // comment at delivery when the agent forgot comment_task, so a review always
    // carries the agent's own summary. Reads the local message store (sync).
    getLastAgentText: (sessionKey: string) => {
      try {
        const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false });
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== "assistant" || typeof m.content !== "string") continue;
          const testo = m.content.trim();
          if (!testo) continue;
          // UN CARTELLO NON SONO LE PAROLE DELL'AGENTE.
          //
          // Questo recupero esiste per una ragione precisa: quando un turno
          // muore prima che l'agente possa commentare, il dispatcher rispecchia
          // la sua ultima prosa nel thread della card, cosi' chi rivede legge
          // "cosa ho fatto" invece di una nota di sistema. Ma prendeva l'ultimo
          // messaggio assistente QUALUNQUE FOSSE — e quando il turno muore, il
          // messaggio piu' recente e' proprio il cartello che ne annuncia la
          // morte: «⚠️ Turno interrotto da un riavvio del server…».
          //
          // Misurato sulla card 235afe11 (20/08): sotto quel cartello c'erano le
          // parole vere dell'agente, ma il recupero si fermava alla prima riga e
          // portava il cartello — cioe' rispecchiava sulla card l'annuncio del
          // guasto al posto del lavoro. La card e' arrivata in review muta con il
          // testo buono a due righe di distanza.
          //
          // I cartelli sono quelli che il client riconosce col prefisso ⚠️
          // (`turnError.ts`): li si SALTA e si continua a scendere, perche' sotto
          // c'e' quasi sempre la prosa che stiamo cercando.
          if (testo.startsWith(TURN_ERROR_PREFIX)) continue;
          // The ID comes back with the words: the note that mirrors them is a
          // card comment, and its anchor has to be the row it quotes, not the
          // last row of the session.
          return { text: m.content, id: m.id };
        }
      } catch { /* best-effort — no mirror on failure */ }
      return null;
    },
    // Review-ready previews: on delivery to review, boot a live preview server
    // from the task's worktree and point output_url at the local deep-link (never
    // prod). Lazy — reads `previewManager` when a turn actually reaches review.
    preparePreview: (taskId) => late.previewManager?.prepareForReview(taskId) ?? Promise.resolve(),
    teardownPreview: (taskId) => late.previewManager?.teardown(taskId) ?? Promise.resolve(),
    // Consegnata la card, il suo worktree smette di pesare per le dipendenze: via
    // `node_modules` e le cache di build, restano cartella, branch e commit. È il
    // momento giusto perché la maggior parte delle card NON landa subito, e sono
    // proprio i giorni di attesa in review a costare ~260 MB l'una.
    slimWorktree: (taskId) => worktreeGc.slimWorktreeOfTask(taskId),
    broadcast: ctx.broadcastToAll,
  });
  late.taskDispatcher = taskDispatcher;

  const scheduledCardsTimer = scheduleEngine.start(isThisServerPrimary, announceTick);
  // A command that was running when the server stopped is read again now, not 15 s from now (R12).
  if (isThisServerPrimary()) tickScheduledCards();

  return { scheduledCardsTimer, taskDispatcher };
}
