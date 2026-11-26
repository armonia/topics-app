/**
 * Everything the task dispatcher is built from: the task service, delivery hooks, node and cloud clients, memory signals.
 */
import { createLandingQueue } from "../services/landing-queue";
import { join } from "path";
import { branchAheadOfMain } from "../services/own-branch";
import { resolveStateDir } from "../lib/data-dir";
import { createSwapFreezeLedger, fileLedgerIo, thawLedgerAtBoot } from "../services/swap-freeze-ledger";
import { createMemoryPressureSignal } from "../services/memory-pressure";
import { readStartTimes } from "../lib/process-snapshot";
import { existsSync } from "fs";
import { setTerminalMemPressure, setChildAdmissionPreview, liveTerminalCwds } from "../routes/terminal";
import { createTaskService, projectIdForPath } from "../services/tasks";
import { configureChannelOriginCards } from "../lib/channel-origin-cards";
import { createCardAction } from "../schedule/card-action";
import { createScheduledCardsService } from "../schedule/cards-service";
import { createScheduleEngine, type TickResult } from "../schedule/engine";
import { createCommandAction } from "../schedule/command-action";
import { createRegistryRunner } from "../schedule/command-runner";
import { createJobsService } from "../schedule/jobs-service";
import { createScheduleDelivery } from "../schedule/deliver/wiring";
import { recordSubjectNotice } from "../attention/owner-notices";
import { jobSubject } from "../../shared/attention";
import { createExternalSessionsService } from "../services/external-sessions";
import { type AgentWorktreeDeps } from "../services/worktree-for-agent";
import { isChecksHold as isChecksHoldOf } from "../services/checks-lights";
import { availableMemGB, probeVm, setAvailableMemReader } from "../services/dispatch-capacity";
import { createMemSignal, fileMemSampleStore } from "../services/mem-signal";
import { OUR_APP_MARKERS } from "../services/memory-owners";
import { createMemoryOwnersReader } from "../services/memory-owners-probe";
import { createDispatchMemoryHistory } from "../services/dispatch-memory-history";
import { createDispatchMemoryInputs } from "../services/dispatch-memory-inputs";
import { freezableRuns } from "../services/budget-governor";
import { makeSheetWriter } from "../services/delivery-sheet";
import { listOwnedScripts } from "../routes/processes";
import { commitStatusFromRepo } from "../services/branch-status";
import { createTaskAttemptStore } from "../services/task-attempts";
import { classifyLanding } from "../services/landing-audit";
import { createTranscriptUsageReader } from "../services/transcript-usage";
import { createDispatchUsageReader } from "../services/dispatch-usage";
import { setTranscriptUsageReader } from "../services/session-consumption-wiring";
import { DETACHED_TOPIC_AUTONOMY } from "../lib/session-control-core";
import { buildProjectCandidates, resolveProjectPath } from "../services/project-path-resolver";
import { SERVER_VERSION } from "../ws-capabilities";
import { resolveAgentRuntime } from "../services/app-settings";
import { createWorktreeGcRunner } from "../services/worktree-gc-runner";
import { createWorktreeOfTask } from "../services/task-worktree";
import { ownedWorktreeRoots } from "../services/worktree-root";
import { hostname as osHostname } from "node:os";
import { createNodeClient, readNodeToken } from "../services/node-client";
import { createNodeBranchPlanter } from "../services/node-branch-plant";
import { projectPathOfAnyId } from "../lib/project-identity";
import { CloudApi } from "../providers/claude-cloud/api";
import { credentialsFor } from "../providers/claude-cloud/creds";
import { recordSystemNotice } from "../attention/system-notices";
import { CLOUD_NODE_BASE_URL, CLOUD_NODE_HOST, CLOUD_NODE_NAME, CLOUD_NODE_TOKEN, cloudCredentialsPresent, createCloudNodeClient, isCloudBaseUrl } from "../providers/claude-cloud/node";
import type { AfterRouters1 } from "./scope";
import { late } from "./late";

