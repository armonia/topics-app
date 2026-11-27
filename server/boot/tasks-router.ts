/**
 * The tasks router and the process detection and presence that start with it.
 */
import { basename } from "path";
import { cpus, loadavg } from "node:os";
import { teardownArchivedTaskBrowserState } from "../services/task-tab-teardown";
import { getClaudeSessionsForDetection, countBusyAgentTerminals } from "../routes/terminal";
import { pushMainToOrigin } from "../services/main-on-origin";
import { CI_BASE_BRANCH, awaitCiEvidence, githubPort, spawnCapped } from "../services/ci-evidence";
import { supersedeEarlierRounds } from "../services/ci-supersede";
import { worktreeDirtProbe, worktreeRealDirt } from "../services/task-automerge";
import { killAgentProcessTree } from "../lib/kill-agent-tree";
import { branchStatusFromRepo, commitIsAncestor, publishedMainRef, resolveCommit } from "../services/branch-status";
import { landedMergeRange } from "../services/task-diff-range";
import { resolveDeliveryBranch } from "../services/delivery-branch-ref";
import { realMainCiPort } from "../services/main-ci-watch";
import { buildProjectCandidates, resolveProjectPath } from "../services/project-path-resolver";
import { classifyWorktreeSource } from "../services/worktree-manager";
import { tryGetProvider } from "../providers";
import { startProcessDetection, stopCardCommandProcesses, stopTopicCommandProcesses } from "../routes/processes";
import { createTasksRouter, ownBranchFiles, runGitCap } from "../routes/tasks";
import { landingFiles, referencedByTheJudge } from "../services/landing-files";
import { defaultLifecycleHooks } from "../services/lifecycle-hooks";
import { getAppSettings, resolveOutputLanguage, resolveDiscordPresenceEnabled, resolveDiscordDetailLevel } from "../services/app-settings";
import { startDiscordPresence } from "../services/discord-presence";
import { computePresenceCounts } from "../services/profile-stats";
import { createNodeCheckWorktrees, nodeCheckRoot } from "../services/node-check-worktree";
import { legacyNodeCheckRoot, sweepScratch } from "../services/worktree-scratch";
import type { AfterPreviewDelivery } from "./scope";
import { late } from "./late";

