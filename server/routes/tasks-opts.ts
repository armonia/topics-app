/**
 * The options the tasks router is built with (host wiring and test seams).
 */
import type { AIProvider } from "../providers";
import type { ProvidersSnapshot } from "../../shared/types";
import { type CheckRun } from "../../shared/board";
import { type RealignOutcome, type TaskAutoMerge } from "../services/task-automerge";
import type { LandingState } from "../services/landing-audit";
import type { RepoProbe } from "../services/deliveryReportChecks";
import { type LandingQueue } from "../services/landing-queue";
import { type BranchStatus } from "../services/worktree-gc";
import { type ReviewCheck } from "../services/review-checks";
import type { LifecycleHookRunner } from "../services/lifecycle-hooks";
import { type MemoryFloor } from "../services/review-checks-brakes";
import { type CloseCiDraftInput, type DraftCleanup } from "../services/ci-evidence";
import type { ScheduledCardsService } from "../services/scheduled-cards";
import type { IntegrationMeasure } from "../services/integration-queue";
import { type NodeDeliveryCheckout } from "../services/node-delivery-meter";
import { type TaskFile } from "../../shared/task-labels";
import type { StopCause } from "../lib/abort-cause";

export interface TasksRouterOpts {
  scheduledCards?: ScheduledCardsService;
  /** Current coding-provider catalogs, used to refuse a stale or unknown card model (MP-TASK-03). */
  taskModelSnapshot?: () => ProvidersSnapshot | null;
  /**
   * The repository a delivery report is verified against, and how a root
   * becomes a probe (tests pass a fake). Handed to the router's OWN task
   * service: the agent's `update_task(status="review")` lands on
   * PATCH /api/sessions/:key/tasks/:id, i.e. on THIS service, not on the
   * dispatcher's. Wired only there, the fix verified nothing (2026-09-04).
   */
  repoRootFor?: (args: { taskId: string; projectId: string | undefined; assignedTopicId: string | null }) => string | null;
  /** Complete repository roots known to the host, including non-selectable projects. */
  listRepoRoots?: () => string[];
  probeFor?: (root: string) => RepoProbe;
  /**
   * The landing queue, owned by the host so a planned restart can see the
   * lands still queued or running: on 2026-09-04 a restart cut a land in
   * half (the merge done, the card bounced back to in_progress and its
   * delivery branch forgotten) because quiescence counted turns only.
   */
  landings?: LandingQueue;
  /** All project dirs the server knows (same union the dispatcher resolves against). */
  listProjectDirs?: () => string[];
  /** Workspace root for scaffolding a NEW project from the board. */
  workspaceDir?: string;
  /** Abort a running headless turn (human "stop" on a dispatched task). */
  abortTurn?: (sessionKey: string, cause: StopCause) => Promise<void>;
  /** Stop command process groups owned by a card after it is done or archived. */
  stopCardProcesses?: (cardId: string) => void | Promise<void>;
  /** Stop process groups owned by a fan-out topic when its losing attempt is archived. */
  stopTopicProcesses?: (topicId: string) => void | Promise<void>;
  /** Is this session's turn running right now (open stream)? Absent means unknown, hence no. */
  hasLiveTurn?: (sessionKey: string) => boolean;
  /**
   * Kill the WHOLE process tree an agent's Bash tool spawned for this session
   * — not just the CLI turn. `abortTurn` cuts the turn (SIGINT to the CLI,
   * recorded as cancelled); it never touches a child that Bash left running
   * (a test suite, a dev server). Without this, "Ferma" stops the agent and
   * lets the heavy work it launched keep running — exactly the load a stop is
   * meant to escape. Called BEFORE `abortTurn` so the process table is read
   * while the tree is still intact (a CLI that exits first reparents its
   * children to init, and a snapshot taken after that no longer sees them).
   */
  killAgentTree?: (sessionKey: string) => Promise<void>;
  /**
   * Auto-merge a task's worktree branch into main on approve (opt-in per board via
   * `dispatchAutoMerge`). Absent ⇒ approve never touches git.
   */
  autoMerge?: TaskAutoMerge;
  /**
   * Real uncommitted changes in the task's branch worktree (junk excluded), or
   * null when the task has no branch worktree. Powers the structural review
   * gate: an agent delivery with uncommitted work is refused with coaching.
   */
  taskWorktreeDirt?: (taskId: string) => Promise<string[] | null>;
  /**
   * Come `taskWorktreeDirt`, ma dice anche SE ha potuto leggere.
   * `ok: false` = `git status` non ha risposto: trattare come sporco.
   * Chi distrugge usa questa; chi solo consiglia usa `taskWorktreeDirt`.
   */
  taskWorktreeDirtProbe?: (taskId: string) => Promise<{ ok: boolean; paths: string[] } | null>;
  /**
   * Il task ha (o ha avuto) un tentativo con worktree di ramo registrato?
   *
   * Serve al cancello `review_needs_commit` per distinguere «non ho trovato
   * il worktree» da «questo task non ha mai avuto un ramo» quando la sonda
   * torna `null`. Senza questa distinzione, un task rilasciato dal dispatcher
   * (che azzera `assigned_topic_id`) passava il cancello in silenzio anche
   * con 279 righe non committate — incidente 18/08, card `171b787d`.
   */
  taskHasBranchAttempt?: (taskId: string) => boolean;
  /**
   * Il progetto di questa board può davvero avere un worktree isolato?
   *
   * È una condizione del BOARD, non del task, ma si scopriva una volta PER
   * TASK: con «worktree isolato» acceso su un progetto che non è un repo git,
   * ogni dispatch moriva con «worktree richiesto ma il progetto non è un repo
   * git registrato». Il messaggio era corretto e arrivava nel posto sbagliato —
   * a chi guarda un task, invece che a chi ha acceso l'impostazione.
   *
   * Esposto insieme alle impostazioni così il pannello può dirlo PRIMA.
   */
  worktreeReady?: (projectId: string) => boolean;
  /**
   * The task branch's state relative to main, read from the PROJECT repo by
   * CONTENT (so a squash-land still reads "merged"). `null` ⇒ the task has no
   * branch worktree. Gates the post-land reap: a branch whose content isn't on
   * main is never destroyed, whatever the merge step claimed.
   */
  taskBranchStatus?: (taskId: string) => Promise<BranchStatus | null>;
  /**
   * The task branch and the most recent commit that is the task's OWN, for the
   * delivery snapshot taken when a task enters `review`. Not the branch tip: a
   * branch born from the shared checkout's HEAD carries commits inherited from
   * whoever was working there, and pointing the audit at one of those makes the
   * card claim someone else's work (10/08: `dd2aa40d` → `987cd8ae`).
   *
   * `null` ⇒ niente da fotografare (task in-place senza branch, o la domanda non
   * ha avuto risposta: si lascia stare quel che c'è). `commit: null` ⇒ verificato,
   * la card non ha prodotto codice — che è un'informazione, e va registrata.
   */
  /**
   * The CI phase (`services/integration-queue.ts`): the repository a card's
   * branch lives in, for the integration commit. Absent = no CI phase, lands go
   * straight to the land queue as before.
   */
  integrationRepo?: (taskId: string) => Promise<string | null>;
  /** Tests: replaces the git + CI measure of an integration batch. */
  integrationMeasure?: (projectId: string, taskIds: string[]) => Promise<IntegrationMeasure>;
  /** Tests: how long an idle integration queue collects cards before measuring. */
  integrationCollectMs?: number;
  /** Tests: the files between two commits of a card (git diff --name-only). */
  integrationFilesBetween?: (taskId: string, from: string, to: string) => Promise<string[] | null>;
  taskDeliveryRef?: (taskId: string) => Promise<{
    branch: string; commit: string | null;
    /** L'entità del lavoro consegnato, quando git ha saputo dirla. */
    filesChanged?: number; insertions?: number; deletions?: number;
  } | null>;
  /**
   * Dove girano i checks pre-review: la cartella del worktree del task e il commit
   * su cui sta in quel momento. `null` ⇒ nessun worktree di branch (task in-place),
   * niente su cui eseguire → gate saltato. Il commit serve a datare l'esito: un
   * "verde" vale per QUEL codice, non per il branch a vita.
   */
  taskCheckoutRef?: (taskId: string) => Promise<{ cwd: string; commit: string | null } | null>;
  /**
   * The user's `task-deliver` hook (HOOKS-02): the first and cheapest gate on
   * the move to `review`, asked before the dirt probe and the checks.
   */
  hooks?: LifecycleHookRunner;
  /**
   * Brings main into the card's branch BEFORE the pre-review checks run, the
   * way the land does before merging (`taskAutoMerge.realign`). `ok:false` is
   * the verdict itself: the checks do not start.
   */
  realignForChecks?: (taskId: string) => Promise<RealignOutcome>;
  /**
   * AUTOMATIC LAND (`services/auto-land.ts`). What the merge of `commit` (the
   * exact delivered commit, net of main) changes, to know whether a person must
   * look and whether the merge reloads the live server (`null` = unknown, and
   * the land does not happen); the turns open on this server right now; the poll
   * beat of the wait for zero turns.
   */
  deliveryFiles?: (taskId: string, commit: string) => Promise<string[] | null>;
  /** Which of those files the bar's configuration names; `null` = unknown. */
  deliveryReferenced?: (taskId: string, commit: string, files: string[]) => Promise<string[] | null>;
  /** `insideLand`: asked from within a land, which does not count itself. */
  liveTurnCount?: (opts?: { insideLand?: boolean }) => number | Promise<number>;
  autoLandPollMs?: number;
  /**
   * A delivery planted from another machine has a branch and no worktree: a
   * throwaway checkout of it, so the board's bar can be measured on the commit
   * that will land. `null` = cannot make one (the card stays unmeasured).
   */
  nodeDeliveryCheckout?: (taskId: string) => Promise<NodeDeliveryCheckout | null>;
  /** Files of the branch's own commits, for the labels of a card with no worktree. */
  ownBranchFiles?: (repoPath: string, branch: string) => Promise<TaskFile[] | null>;
  /** Replaces the git-backed reader of own-commit files (tests). */
  ownCommitFiles?: (cwd: string) => Promise<TaskFile[] | null>;
  /**
   * Called once when the router exists, with the two doors the node lane and the
   * boot sweep need and cannot reach any other way.
   */
  onAutoLand?: (api: {
    /** Measure a node delivery's bar, then land it by itself if the verdict allows. */
    measureNodeDelivery: (taskId: string) => Promise<void>;
    /** Re-run the verdict over every review card: lost timers do not strand a card. */
    sweepAutoLand: () => Promise<number>;
  }) => void;
  /**
   * Il provider con cui ricavare un titolo leggibile da una card dettata.
   *
   * Assente ⇒ nessun titolo generato, resta quello del composer: è una
   * comodità, e una board senza modello configurato deve continuare a
   * funzionare come prima.
   */
  namingProvider?: () => AIProvider | null;
  /**
   * Timbra l'esito di atterraggio di UNA card, subito dopo un land.
   *
   * Due modi, e la differenza è il punto: uno stato concreto è ciò che il land
   * HA VISTO (merge uscito zero, o fallito) e vale come fatto — si registra
   * mentre il ramo esiste ancora e la passata periodica non lo tocca più.
   * `"ask"` è il caso in cui il land non sa (nessun ramo, o niente da portare):
   * lì si chiede al repo, ed è una deduzione come le altre.
   *
   * Best-effort: se non risponde, la passata periodica raggiunge comunque le
   * card senza testimonianza.
   */
  stampLanding?: (taskId: string, verdict: LandingState | "ask") => Promise<void>;
  /**
   * Segna la card come «land richiesto, non ancora atterrata» — nel momento in
   * cui il land si ACCODA, prima che git abbia fatto qualunque cosa.
   *
   * Serve perché il `done` arriva SUBITO (la rotta approva e risponde) mentre la
   * fusione arriva dopo: fra i due c'è una finestra in cui la card è chiusa e
   * nessuno può dire se il codice è su main. Se in quella finestra il processo
   * muore — o il land non parte affatto — senza questo timbro la card resta in
   * Done senza verdetto, cioè indistinguibile da una atterrata. È esattamente lo
   * stato che ci è costato le 16 card dell'11/08.
   *
   * Il timbro è `unlanded` NON testimoniato: dice il vero (non è su main in
   * questo istante) e lascia alla passata periodica il diritto di correggerlo se
   * il land è morto a metà dopo aver mergiato davvero.
   */
  markLandPending?: (taskId: string) => void;
  /**
   * LA PROVA CHE IL LAND È AVVENUTO, chiesta al repo e non al resoconto del
   * merge: il commit di fusione è dentro l'integrazione (`main`) di QUEL
   * checkout?
   *
   * `git merge --no-ff` uscito zero dice che una fusione è riuscita, non su
   * quale ramo: il land può atterrare su un checkout parcheggiato altrove, o su
   * un worktree usa-e-getta che poi non si è ricucito. Il 13/08 tre card sono
   * passate a `done` col ramo mai arrivato su main, e `landing_state` diceva
   * `landed` — cioè il campo raccontava un resoconto, non un fatto.
   *
   * `true` = il commit è antenato dell'integrazione · `false` = provatamente no
   * (e allora la card NON si chiude e il worktree NON si pota) · `null` = git
   * non ha risposto, quindi non lo si sa e non si scrive `landed`.
   *
   * Assente ⇒ nessuna prova disponibile su questo host, che vale `null`: si
   * chiude la card (il merge è uscito zero) ma il verdetto resta
   * `unverifiable`. Un verdetto `landed` lo scrive SOLO questa prova.
   */
  confirmLandedOnMain?: (repoPath: string, commit: string) => Promise<boolean | null>;
  /**
   * Pushes `main` to origin after a confirmed land, fast-forward only
   * (`main-on-origin.ts`). Absent = no push (tests that do not care).
   * An `ok:false` does NOT undo the land (the work is on the local main): the
   * card gets `unpushed` plus a thread line, and the periodic sweep retries.
   */
  pushMainAfterLand?: (repoPath: string) => Promise<{ ok: true; pushed: number } | { ok: false; reason: string }>;
  /**
   * Close the delivery's draft pull request and delete its branch on origin.
   * Absent ⇒ the real `gh`/`git` (`closeCiDraft`); the seam exists so the three
   * doors that call it can be proved without a GitHub account, the same way
   * `deleteTaskWorktree` and `confirmLandedOnMain` are.
   */
  closeDelivery?: (input: CloseCiDraftInput) => Promise<DraftCleanup>;
  /**
   * Delete the task's worktree + branch + store row (the worktree-manager
   * path). Called after a landing: once merged, the worktree has no value and
   * keeping it is how 30+ stale worktrees accumulated.
   */
  deleteTaskWorktree?: (taskId: string) => Promise<boolean>;
  /**
   * Tear down the task's live preview server (booted at review-time by the
   * preview manager). Called on land, approve→done and archive so a merged/closed
   * task frees its pool port. Idempotent; absent ⇒ no preview to reap.
   */
  teardownPreview?: (taskId: string) => Promise<void>;
  /**
   * Smonta le tab del task ARCHIVIATO: cancella `task-browser-tabs:<id>` e
   * `task-browser-layout:<id>` (root + sottoalbero) e rilascia i contesti
   * browser che ci trova dentro — `services/task-tab-teardown.ts`, dove sta il
   * perché. Restituisce gli id toccati, che finiscono nel `task:deleted` così i
   * client dimenticano le chiavi invece di ri-PUTtarle dal loro debounce.
   * Assente ⇒ passo saltato (test, fixture): il ripasso al boot rimedia.
   */
  teardownTaskBrowserState?: (taskId: string) => { taskIds: string[] };
  /**
   * Boot the review preview from the task's worktree. Serve alla scelta del
   * vincitore di un fan-out: la consegna arriva in review PRIMA che il task abbia
   * un worktree suo (quello del tentativo 1 può non essere il vincitore), quindi
   * l'anteprima non può partire alla consegna — parte quando il worktree del task
   * diventa quello scelto. Assente ⇒ nessuna anteprima, la scelta funziona lo stesso.
   *
   * `explain: true` = l'ha chiesto una persona (POST …/preview su una card già in
   * review): il ramo «non è stato possibile» deve lasciare la sua review-note col
   * motivo invece di tacere.
   */
  preparePreview?: (taskId: string, opts?: { explain?: boolean }) => Promise<void>;
  /**
   * Callback chiamata subito dopo che il `checksGate` interno e' stato creato.
   * Serve a `server.ts` per passare `checksGate.runningCount` al dispatcher:
   * il gate e' una closure della rotta, ma il dispatcher nasce prima della rotta
   * e non puo' riceverlo al costruttore. Con questo hook il wiring e' immediato
   * e senza accoppiamenti circolari.
   */
  /**
   * `hooks.settleDelivery` rides along because it answers the OTHER half of the
   * same question: the periodic sweep that switches off an orphaned `running`
   * light (`services/checks-lights.ts`) has the card ids in hand, and without
   * this the honest light would just park the card - nothing in this process
   * restarts a round whose gate key is gone, and the boot resume now gives up
   * after three rounds (`MAX_DELIVERY_ROUNDS`). It is a no-op for a card this
   * process holds no delivery for.
   */
  onChecksGate?: (
    gate: import("../services/checks-gate").ChecksGate,
    hooks: { settleDelivery: (taskId: string) => void },
  ) => void;
  /**
   * The memory a pre-review command waits for before it starts: a delivery's
   * unit tree is 4-11 GB, and nothing else holds it back once the card was
   * admitted. Passed by `server.ts` with the real probe. Absent = the checks
   * never wait on memory, which is what the route tests need: their result must
   * not depend on how much memory the machine running them has left.
   */
  checksMemoryFloor?: MemoryFloor;
  /**
   * Reads the pull request CI verdicts for the delivered commit (KANBAN-84): one
   * row per declared `github-ci:*` check, from one push and one poll loop, called
   * only after every local command is green and the lane is given back.
   * Absent with a declared CI row = NOT MEASURED, never a pass.
   */
  ciEvidence?: (input: {
    cwd: string; sha: string; taskId: string; checks: ReviewCheck[];
    /** The links of the wait, as soon as they exist: they go on the card. */
    onCiWait?: (links: { prUrl: string; runUrl?: string }) => void;
  }) => Promise<CheckRun[]>;
}