export function bootDispatchPrep(scope: AfterRouters1) {
  const { DISPATCH_WORKSPACE_DIR, activeStreams, broadcastToAll, claudeSessionTracker, ctx, db, dispatchExtraPaths, rootDir } = scope;
  // The repository a delivery report is checked against: the agent's worktree
  // (a cited file may exist only on the delivery branch), else the repository
  // the topic worked in, else the board's project. Until 2026-09-04 every report
  // was checked against THIS checkout, so a dancerooms commit was "in no ref"
  // and a new file on a branch "not tracked". One resolver, handed to BOTH task
  // services: the dispatcher's and the router's, which is the one an agent's
  // update_task(status="review") actually reaches.
  const repoRootForCard = ({ projectId, assignedTopicId }: { taskId: string; projectId: string | undefined; assignedTopicId: string | null }): string | null => {
      try {
        if (assignedTopicId) {
          const row = ctx.db.prepare("SELECT worktree_id, project_path FROM topics WHERE id = ?").get(assignedTopicId) as { worktree_id?: string | null; project_path?: string | null } | undefined;
          const wt = row?.worktree_id ? ctx.worktreeStore.get(row.worktree_id) : null;
          if (wt?.absPath && existsSync(wt.absPath)) return wt.absPath;
          // The worktree may already be reaped (a land, a restart): the topic
          // still knows which repository it worked in.
          if (row?.project_path && existsSync(row.project_path)) return row.project_path;
        }
      } catch { /* fall through to the project */ }
      if (!projectId) return null;
      try {
        const c = resolveProjectPath(projectId, buildProjectCandidates({ projectStore: ctx.projectStore, workspaceDir: DISPATCH_WORKSPACE_DIR, extraPaths: dispatchExtraPaths }));
        return c?.path && existsSync(c.path) ? c.path : null;
      } catch { return null; }
    };

  const listKnownDeliveryRepoRoots = (): string[] => {
    const roots = new Set<string>();
    try {
      for (const candidate of buildProjectCandidates({
        projectStore: ctx.projectStore,
        workspaceDir: DISPATCH_WORKSPACE_DIR,
        extraPaths: dispatchExtraPaths,
      })) {
        if (existsSync(candidate.path)) roots.add(candidate.path);
      }
    } catch { /* best-effort source */ }
    try {
      for (const project of ctx.projectStore.list({ archived: true })) {
        if (project.path && existsSync(project.path)) roots.add(project.path);
      }
    } catch { /* best-effort source */ }
    try {
      for (const worktree of ctx.worktreeStore.list()) {
        if (worktree.absPath && existsSync(worktree.absPath)) roots.add(worktree.absPath);
      }
    } catch { /* best-effort source */ }
    return [...roots];
  };

  const dispatcherSvc = createTaskService(ctx.db, {
    writeDeliverySheet: makeSheetWriter(ctx.APP_DATA_DIR),
    repoRootFor: repoRootForCard,
    branchAheadOf: branchAheadOfMain,
    listRepoRoots: listKnownDeliveryRepoRoots,
    onLateDeliveryNote: (taskId, projectId) => {
      const noted = dispatcherSvc.get(taskId, { projectId })?.task;
      if (noted) ctx.broadcastToAll({ type: "task:updated", projectId, task: noted });
    },
  });

  // Cards born from a channel chat follow that chat's turns (97e3951f).
  configureChannelOriginCards(ctx.db, dispatcherSvc);

  const scheduleNow = () => late.scheduledCardTestNow ?? new Date();
  const scheduledCards = createScheduledCardsService(ctx.db, scheduleNow);
  // The command action closes runs through the engine, which is built with the action: the door is read at call time.
  const engineDoor = { closeIfOpen: (...args: Parameters<ReturnType<typeof createScheduleEngine>["closeIfOpen"]>) => scheduleEngine.closeIfOpen(...args) };
  let tickAfterCloseQueued = false;
  const jobRunner = createRegistryRunner();
  const commandAction = createCommandAction(ctx.db, engineDoor, {
    runner: jobRunner,
    projectPath: (projectId) => projectId ? projectPathOfAnyId(ctx.db, (storeId) => ctx.projectStore.get(storeId)?.path, projectId) ?? null : null,
    now: scheduleNow,
    // A job that was waiting on this run restarts right away (R9); never from inside the tick that closed it.
    onClosed: () => {
      if (tickAfterCloseQueued) return;
      tickAfterCloseQueued = true;
      setTimeout(() => { tickAfterCloseQueued = false; tickScheduledCards(); }, 0).unref?.();
    },
  });
  const scheduleDelivery = createScheduleDelivery(ctx.db, scheduleNow);
  const scheduleEngine = createScheduleEngine(ctx.db, {
    executors: { card: createCardAction(ctx.db, dispatcherSvc), command: commandAction.executor }, now: scheduleNow,
    // Outcomes leave the app and failures are counted after every tick (R22 to R24); the sweep never throws into the tick.
    onTick: () => { void scheduleDelivery.delivery.sweep().catch((error) => console.warn("[schedule] delivery sweep failed:", error)); },
  });
  // The registry reports a scheduled command's end; the ones that ended while the server was down close now.
  jobRunner.onEnd((end) => commandAction.ended(end));
  const scheduledJobs = createJobsService(ctx.db, {
    engine: scheduleEngine, now: scheduleNow,
    agentJobMode: () => scheduleDelivery.settings().agentJobs,
    // A job an agent made waits in pause: the person is told on the bell, under the job's own subject (R26).
    onPausedByAgent: (job) => recordSubjectNotice({ subject: jobSubject(job.id), title: `An agent created the job "${job.name}"`, body: "It is paused until you turn it on.", dedupeKey: `agent-job:${job.id}`, lights: false }),
    projectPath: (projectId) => projectPathOfAnyId(ctx.db, (storeId) => ctx.projectStore.get(storeId)?.path, projectId) ?? null,
  });

  /** Announces the cards a tick created, the same way a person's new card is. */
  function announceTick(result: TickResult) {
    for (const taskId of result.created) {
      const task = dispatcherSvc.get(taskId)?.task;
      if (!task) continue;
      ctx.broadcastToAll({ type: "task:created", projectId: task.projectId, task });
      if (task.status === "todo") late.taskDispatcher.onEnterTodo(task.projectId, task.id);
    }
  }

  function tickScheduledCards(): TickResult {
    try {
      const result = scheduleEngine.tick();
      announceTick(result);
      return result;
    } catch (error) { console.warn("[scheduled-jobs] tick failed:", error); }
    return { created: [], skipped: [], started: [] };
  }

  // A delivery note that was waiting on git when the previous process stopped
  // died with it: the deliveries of the last ten minutes that have none are
  // checked again, off the loop like the first time.
  try { dispatcherSvc.recheckRecentDeliveries(new Date(Date.now() - 10 * 60_000).toISOString()); } catch (err) {
    console.warn("[tasks] delivery notes not rechecked at boot:", err);
  }


  // Incremental, dedup-by-message-id usage accounting over Claude Code
  // transcripts (see transcript-usage.ts). One instance: it caches per-path
  // byte offsets so the dispatcher's 4s live ticker stays O(appended bytes).
  const transcriptUsageReader = createTranscriptUsageReader();


  // Lo stesso lettore, ma per una sessione DI TASK: somma le sessioni figlie che
  // il coordinatore ha lanciato, così `tasks.agent_tokens` porta il costo del
  // lavoro e non quello del solo coordinamento (vedi dispatch-usage.ts). Una
  // istanza sola: dentro c'è il ledger che tiene i token delle figlie gia' morte.
  const dispatchUsageReader = createDispatchUsageReader({
    db: ctx.db,
    read: (p) => transcriptUsageReader.read(p),
  });

  // The per-session consumption (load screen, Processes view, card drawer) reads the
  // same reader the dispatcher does, so a session's tokens are one number everywhere.
  setTranscriptUsageReader((sessionKey) => dispatchUsageReader.read(sessionKey));


  // Census of the Claude sessions Topics did NOT start (bare `claude` in a
  // terminal). The dispatcher guard below refuses to drop an agent into a
  // directory somebody is already working in. The tracker roster is the
  // ownership signal — anything it knows is ours, by definition.
  const externalSessions = createExternalSessionsService({
    knownSessionIds: () => claudeSessionTracker.listSessions().map((s) => s.claudeSessionId),
    candidatePaths: () =>
      buildProjectCandidates({
        projectStore: ctx.projectStore,
        workspaceDir: DISPATCH_WORKSPACE_DIR,
        extraPaths: dispatchExtraPaths,
      }).map((c) => c.path),
    projectIdFor: projectIdForPath,
  });


  /**
   * L'autonomia con cui nasce la chat di un agente DISPACCIATO dalla board.
   *
   * Scritta qui, esplicita, e non lasciata al default della colonna — che è la
   * trappola segnata nero su bianco in
   * `openspec/changes/autonomy-level-needs-permission-channel/proposal.md`: «i
   * topic dispatchati dalla board non possono chiedere niente a nessuno; se il
   * mapping si accende con il default di colonna, OGNI dispatch si blocca».
   *
   * Da oggi il canale di permesso esiste, quindi una modalità che chiede non nega
   * più in silenzio: apre un pannello in chat e aspetta. Ottimo per una chat che
   * hai davanti — inservibile per un agente di board, la cui chat nasce chiusa
   * (`background: true`) e che nessuno sta guardando: il pannello resterebbe a
   * schermo in una conversazione mai aperta e il task fermo senza un motivo
   * leggibile sulla board.
   *
   * `yolo` e non `auto-apply`, cioè `bypassPermissions`: un agente di board lavora
   * dentro un worktree isolato e il suo mestiere è ESEGUIRE (protocollo di
   * consegna, CLAUDE.md). Non è un allargamento mascherato: è la stessa cosa che
   * faceva finora — con la differenza che finora funzionava per SBAGLIO, perché a
   * tenere vivi i suoi tool MCP era una riga in un `.claude/settings.local.json`
   * gitignorato del repo, e nelle chat fuori da quel repo gli stessi strumenti
   * morivano muti.
   */
  // Il tier di nascita di un agente dispacciato ha UNA fonte sola, ed è dentro
  // `createDetachedTopic` (DETACHED_TOPIC_AUTONOMY): lì vale anche per un
  // chiamante che se ne dimentichi. Qui resta l'alias storico, non un secondo
  // valore che può divergere da quello.
  const DISPATCH_AUTONOMY = DETACHED_TOPIC_AUTONOMY;


  /**
   * Turni in volo adesso, per chi deve leggerli DENTRO le dipendenze del
   * dispatcher (che a quel punto non esiste ancora). Zero finché non esiste: un
   * conteggio assente vale «nessuno», mai un'eccezione dentro un tick.
   */
  const turniInVolo = (): number => {
    try { return late.taskDispatcher.busyCount(); } catch { return 0; }
  };


  /**
   * Il lavoro consegnato da una card è già dentro main?
   *
   * Si guarda per CONTENUTO (`commitStatusFromRepo` + `classifyLanding`, gli stessi
   * dell'audit degli atterraggi) e non per sola discendenza, perché il land RICOPIA
   * i commit della card (`cherry-pick -C <sha>`) invece di fonderli: dopo un land
   * riuscito il commit di consegna NON è antenato di main, e una risposta basata
   * sull'ancestry direbbe «non atterrato» sul caso normale.
   *
   * `unverifiable` esce `null`, che non è `false`: non aver potuto guardare non è
   * una prova di fallimento, e i due chiamanti ne fanno usi che non perdonano la
   * confusione — uno scioglie un worktree, l'altro CHIUDE una card.
   *
   * Una funzione sola perché le due risposte non possono divergere: se l'audit
   * dice «atterrato» e il dispatcher dice «no», il dispatcher rimanda un agente su
   * lavoro che la board mostra come finito.
   */
  async function deliveryIsOnMain(repoPath: string, commit: string): Promise<boolean | null> {
    const state = classifyLanding(await commitStatusFromRepo(repoPath, commit));
    return state === "unverifiable" ? null : state === "landed";
  }

  /**
   * Is this card's delivery parked on our pre-review checks with NOTHING of ours
   * running for it?
   *
   * Two registries answer it, and neither is the card's own row: the checks gate
   * knows a run is live (running, queued behind another card's lane, or off-lane
   * on the pull request CI), and the governor's registry knows whether a command
   * of that run has actually been spawned. Live run + no spawned command = the
   * round is WAITING - memory floor, release spacing, sustained swap, the gate's
   * queue, the CI poll - and the restart gate may cut it (`cardTurnsHoldingReload`).
   *
   * `checks_state` is deliberately NOT read here, unlike `isChecksHold`: the row
   * says "running" for the whole round, command included, and a stale row after a
   * crash would tell the gate to cut a card that is grinding a test suite.
   */
  function deliveryOnlyWaitsOnChecks(taskId: string): boolean {
    if (!late.checksGateIsRunning?.(taskId)) return false;
    return !freezableRuns().some((run) => run.taskId === taskId);
  }


  /** The live registry answers, not the row: see `services/checks-lights.ts`. */
  function isChecksHold(sessionKey: string): boolean {
    return isChecksHoldOf(db, late.checksGateIsRunning, sessionKey);
  }


  /**
   * Il manager e lo store, vestiti come li chiede `worktree-for-agent.ts`. Un
   * solo posto in cui questo cablaggio esiste, cosi' la nascita del worktree di
   * una card e quella di un sotto-agente isolato non possono divergere; l'unica
   * differenza e' l'etichetta con cui il ripiego su HEAD si annuncia nei log.
   */
  function agentWorktreeDeps(label: string): AgentWorktreeDeps {
    return {
      projectPath: (projectStoreId) => ctx.projectStore.get(projectStoreId)?.path,
      create: (input) => ctx.worktreeManager.create(input),
      awaitMaterialisation: (id, timeoutMs) => ctx.worktreeManager.awaitMaterialisation(id, timeoutMs),
      warn: (reason) => console.warn(`[${label}] ${reason}`),
    };
  }


  const taskAttemptStore = createTaskAttemptStore(ctx.db);


  /**
   * The two halves of the remote lane (KANBAN-76), built once.
   *
   * `nodeClient` is the same one the pairing routes use, with the real fetch and
   * the wall clock. `nodeBranchPlanter` is the only thing here that runs git: it
   * turns a node's bundle into a local branch, and it answers the ORIGIN of a
   * project, which is how the node recognises the repository (its own project
   * id is a hash of a path that does not exist on this machine).
   */
  const nodeClient = createNodeClient({
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    version: SERVER_VERSION,
    hostname: osHostname(),
  });

  // A card carries its BOARD id, the store wants the UUID: resolve either.
  const projectPathForNode = (projectId: string) =>
    projectPathOfAnyId(ctx.db, (storeId) => ctx.projectStore.get(storeId)?.path, projectId);

  const nodeBranchPlanter = createNodeBranchPlanter({
    repoPathOf: projectPathForNode,
  });

  /**
   * The Claude cloud as a node (KANBAN-76 lane): a card on the «Cloud Claude» machine runs in a
   * Claude Code cloud session, and this server only polls it. The machine row exists only where
   * Claude Code's credentials do, so the picker never offers a cloud nobody can reach.
   */
  const cloudNode = createCloudNodeClient({
    api: new CloudApi(credentialsFor(process.env.TOPICS_CLAUDE_CLOUD_ACCOUNT || undefined)),
    repoPathOfTask: (taskId) => {
      const projectId = dispatcherSvc.get(taskId)?.task.projectId;
      return projectId ? projectPathForNode(projectId) ?? null : null;
    },
    statePath: join(ctx.STATE_DIR, "claude-cloud-runs.json"),
    // One notice per cause, in the system notices where the other configuration alerts go.
    notify: (n) => recordSystemNotice({ key: "claude-cloud", cycle: n.key, title: n.title, body: n.body }),
  });

  // ONE road to a node for everything that talks to one: the card lane below and
  // the sub-agent routes (`ctx.remoteNode`). The «Cloud Claude» machine answers on
  // the sessions API with its own token, never on a paired Topics with a token file.
  const remoteNodeRoad = {
    readRun: (input: Parameters<typeof nodeClient.readRun>[0]) => isCloudBaseUrl(input.baseUrl) ? cloudNode.readRun(input) : nodeClient.readRun(input),
    cancelRun: (input: Parameters<typeof nodeClient.cancelRun>[0]) => isCloudBaseUrl(input.baseUrl) ? cloudNode.cancelRun(input) : nodeClient.cancelRun(input),
    // A child never picks the cloud machine as a seat (`childNodeCandidates`,
    // `routes/terminal.ts`): it has no card to mirror a cloud session onto. Both
    // stay on the paired-node client only, same door a card's `createRun` uses.
    createRun: (input: Parameters<typeof nodeClient.createRun>[0]) => nodeClient.createRun(input),
    fetchBundle: (input: Parameters<typeof nodeClient.fetchBundle>[0]) => nodeClient.fetchBundle(input),
    codingModels: (input: Parameters<typeof nodeClient.codingModels>[0]) => nodeClient.codingModels(input),
    baseUrlOf: (machineId: string) => ctx.machineStore.get(machineId)?.baseUrl ?? null,
    tokenOf: (machineId: string) => isCloudBaseUrl(ctx.machineStore.get(machineId)?.baseUrl)
      ? CLOUD_NODE_TOKEN
      : readNodeToken(ctx.STATE_DIR, machineId),
  };

  ctx.remoteNode = remoteNodeRoad;

  const cloudEnabled = cloudCredentialsPresent();

  if (cloudEnabled) {
    // Un nodo accoppiato che si chiama proprio «claude-cloud» resta suo: non gli si riscrive l'indirizzo.
    const existing = ctx.machineStore.getByHostname(CLOUD_NODE_HOST);
    if (!existing || isCloudBaseUrl(existing.baseUrl)) {
      try { ctx.machineStore.upsertNode({ hostname: CLOUD_NODE_HOST, name: existing?.name ?? CLOUD_NODE_NAME, baseUrl: CLOUD_NODE_BASE_URL }); }
      catch (err) { console.warn("[claude-cloud] riga della macchina cloud non scritta", err); }
    }
  }


  /**
   * THE MEMORY SIGNAL, one probe with a 2-minute history for every memory reader:
   * the admission floor, the budget axis, the checks waiter and the swap brake
   * (`server/services/mem-signal.ts`). Sampled at boot and on the dispatch beat.
   */
  /**
   * THE LEDGER OF THE SWAP FREEZER, and the first thing it does: continue every
   * tree the previous server left STOPped.
   *
   * A SIGKILL (a `kickstart -k`, a crash, the machine giving up on us) takes away
   * the only process that could send SIGCONT. The pids are on disk because they
   * were written there BEFORE their SIGSTOP, so this runs before the memory signal
   * starts and before anything can freeze again.
   */
  const swapFreezeLedger = createSwapFreezeLedger(
    fileLedgerIo(join(resolveStateDir(process.cwd()), "swap-freeze.json"), (line) => console.warn(line)),
  );

  void thawLedgerAtBoot({
    ledger: swapFreezeLedger,
    lstartOf: readStartTimes,
    signal: (pid, sig) => { process.kill(pid, sig); },
    log: (line) => console.warn(line),
  }).catch((err) => console.warn("[freeze] boot thaw failed:", err));


  /**
   * The 2-minute window is PARKED ON DISK between restarts (`fileMemSampleStore`).
   * With `TOPICS_SERVER_WATCH=1` this server restarts on every save under
   * `server/`, and a window born empty holds every admission and every resume for
   * 120 s on a machine that may be completely free: 28 windows zeroed over 44
   * restarts in 25.7 h of 16-17/09/2026, about 56 minutes a day of stopped queue.
   */
  const memSignal = createMemSignal({
    probe: probeVm,
    measurable: process.platform === "darwin",
    store: fileMemSampleStore(join(resolveStateDir(process.cwd()), "mem-samples.json")),
  });

  const dispatchMemoryHistory = createDispatchMemoryHistory();

  function recordDispatchMemoryHistory(): void {
    const sample = memSignal.samples().at(-1);
    if (sample?.availGB != null) {
      let running: number | undefined;
      try { running = late.taskDispatcher.busyCount(); } catch { /* the dispatcher is built after the first sample */ }
      dispatchMemoryHistory.record(sample.at, sample.availGB, running);
    }
  }

  // Created here, before the listener opens: the socket open handler sends its
  // frame, and the port starts accepting during the boot's first await.
  const memoryPressureSignal = createMemoryPressureSignal(
    (frame) => broadcastToAll(frame),
    memSignal.swap().sustained,
  );

  void memSignal.sample().then(recordDispatchMemoryHistory);

  // The capacity reading takes its memory from this sample instead of a
  // synchronous `vm_stat` per request; the sync probe stays only as the fallback
  // when no fresh sample exists (see `setAvailableMemReader`).
  setAvailableMemReader(() => memSignal.latestAvailGB() ?? availableMemGB());

  // La passata di parcheggio dei terminali stringe la soglia quando la macchina e'
  // al soffitto. `sustained` e' gia' la misura di «lo swap morde davvero» (due
  // porte, tarate sul log vero: vedi mem-signal.ts), quindi non se ne inventa una
  // seconda qui. Iniettato con un setter perche' questo segnale nasce dopo il
  // router; senza, la passata usa la soglia normale come sempre.
  setTerminalMemPressure(() => ({ atCeiling: memSignal.swap().sustained }));

  // The sub-agent door asks the dispatcher's own gate, priced for a child, when the board runs "by resources".
  setChildAdmissionPreview(() => late.taskDispatcher.childAdmissionPreview?.() ?? null);


  /**
   * CHI tiene la memoria quando non e' Topics: un solo `/bin/ps` al minuto, sul
   * battito che stampa gia' `[memsig]`. I marcatori sono le radici da cui nasce
   * tutto il nostro: il checkout, le worktree degli agenti e i DUE bundle di
   * `OUR_APP_MARKERS` (il guscio e il programma del LaunchAgent, che del server e'
   * antenato e non discendente). Tutto il resto e' di qualcun altro, e va detto a
   * chi guarda la coda ferma.
   */
  const memoryOwners = createMemoryOwnersReader({
    selfPid: process.pid,
    ourMarkers: () => {
      const marks = [rootDir, ...OUR_APP_MARKERS];
      try { marks.push(ctx.worktreeManager.worktreesDir()); } catch { /* not mounted yet */ }
      return marks;
    },
  });


  const dispatchMemoryInputs = createDispatchMemoryInputs({
    heldMemory: () => memSignal.held(),
    runtime: resolveAgentRuntime,
    memoryReading: () => {
      const sample = memSignal.samples().at(-1);
      return { freeGB: sample?.availGB ?? null, at: sample?.at ?? null };
    },
    memoryHistory: () => dispatchMemoryHistory.read(),
    memoryOwners: () => memoryOwners.latest(),
  });


  // Opt-in auto-merge on approve (board setting `dispatchAutoMerge`). Resolves a
  // task → its dispatch topic → worktree → project's main checkout, then merges the
  // branch there. Only `branch`-mode worktrees on a ready project have something to
  // land; everything else resolves to null (skip). Default branch is `main`.
  // The card's worktree here, or none: the rule (and why a node card's old local
  // attempt is not its round) is in `services/task-worktree.ts`. The local id is
  // read once: `upsertLocal` also writes the heartbeat, and this runs per card.
  let localMachineId: string | null = null;
  const worktreeOfTask = createWorktreeOfTask({
    task: (taskId) => dispatcherSvc.get(taskId)?.task,
    topicWorktreeId: (topicId) => ctx.getTopicById(topicId)?.worktreeId,
    worktree: (worktreeId) => ctx.worktreeStore.get(worktreeId),
    lastAttemptWorktreeId: (taskId) => (ctx.db.prepare(
      `SELECT worktree_id FROM task_attempts
      WHERE task_id = ? AND worktree_id IS NOT NULL
      ORDER BY idx DESC LIMIT 1`,
    ).get(taskId) as { worktree_id: string } | undefined)?.worktree_id,
    localMachineId: () => (localMachineId ??= ctx.machineStore.upsertLocal().id),
  });


  // ── La potatura dei worktree: il cablaggio ─────────────────────────────────
  // Built in this stage, ahead of `taskAutoMerge`, the preview manager and the dispatcher:
  // whatever it needs from them it reads through `late` inside a closure, so it is resolved
  // at call time. The three callers sit higher up and read it inside a closure too, which is
  // the property a `function` declared at the bottom of the file used to give through
  // hoisting, obtained without depending on evaluation order.
  const worktreeGc = createWorktreeGcRunner({
    db: ctx.db,
    worktreeStore: ctx.worktreeStore,
    worktreeManager: ctx.worktreeManager,
    projectStore: ctx.projectStore,
    // The roots are named HERE, by the server: current, default, and the past ones its rows prove.
    roots: () => ownedWorktreeRoots(ctx.worktreeStore.list(), new Set(ctx.projectStore.list().map((p) => p.slug))),
    // Claude Code, Codex or jcode started from a terminal in a folder hold it like a session of ours,
    // inside the worktree root too: `activeAt` would call those Topics' own and skip them.
    externalActiveAt: (absPath) => externalSessions.activeInside(absPath).length > 0,
    getTopicBySessionKey: (sessionKey) => ctx.getTopicBySessionKey(sessionKey),
    resolveTopicCwd: (topic) => ctx.resolveTopicCwd(topic),
    svc: dispatcherSvc,
    // La potatura scrive sulle card da un timer: senza questo filo la board
    // resterebbe ferma sulla versione di prima fino a un ricaricamento.
    broadcast: (msg) => ctx.broadcastToAll(msg as Parameters<typeof ctx.broadcastToAll>[0]),
    isInFlight: (taskId) => late.taskDispatcher.isInFlight(taskId),
    worktreeOfTask: (taskId) => worktreeOfTask(taskId),
    deliveryIsOnMain: (repoPath, commit) => deliveryIsOnMain(repoPath, commit),
    previewList: () => late.previewManager?.list() ?? [],
    previewTeardown: (taskId) => late.previewManager?.teardown(taskId) ?? Promise.resolve(),
    // PUNTO 3 (task e3240a22): lista degli script vivi per rimandare lo slim.
    listOwnedScripts: () => listOwnedScripts(),
    // WORKTREE-14: chi sta DENTRO una cartella, che e' l'unica cosa che tiene in
    // piedi il worktree di un sotto-agente isolato (nessun task lo protegge).
    liveCwds: () => liveTerminalCwds(),
    // A chat topic bound to the worktree: mid-turn, or a message in the last 10 minutes.
    chatActive: (sessionKey) => {
      if (activeStreams.has(sessionKey)) return true;
      const row = ctx.db.query("SELECT timestamp, streamed_at FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
        .get(sessionKey) as { timestamp?: string | null; streamed_at?: string | null } | null;
      const times = [row?.timestamp, row?.streamed_at].map((v) => Date.parse(v ?? "")).filter(Number.isFinite);
      return times.length > 0 && Date.now() - Math.max(...times) < 10 * 60_000;
    },
  });


  // A worktree created over its project's cap triggers a cap pass at once (slim, then
  // reap the oldest the contract admits) instead of waiting for the 30-minute timer.
  ctx.worktreeGcDeps.afterCreate = (projectId) => { void worktreeGc.enforceCap(projectId); };

  // Owned here so the quiescence wait can see lands still queued or running.
  const landingQueue = createLandingQueue({ log: (m) => console.warn(m) });

  return { DISPATCH_AUTONOMY, agentWorktreeDeps, cloudEnabled, cloudNode, deliveryIsOnMain, deliveryOnlyWaitsOnChecks, dispatchMemoryInputs, dispatchUsageReader, dispatcherSvc, externalSessions, isChecksHold, landingQueue, listKnownDeliveryRepoRoots, memSignal, memoryOwners, memoryPressureSignal, nodeBranchPlanter, nodeClient, projectPathForNode, recordDispatchMemoryHistory, remoteNodeRoad, announceTick, repoRootForCard, scheduleEngine, scheduledCards, scheduledJobs, swapFreezeLedger, taskAttemptStore, tickScheduledCards, turniInVolo, worktreeGc, worktreeOfTask };
}