export function bootTasksRouter(scope: AfterPreviewDelivery) {
  const { DISPATCH_WORKSPACE_DIR, abortHeadlessTurn, activeStreams, auditOneLanding, autoLandTurnCount, browserService, ctx, db, deliveryBranchDeps, dispatchExtraPaths, dispatcherSvc, landingQueue, listKnownDeliveryRepoRoots, listSelectableProjectDirs, memSignal, repoRootForCard, scheduledCards, taskAutoMerge, taskCheckoutRef, taskDeliveryRef, taskDispatcher, worktreeOfTask } = scope;
  // The throwaway checkouts node deliveries are measured on. No measure is in
  // flight at boot, so whatever the previous process left (cut mid-measure by a
  // restart, or killed) goes now: nothing else would ever remove it.
  const nodeChecks = createNodeCheckWorktrees({ git: runGitCap, root: nodeCheckRoot(), resolveHead: (cwd) => resolveCommit(cwd, "HEAD") });
  void nodeChecks.sweep()
    .then((gone) => { if (gone.length) console.warn(`[node-checks] ${gone.length} checkout lasciati dal processo prima, tolti: ${gone.map((p) => basename(p)).join(", ")}`); })
    .catch((err) => console.warn("[node-checks] spazzata d'avvio fallita", err));
  // The other throwaway checkouts (land, realign, integration), and the node checks the
  // layout before worktree-standard T2 left in $TMPDIR: nothing of this process is in
  // flight yet, so whatever is there was cut by the previous one.
  void sweepScratch(runGitCap)
    .then((gone) => { if (gone.length) console.warn(`[scratch] ${gone.length} checkout lasciati dal processo prima, tolti: ${gone.map((p) => basename(p)).join(", ")}`); })
    .catch((err) => console.warn("[scratch] spazzata d'avvio fallita", err));
  void createNodeCheckWorktrees({ git: runGitCap, root: legacyNodeCheckRoot(), resolveHead: (cwd) => resolveCommit(cwd, "HEAD") }).sweep()
    .then((gone) => { if (gone.length) console.warn(`[node-checks] ${gone.length} checkout del vecchio posto (temp), tolti`); })
    .catch((err) => console.warn("[node-checks] spazzata del vecchio posto fallita", err));
  const tasksRouter = createTasksRouter(ctx, taskDispatcher, {
    scheduledCards,
    taskModelSnapshot: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to preserve provider startup order
      const { getSnapshotManager } = require("../providers/snapshot-manager") as typeof import("../providers/snapshot-manager");
      return getSnapshotManager().getSnapshot();
    },
    landings: landingQueue,
    stopCardProcesses: stopCardCommandProcesses,
    stopTopicProcesses: stopTopicCommandProcesses,
    repoRootFor: repoRootForCard,
    workspaceDir: DISPATCH_WORKSPACE_DIR,
    // Il titolo leggibile di una card dettata (`services/task-title.ts`). Si
    // risolve al momento della chiamata e non all'avvio: il default della
    // macchina si ricalcola a ogni boot, e una funzione lo rilegge sempre fresco.
    // `null` in caso di guasto: senza modello la card tiene il titolo del
    // composer, che e' come si e' sempre comportata.
    namingProvider: () => tryGetProvider() ?? null,
    autoMerge: taskAutoMerge,
    // Structural review gate: real uncommitted changes in the task's branch
    // worktree (junk excluded); null = no worktree, gate skipped.
    // Can this board's project have an isolated worktree? Same classification
    // the dispatch uses (`classifyWorktreeSource`, shared with
    // `assertNotAlreadyAWorktree`), so the panel can never say one thing while
    // dispatch does another. A REGISTERED project (non-null projectStoreId)
    // used to always return `true` here, skipping the `.git` check entirely:
    // every project added through the UI (which is almost all of them) never
    // saw the warning, even with no repo or from inside a nested worktree.
    worktreeReady: (projectId) => {
      try {
        const c = resolveProjectPath(
          projectId,
          buildProjectCandidates({
            projectStore: ctx.projectStore,
            workspaceDir: DISPATCH_WORKSPACE_DIR,
            extraPaths: dispatchExtraPaths,
          }),
        );
        if (!c) return "no-git";
        const kind = classifyWorktreeSource(c.path);
        return kind === "ok" ? true : kind;
      } catch { return true; } // in dubbio non si accusa il progetto
    },
    taskWorktreeDirt: async (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt || wt.mode !== "branch") return null;
      return worktreeRealDirt(wt.absPath);
    },
    // Come sopra, ma dice anche SE ha potuto leggere: la usa chi CANCELLA
    // (`reapAfterLand`), dove un `git status` muto non vale «pulito».
    taskWorktreeDirtProbe: async (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt || wt.mode !== "branch") return null;
      return worktreeDirtProbe(wt.absPath);
    },
    // Il task ha (o ha avuto) un tentativo con worktree di ramo registrato?
    // Usato dal cancello `review_needs_commit` per distinguere «non ho trovato
    // il worktree» da «questo task non ha mai avuto un ramo»: un task senza
    // ramo (in-place) non deve essere bloccato quando la sonda torna null.
    taskHasBranchAttempt: (taskId) => {
      try {
        const row = ctx.db.prepare(
          `SELECT 1 FROM task_attempts WHERE task_id = ? AND worktree_id IS NOT NULL LIMIT 1`,
        ).get(taskId);
        return !!row;
      } catch { return false; }
    },
    // Post-landing reap guard: the branch's state relative to main read by
    // CONTENT (survives squash-landing). null = no branch worktree to protect.
    taskBranchStatus: async (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt || wt.mode !== "branch" || !wt.branchName) return null;
      const repoPath = ctx.projectStore.get(wt.projectId)?.path;
      if (!repoPath) return null;
      return branchStatusFromRepo(repoPath, wt.branchName);
    },
    // Delivery snapshot, taken when the task enters review: the branch plus the
    // most recent commit that is the task's OWN. The branch dies with the reap,
    // the commit survives (gc.pruneExpire=90d), so the landing audit holds it.
    //
    // NON la punta del ramo: un branch nato dall'HEAD del checkout condiviso
    // eredita i commit di chi ci stava sopra, e la punta è di un altro — il 10/08
    // `dd2aa40d` registrava `987cd8ae`, commit di un'altra card e già su main.
    // `null` = domanda senza risposta ⇒ nessuna fotografia (meglio del ritratto
    // sbagliato); `commit: null` = verificato, non ha prodotto codice.
    taskDeliveryRef,
    // Dove far girare i checks pre-review: la cartella del worktree del task e il
    // commit su cui sta. Solo worktree di branch — un task in-place girerebbe i
    // comandi nel checkout principale, cioè su codice che non è il suo.
    taskCheckoutRef,
    // The user's `task-deliver` hook, the first gate on the move to review (HOOKS-02).
    hooks: defaultLifecycleHooks(),
    // The automatic land (`services/auto-land.ts`): which files the branch
    // touches (a server file reloads the live server on landing), and how many
    // turns are open right now (the land waits for none).
    deliveryFiles: async (taskId, commit) => {
      const ref = await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null);
      if (!ref) return null;
      // What the merge of THAT commit brings (net diff against main), not the own-commit walk (it leaves out the pruning-residue commit) and not the branch tip (it moves).
      return landingFiles(ref.repoPath, commit);
    },
    // Which of those files `bunfig.toml`, `scripts/`, `package.json` or `.github/` name: the bar's own configuration, as of the same commit.
    deliveryReferenced: async (taskId, commit, files) => {
      const ref = await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null);
      if (!ref) return null;
      return referencedByTheJudge(ref.repoPath, commit, files);
    },
    // The count the restart gate waits on (see `autoLandTurnCount`).
    liveTurnCount: autoLandTurnCount,
    ownBranchFiles: (repoPath, branch) => ownBranchFiles(repoPath, branch),
    // The CI phase (`services/integration-queue.ts`): the repository a card's branch lives in.
    integrationRepo: async (taskId) => (await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null))?.repoPath ?? null,
    // The CI of main, for the red no card owns (`services/main-ci-watch.ts`).
    mainCiPort: async (projectId) => {
      const repo = deliveryBranchDeps().boardRepoPath(projectId);
      return repo ? realMainCiPort(repo) : null;
    },
    // A throwaway checkout of a branch planted from another machine, so its bar
    // can be measured on the commit that will land (`services/node-delivery-meter.ts`).
    // Detached on the DELIVERED COMMIT, not on the branch tip: the branch can
    // move (a land, a new delivery) while the measure is running, and a
    // checkout attached to it would follow HEAD without updating its files.
    nodeDeliveryCheckout: async (taskId) => {
      const ref = await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null);
      const commit = dispatcherSvc.get(taskId)?.task.deliveryCommit;
      if (!ref || !commit) return null;
      return nodeChecks.open({ repoPath: ref.repoPath, commit, branch: ref.branch, taskId });
    },
    onAutoLand: (api) => {
      late.misuraConsegnaNodo = api.measureNodeDelivery;
      // A wait for zero turns lives in memory and a reload loses it: the verdict
      // is asked again at boot and every ten minutes, so no card is stranded.
      const sweep = () => { void api.sweepAutoLand().catch((err) => console.warn("[auto-land] spazzata fallita", err)); };
      setTimeout(sweep, 90_000).unref?.();
      setInterval(sweep, 10 * 60_000).unref?.();
    },
    // Main dentro il ramo PRIMA dei check, come fa il land prima di fondere: il
    // cancello misura l'albero che atterra, non una base invecchiata.
    realignForChecks: (taskId) => taskAutoMerge.realign(taskId),
    // L'esito di atterraggio della card, timbrato SUBITO dopo un land: un verdetto
    // concreto è ciò che il land ha visto e vale come fatto (`witnessed`), `"ask"`
    // è il caso in cui non sa e si chiede al repo (`auditOneLanding`, più in basso).
    stampLanding: async (taskId, verdict) => {
      if (verdict === "ask") { await auditOneLanding(taskId); return; }
      try {
        dispatcherSvc.recordLandingState({
          taskId, state: verdict, checkedAt: new Date().toISOString(), witnessed: true,
        });
      } catch (err) { console.warn("[landing-audit] timbro del land fallito", err); }
    },
    // Il land è stato CHIESTO ma non è ancora avvenuto. La card è già `done` (la
    // rotta approva e risponde subito) e la fusione arriva dopo: senza questo
    // timbro, in quella finestra una card chiusa è indistinguibile da una
    // atterrata — ed è così che l'11/08 sedici card sono rimaste in Done col
    // codice sul loro ramo, in silenzio. `witnessed: false` di proposito: è il
    // vero di ADESSO, e la passata periodica resta libera di correggerlo se il
    // land è morto a metà dopo aver mergiato davvero.
    // La PROVA che il land è avvenuto: il commit di fusione dev'essere dentro
    // `main` di quel checkout, riletto da git dopo il merge. `defaultBranch` è
    // "main" ovunque qui (vedi `resolveTaskMerge` sopra), quindi la domanda è
    // esattamente quella che il land ha provato a rendere vera.
    confirmLandedOnMain: (repoPath, commit) => commitIsAncestor(repoPath, commit, "main"),
    // THE SAME THREE QUESTIONS THE AUDIT ASKS (`landing-audit-pass.ts`), here
    // asked BEFORE the merge, on a card the unmeasured-delivery gate would
    // otherwise block forever: is the commit already an ancestor of the
    // published main, or inside the merge this card already wrote there?
    alreadyLandedProof: async (repoPath, taskId, commit) => {
      const mainRef = await publishedMainRef(repoPath);
      if ((await commitIsAncestor(repoPath, commit, mainRef)) === true) return commit;
      const merge = await landedMergeRange(repoPath, taskId, { mainRef }).catch(() => null);
      if (!merge) return null;
      const sha = merge.range.split("..")[1] ?? "";
      return sha && (await commitIsAncestor(repoPath, commit, sha)) === true ? sha : null;
    },
    pushMainAfterLand: (repoPath) => pushMainToOrigin(repoPath),
    markLandPending: (taskId) => {
      try {
        dispatcherSvc.recordLandingState({
          taskId, state: "unlanded", checkedAt: new Date().toISOString(),
        });
      } catch (err) { console.warn("[landing-audit] timbro di attesa fallito", err); }
    },
    // Post-landing reap: merged (or empty) worktrees have no remaining value —
    // the manager path removes worktree + branch + row, serialized per project.
    deleteTaskWorktree: async (taskId) => {
      const wt = worktreeOfTask(taskId);
      if (!wt) return false;
      return ctx.worktreeManager.delete(wt.id);
    },
    // Reap the task's live preview server on land / approve / close.
    teardownPreview: (taskId) => late.previewManager?.teardown(taskId) ?? Promise.resolve(),
    // Archiviare un task porta via anche le sue tab: le due chiavi `ui_state` e i
    // contesti browser dietro di esse. `browserService` è il servizio vivo, quindi
    // la chiusura headless è reale; il broadcast chiude la pane su ogni device.
    teardownTaskBrowserState: (taskId) =>
      teardownArchivedTaskBrowserState(
        {
          db,
          broadcastToAll: ctx.broadcastToAll,
          destroyContext: (contextId) => browserService.destroyContext(contextId),
        },
        taskId,
      ),
    // Due chiamanti, stessa porta: il fan-out (l'anteprima parte quando l'umano
    // sceglie il vincitore, perché solo allora il worktree del task è quello
    // giusto da mostrare) e «Ricattura evidenza» su una card già in review, che
    // passa `explain: true` per farsi motivare anche il no.
    preparePreview: (taskId, o) => late.previewManager?.prepareForReview(taskId, o) ?? Promise.resolve(),
    // NOTE: the server no longer SELF-RESTARTS when an approve lands server code
    // (removed 2026-07-18, Attilio: "l'auto-riavvio sporca tutto"). A landed
    // server change goes live either via the opt-in graceful hot-reload watch
    // (TOPICS_SERVER_WATCH=1 in start-prod.sh) or a deliberate manual restart —
    // never an autonomous restart triggered by task approval. tasks.ts just posts
    // an informational note on a server-touching landing.
    // Human "stop" on a dispatched task cuts the running turn (same abort path
    // as the dispatcher's wall-clock timeout).
    abortTurn: abortHeadlessTurn,
    hasLiveTurn: (sk) => activeStreams.has(sk),
    killAgentTree: killAgentProcessTree,
    // Collega il gate dei check al freno del dispatcher: appena il gate esiste,
    // `checksGateRunningCount` punta al suo `runningCount()` e il dispatcher
    // lo usa in ogni tick e resume per sapere quante barre sono in volo.
    onChecksGate: (gate, hooks) => {
      late.checksGateRunningCount = () => gate.runningCount();
      late.checksGateIsRunning = (taskId) => gate.isRunning(taskId);
      late.checksGateIsOffLane = (taskId) => gate.isOffLane(taskId);
      // What `sweepStaleChecksLights` calls on a card whose light it just had to
      // switch off: the round is gone, and this is the only thing left in this
      // process that can start another one.
      late.resumeHeldDelivery = (taskId) => hooks.settleDelivery(taskId);
    },
    // The e2e row of a delivery is read from the pull request CI, never run here.
    // The planted delivery branch is handed in as a fallback: a node-check
    // checkout is detached on the delivered commit (`openNodeCheckWorktree`),
    // so `git symbolic-ref` inside it finds nothing on its own.
    ciEvidence: async ({ onCiWait, ...input }) => {
      const ref = await resolveDeliveryBranch(deliveryBranchDeps(), input.taskId).catch(() => null);
      return awaitCiEvidence({ ...input, branch: ref?.branch ?? null }, { onCiWait });
    },
    // A round on a new branch ends the pull requests of the card's earlier rounds.
    supersedeEarlierRounds: ({ cwd, taskId }) => supersedeEarlierRounds(githubPort(), { cwd, taskId, baseBranch: CI_BASE_BRANCH }),
    // The review sweep asks whether a green card's pull request still merges into main.
    reviewPrMergeable: async (taskId, branch) => {
      const repo = (await resolveDeliveryBranch(deliveryBranchDeps(), taskId).catch(() => null))?.repoPath ?? null;
      if (!repo) return null;
      const r = await spawnCapped(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "mergeable", "--limit", "1"], repo);
      if (r.code !== 0) return null;
      try { return String((JSON.parse(r.out) as Array<{ mergeable?: string }>)[0]?.mergeable ?? "") || null; } catch { return null; }
    },
    // No new pre-review command starts under the memory floor, into sustained
    // swap, or within 2 minutes of another delivery's release (15/09/2026: 5.9 GB
    // free and 9.9 GB of swap, four commands on one poll). The floor is READ HERE,
    // at every poll, not captured: it is the owner's setting on the reserved '*'
    // row, so moving it in the panel takes effect on the next round. It used to be
    // `DISPATCH_MEM_FLOOR_NATIVE_GB` — the floor for admitting an AGENT, three
    // times the heaviest check command ever measured on this machine.
    checksMemoryFloor: { held: () => memSignal.held(), swap: () => memSignal.swap(), floorGB: () => dispatcherSvc.getChecksMemFloorGB(), loadPerCore: () => loadavg()[0]! / Math.max(1, cpus().length) },
    // Same union the dispatcher resolves against — but trimmed to the dirs that
    // are actually SELECTABLE boards. Internal catch-all plumbing (the shared
    // `generale` dir, the per-task `tasks/<id8>` cwds), the home dir, config
    // dot-dirs and vanished paths are dropped so the picker/sidebar stay clean;
    // the resolver above keeps the FULL union so those hashes still invert.
    listProjectDirs: listSelectableProjectDirs,
    listRepoRoots: listKnownDeliveryRepoRoots,
  });

  // Auto-register servers Claude starts inside its PTY sessions (bare `bun run dev`
  // etc.) into the Processes panel, attributing listening ports by PTY process tree.
  startProcessDetection(ctx, getClaudeSessionsForDetection);


  // Lo stato pubblicato su Discord, se l'interruttore è acceso (default: spento,
  // migration 102). Il servizio parte SEMPRE — è lui a rileggere le impostazioni
  // a ogni giro e a non aprire nessun filo finché non gli viene detto di sì —
  // così accendere non richiede un riavvio.
  //
  // Sostituisce il daemon launchd `claude-discord-presence`, che contava i
  // processi `claude` con `ps`: i numeri che passano di qui sono conteggi esatti
  // del server (`activeStreams` = i turni che stiamo trasmettendo ADESSO, non una
  // soglia sulla CPU di un processo).
  // Da quando questa installazione è in piedi: diventa il cronometro sotto la
  // card di Discord. È l'avvio del SERVER e non l'avvio della sessione, perché è
  // quello che «da quanto stai lavorando» significa per chi guarda.
  const SERVER_STARTED_AT = Date.now();

  startDiscordPresence({
    getSnapshot: () => ({
      ...computePresenceCounts(
        ctx.db,
        ctx.activeStreams.size + countBusyAgentTerminals(),
        ctx.externalSessionsCount?.() ?? 0,
        ctx.externalSessionsWorking?.() ?? 0,
      ),
      since: SERVER_STARTED_AT,
    }),
    getSettings: () => {
      const s = getAppSettings();
      return {
        enabled: resolveDiscordPresenceEnabled(s),
        level: resolveDiscordDetailLevel(s),
        language: resolveOutputLanguage(s),
      };
    },
  });

  return { SERVER_STARTED_AT, tasksRouter };
}
