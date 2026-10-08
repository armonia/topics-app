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
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus, homedir } from "node:os";
import type { AppContext, RouteHandler } from "../types";
import { readableTaskIds, levelFor, meetsLevel } from "../lib/grants-query";
import { titoloMigliore } from "../services/task-title";
import type { AIProvider } from "../providers";
import { resolvePrincipals } from "../lib/principals";
import { liveAgentStartCapability, queueDelegatedRun } from "../lib/delegated-agent-start";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { budgetShare, capMode, isAgentWorking, isCiEvidenceCheck, type CheckRun, isThreadSpeech, PARKED_WAITED_OUT, pendingQuestion, TASK_STATUSES, type DispatchAdmission, type GlobalDispatchCap, type PendingQuestionComment, type TaskStatus } from "../../shared/board";
import { AGENT_AUTHOR, AGENT_AUTHOR_PREFIX } from "../../shared/comment-author";
import { isPreviewablePath } from "../../shared/media-kind";
import { isBlankLikeImage } from "../services/image-shape";
import { parseTaskPatch, unapplicableFieldsBody, checkConstraintBody, type FieldRead } from "./task-patch";
import { getTerminalSessionById } from "./terminal";
import { createBoardRoutes } from "./tasks-board";
import { applySpendCapPatch, hasSpendCapPatch, spendCapFields, spendSnapshot } from "./task-spend-caps";
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";

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
import { AUTO_PROJECT_ID, commentAsksHuman, createTaskService, projectIdForPath, TaskServiceError, UNASSIGNED_PROJECT_ID, type Task, type TaskService } from "../services/tasks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";
import { activeFrozenCount } from "../services/budget-governor";
import { resolveAgentRuntime } from "../services/app-settings";
import { newProjectParentDir, scaffoldNewProject } from "../services/project-path-resolver";
import { parkedEdgeEvent, type TaskDispatcher } from "../services/task-dispatcher";
import { type RealignOutcome, landFallout, type TaskAutoMerge } from "../services/task-automerge";
import type { LandingState } from "../services/landing-audit";
import type { RepoProbe } from "../services/deliveryReportChecks";
import { createLandingQueue, type LandingQueue, type LandingTicket, type LandOutcomeResult } from "../services/landing-queue";
import { decidePostLandReap, type BranchStatus, type LandOutcome } from "../services/worktree-gc";
import { checksVerdict, formatChecksComment, formatChecksThreadSummary, formatChecksWait, runReviewChecks, type ReviewCheck } from "../services/review-checks";
import type { LifecycleHookRunner } from "../services/lifecycle-hooks";
import { ChecksInterruptedError, clampLegMs, createChecksGate, type ChecksLane, type ChecksLeg } from "../services/checks-gate";
import { forgetDelivery, reviewChecksStopping, swapInterruptedDelivery, throwIfStopping, type MemoryFloor } from "../services/review-checks-brakes";
import { bumpPendingDeliveryRound, forgetPendingDelivery, loadPendingDeliveries, savePendingDelivery, type PendingDelivery } from "../services/pending-delivery-store";
import { ciNotMeasured, closeCiDraft, type CloseCiDraftInput, type DraftCleanup } from "../services/ci-evidence";
import { createTaskAttemptStore, type TaskAttempt } from "../services/task-attempts";
import { recordRetirement } from "../services/retirement";
import { attemptHasWork, formatAttemptStat } from "../../shared/task-attempt";
import { listOwnCommits, mergeNameStatus } from "../services/own-commits";
import { createDeliveryCapture } from "../services/task-delivery-capture";
import { makeSheetWriter } from "../services/delivery-sheet";
import { resolveTaskDiffRange, revsOfRange } from "../services/task-diff-range";
import { gitDiffFilePatch, serveDiffBlob } from "../services/task-diff-file";
import { gitDiffBundle } from "../lib/git-diff-stat";
import { isTaskLabel, normalizeLabels, type TaskFile } from "../../shared/task-labels";
import type { StopCause } from "../lib/abort-cause";
import { probeUrl } from "../services/url-probe-cache";
import { setClosed } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import {
  getEligibleGlobalOrchestratorSessionBySessionKey,
  isGlobalOrchestratorSession,
} from "../services/global-orchestrator-session";

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

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
  open_subtasks: 409,
  review_needs_summary: 409,
  // A card the board ALREADY labelled `visibile` has a surface someone will
  // look at, so it delivers with a preview. 409 like the other review gates:
  // the delivery is refused for its state, not for a missing permission.
  review_needs_preview: 409,
  // The task was taken away from the agent (park/requeue): 409 like the other
  // ownership refusals, not 403. This is not a permissions problem, it is a
  // state that changed underneath in the meantime.
  task_not_yours: 409,
  // The card was closed by a human: reopening it would override that decision.
  // 409 like the other state refusals, not 403. It is not a missing permission,
  // it is a decision that already exists on the card.
  reopen_needs_human: 409,
  // 403 and not 409: here it is NOT a state that changed underneath, it is a
  // permission that does not exist and will not exist on the next attempt. An
  // agent does not mark its own work `invisibile`, full stop.
  label_forbidden: 403,
};

/**
 * Broadcast the dedicated "a task just ENTERED review" edge event. This is the
 * end-of-task signal the user asked for: it drives the OS banner (client
 * `useCompletionNotifier`) and the closed-app web-push (`push-triggers.ts`),
 * decoupled from the fragile session-idle inference. No-op unless the task
 * actually transitioned INTO review (prevStatus !== "review"), so re-emitting
 * `task:updated` for an already-in-review task (e.g. a new comment) never
 * re-notifies. Emitted IN ADDITION to `task:updated`, never instead of it.
 */
export function emitReviewReadyEdge(
  broadcast: (m: OutboundMessage) => void,
  projectId: string,
  task: { id: string; text: string; status: string } | undefined | null,
  prevStatus: string | undefined,
  reason?: string,
  /**
   * The task's thread, LAZY: called only when the edge actually fires. It
   * tells us whether the agent's last word is a question, because its options
   * become the banner's buttons. Lazy rather than an already-resolved
   * parameter because every PATCH of the task calls this function: reading the
   * thread on every priority save, for an edge that fires exactly once, would
   * be a query for nothing.
   */
  resolveComments?: () => readonly PendingQuestionComment[] | null | undefined,
): void {
  if (task && task.status === "review" && prevStatus !== "review") {
    let question: { text: string; options: string[] } | null = null;
    // Best-effort: a thread read that fails must not swallow the edge (a banner
    // without buttons is still far better than no banner at all).
    let isAsk = false;
    try {
      const comments = resolveComments?.();
      question = pendingQuestion(comments);
      // `question` also carries the options of a DELIVERY (the envelope tells
      // the agent to attach `options=["Landa su main"]` to every delivery, and
      // the server wraps them in the same ```question fence): it is not enough
      // to tell whether the agent's last word is asking something. `isAsk`
      // looks at the same last comment with `commentAsksHuman` (it reads the
      // OPTIONS, not the fence), so the banner can pick the right title without
      // losing the "Landa su main" button that lives in `question.options`.
      const speech = (comments ?? []).filter(isThreadSpeech);
      const last = speech[speech.length - 1];
      isAsk = commentAsksHuman(last?.content);
    } catch { question = null; isAsk = false; }
    broadcast({
      type: "task:review-ready",
      projectId,
      taskId: task.id,
      taskTitle: task.text || "Task",
      ...(reason ? { reason } : {}),
      // ALWAYS present, `null` included, and that is the point. The client
      // decides from here whether the banner carries "Approva" or the answers
      // to the question, and the two ends of the wire update separately (the
      // desktop shell ships its own client, the server is the daemon). With the
      // field OMITTED when there is no question, a new client on an old server
      // would read "no question" and put an "Approva" button on a task that is
      // waiting for an answer: one click, and the task is closed instead of
      // answered. An explicit `null` keeps "there is none" distinguishable from
      // "this server cannot say".
      question,
      isAsk,
    });
  }
}

// `pendingQuestion` lives in `shared/board.ts`: it has three readers on two
// sides of the wire (this emitter, the client's fallback on a server that does
// not send the field, and conceptually the card's quick-reply).
// Re-exported because this module's tests import it from here, where it was.
export { pendingQuestion, type PendingQuestionComment };

/**
 * Cap for AGENT-authored comments (the session surface only — humans are
 * uncapped). Generous enough for 2-3 dense sentences or a question block,
 * tight enough to reject log dumps; the 400 message coaches a retry.
 */
const AGENT_COMMENT_MAX_CHARS = 600;

export interface TasksRouterOpts {
  /**
   * The repository a delivery report is verified against, and how a root
   * becomes a probe (tests pass a fake). Handed to the router's OWN task
   * service: the agent's `update_task(status="review")` lands on
   * PATCH /api/sessions/:key/tasks/:id, i.e. on THIS service, not on the
   * dispatcher's. Wired only there, the fix verified nothing (2026-09-04).
   */
  repoRootFor?: (args: { taskId: string; projectId: string | undefined; assignedTopicId: string | null }) => string | null;
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

/**
 * Run git in `cwd`, capturing stdout/stderr/exit. Never throws (code 1 on spawn
 * failure) and disables the credential prompt so a push that needs auth fails
 * fast instead of hanging the request.
 */
async function runGitCap(cwd: string, args: string[], timeoutMs: number = SPAWN_TIMEOUT.write): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = spawnBounded(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs,
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = (await p.exited) ?? 124;
    return { code, out, err };
  } catch (e) {
    return { code: 1, out: "", err: String((e as Error)?.message ?? e) };
  }
}

/**
 * I file che i commit PROPRI del task hanno toccato — la base su cui si derivano
 * `visibile`/`invisibile` e il GENERE della card.
 *
 * PROPRI e non `main...HEAD`: un ramo nato dall'HEAD di un checkout condiviso
 * eredita i commit di chi ci stava sopra, e su quei file la regola risponde alla
 * domanda di un'altra card. Ricostruendo a mano la coda dell'11/08, le due basi
 * davano risposte diverse su 6 card su 29 — fra cui una ricerca che aveva
 * prodotto un solo `.md` e che, letta sul ramo intero, sembrava toccare 83 file
 * di client.
 *
 * `--name-status` e non `--name-only`: il path dice DOVE sta il file, non se è
 * nato qui, e senza quel flag `deriveKind` non può separare una funzionalità
 * nuova da una modifica a codice che esisteva già.
 *
 * `null` = non contabile (niente worktree, git muto): chi chiama non scrive
 * niente. `[]` = verificato, nessun file — che NON è invisibilità (vedi
 * `deriveCloser`): una card senza codice è una DECISIONE, e la chiude un umano.
 */
export async function ownCommitFiles(cwd: string, mainRef = "main"): Promise<TaskFile[] | null> {
  const head = await runGitCap(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.code === 0 ? head.out.trim() : "";
  if (!branch || branch === "HEAD") return null; // detached: non c'è un ramo di cui dire "suo"
  const commits = await listOwnCommits(cwd, branch, { mainRef, runGit: gitRunner });
  if (commits === null) return null;
  const outputs: string[] = [];
  for (const sha of commits) {
    const r = await runGitCap(cwd, ["show", "--name-status", "--format=", "--no-renames", sha]);
    if (r.code !== 0) return null;
    outputs.push(r.out);
  }
  return mergeNameStatus(outputs);
}

/** Adattatore fra `runGitCap` e la firma del runner di `own-commits.ts`. */
const gitRunner = async (cwd: string, args: string[]) => {
  const r = await runGitCap(cwd, args);
  return { code: r.code, stdout: r.out, stderr: r.err };
};

/** `/api/all-boards/publish-status` answers from here for a short while; a publish empties it. */
const PUBLISH_STATUS_TTL_MS = 30_000;
let publishStatusCache: { key: string; until: number; body: { projects: unknown[] } } | null = null;

/** Is this repository the one this server runs from (and serves `public/` of)? */
function isServerRepo(repoPath: string): boolean {
  try {
    return realpathSync(repoPath) === realpathSync(join(import.meta.dir, "..", ".."));
  } catch {
    return false;
  }
}

/** How many pre-review check runs may execute at once (see `createChecksGate`). */
function checksLanes(): number {
  const forced = Number(process.env.TOPICS_CHECKS_LANES);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  let cores = 0;
  try { cores = cpus().length; } catch { cores = 0; }
  return cores >= 12 ? 2 : 1;
}

/**
 * The only writes a GUEST may make on a shared task, and the minimum level
 * each needs - `read` moves nothing, `unsupported` covers every other route
 * on this router (run, stop, retitle, label, move, merge, land, publish,
 * deploy, ...): those stay out of reach at ANY level, because "start an
 * agent", "code changes", "approval" and "publishing" are distinct actions
 * that a collaboration capability never grants implicitly.
 *
 * `/run` has its own result because it is checked against a separate,
 * owner-issued capability. `/stop` remains unsupported: start does not confer
 * lifecycle or owner powers.
 *
 * Pure and testable on its own: `idInPath` is the EXACT segment read from
 * the path (still url-encoded), so comparing against `pathname` does not
 * need a second regex here.
 */
export function matchGuestTaskAction(
  pathname: string,
  idInPath: string,
  method: string,
): "read" | "comment" | "edit" | "run" | "unsupported" {
  const base = `/api/tasks/${idInPath}`;
  if (method === "GET") return pathname === base ? "read" : "unsupported";
  if (method === "POST" && pathname === `${base}/comments`) return "comment";
  if (method === "POST" && pathname === `${base}/run`) return "run";
  if (method === "PATCH" && pathname === base) return "edit";
  return "unsupported";
}

export function createTasksRouter(ctx: AppContext, dispatcher?: TaskDispatcher, opts?: TasksRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, broadcastToTopicSubscribers, getTopicBySessionKey, isPathAllowed } = ctx;
  // La SCHEDA DI CONSEGNA (l'anteprima disegnata quando non ce n'e' nessuna)
  // si scrive sotto `<dati>/media/`, cioe' dentro l'allowlist che la serve.
  const svc = createTaskService(db, {
    writeDeliverySheet: makeSheetWriter(ctx.OPENCLAW_DIR),
    repoRootFor: opts?.repoRootFor,
    probeFor: opts?.probeFor,
    // The delivery note that waited on git lands after the PATCH broadcast:
    // the same second emit every other late `addComment` in this file makes.
    onLateDeliveryNote: (taskId, projectId) => {
      const noted = svc.get(taskId, { projectId })?.task;
      if (noted) broadcastToAll({ type: "task:updated", projectId, task: noted });
    },
  });
  const attempts = createTaskAttemptStore(db);

  /**
   * UN TITOLO LEGGIBILE, in sottofondo, per una card appena nata.
   *
   * VIVE QUI e non dentro una delle due rotte perche' i creatori sono DUE e
   * il difetto e' lo stesso per entrambi: la board (una persona che scrive o
   * detta) e `create_task` via MCP (un agente). La prima versione lo cablava
   * solo sulla rotta della board, e sul database vivo quella scelta lasciava
   * scoperti 267 titoli oltre gli 80 caratteri creati da agenti — il difetto
   * c'era, era solo meno visibile perche' lo schema MCP chiede «Task title /
   * one-line description» e di solito viene rispettato.
   *
   * In background per costruzione: la `create` risponde subito con la card e
   * il titolo migliore arriva un istante dopo via `task:updated`. Se il modello
   * non c'e' o risponde storto, non succede niente e resta il titolo di
   * partenza — un titolo e' una comodita', non puo' far fallire una card.
   */
  function titoloInSottofondo(task: { id: string; text: string; description: string | null }, projectId: string): void {
    void (async () => {
      try {
        const prov = opts?.namingProvider?.();
        if (!prov) return;
        const migliore = await titoloMigliore(prov, { text: task.text, description: task.description });
        if (!migliore) return;
        // Riletta PRIMA di scrivere: fra la chiamata al modello e qui (secondi)
        // qualcuno puo' aver rinominato la card a mano, e quella e' una scelta
        // esplicita che non si sovrascrive.
        const fresca = svc.get(task.id)?.task;
        if (!fresca || fresca.text !== task.text) return;
        const aggiornata = svc.update({
          taskId: task.id, actor: "agent", by: "system",
          projectId, patch: { text: migliore },
        });
        if (aggiornata) broadcastToAll({ type: "task:updated", projectId, task: aggiornata });
      } catch { /* un titolo e' una comodita': non fallisce mai la card */ }
    })();
  }


  // Il lato «risposta» dell'instradamento delle domande (board-ask-routing.ts).
  // Qui serve solo `deliver`: il commento con la domanda lo scrive l'altra
  // sponda, la gamba dell'attesa in routes/permission.ts.
  const askRouting = {
    db,
    comment: () => null,
    deliver: (sessionKey: string, answers: Record<string, string>) => deliverAnswer(sessionKey, answers),
  };

  /**
   * `tasks.project_id` is a BOARD id (`projectIdForPath(path)`), NOT the
   * `projects.id` record key, which is a UUID. A caller that passes the UUID
   * read from `GET /api/projects` — a reasonable and wrong choice — gives
   * birth to the task on a board nobody reads: the kanban grows a second
   * column showing the raw UUID beside the real one, and nothing errors
   * anywhere. Translate the UUID to the board it actually belongs to.
   *
   * Only a UUID that really exists in `projects` is translated; any other id
   * passes through untouched, so legacy boards whose id happened to equal
   * `projects.id` keep working (see `server/lib/tab-resolver.ts`).
   */
  function boardIdFromProjectRowId(projectId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return projectId;
    try {
      const row = db.query("SELECT path FROM projects WHERE id = ?").get(projectId) as { path?: string } | null;
      if (row?.path) return projectIdForPath(row.path);
    } catch { /* best-effort: an untranslatable id stays as it is */ }
    return projectId;
  }

  /**
   * Project "Auto" → the REAL board. Resolve a known project name mentioned in
   * the task text. Exactly one distinct hit → that board (auto-assigned).
   * None/ambiguous → the catch-all workspace so the task STILL RUNS standalone
   * — a project-less task MUST dispatch (by request). The dispatcher only ticks
   * real boards, so the catch-all is a real (scaffolded, non-git, in-place)
   * board; its "generale" label is hidden client-side (the card treats it as
   * "no project"). Only a host with no workspace at all degrades to UNASSIGNED.
   *
   * Shared by create AND by the intake suggester: the proposal has to look at
   * the SAME board the task would be born on, or it would offer to link a
   * landing-feedback card to whatever sits on the wrong board.
   */
  function resolveBoardId(projectId: string, text: unknown, description: unknown): string {
    if (projectId !== AUTO_PROJECT_ID) return boardIdFromProjectRowId(projectId);
    const haystack = `${typeof text === "string" ? text : ""}\n${typeof description === "string" ? description : ""}`.toLowerCase();
    const hits = new Set<string>();
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    for (const raw of dirs) {
      if (typeof raw !== "string" || !raw.startsWith("/")) continue;
      const path = raw.replace(/\/+$/, "");
      const name = basename(path).toLowerCase();
      if (name.length < 3) continue; // too generic to be a mention
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(haystack)) hits.add(projectIdForPath(path));
    }
    if (hits.size === 1) return [...hits][0];
    if (!opts?.workspaceDir) return UNASSIGNED_PROJECT_ID; // degraded host (no workspace)
    const dir = join(opts.workspaceDir, "generale");
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "CLAUDE.md"), "# generale\n\nWorkspace catch-all: i task senza progetto girano qui, in-place (non-git).\n");
        // Non-git → dispatch in-place (no worktree). Nothing else to set: a
        // fresh board defaults autoDispatch on, so a project-less task starts
        // without any manual setup.
        svc.updateBoardSettings(projectIdForPath(dir), { dispatchUseWorktree: false });
      } catch { /* fall through to unassigned below */ }
    }
    return existsSync(dir) ? projectIdForPath(dir) : UNASSIGNED_PROJECT_ID;
  }

  /**
   * Land a task's branch on main (merge locally, reap the worktree, rebuild the
   * client if it changed). ON-DEMAND — this used to ride on every approve, which
   * meant approving a task also merged/built "da sotto". Now approve just accepts
   * the task; landing is an explicit human step (a "Landa su main" quick-reply the
   * agent offers, or the /land endpoint / button). Non si chiama MAI diretta: si
   * passa da `enqueueLand`, che la mette in fila per progetto e le dà un ticket —
   * una git lenta non blocca chi chiama, ma l'esito non si perde più. Tutti gli
   * esiti finiscono anche come commenti di sistema.
   * NEVER pushes (the release/publish pipeline stays the sole pusher).
   */
  /**
   * Reap the task's worktree ONLY when the land can be shown to have worked —
   * the same guard the periodic GC applies (`decidePostLandReap`), so the manual
   * "Landa su main" path can't destroy what the sweep would have protected.
   * Both halves matter: uncommitted work in the tree (task `e8780726`) and a
   * branch whose content never reached main (the `watching`-phase loss).
   */
  async function reapAfterLand(taskId: string, outcome: LandOutcome): Promise<void> {
    if (!opts?.deleteTaskWorktree) return;
    const [dirtProbe, branchAfter] = await Promise.all([
      opts.taskWorktreeDirtProbe?.(taskId).catch(() => null) ?? Promise.resolve(null),
      opts.taskBranchStatus?.(taskId).catch(() => "unmerged" as BranchStatus) ?? Promise.resolve(null),
    ]);
    // No branch worktree to reason about (in-place task) → nothing to reap.
    if (dirtProbe === null && branchAfter === null) return;
    const post = decidePostLandReap({
      outcome,
      branchAfter: branchAfter ?? "gone",
      dirtAfter: dirtProbe?.paths ?? [],
      dirtReadable: dirtProbe === null ? undefined : dirtProbe.ok,
    });
    // `free-checkout` — liberare la cartella tenendo il branch — è una decisione
    // che QUESTO percorso non esegue, di proposito. La passata periodica agisce
    // su task chiusi che nessuno guarda; qui l'umano ha appena premuto «Landa su
    // main» su una card ancora in review, e portargli via la cartella sotto le
    // dita (con magari una shell aperta dentro) mentre legge perché il land non
    // è passato non fa risparmiare spazio: fa perdere il filo. Il contratto è
    // uno — `decidePostLandReap` — ma l'autorità di distruggere no.
    if (post.action === "keep" || post.action === "free-checkout") {
      const nota = post.action === "free-checkout"
        ? " Il GC libererà la cartella (conservando il branch) quando il task sarà chiuso."
        : "";
      svc.addComment({
        taskId, author: "system",
        content: `⚠️ Worktree NON ripulito: ${post.reason}. Il branch del task è stato conservato. Recupera il lavoro o cancellalo a mano.${nota}`,
      });
      return;
    }
    const reaped = await opts.deleteTaskWorktree(taskId).catch(() => false);
    if (reaped) svc.addComment({ taskId, author: "system", kind: "service", content: "Worktree e branch del task ripuliti." });
  }

  /**
   * The same reap, on the OTHER side: the draft pull requests the card's
   * deliveries opened and the branches they pushed to origin.
   *
   * `reapAfterLand` above has always cleaned the local half - worktree and local
   * branch - and nothing ever cleaned the remote one: until 17/09/2026 the whole
   * tree had no `gh pr close` and no `push --delete`, so origin carried 41
   * `topics/*` branches with 39 of them already inside `main`. Now that every
   * delivery into review opens a draft (121 entries in 7 days) the drafts pile up
   * at the same rate, so the three doors where the branch is finished for good -
   * a confirmed land, an approval marked `superseded`, an archived card - sweep it.
   *
   * PLURAL, because a card delivers on MORE THAN ONE BRANCH. Every delivery that
   * goes through the checks gate pushes the branch of ITS OWN worktree and opens
   * its own draft (`awaitCiEvidence` takes `port.branch(cwd)`), while the card
   * remembers only the last one in `delivery_branch`. On the live DB: 151 cards
   * carry two or more distinct attempt branches, 104 of them also have a
   * `delivery_branch`, and 83 branches belong to a `delivered` attempt that is
   * NOT the card's delivery branch. Sweeping one branch per card would leave
   * exactly those 83 behind - the very loss T4.2 exists to stop.
   *
   * `landed` - the branch the merge actually carried onto main - is the ONLY one
   * whose pull request is left alone: GitHub marks it MERGED itself once main is
   * pushed. Every other branch of the card will never land, so its draft is
   * closed here or never.
   *
   * NOT on a plain approval and NOT on a rejection: an approval that does not land
   * leaves real work on that branch and a rejection sends the agent back to the
   * same branch to deliver again.
   *
   * Best-effort by contract. A `gh` that is logged out, rate-limited or missing
   * must never turn a land into a failure: the problems go to the log, and the
   * card gets a receipt only for what actually happened.
   */
  async function sweepRemoteDelivery(
    projectId: string, taskId: string, reason: string,
    over?: { cwd?: string | null; landed?: string | null; extra?: Array<string | null | undefined> },
  ): Promise<void> {
    const task = svc.get(taskId, { projectId })?.task;
    const landed = (over?.landed ?? "").trim();
    let tried: Array<string | null | undefined> = [];
    try { tried = attempts.list(taskId).map((a) => a.branch); } catch { /* best-effort */ }
    const branches: string[] = [];
    for (const raw of [landed, task?.deliveryBranch, ...(over?.extra ?? []), ...tried]) {
      const b = (raw ?? "").trim();
      if (b && !branches.includes(b)) branches.push(b);
    }
    if (!branches.length) return;
    let cwd = over?.cwd ?? null;
    if (!cwd) {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      cwd = dirs.find((d) => projectIdForPath(d) === projectId) ?? null;
    }
    if (!cwd) return;
    const close = opts?.closeDelivery ?? ((i: CloseCiDraftInput) => closeCiDraft(i));
    const did: string[] = [];
    for (const branch of branches) {
      const done = await close({ cwd, branch, reason, closePr: branch !== landed }).catch((err) => {
        console.warn(`[land] remote cleanup threw for ${taskId} on ${branch}:`, err);
        return null;
      });
      if (!done) continue;
      if (done.problems.length) console.warn(`[land] remote cleanup for ${taskId} on ${branch}: ${done.problems.join("; ")}`);
      const half = [
        done.pr ? `chiusa la bozza #${done.pr.number}` : null,
        done.branchDeleted ? `cancellato il ramo \`${branch}\` su origin` : null,
      ].filter(Boolean).join(" e ");
      if (half) did.push(half);
    }
    // THE RECEIPT SAYS ONLY WHAT HAPPENED. With `gh` logged out both halves come
    // back false and the card would otherwise read «Pulizia su GitHub: .» - a
    // line that claims a cleanup nobody did, on the one path this code is built
    // to survive.
    if (!did.length) return;
    try {
      svc.addComment({ taskId, author: "system", kind: "service", content: `Pulizia su GitHub: ${did.join("; ")}.` });
      const fresh = svc.get(taskId, { projectId })?.task;
      if (fresh) broadcastToAll({ type: "task:updated", projectId, task: fresh });
    } catch (err) { console.warn(`[land] remote cleanup receipt not written for ${taskId}:`, err); }
  }

  /**
   * Butta il workspace di un tentativo perdente: worktree + branch + riga di
   * store (via manager), poi la chat dell'agente che ci lavorava.
   *
   * L'ordine conta e non è simmetrico: un topic vivo su un worktree potato è una
   * sessione congelata su una cartella che non esiste più — lo stesso modo in cui
   * il reap orfanava un topic il 23/07. Archiviare per ultimo significa che, se
   * la cancellazione del worktree fallisce, resta almeno una chat che punta a
   * qualcosa di vero. Best-effort in entrambi i passi: la scelta del vincitore
   * non può fallire perché git ha singhiozzato su un perdente.
   */
  async function reapAttemptWorkspace(a: TaskAttempt): Promise<void> {
    if (a.worktreeId) {
      try { await ctx.worktreeManager.delete(a.worktreeId); }
      catch (err) { console.error(`[attempts] reap worktree ${a.worktreeId}`, err); }
    }
    if (!a.topicId) return;
    try {
      const topic = ctx.getTopicById(a.topicId);
      if (!topic || topic.archived) return;
      const at = new Date().toISOString();
      topic.archived = true;
      topic.updatedAt = at;
      ctx.saveSingleTopic(topic);
      broadcastToAll({ type: "topic:archived", topic });
      // And to the attention state, like the other archive paths: a lit attempt goes idle now, not at the next restart.
      setClosed(topicSubject(topic.id), { archived: true });
      // Il fatto (`services/retirement.ts`) accanto al flag. Questa e' la QUARTA
      // strada che alza `archived` da sola: non la si riscrive qui — il ritiro
      // per intero e' `archiveTopicFully` — ma senza il timbro il ritiro di un
      // tentativo perdente sarebbe invisibile alla query che risponde «cosa e'
      // aperto», che e' precisamente il guasto che si sta chiudendo.
      recordRetirement(ctx.db, "topic", topic.id, at, "attempt-reap");
    } catch (err) { console.error(`[attempts] archive topic ${a.topicId}`, err); }
  }

  /**
   * Snapshot what was delivered, on the edge INTO `review`. The branch is reaped
   * the moment the task lands, so the branch NAME cannot be the handle the audit
   * holds onto: the commit can (git keeps unreachable objects 90 days here).
   * Without this the board's "done" is a column, not a claim about main — which
   * is exactly how 139 lines were lost on 19/07 without anyone noticing.
   * Best-effort: a git hiccup must never refuse a delivery.
   */
  /**
   * La fotografia e le etichette stanno in `services/task-delivery-capture.ts`:
   * ne esistevano tre copie e la terza — quella del dispatcher — mancava, cioe'
   * la consegna forzata dal sistema diceva «nessun ramo» su card che avevano
   * committato. Qui resta solo il CANCELLO sull'edge: si fotografa quando la
   * card ENTRA in review, non a ogni PATCH su una card che c'e' gia'.
   */
  const capturaConsegna = createDeliveryCapture({
    svc,
    taskDeliveryRef: opts?.taskDeliveryRef,
    taskCheckoutRef: opts?.taskCheckoutRef,
    ownCommitFiles: (cwd) => ownCommitFiles(cwd),
  });

  async function captureDelivery<T extends { id: string; status: string }>(task: T, prevStatus?: string): Promise<T> {
    if (task.status !== "review" || prevStatus === "review") return task;
    await capturaConsegna(task.id);
    // Return the REFRESHED row so the response and the broadcast already carry
    // the snapshot — otherwise the board only learns about it on a refetch.
    return (svc.get(task.id)?.task as T | undefined) ?? task;
  }

  /**
   * Sonda l'output_url in background (fire-and-forget) e aggiorna il DB +
   * manda un delta WS ai client. Non blocca la richiesta corrente.
   *
   * - Con cache TTL (5 min): non ri-sonda su ogni accesso alla card.
   * - Solo se il task ha un output_url.
   * - Il client usa `urlProbeStatus` per decidere se mostrare il link.
   */
  function triggerUrlProbe(taskId: string, outputUrl: string | null, projectId?: string): void {
    if (!outputUrl) return;
    void (async () => {
      try {
        const result = await probeUrl(outputUrl);
        const updated = svc.setUrlProbeStatus({ taskId, status: result.status, checkedAt: result.checkedAt });
        // Broadcast il delta ai client connessi (come gli altri update in questo file).
        if (projectId) {
          broadcastToAll({ type: "task:updated", projectId, task: updated });
        }
      } catch (err) {
        console.warn("[url-probe] background probe failed", taskId, err);
      }
    })();
  }


  /**
   * Le corse dei check, una per task, VIVE oltre la richiesta che le ha chieste.
   * Sta nella chiusura della rotta (non è un singleton di modulo) perché muore
   * con l'istanza: due server nello stesso processo, due registri, come per la
   * fila dei land qui sotto.
   */
  // TWO RUNS AT ONCE ON A BIG MACHINE. One run at a time was the right
  // default when every agent also ran the whole suite by itself; since the
  // envelope stopped that (2026-09-04) a run costs ~6-8 load for ~7 minutes,
  // and with six agents delivering in the same quarter hour a single lane
  // meant 40+ minutes of queue for the last one - past the 50-minute cap (now 100) of
  // `update_task`. Two lanes on twelve cores keep the load under ~20 and halve
  // the queue; smaller machines keep the one lane. `TOPICS_CHECKS_LANES`
  // overrides either way.
  const checksGate = createChecksGate({ maxConcurrent: checksLanes() });
  // Notifica il chiamante non appena il gate esiste, cosi' puo' passarne
  // `runningCount` al dispatcher senza accoppiamenti circolari.
  // `settleDelivery` is a hoisted declaration below: the hook only stores the
  // reference, and nothing calls it before the router is finished being built.
  try { opts?.onChecksGate?.(checksGate, { settleDelivery: (taskId) => settleDelivery(taskId) }); } catch { /* best-effort */ }

  // WITHOUT A PREDICATE, and only here: this is the one instant when the gate's
  // registry is EMPTY by construction, so every «running» left in the database
  // belongs to a dead process. The periodic sweep (`sweepStaleChecksLights` in
  // server.ts) asks the same question every 30 s, but it has to pass the live
  // registry - the bare call there would switch off a run that is grinding.
  try {
    const spente = svc.clearStaleChecksRuns();
    if (spente.length) console.warn(`[checks] ${spente.length} spie 'running' spente: erano di un processo morto`);
  } catch { /* una spia non deve poter impedire al server di partire */ }

  /**
   * Terzo gate strutturale sulla review, dopo il commit (`review_needs_commit`) e
   * il riassunto (`review_needs_summary`): i comandi dichiarati sulla board devono
   * essere VERDI. Non si chiede all'agente se ha fatto girare i test — si fanno
   * girare, nel suo worktree, sul codice che ha appena committato.
   *
   * Ritorna `null` quando il gate non si applica (board senza comandi, task senza
   * worktree di branch): "nessun check" non è un verde e non deve scriverne uno.
   *
   * L'AGENTE ASPETTA, LA RICHIESTA NO. Il gate girava dentro questa richiesta, e
   * la richiesta durava quanto i comandi: misurato il 13/08, `test:unit` da solo
   * ci mette ~10 minuti su macchina carica, ma il socket muore a 255,6s netti
   * perché `idleTimeout` di Bun non sale oltre 255. Esito: transizione persa e
   * `checks_state` fermo su «running» per sempre. Adesso la corsa vive nel
   * registro (`services/checks-gate.ts`) e questa funzione aspetta al massimo UNA
   * GAMBA: `{ pending: true }` significa "sta ancora girando, richiama" ed è il
   * client MCP a rimettersi in fila, esattamente come fa per `ask_user_question`.
   *
   * Il resto della semantica è quello di prima, e volutamente: il task NON entra
   * in review mentre i comandi girano (il reviewer vedrebbe una consegna
   * guardabile a verdetto ignoto), e un rosso torna all'agente con l'output.
   */
  /**
   * A DELIVERY WHOSE CLIENT GAVE UP STILL LANDS ITS VERDICT.
   *
   * The checks run in the registry and the status moves only when a leg comes
   * back with the verdict - and the leg is the MCP client polling every 25 s,
   * for at most 100 minutes (`CHECKS_MAX_LEGS`). On 2026-09-04 at 12:37 three
   * cards resumed together, delivered at once, and sat in the gate's slot
   * queue past that cap: `update_task` threw, each agent ended its turn saying
   * "consegnato", the checks finished green minutes later and NOBODY applied
   * them. The cards stayed in_progress, the dispatcher read the turns as
   * "closed without review" and spent an attempt each.
   *
   * So the route remembers the delivery it answered 202 to, and when the run
   * ends it re-issues that same PATCH to itself: green moves the card to
   * review exactly as a client leg would, red leaves the comment the run
   * already wrote. The client's polling becomes a courtesy, not a condition.
   */
  const pendingDeliveries = new Map<string, { pathname: string; body: Record<string, unknown> }>();

  /**
   * AND IT OUTLIVES THE PROCESS, since 2026-09-16.
   *
   * The map above only ever had to survive a client giving up. Now it has to
   * survive the server too: a delivery whose checks are only WAITING no longer
   * holds a planned reload back (`cardTurnsHoldingReload` in lib/quiescence.ts),
   * and cutting it is only free if it comes back by itself. The row is written
   * beside every `set` and removed beside every `delete`; the map stays the fast
   * path, the table is read once at boot.
   */
  function rememberDelivery(taskId: string, pathname: string, body: Record<string, unknown>): void {
    pendingDeliveries.set(taskId, { pathname, body });
    savePendingDelivery(ctx.db, {
      taskId, pathname, body,
      // THE COMMIT OF *THIS* ROUND, not of the last one measured.
      //
      // It used to be `svc.get(taskId).task.checksCommit`, which is whatever
      // the previous round recorded, and a delivery that never started a round
      // wrote it anyway: `runChecksGate` answers `interrupted` to a leg that
      // arrives while the server is on its way out BEFORE it resolves a
      // checkout, so the row got the old commit. If that stale commit happened
      // to be the worktree HEAD (a redelivery with no new commit of its own),
      // at boot `sameDelivery` read "same delivery" and skipped the realign
      // entirely - the checks then measured a base main had moved away from,
      // which is the 2026-09-04 regression the block at `runChecksGate`
      // describes, while the log claimed "nessun riallineamento in più".
      //
      // `roundCommit` is written by the round itself, once its checkout is
      // known, and only a round that got that far can claim "already realigned".
      commit: roundCommit.get(taskId) ?? null,
    });
  }

  function forgetDeliveryMemo(taskId: string): void {
    pendingDeliveries.delete(taskId);
    roundCommit.delete(taskId);
    forgetPendingDelivery(ctx.db, taskId);
  }

  /**
   * What the round in flight is measuring: the commit its checkout was on when
   * it started, AFTER the realign. Written by `runChecksGate` once it has a
   * ref, dropped when a verdict is recorded - so "no entry" means "this
   * delivery never got as far as realigning", and the round that restarts it
   * has to realign.
   */
  const roundCommit = new Map<string, string | null>();

  /**
   * The deliveries a previous process was in the middle of, recognised by their
   * commit: the round they restart is the SAME delivery, so it does not realign
   * on main again (`sameDelivery` in `runChecksGate`). An entry lives until a
   * verdict is recorded for that card, exactly like the row.
   */
  const restoredDeliveries = new Map<string, string | null>();

  /**
   * THE CHAT SEES THE WAIT TOO. The card shows «2/5» (`checksProgress`); the
   * agent's thread showed a mute `update_task` spinning for the whole bar, and
   * from there the topic looked stuck: on 05/09/2026 three card turns sat 20-60
   * minutes in this exact wait while the person asked, three times, why the
   * topics were still. Each pending leg pushes ONE line into the running tool
   * call of the agent's live stream, on the channel bash already uses for its
   * partial output (`stream:tool_update`): ephemeral, never persisted, skipped
   * when there is no live stream or no running tool to hang it on. The clock
   * starts at the first pending leg, so the queue behind another card counts.
   */
  const checksWaitSince = new Map<string, number>();
  function tellChatAboutChecksWait(
    sessionKey: string,
    topicId: string | null,
    taskId: string,
    projectId: string,
    task: { checksProgress?: { done: number; total: number } | null } | undefined,
  ): void {
    try {
      const since = checksWaitSince.get(taskId) ?? Date.now();
      checksWaitSince.set(taskId, since);
      const stream = ctx.activeStreams.get(sessionKey);
      if (!stream) return;
      const running = ctx.getMessageById(stream.messageId)?.toolCalls?.find((tc) => tc.status === "running");
      if (!running) return;
      const declared = svc.getBoardSettings(projectId).reviewChecks;
      const progress = task?.checksProgress ?? null;
      const partialResult = formatChecksWait({
        done: progress ? progress.done : null,
        total: progress?.total ?? declared.length,
        checks: declared,
        elapsedMs: Date.now() - since,
      });
      const message = { type: "stream:tool_update" as const, sessionKey, topicId: topicId ?? undefined, toolCallId: running.id, partialResult };
      if (topicId) broadcastToTopicSubscribers(topicId, message);
      else broadcastToAll(message);
    } catch { /* a courtesy line: it must never stop the leg */ }
  }

  function settleDelivery(taskId: string, attempt = 0): void {
    const pending = pendingDeliveries.get(taskId);
    if (!pending) return;
    // The run's promise settles a microtask after `run` returns; a timer is
    // enough to land after it, and a run still marked live simply waits.
    setTimeout(() => {
      if (checksGate.isRunning(taskId)) {
        if (attempt < 20) settleDelivery(taskId, attempt + 1);
        return;
      }
      // The map entry goes, the ROW stays: the re-issued PATCH writes it again
      // if the round is still going, and removes it once there is a verdict. A
      // process that dies in between finds the delivery again at its next boot.
      if (!pendingDeliveries.delete(taskId)) return;
      reissueDelivery(taskId, pending.pathname, pending.body, "client andato");
    }, attempt === 0 ? 0 : 250);
  }

  /** The remembered PATCH, sent back through the router's own front door. The
   *  leg is short: nobody is waiting on this answer, the card and the thread are. */
  function reissueDelivery(taskId: string, pathname: string, body: Record<string, unknown>, why: string): void {
    const url = new URL(`http://localhost${pathname}`);
    const req = new Request(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, legMs: 1_000 }),
    });
    tasksRouter(req, url, pathname, "PATCH")
      .then((resp) => console.log(`[Tasks] consegna di ${taskId.slice(0, 8)} completata dal server (${why}): HTTP ${resp?.status ?? "nessuna risposta"}`))
      .catch((err) => console.warn(`[Tasks] consegna di ${taskId.slice(0, 8)}: il PATCH riemesso dal server è fallito:`, err));
  }

  /**
   * How many times a boot restarts the SAME round before saying so instead.
   *
   * Three, and the arithmetic is the round's own: a round with the CI rows
   * costs the local commands (typecheck measured at 73-177 s, plus lint,
   * deadcode and the static rails) and then up to 65 minutes of polling
   * GitHub, while a save under `server/` sends a SIGTERM that cuts it - 6
   * restarts in the 14/09T23 hour, 4 in the T20 one, 1-2 an hour all through
   * 16/09. Three whole rounds thrown away is already more wall clock than one
   * round ever gets, so a fourth silent attempt is not patience, it is a loop.
   */
  const MAX_DELIVERY_ROUNDS = 3;

  /**
   * The round is not restarted a fourth time: the card is told, once.
   *
   * The row goes with it, because leaving it would restart the count at the
   * next boot and write the same line again. Nothing else is touched - the card
   * stays `in_progress`, the branch and the commit are where the agent left
   * them - since what unblocks this is a person or a new delivery, not another
   * round nobody watches.
   */
  function giveUpOnDelivery(taskId: string, rounds: number): void {
    forgetPendingDelivery(ctx.db, taskId);
    console.warn(`[Tasks] consegna di ${taskId.slice(0, 8)}: ${rounds} giri di check ripartiti da zero senza verdetto, il giro non riparte`);
    try {
      const task = svc.get(taskId)?.task;
      if (!task) return;
      svc.addComment({
        taskId, author: "system", kind: "comment",
        content:
          `I check di questa consegna sono ripartiti da zero ${rounds} volte senza arrivare a un verdetto: ` +
          "ogni riavvio del server taglia il giro (i comandi locali durano minuti, le righe CI aspettano la pull request) " +
          "e ricominciarlo non ha misurato niente. Il giro non riparte piu' da solo: serve un commit nuovo da consegnare, " +
          "oppure una persona che guardi perche' questo giro non arriva in fondo.",
      });
      const t = svc.get(taskId)?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId: t.projectId, task: t });
    } catch { /* the card may have moved under us: the log line above stays */ }
  }

  /**
   * THE DELIVERIES THE PREVIOUS PROCESS WAS STILL WAITING ON.
   *
   * A planned reload no longer waits for a delivery whose checks are only
   * waiting (`cardTurnsHoldingReload`), and the swap brake already cut rounds
   * without a verdict. Either way the round is gone and nothing else would
   * bring the delivery back: the agent's turn died with the process, and its
   * `update_task` with it. So the server re-issues each remembered PATCH, once,
   * as the same delivery — the commit is carried into `restoredDeliveries`, so
   * the round measures the tree it already realigned instead of merging main a
   * second time.
   *
   * ONLY FOR A CARD THAT IS STILL DELIVERING. The filter used to be "not in
   * review, not done, not gone", which let through every card that had left
   * `in_progress` by another door: the «Ferma» button parks it in `backlog`
   * (`release({requeue:false})`), the dispatcher's boot reconcile requeues an
   * orphan to `todo`. The re-issue then ran the WHOLE round for it — tsc,
   * eslint, `bun test`, vite launched by nobody on the Mac that had just
   * rebooted for lack of memory, which is the exact resource this change
   * defends — wrote `checks_state = 'pass'` and a service comment on a parked
   * card, and only the final transition was refused with a 409, suite already
   * run. A green badge on a delivery that never happened.
   */
  function resumePendingDeliveries(): void {
    let entries: PendingDelivery[] = [];
    try { entries = loadPendingDeliveries(ctx.db); } catch { entries = []; }
    for (const entry of entries) {
      if (!stillDelivering(entry.taskId)) {
        forgetPendingDelivery(ctx.db, entry.taskId);
        // One line per row dropped, because "my card never resumed its checks"
        // is a question somebody asks, and the rows in flight at a shutdown are
        // a handful, not a stream.
        console.warn(`[Tasks] consegna di ${entry.taskId.slice(0, 8)} dimenticata al boot: la card non è più in lavorazione, nessun check lanciato`);
        continue;
      }
      // COUNTED BEFORE IT RESTARTS, because the round that follows may well be
      // cut by the next save under `server/` and never be counted at all.
      const round = bumpPendingDeliveryRound(ctx.db, entry.taskId);
      if (round > MAX_DELIVERY_ROUNDS) {
        giveUpOnDelivery(entry.taskId, round);
        continue;
      }
      restoredDeliveries.set(entry.taskId, entry.commit);
      pendingDeliveries.set(entry.taskId, { pathname: entry.pathname, body: entry.body });
      // A tick, not a microtask: the router is still being built, and the
      // re-issue goes back in through `tasksRouter`.
      setTimeout(() => {
        // Asked again, at the moment of the action: this sweep runs while
        // `createTasksRouter` is still being built (server.ts), and the
        // dispatcher's boot reconcile — which requeues the orphans of the
        // killed process — only runs its first pass later, asynchronously. A
        // card requeued in between must not get a round either.
        if (!stillDelivering(entry.taskId)) {
          pendingDeliveries.delete(entry.taskId);
          restoredDeliveries.delete(entry.taskId);
          forgetPendingDelivery(ctx.db, entry.taskId);
          console.warn(`[Tasks] consegna di ${entry.taskId.slice(0, 8)} dimenticata: la card non è più in lavorazione, nessun check lanciato`);
          return;
        }
        if (!pendingDeliveries.delete(entry.taskId)) return;
        // Said HERE and not in the sweep above: a line that announces a resume
        // must only be printed by a resume that happens.
        console.warn(
          `[Tasks] consegna di ${entry.taskId.slice(0, 8)} ripresa dopo il riavvio: i check ripartono ` +
          (entry.commit
            ? `sullo stesso commit (${entry.commit.slice(0, 7)}), nessun riallineamento in più`
            : "con un riallineamento su main: il giro tagliato non era arrivato a farlo"),
        );
        reissueDelivery(entry.taskId, entry.pathname, entry.body, "riavvio del server");
      }, 0);
    }
  }

  /**
   * Is this card still the one that delivered? `in_progress` is the only status
   * a delivery can come back to: review and done are past it, backlog and todo
   * are a card someone took back. `archived` is not a status here — an archived
   * card answers nothing from `get`, which the missing-task arm covers.
   */
  function stillDelivering(taskId: string): boolean {
    let task: Task | undefined;
    try { task = svc.get(taskId)?.task; } catch { return false; }
    return !!task && task.status === "in_progress";
  }

  async function runChecksGate(
    taskId: string,
    projectId: string,
    legMs: number,
  ): Promise<ChecksLeg> {
    if (!opts?.taskCheckoutRef) return null;
    let checks: ReviewCheck[] = [];
    try { checks = svc.getBoardSettings(projectId).reviewChecks; } catch { return null; }
    if (!checks.length) return null;
    // A server on its way out starts no round: the realign below would run a
    // merge in the worktree that the exit can cut in half, and the round would
    // be interrupted before its first command anyway. The leg is HELD for its
    // length, like a leg with a round in flight, so the socket close answers it
    // and the client retries that silence within its grace. Answered at once,
    // the client calls again in a tight loop for the whole exit (~3.5 s of
    // provider grace), and every call spends one of its legs.
    if (reviewChecksStopping()) {
      await Bun.sleep(legMs);
      return { interrupted: true };
    }
    // THE CHECKS MEASURE THE TREE THAT LANDS. On 2026-09-04 three cards
    // (4c4ac437, 882f81b9, c8039b35) burnt a turn each on an "inherited" red:
    // a bloat baseline main had already moved while their branch sat on an
    // older base. The land realigns before merging; the checks now do the
    // same before measuring, once per delivery. "Once per delivery" is read
    // off the gate: a run in flight, or a retained verdict for the commit the
    // worktree is on, means the legs of the same delivery; anything else is a
    // new delivery and main may have moved since (8db353ac, 2026-09-04: a
    // redelivery measured on a base ten commits behind because the key was
    // merely "known"). A realign that cannot happen - conflict, dirty tree -
    // IS the verdict: not a single command runs, and the agent gets the file
    // list instead of a timeout.
    const before = await opts.taskCheckoutRef(taskId).catch(() => null);
    // A round the swap brake interrupted restarts as the SAME delivery: realigned
    // again, two `git merge main` in one worktree (a server re-issue and a client
    // leg) race on index.lock and write a failed realign as a red.
    //
    // So does a round the RESTART cut. The registry of the dead process is
    // gone, so nothing in memory can say "same delivery": the row says it, by
    // the commit the round was measuring. The worktree is still on the tree the
    // first realign produced, and merging main into it again would write a
    // second merge commit into a delivery nobody re-made. A row whose commit is
    // null says "this round never got as far as a checkout": it matches only a
    // worktree whose own HEAD is unreadable, where a realign has nothing to
    // merge into anyway - and `roundCommit` is what keeps that null honest.
    const restoredCommit = restoredDeliveries.get(taskId);
    const sameDelivery = checksGate.isRunning(taskId) || checksGate.verdictFor(taskId, before?.commit ?? null)
      || swapInterruptedDelivery(taskId, before?.commit ?? null)
      || (restoredDeliveries.has(taskId) && restoredCommit === (before?.commit ?? null));
    if (opts.realignForChecks && !sameDelivery) {
      const re = await opts.realignForChecks(taskId)
        .catch((err): RealignOutcome => ({ ok: false, reason: `riallineamento fallito: ${err instanceof Error ? err.message : String(err)}` })); // allow-italian: board notes are written in Italian like every other service comment
      if (!re.ok) {
        const comment =
          `**Riallineamento su main fallito, check non partiti**: ${re.reason}. ` + // allow-italian: board notes are written in Italian like every other service comment
          "Nel worktree fai `git merge main`, risolvi, committa, poi rimetti in review con update_task(status=\"review\")."; // allow-italian: board notes are written in Italian like every other service comment
        try {
          svc.recordChecks({
            taskId, state: "fail", commit: null,
            runs: [{ name: "realign", cmd: "git merge main", ok: false, code: 1, ms: 0, timedOut: false, tail: re.reason }],
          });
          svc.addComment({ taskId, author: "system", kind: "comment", content: comment });
          const t = svc.get(taskId, { projectId })?.task;
          if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
        } catch { /* the verdict counts more than its record */ }
        return { ok: false, comment };
      }
      if (re.note) {
        try { svc.addComment({ taskId, author: "system", kind: "service", content: `Riallineato su main prima dei check: ${re.note}` }); } // allow-italian: board notes are written in Italian like every other service comment
        catch { /* a trace, not the gate */ }
      }
    }
    const ref = await opts.taskCheckoutRef(taskId).catch(() => null);
    if (!ref) return null;
    // Past the realign, on a known checkout: from here on THIS is the commit
    // the delivery is measuring, and the one a restart has to carry over.
    roundCommit.set(taskId, ref.commit ?? null);
    // The CI evidence rows never reach a shell: they are read after the local commands.
    const localChecks = checks.filter((c) => !isCiEvidenceCheck(c));
    const ciChecks = checks.filter(isCiEvidenceCheck);

    const measure = async (lane: ChecksLane) => {
      // 'running' subito e in broadcast: i comandi possono durare minuti e una
      // board ferma senza spiegazioni si legge come "si è impiantato".
      try {
        const t = svc.recordChecks({
          taskId, state: "running", commit: ref.commit, runs: null,
          // Zero su N: la spia si accende gia' sapendo QUANTI comandi
          // aspettano, cosi' la card dice «0/4» invece di «in corso».
          progress: { done: 0, total: checks.length },
        });
        broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch { /* il gate vale anche senza la spia */ }

      /* IL PROGRESSO SI RIPORTA A OGNI COMANDO FINITO.
       *
       * `onProgress` c'era gia' in `runReviewChecks` e non lo usava nessuno:
       * i comandi giravano uno per uno e la card diceva «check in corso»
       * dall'inizio alla fine. Segnalato: «vedo che c'e' qualcosa in corso,
       * ma se c'e' qualcosa in corso dovrebbe esserci un progress».
       *
       * Best-effort come la spia qui sopra: se la scrittura fallisce il gate
       * continua: un progresso mancato non deve poter fermare una consegna. */
      const runs = await runReviewChecks(localChecks, {
        cwd: ref.cwd,
        // So a run frozen for load can say so in THIS card's thread.
        taskId,
        commit: ref.commit,
        // No new command starts under the memory floor (see `MemoryFloor`).
        memoryFloor: opts?.checksMemoryFloor,
        onProgress: (_run, i) => {
          try {
            const t = svc.recordChecks({
              taskId, state: "running", commit: ref.commit,
              // I run PARZIALI viaggiano con lui: un comando gia' rosso si
              // vede subito nel drawer, invece di aspettare la fine del giro.
              runs: null,
              progress: { done: i + 1, total: checks.length },
            });
            broadcastToAll({ type: "task:updated", projectId, task: t });
          } catch { /* una spia persa non ferma il gate */ }
        },
      });
      if (ciChecks.length && runs.length === localChecks.length && runs.every((r) => r.ok)) {
        // Waiting on GitHub holds no CPU: give the lane to the next card's run.
        lane.release();
        // A reader that throws measured nothing: NOT MEASURED, like its own
        // docstring promises. Left to the gate, the exception became the `null`
        // of a run that blew up, which the delivery reads as "no gate at all",
        // and the card entered review with no e2e verdict. Only a shutdown
        // passes through, as the interrupted outcome it already has.
        const unread = (reason: string) => ciChecks.map((c) => ciNotMeasured(c, reason));
        /* THE WAIT ON GITHUB IS NOT A MUTE WAIT.
         *
         * The pull request and its run exist within seconds of the push, and
         * used to reach the card only inside the tail of the verdict — measured
         * on run 35158365969, from 22:34:48 to 22:49:48: a quarter of an hour in
         * which the card said «check 1/2» and nothing that could be opened.
         * Best-effort like every other lamp of this round: a link that fails to
         * be written must not be able to stop a delivery. */
        const onCiWait = (links: { prUrl: string; runUrl?: string }) => {
          try {
            const t = svc.recordChecks({
              taskId, state: "running", commit: ref.commit, runs: null,
              progress: { done: localChecks.length, total: checks.length }, ci: links,
            });
            broadcastToAll({ type: "task:updated", projectId, task: t });
          } catch { /* a link lost does not stop the gate */ }
        };
        const ciRuns = ref.commit && opts?.ciEvidence
          ? await opts.ciEvidence({ cwd: ref.cwd, sha: ref.commit, taskId, checks: ciChecks, onCiWait }).catch((err: unknown) => {
            if (err instanceof ChecksInterruptedError) throw err;
            return unread(`the CI evidence reader failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          : unread(ref.commit ? "no CI evidence reader on this server" : "the worktree has no commit");
        // One row per declared CI check, whatever the reader answered.
        runs.push(...ciChecks.map((c) => ciRuns.find((r) => r.cmd === c.cmd) ?? ciNotMeasured(c, "the CI evidence reader returned no row for it")));
        throwIfStopping();
      }
      const ok = runs.length === checks.length && runs.every((r) => r.ok);
      const comment = formatChecksComment(runs, { commit: ref.commit });
      const threadSummary = formatChecksThreadSummary(runs, { commit: ref.commit });
      try {
        // TRE ESITI, non due. `checksVerdict` e' lo stesso predicato che sceglie
        // la parola del commento: uno SCADUTO non ha misurato niente, e
        // marcarlo `fail` manda chi rivede a cercare un guasto che non c'e'.
        // Misurate il 18/08 sul DB vivo: 6 card su 15 marcate rosse erano solo
        // scadute. `checks` e' l'elenco DICHIARATO — se ne sono tornati meno,
        // qualcuno non e' arrivato in fondo.
        svc.recordChecks({ taskId, state: checksVerdict(runs, checks.length), commit: ref.commit, runs });
        forgetDelivery(taskId);
        // Measured: whatever brought this delivery back, it is no longer a
        // delivery of a dead process, and its next leg is a NEW one.
        restoredDeliveries.delete(taskId);
        roundCommit.delete(taskId);
        // Green is service bookkeeping; red is a visible outcome. The thread
        // keeps only the compact verdict and first failure. Commands and logs
        // remain in checks_json, rendered by the expandable ChecksSection.
        svc.addComment({ taskId, author: "system", kind: ok ? "service" : "comment", content: threadSummary });
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch { /* l'esito conta più della sua registrazione */ }
      settleDelivery(taskId);
      return { ok, comment };
    };

    return checksGate.leg(taskId, {
      commit: ref.commit ?? null,
      legMs,
      run: async (lane) => {
        try {
          return await measure(lane);
        } catch (err) {
          // Interrupted for swap: no verdict, and nothing else would restart the
          // round if no client leg comes back. The remembered PATCH is re-issued
          // once the key is gone, and its first command waits for the swap to end.
          if (err instanceof ChecksInterruptedError && err.reason === "swap") setTimeout(() => settleDelivery(taskId), 0);
          throw err;
        }
      },
    });
  }

  /**
   * Taglia il turno VIVO di una card: ferma il processo dell'agente e chiude i
   * tentativi in corso. Non tocca lo stato — dove finisce la card lo decide chi
   * chiama (parcheggiata dal bottone «Ferma», chiusa da un land riuscito).
   *
   * `false` = non c'era niente da tagliare, e chi chiama può smettere lì.
   *
   * Chi chiama DEVE aver già scritto lo stato finale: la fine del turno passa da
   * `onTurnEnd`, che su una card ancora `in_progress` RIPRENDE l'agente
   * (`shouldResume` è vero per tutto tranne un rifiuto del modello). Tagliare
   * prima di chiudere la card significa quindi farla ripartire — su `done` la
   * stessa strada si limita a spegnere il chip.
   */
  function cutLiveTurn(
    t: { id: string; assignedTopicId: string | null; dispatchState: string | null },
    reason: string,
    // A person's Stop on the card is `user`; the machine closing it is not (card C9).
    cause: StopCause,
  ): boolean {
    let running: TaskAttempt[] = [];
    try { running = attempts.list(t.id).filter((a) => a.state === "running"); }
    catch { /* tabella assente (host degradato) ⇒ nessun fan-out */ }
    if (!t.assignedTopicId && !isAgentWorking(t.dispatchState) && running.length === 0) return false;
    // Dedup: il tentativo 1 è anche il topic legato al task.
    const keys = new Set<string>();
    for (const id of [t.assignedTopicId, ...running.map((a) => a.topicId)]) {
      if (id) keys.add("topic:" + id.slice(0, 8));
    }
    dispatcher?.onLeaveTodo(t.id); // sgancia un grace timer ancora pendente (queued)
    for (const a of running) {
      try { attempts.finish(a.id, { state: "failed", error: reason }); }
      catch { /* best-effort: il taglio del turno conta più della riga */ }
    }
    // Tree first, turn second: see `killAgentTree`'s doc for why the order is
    // load-bearing, not cosmetic.
    if (opts?.killAgentTree) {
      for (const key of keys) void opts.killAgentTree(key).catch(() => { /* best-effort */ });
    }
    if (opts?.abortTurn) {
      for (const key of keys) void opts.abortTurn(key, cause).catch(() => { /* best-effort */ });
    }
    return true;
  }

  /**
   * La fila dei land, una per progetto: le fusioni toccano tutte main nello
   * stesso checkout, quindi vanno in ordine. Il punto NON è che siano in fila —
   * `task-automerge` già serializzava le sue operazioni git — è che chi arriva
   * mentre una è in corso adesso si ACCODA con un ticket interrogabile, invece
   * di essere una promise fluttuante che nessuno tiene (`void landTask(...)`).
   */
  const landings = opts?.landings ?? createLandingQueue({ log: (m) => console.warn(m) });

  /**
   * Accoda il land di una card e restituisce il suo ticket (subito, senza
   * aspettare git). Ogni percorso che atterra una card passa da qui: il bottone
   * «Landa», la quick-reply dell'agente, e il trascinamento in Done.
   */
  function enqueueLand(projectId: string, taskId: string): LandingTicket {
    // PRIMA di accodare, non dopo: fra l'accodamento e la fusione la card non è
    // su main, e in quella finestra deve dirlo.
    try { opts?.markLandPending?.(taskId); } catch (err) { console.warn("[land] timbro di attesa fallito per", taskId, err); }
    // LA RICHIESTA LASCIA UNA TRACCIA, e non è un lusso: il 13/08 tre card sono
    // passate a `done` col ramo mai arrivato su main e nel thread — come nel log
    // del server — non c'era una riga sul tentativo. La coda vive in memoria,
    // quindi un riavvio fra l'accodamento e la fusione se la porta via: quella
    // riga è tutto ciò che resta a dire che un land era stato chiesto.
    try {
      svc.addComment({
        taskId, author: "system",
        // Ricevuta interna, e il commento qui accanto lo dice: esiste perché la
        // coda vive in RAM e un riavvio la perderebbe. È un log, non una parola.
        kind: "service",
        content: "Land accodato: la card si chiude solo quando il merge è CONFERMATO su main.",
      });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch (err) { console.warn("[land] traccia della richiesta non scritta per", taskId, err); }
    return landings.enqueue(projectId, taskId, () => landTask(projectId, taskId));
  }

  /**
   * REACHING DONE IS NOT PRESSING "LANDA": the board has a switch, and it has
   * to be read.
   *
   * Every entry into Done of a card carrying a delivery branch queued a merge
   * into main. Not just approval: the drag and the "Sposta in" menu too, two
   * gestures nobody performs in order to merge. The comment next to it claimed
   * the board had already decided this via `dispatchAutoMerge`, but on this
   * path nobody read that field. Measured on 13/08 against the live board db:
   * of the 137 "Mergiato su main" notes, 8 sit on boards whose switch is off
   * today (cifra, armonia-site, quadra, and one board with no settings row at
   * all, which defaults to off). Historical rows cannot prove what the switch
   * said at the time, which is why the count is stated as what it is and no
   * more; the structural fact needs no count, and a grep gives it: outside this
   * function `dispatchAutoMerge` had exactly one production reader, the
   * worktree GC.
   *
   * Off ⇒ no merge, and the card SAYS SO: a mute closure with the code still on
   * the branch is exactly the 10/08 fault in its silent form. The explicit
   * "Landa su main" button still goes through `enqueueLand` directly: that one
   * is a person's choice, not a side effect.
   */
  function enqueueLandOnDone(projectId: string, taskId: string, branch: string): LandingTicket | null {
    let autoMergeOn = true;
    // Failing to read the settings must not merge "because we did not know":
    // the careful direction is to NOT touch main.
    try { autoMergeOn = svc.getBoardSettings(projectId).dispatchAutoMerge; }
    catch (err) { console.warn("[land] board settings unreadable for", projectId, err); autoMergeOn = false; }
    if (autoMergeOn) return enqueueLand(projectId, taskId);
    try {
      svc.addComment({
        taskId, author: "system",
        content:
          // The note quotes the switch by the words printed next to it
          // (`board.settings.autoMerge` in client/src/lib/i18n.ts) and the
          // button by the words printed on it (`board.action.land`, the single
          // action table): a note that names a control the reader cannot find is
          // a note that gets ignored. Both are pinned by a test in
          // server/routes/tasks.test.ts, so renaming either label there fails
          // here rather than quietly drifting.
          "Chiusa SENZA fondere: il merge automatico è spento per questa board " +
          `(impostazioni della board, «Fondi su main quando la card arriva in Done»). Il lavoro resta sul branch \`${branch}\`. ` +
          "Per portarlo su main premi «Landa su main» sulla card, oppure fondilo a mano: " +
          `\`git merge --no-ff ${branch}\`.`,
      });
    } catch (err) { console.warn("[land] skipped-merge note not written for", taskId, err); }
    // THE NOTE HAS TO REACH THE CARD THAT IS OPEN RIGHT NOW. The PATCH handler
    // that called us already broadcast `task:updated` with the task as it was
    // BEFORE this comment, and `addComment` bumps `updated_at` precisely so a
    // live client refetches the thread (Card.tsx keys its comment effect on
    // `task.updatedAt`). Without a second broadcast the note exists only in the
    // db: a closure that looks exactly as mute as the one this whole function
    // exists to stop. Every other `addComment` in this file re-emits.
    const noted = svc.get(taskId, { projectId })?.task;
    if (noted) broadcastToAll({ type: "task:updated", projectId, task: noted });
    // AND THE WAY OUT THE NOTE NAMES HAS TO EXIST. "Landa su main" on a `done`
    // card is drawn by ONE surface: the "chiuso ma non su main" banner, behind
    // `landingState === 'unlanded'` — and `recordDelivery` blanks that column,
    // so it sits at NULL until the periodic audit runs, up to 30 minutes later
    // (LANDING_AUDIT_INTERVAL_MS). A note that names a button which is not
    // there for half an hour hands out a chore instead of a way out, which is
    // the exact defect the banner was built to close.
    //
    // So ASK, don't assert: "ask" makes the audit compute the verdict from the
    // repo now. Claiming `unlanded` outright would be a guess (the branch may
    // already be in main by someone else's hand), and a guess written as a
    // witnessed fact is how `landing_state` lied before.
    void (async () => {
      try { await opts?.stampLanding?.(taskId, "ask"); } catch { /* the verdict is best-effort: it must not break the close */ }
      const stamped = svc.get(taskId, { projectId })?.task;
      if (stamped) broadcastToAll({ type: "task:updated", projectId, task: stamped });
    })();
    return null;
  }

  /**
   * «Il commit di fusione è su main?» — con la prova che manca trattata come un
   * no, mai come un sì. Una verifica che esplode (`throw`) o che non esiste su
   * questo host non è un'assoluzione: vale `null`, cioè «non lo so», e da lì il
   * verdetto non può diventare `landed`.
   */
  async function landProof(repoPath: string, commit: string): Promise<boolean | null> {
    if (!opts?.confirmLandedOnMain) return null;
    try { return await opts.confirmLandedOnMain(repoPath, commit); }
    catch (err) { console.warn("[land] verifica su main fallita per", commit, err); return null; }
  }

  /**
   * «NON C'ERA NIENTE DA ATTERRARE» NON È UNA CHIUSURA, ed è la sola regola che
   * tiene: solo un merge CONFERMATO su main toglie una card da review. Un land
   * senza ramo, o su un ramo che non porta commit che main non abbia, non ha
   * portato niente da nessuna parte — magari il lavoro è già di là per mano di
   * qualcun altro, magari non è mai esistito. Le due cose si distinguono
   * guardando, e a guardare è l'umano: la card resta dov'è con scritto perché.
   *
   * Chiuderla qui sarebbe di nuovo far dire allo stato una cosa che nessuno ha
   * visto — il difetto del 13/08 con un'altra maschera. Su una card già chiusa
   * (il land partito dal trascinamento in Done) non c'è niente da spiegare.
   */
  function explainNothingToLand(projectId: string, taskId: string, reason: string): void {
    const cur = svc.get(taskId, { projectId })?.task;
    if (!cur || cur.status !== "review") return;
    try {
      svc.addComment({
        taskId, author: "system",
        content:
          `Niente da atterrare: ${reason}. Non è stato fuso niente, quindi la card resta in review. ` +
          "Se il lavoro è già su main (o non ce n'era), approvala tu; altrimenti guarda il ramo e rilancia «Landa su main».",
      });
      const fresh = svc.get(taskId, { projectId })?.task;
      if (fresh) broadcastToAll({ type: "task:updated", projectId, task: fresh });
    } catch (err) { console.warn(`[land] nota «niente da atterrare» non scritta per ${taskId}:`, err); }
  }

  async function landTask(projectId: string, taskId: string): Promise<LandOutcomeResult | void> {
    const autoMerge = opts?.autoMerge;
    if (!autoMerge) {
      svc.addComment({ taskId, author: "system", content: "Landing non disponibile: merge automatico non configurato per questo host." });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      // Il MOTIVO sul ticket, non la frase per una persona: quella e' il commento
      // qui sopra, e resta italiana. Questo campo esce solo da GET .../land, dove
      // lo legge chi diagnostica, ed e' inglese come gli altri esiti di questa
      // rotta ("task not found", "workspace not configured").
      return { outcome: "skipped", reason: "auto-merge not configured on this host" };
    }
    const task = svc.get(taskId, { projectId })?.task;
    // La card è sparita fra il click e il suo turno in coda (archiviata, spostata
    // di board). Non è un esito da nascondere: `throw` lo porta sul ticket, che è
    // l'unico posto dove chi ha chiesto il land può ancora leggerlo.
    if (!task) throw new Error(`task ${taskId} non trovato su questa board: land annullato`);
    try {
      const res = await autoMerge.tryMerge(taskId, task.text, {
        branch: task.deliveryBranch ?? null,
        commit: task.deliveryCommit ?? null,
      });
      // Il ramo era vecchio e il land l'ha riportato al passo con main da sé: è
      // un commit che nessun umano ha fatto, quindi lo si dice — e per PRIMO,
      // perché è successo prima di tutto il resto.
      // ...and what that costs. What landed is C2 = merge(C, main), and the
      // checks - the local commands AND the two CI rows - measured C. Nobody
      // reads the CI of C2: the push, the draft and the poll loop all happened
      // once, on C, hours earlier (1,93 h in review on average, 32 lands in 7
      // days). So the note says which commit those verdicts describe, and
      // `checks_commit` stops naming a commit as if it were the one that landed.
      // Measured on 17/09: 22 of those 32 lands carry this line and only 4 also
      // warned that the land differed from the delivery - 18 said nothing.
      //
      // NOT a merge queue. Re-pushing C2 and re-reading its CI costs 15-40
      // minutes per land and is the owner's call, not this line's: what changes
      // here is only that the card stops claiming more than it measured.
      if (res.status === "merged" && res.realigned) {
        const before = svc.get(taskId, { projectId })?.task;
        const measured = before?.checksState && before.checksState !== "running"
          ? before.checksCommit ? `\`${before.checksCommit.slice(0, 8)}\`` : "il commit consegnato"
          : null;
        svc.addComment({
          taskId, author: "system", kind: "service",
          content: `Riallineato prima del land: ${res.realigned}.`
            + (measured
              ? ` I check (comandi locali e righe CI) hanno misurato ${measured}, non la fusione che sta atterrando: nessuno li ha rimisurati su quest'ultima.`
              : ""),
        });
        try { svc.clearChecksCommit(taskId); } catch (err) { console.warn(`[land] checks_commit non azzerato per ${taskId}:`, err); }
      }
      // Ciò che è atterrato non era lo scatto approvato: chi ha cliccato «Landa»
      // deve leggerlo, altrimenti crede di aver pubblicato quello che ha visto.
      // Prima del «Mergiato»: la riga che spiega vale solo se si legge per prima.
      const drift = res.status === "merged" || res.status === "nothing" ? res.deliveryDrift : null;
      if (drift) {
        svc.addComment({ taskId, author: "system", content: `⚠️ Land ≠ consegna: ${drift}.` });
      }
      // ── SI CHIEDE A MAIN, non al merge ─────────────────────────────────────
      //
      // `git merge` uscito zero è un resoconto: dice che una fusione è riuscita,
      // non DOVE. Da qui in giù «merged» vale solo insieme alla prova, e la
      // prova è che il commit di fusione sia dentro l'integrazione.
      const proof = res.status === "merged" ? await landProof(res.repoPath, res.commit) : null;
      if (res.status === "merged" && proof === false) {
        // Il caso che chiude questo difetto: la macchina crede di aver landato,
        // main dice di no. La card NON si chiude, il worktree NON si pota (è
        // l'unica copia del lavoro) e il verdetto dice il vero.
        const proofReason = `il merge e' uscito zero ma il commit ${res.commit} NON risulta su main in ${res.repoPath}`;
        svc.addComment({
          taskId, author: "system",
          content:
            `⚠️ Land NON confermato: il merge è uscito zero ma il commit \`${res.commit}\` NON risulta su main in \`${res.repoPath}\`. ` +
            "La card resta dov'è e il branch è stato conservato. Controlla su quale ramo è il checkout, poi rilancia «Landa su main».",
        });
        try { await opts?.stampLanding?.(taskId, "unlanded"); } catch { /* la spia non fa fallire il resto */ }
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
        return { outcome: "unlanded", reason: proofReason };
      }
      if (res.status === "merged") {
        if (proof === null) {
          svc.addComment({
            taskId, author: "system",
            content:
              "⚠️ Il merge è uscito zero ma non ho potuto RILEGGERE main per confermarlo: la card è chiusa, " +
              "il verdetto di atterraggio resta «non verificabile». Controlla a mano se il lavoro è su main.",
          });
        }
        svc.addComment({ taskId, author: "system", kind: "service", content: `Mergiato su main (commit ${res.commit}).` });
        // THIS is where the card's review life ends, not at the start of the
        // land: the preview is torn down once the merge is confirmed. Tearing it
        // down before attempting the merge took the live page away from the
        // reviewer even when the land then failed and the card came back to
        // them (idempotent).
        try { await opts?.teardownPreview?.(taskId); } catch { /* best-effort */ }
        // The OTHER side of the same defect. The land promoted to `done` only
        // when coming from `review` (`POST …/land` does that before calling
        // here): from every other state it merged and left the card where it
        // was. Measured on 11/08 on `4ec47331`: work on main (`a5f83e0e`), card
        // `in_progress` with the `working` chip, and an agent that spent a whole
        // turn redoing it. A successful merge is the strongest possible claim
        // that the work is finished: the status must say so, whatever state we
        // came from. Idempotent on cards already closed and still (the normal
        // case), so it adds no history rows to the path that already worked.
        const closed = svc.settleLanded({ taskId, by: "system", reason: `landed: the code is on main (${res.commit})` });
        // THE MERGE HAPPENED EVEN WHEN THE CARD DOES NOT CLOSE. `settleLanded`
        // refuses to close a parent that still has open steps (closing it would
        // make them unreachable: the feed is `rootsOnly`), and without this line
        // whoever clicked "Landa su main" would read "Mergiato su main" above a
        // card that stays in review, with no idea why. The steps are named: they
        // are the ones to close or archive before approving the card.
        if (closed && closed.status !== "done") {
          const aperti = (svc.get(taskId, { projectId })?.children ?? [])
            .filter((c) => c.status !== "done")
            .map((c) => `«${c.text}»`);
          if (aperti.length) {
            svc.addComment({
              taskId, author: "system",
              content:
                `Il lavoro è su main, ma la card NON si chiude: restano ${aperti.length} sottotask aperti (${aperti.join(", ")}). ` +
                "Chiudili o archiviali, poi approva questa card.",
            });
          }
        }
        // Whoever was WAITING on this card finds out here, no longer at
        // approval: this is now the door through which a landed card reaches
        // `done`.
        if (closed && closed.status === "done") dispatcher?.onBlockerDone(taskId);
        // ...and if an agent was still WORKING on that card, it gets stopped.
        // Closing the card removes it from the queue but does not cut the turn
        // already under way, and that is where the money goes: measured on
        // 11/08 on two consecutive lands, $5,64 (`4ec47331`) and $8,24
        // (`56677242`, stopped within a minute) spent redoing work that was
        // already on main. Not an edge case: it happened on two lands out of
        // two, and the bill grows with every land.
        //
        // AFTER `settleLanded`, never before: the end of the turn goes through
        // `onTurnEnd`, which RESUMES the agent on a card still `in_progress`.
        // Cutting before closing the card would make it start again.
        if (closed && cutLiveTurn(closed, "il lavoro di questa card è atterrato su main: il turno non serve più", "superseded")) {
          svc.addComment({
            taskId, author: "system",
            content: "Fermato l'agente che stava ancora lavorando su questa card: il suo lavoro è appena atterrato su main.",
          });
        }
        await reapAfterLand(taskId, "landed");
        // The remote half of that same reap. Here, and not at the approval, for
        // the reason the whole land path is built on: the branch is finished only
        // once main has been RE-READ and confirms it. `proof === null` - the
        // merge exited zero and main could not be re-read - keeps the branch on
        // origin, because that is the one case where the comment above already
        // asks a person to go and look.
        //
        // `landed: res.branch` LEAVES THAT ONE PULL REQUEST ALONE, and this is
        // the whole reason the flag exists. `confirmLandedOnMain` re-reads the
        // LOCAL main (`server.ts`), and nothing in this server ever pushes main:
        // when the sweep runs, `origin/main` does not have the merge yet and a
        // person pushes it seconds to hours later. GitHub then marks that pull
        // request MERGED by itself - measured on #78, 17/09/2026, a minute after
        // the land. A `gh pr close` racing that push would stamp "Closed" on the
        // ~32 cards that land in a week instead. The card's OTHER branches, which
        // no push will ever merge, are closed here.
        //
        // NOT AWAITED, and that is the difference between housekeeping and a
        // stop-the-world. `landTask` runs inside `landings.enqueue`, ONE land at
        // a time per project, while this sweep is `gh pr list` + `git push
        // --delete` per branch with a 60 s cap each. On the live DB the worst
        // card carries 11 branches: with `gh` logged out or rate-limited an
        // awaited sweep turned a 3-minute queue into a 22-minute one for every
        // OTHER card waiting behind it, and 124 archived cards carry attempt
        // branches that never delivered, so those calls buy nothing at all.
        // Nothing downstream reads its result - the receipt it writes is its own
        // comment - and the two other doors (superseded approval, archive)
        // already call it exactly like this.
        if (proof === true) {
          void sweepRemoteDelivery(projectId, taskId, `Closed by the Topics board: the card landed on main as ${res.commit} from another branch, this one will not land.`,
            { cwd: res.repoPath, landed: res.branch })
            .catch((err) => console.warn(`[land] remote cleanup after a land failed for ${taskId}:`, err));
        }
        if (res.landedNotLive) {
          // Landed on main, but the shared checkout (the live server's cwd) is parked
          // on another branch — so the code is on main yet NOT running. Say it loudly:
          // rebuilding/relaunching off the shared checkout would build the WRONG branch,
          // so we skip those steps and tell the human exactly what to do to activate it.
          svc.addComment({
            taskId, author: "system",
            content: `⚠️ Landato su main ma NON ancora attivo: il server di produzione gira dal checkout fermo su '${res.checkoutBranch}', non su main. Per attivarlo riporta quel checkout su main (git switch main) oppure fai girare il server da un checkout dedicato su main.`,
          });
        } else {
          // THE REBUILD IS FOR THE APP THIS SERVER SERVES, not for every repo
          // with a `client/` folder: a dancerooms land got "Client NON
          // servibile: manca dancerooms/public/index.html" on 2026-09-04.
          const servesFromHere = isServerRepo(res.repoPath);
          if (res.touchedClient && servesFromHere) {
            const t2 = svc.get(taskId, { projectId })?.task;
            if (t2) broadcastToAll({ type: "task:updated", projectId, task: t2 });
            const build = await autoMerge.buildClient(res.repoPath);
            svc.addComment({
              taskId, author: "system",
              // Riuscita ⇒ ricevuta; fallita ⇒ parola, perché chiede un comando
              // all'umano. Stessa regola dei checks: non conta chi scrive, conta
              // se cambia cosa fai.
              kind: build.code === 0 ? "service" : "comment",
              content: build.code === 0
                ? "Client ricostruito: la modifica è visibile (hard refresh se non appare)."
                : build.artifact
                  // A build can exit 0 and leave nothing behind: on 29/08
                  // `public/assets/` stayed empty and `index.html` was gone,
                  // while the card said "rebuilt". When the artifact is still
                  // not there after two attempts the card says so - what is
                  // broken is the thing people see.
                  ? `⚠️ Client NON servibile dopo due build: manca ${build.artifact}. L'app serve da \`public/\`: lancia \`bun run build:client\` e guarda l'errore.`
                  : `Build client fallita (exit ${build.code}). Lancia \`bun run build:client\` a mano.`,
            });
            if (build.code !== 0) console.error("[land] build:client failed for", taskId, build.artifact ?? build.stderr.slice(-2000));
          }
          if (res.touchedNative && servesFromHere) {
            svc.addComment({ taskId, author: "system", content: "Il landing tocca desktop-tauri/: per vederlo nel shell nativo serve un rebuild dell'app (cargo build + relaunch)." });
          }
          if (res.touchedServer && servesFromHere) {
            svc.addComment({ taskId, author: "system", kind: "service", content: "Il landing tocca il server: andrà live al prossimo reload del server (hot-reload watch attivo, o riavvio manuale)." });
          }
        }
      } else if (res.status === "nothing") {
        // "nothing" = the branch has no commits main lacks BY ANCESTRY. That is
        // the exact claim that cost us the `watching` phase — verify it against
        // the repo (content, not ancestry) before destroying anything.
        await reapAfterLand(taskId, "nothing");
        explainNothingToLand(projectId, taskId, "il ramo non porta commit che main non abbia");
      } else if (res.status === "conflict") {
        // La card ESCE da `done`, e la riga di storico deve dire perché. Prima
        // diceva "user → In corso": la stessa riga che scrive un umano quando
        // ritira una consegna a mano — mentre qui l'umano aveva cliccato
        // "Landa su main" e il ritiro è della macchina. `by: "system"` mette la
        // firma giusta, `statusReason` la causa; il commento sotto resta perché
        // porta l'istruzione all'agent, non la sola causa.
        // `actor: "human"` è l'asse dei PERMESSI (nessun agente potrebbe
        // riportare indietro un task chiuso), non quello dell'attribuzione.
        //
        // DUE conflitti diversi, e all'agente servono due istruzioni diverse. Il
        // land prova prima a riportare main DENTRO il ramo vecchio: se è lì che
        // si è rotto, il lavoro non è «pubblicare» ma «riconciliare», e i file
        // in conflitto sono già noti — dirglieli gli risparmia di riscoprirli.
        const rc = res.realignConflict;
        const files = rc?.files ?? [];
        const elenco = files.length > 0 ? files.slice(0, 20).join(", ") : "nessun file elencabile";
        svc.update({
          taskId, actor: "human", by: "system", projectId,
          patch: { status: "in_progress" },
          statusReason: rc
            ? `riportare main nel ramo (indietro di ${rc.behind}) ha fatto conflitto`
            : "il land ha fatto conflitto con main",
        });
        svc.addComment({
          taskId, author: "system",
          content: rc
            ? `Il ramo era indietro di ${rc.behind} commit su main e riportare main dentro il ramo ha fatto conflitto su ${files.length} file: ${elenco}. Non ho landato niente. Rimando all'agent per riconciliare.`
            : "Merge automatico in conflitto con main. Rimando all'agent per risolvere.",
        });
        dispatcher?.resume(
          taskId,
          rc
            ? `Il tuo ramo è indietro di ${rc.behind} commit su main e il land ha provato a riportare main dentro il ramo: ha fatto CONFLITTO su questi file: ${elenco}. Nel tuo worktree fai \`git merge main\`, risolvi quei file (non ce ne sono altri: il merge è stato annullato, quindi riparti da zero), committa la fusione, poi rimetti in review con update_task(status="review"). Il commit di consegna resta un antenato del ramo, quindi il land ripartirà da solo dalla punta. Resta vietato toccare main: niente push, niente merge verso main.`
            : 'Il merge automatico del tuo branch su main è andato in conflitto. Rifai la BASE del tuo ramo sul main aggiornato (`git fetch` se serve, poi `git rebase main`), NON un merge di main dentro il ramo: risolvi i conflitti durante la rebase, ricommitta, poi rimetti in review con update_task(status="review"). Resta vietato toccare main: niente push, niente merge verso main.',
        ).catch((err) => console.warn(`[Tasks] resume after merge-conflict failed for ${taskId}:`, err));
      } else if (res.status === "skipped") {
        svc.addComment({ taskId, author: "system", content: `⚠️ Land NON riuscito: ${res.reason}. Il branch del task NON è su main. Risolvi e rilancia "Landa su main".` });
        // Il thread lo diceva onestamente e lo STATO diceva il contrario: la card
        // restava in Done col codice fuori da main, cioè nell'unica colonna che
        // nessuno riapre — e il GC dei worktree può potare quel ramo. Misurato
        // l'11/08 su `2e6964cb`. Ora un land fallito ritira la card, con la
        // causa nella riga di storico; l'unico `skipped` che la lascia chiusa è
        // «non c'era niente da atterrare».
        const cur = svc.get(taskId, { projectId })?.task;
        // The delivery commit decides whether a missing branch is a loss or a
        // no-op (see `landFallout`): an analysis card whose branch was reaped
        // after a "nothing to land" must be closable.
        const fall = landFallout(res.code, { deliveryCommit: cur ? (cur.deliveryCommit ?? null) : undefined });
        // Da `done` la card si RITIRA; da `review` non si è mai mossa (il land
        // non approva più prima di atterrare) e ci resta — tranne dove il
        // fallout la manda dall'agente, che è l'unico posto in cui c'è qualcosa
        // da fare. `no-branch` (`fall.status === null`) non è un fallimento:
        // non c'era niente da atterrare, e la card si accetta.
        if (!fall.status) {
          explainNothingToLand(projectId, taskId, "non c'era nessun ramo da atterrare");
        } else if (cur && (cur.status === "done" || cur.status === "review") && cur.status !== fall.status) {
          try {
            // `actor: "human"` è l'asse dei PERMESSI (nessun agente riporta
            // indietro un task chiuso); `by: "system"` è la firma vera, perché
            // a ritirarla è la macchina — stessa scelta del ramo `conflict`.
            svc.update({
              taskId, actor: "human", by: "system", projectId,
              patch: { status: fall.status },
              statusReason: fall.reason,
            });
          } catch (err) { console.warn(`[land] impossibile spostare ${taskId} dopo il land fallito:`, err); }
          if (fall.resume) {
            dispatcher?.resume(taskId, fall.resume)
              .catch((err) => console.warn(`[Tasks] resume after failed land for ${taskId}:`, err));
          }
        }
      }
      // ── The outcome is RECORDED now, not reconstructed later ─────────────
      //
      // `landingState` used to be written only by a pass every 30 minutes that,
      // given the delivery commit, tries to INFER whether its content is on
      // main. Two problems: the verdict arrived up to half an hour late (red on
      // work that had just landed), and the inference is wrong. Tried by hand
      // on 108 cards: the reverse patch gives 20 false alarms, the distinctive
      // line 5, and the "NON su main" message in the thread is there on cards
      // that landed fine too, because it is emitted at DELIVERY. The only proof
      // that holds is valid as long as the branch exists, that is, NOW.
      //
      // So here we write what the land HAS SEEN (`merged` = landed, failed =
      // not landed) and mark it witnessed, so the periodic pass skips it
      // instead of overwriting it with its inference. Only where the land does
      // not know (no branch to look at, or "there was nothing to bring over")
      // do we ask the repo.
      // portare») si chiede al repo.
      const verdict: LandingState | "ask" =
        res.status === "merged" ? (proof === true ? "landed" : "unverifiable")
        : res.status === "conflict" ? "unlanded"
        : res.status === "skipped" && res.code !== "no-branch" ? "unlanded"
        : "ask";
      try { await opts?.stampLanding?.(taskId, verdict); } catch { /* la spia non fa fallire un land */ }
      const updated = svc.get(taskId, { projectId })?.task;
      if (updated) broadcastToAll({ type: "task:updated", projectId, task: updated });
      // Hands the outcome back to the queue ticket: GET /land reports it right
      // away, without having to re-read the task through a second GET.
      // `verdict === "ask"` covers the cases where the land does not know (no
      // branch, or the branch was already on main): they map to "skipped" for
      // the MCP caller.
      const ticketOutcome: LandOutcomeResult['outcome'] =
        verdict === "ask" ? "skipped" : verdict;
      // The reason is only useful when the merge was refused: it is what the
      // MCP reports directly instead of leaving the caller to open the card's
      // thread.
      const ticketReason: string | null =
        verdict === "unlanded"
          ? (res.status === "conflict"
            ? (res.realignConflict
              ? `il ramo era indietro di ${res.realignConflict.behind} commit e il realign ha fatto conflitto`
              : "il merge ha fatto conflitto con main")
            : res.status === "skipped" ? (res.reason ?? null) : null)
          : null;
      return { outcome: ticketOutcome, reason: ticketReason };
    } catch (e) {
      // ── The path that produced "zero comments, zero reason" ────────────────
      //
      // This `catch` covered git, the comments, the worktree pruning and the
      // rebuild, and it covered them with a `console.error`. What whoever looks
      // at the board got was a card in Done with the code on its branch and a
      // thread that says nothing: the very state the "noisy" failed land
      // (`skipped`) learned to avoid, reached through the back door.
      //
      // Now an exception says three things, in the order they are needed: the
      // line in the thread, the `unlanded` verdict on the card, and the
      // withdrawal from Done, because a card closed on work that has not landed
      // is the one the worktree GC may prune. Then it RETHROWS: the queue
      // ticket is the only place where whoever pressed "Landa" can still read
      // how it went.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[land] failed for", taskId, e);
      try {
        svc.addComment({
          taskId, author: "system",
          content: `⚠️ Land NON riuscito (errore interno): ${msg}. Il branch del task NON è su main. Rilancia "Landa su main" quando la causa è risolta.`,
        });
      } catch (err) { console.warn("[land] impossibile commentare l'errore di", taskId, err); }
      try { await opts?.stampLanding?.(taskId, "unlanded"); } catch { /* la spia non fa fallire il resto */ }
      try {
        const cur = svc.get(taskId, { projectId })?.task;
        if (cur && cur.status === "done") {
          // `actor: "human"` è l'asse dei PERMESSI, `by: "system"` la firma vera:
          // stessa scelta dei rami `conflict` e `skipped`.
          svc.update({
            taskId, actor: "human", by: "system", projectId,
            patch: { status: "in_progress" },
            statusReason: "il land è fallito con un errore interno",
          });
        }
        const t = svc.get(taskId, { projectId })?.task;
        if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      } catch (err) { console.warn(`[land] impossibile ritirare ${taskId} da done:`, err); }
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  /**
   * Post-approve: PROPOSE a deploy, never run one. Mirrors `enqueueLandOnDone`'s
   * shape (a board setting gates an approve-time side effect) but the effect
   * itself stops one step earlier — a comment + a button, not a queued action.
   * No-op when the board has no `deployCommand` configured.
   */
  function proposeDeployIfConfigured(projectId: string, taskId: string): void {
    let cmd = "";
    try { cmd = (svc.getBoardSettings(projectId).deployCommand ?? "").trim(); }
    catch (err) { console.warn("[deploy] board settings unreadable for", projectId, err); return; }
    if (!cmd) return;
    try {
      const proposed = svc.proposeDeploy({ taskId, command: cmd });
      if (proposed) broadcastToAll({ type: "task:updated", projectId, task: proposed });
    } catch (err) { console.warn("[deploy] propose failed for", taskId, err); }
  }

  /**
   * Runs a CONFIRMED deploy in the project's own checkout (never a worktree —
   * the whole point is "the real thing", same target as `publishProject`).
   * Fire-and-forget from the route: the request already answered 202 with the
   * task in `running`; the outcome lands as a system comment + broadcast.
   */
  async function runDeploy(projectId: string, taskId: string, command: string): Promise<void> {
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    const cwd = dirs.find((d) => projectIdForPath(d) === projectId);
    const settle = (ok: boolean, detail: string) => {
      let t: Task;
      try { t = svc.finishDeploy({ taskId, ok, detail }); }
      catch (err) { console.warn("[deploy] finish failed for", taskId, err); return; }
      broadcastToAll({ type: "task:updated", projectId, task: t });
    };
    if (!cwd) { settle(false, "progetto non risolvibile su questo host: nessun checkout da usare."); return; }
    try {
      // 10 minutes: a deploy that does not return within this window is a stuck
      // deploy, not a slow one — better to say so than stay "running" forever.
      // `spawnBounded` and not a `setTimeout` + `kill()`: the shell's children kept
      // the pipe open after the kill and the deploy stayed "running" regardless.
      const p = spawnBounded(["bash", "-lc", command], {
        cwd, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 10 * 60 * 1000,
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const code = (await p.exited) ?? 124;
      const tail = (s: string) => s.trim().slice(-1500);
      const body = tail(err) || tail(out);
      const detail = `\`${command}\` (exit ${code})` + (body ? `\n\n\`\`\`\n${body}\n\`\`\`` : "");
      settle(code === 0, detail);
    } catch (e) {
      settle(false, `\`${command}\`: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Push a project's current branch to origin (triggers deploy CI where set up).
   *  Shared by the /publish endpoint and the agent-proposed "Landa e pubblica"
   *  option. Never resolves an unknown project — returns {ok:false}. */
  async function publishProject(projectId: string): Promise<{ ok: boolean; branch?: string; output?: string; error?: string; code?: string }> {
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    const path = dirs.find((d) => projectIdForPath(d) === projectId);
    if (!path) return { ok: false, error: "project not found", code: "not_found" };
    const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
    if (!branch) return { ok: false, error: "detached HEAD: nothing to publish.", code: "detached_head" };
    // 10 minutes: a pre-push hook (tests, lint) may run for minutes, and this push had
    // no deadline at all before T5. 120 s would turn a slow hook into a failed publish.
    const push = await runGitCap(path, ["push", "origin", branch], SPAWN_TIMEOUT.long);
    if (push.code !== 0) return { ok: false, branch, error: (push.err || push.out).trim().slice(-400) || "git push fallito" };
    return { ok: true, branch, output: (push.err + "\n" + push.out).trim().slice(-400) };
  }

  /**
   * SECURITY: attachment paths are stored AND later handed to the agent as
   * "read these files" — so they must pass the same allowlist that gates
   * serving them (/api/media: uploads, context, workspace/media dirs). Without
   * this, a comment could reference ~/.ssh/id_rsa and the resume message would
   * happily instruct the agent to read it. Anything outside the allowlist is
   * silently dropped (the comment itself still lands).
   */
  function filterMedia(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((m): m is string => {
      if (typeof m !== "string" || !m.startsWith("/")) return false;
      if (typeof isPathAllowed !== "function") return true; // test ctx without the helper
      try { return isPathAllowed(m); } catch { return false; }
    });
  }

  /**
   * Il valore da scrivere in `previewImage`, o il MOTIVO del rifiuto. Due
   * cancelli, non uno:
   *
   *  · il PATH, come per ogni allegato (`filterMedia`, allowlist di sicurezza);
   *  · il TIPO — deve esistere un elemento che lo mostri. `PREVIEW_RULE` ne
   *    ammette tre (screenshot .png, video, diagramma .svg) e questa è la stessa
   *    frontiera vista dal rendering.
   *
   * Il secondo mancava, ed è così che un `.pdf` è diventato l'anteprima di una
   * card: passava l'allowlist, arrivava al ramo `<img>` del client e si vedeva
   * un'icona rotta. Il 200 diceva «consegnato», la card non mostrava niente.
   *
   * Stringa vuota = azzera (gesto esplicito, resta valido).
   */
  function acceptPreview(raw: unknown): FieldRead {
    if (raw === null) return { ok: true, value: null }; // azzera, come la stringa vuota
    if (typeof raw !== "string") return { ok: false, reason: "atteso il path (string) di uno screenshot, video o diagramma" };
    if (raw.trim() === "") return { ok: true, value: "" };
    if (!filterMedia([raw])?.length) {
      return { ok: false, reason: "path outside the allowed folders (~/.topics/media, ~/.openclaw/media, workspace)" };
    }
    if (!isPreviewablePath(raw)) {
      return { ok: false, reason: "extension not previewable: it takes a .png/.jpg, a video or an .svg" };
    }
    // IL DEFAULT E' LA COSA VERA, non un si'.
    //
    // Il seam esiste perche' un test possa dire «fingi che ci sia»; il suo
    // valore di riposo pero' deve restare `existsSync`, altrimenti qualunque
    // AppContext costruito senza quel campo perde il cancello SENZA dirlo — e
    // un cancello che sparisce in silenzio e' peggio di uno che non c'e' mai
    // stato. Con `?? (() => true)` bastava dimenticare una riga di cablaggio
    // per tornare al difetto di partenza: una card che punta a un'anteprima
    // cancellata e una PATCH che risponde 200.
    const checkExists = ctx.fileExistsSync ?? existsSync;
    if (!checkExists(raw)) {
      return { ok: false, reason: `file not found on disk: ${raw}` };
    }
    // A BLANK IMAGE IS NOT EVIDENCE, and this gate holds even on an explicit
    // gesture. The shape gate below was removed BECAUSE the crop already does
    // its job — but a flat, uniform image has no job left for the crop to do:
    // no layout choice makes an empty screenshot show the work. `isBlankLikeImage`
    // is the same measured floor already used for the auto-captured path
    // (`preview-manager.ts`); a card that could not be measured (unknown
    // format, unreadable header) still passes, same as every other gate here.
    try {
      const shape = ctx.imageShapeOf?.(raw);
      if (
        shape &&
        isBlankLikeImage({
          bytes: statSync(raw).size,
          width: shape.width,
          height: shape.height,
          vector: shape.vector,
        })
      ) {
        return { ok: false, reason: "image is blank (flat colour): not evidence of the work" };
      }
    } catch { /* unreadable ⇒ same as unmeasurable: promote, do not block */ }
    // NIENTE CANCELLO SULLA FORMA, e la ragione e' una misura.
    //
    // Ci avevo messo un terzo cancello: un'anteprima piu' alta che larga occupa
    // la card e spinge giu' il testo (misurato il 17/08: 255x397 alta 330px su
    // una card di 798). Il fatto e' vero, il rimedio era sbagliato, e l'ha
    // detto la suite - due tentativi, due rossi su `board-preview-cap.spec.ts`.
    //
    // Il riquadro della card RITAGLIA, sempre: `object-cover object-top` con
    // `max-h-[70cqw]`. Quella spec dichiara il contratto («il tetto taglia, non
    // deforma») e tiene apposta fra i casi buoni una quadrata E una 900x1800,
    // col commento «quella che il tetto deve tagliare». Rifiutarle qui vorrebbe
    // dire che la porta manuale non crede a cio' che la card fa un layer piu'
    // in la'.
    //
    // Il rifiuto per forma resta dov'era gia': nella promozione AUTOMATICA
    // (`tooTallForCard`), che sceglie da sola cosa mettere sulla card e nel
    // dubbio non sceglie. Qui c'e' un gesto esplicito - qualcuno dice «voglio
    // QUESTA» - e la risposta giusta e' mostrarla ritagliata, non rifiutarla.
    //
    // Cio' che ho sbagliato a fare qui e' documentato in
    // `shared/board.ts:PREVIEW_CARD_MAX_RATIO`.
    return { ok: true, value: raw };
  }

  /**
   * Lo SCATTO della consegna (`deliveryBranch` / `deliveryCommit`) non si
   * riscrive da una PATCH: torna la risposta 400 da restituire, o `null` se la
   * richiesta non lo tocca.
   *
   * È la descrizione di ciò che il reviewer ha guardato prima di cliccare «Landa
   * su main», e la deriva fra quello scatto e la punta del ramo è precisamente
   * ciò che il land mette nel thread — poterlo correggere vorrebbe dire
   * cancellare l'unica prova che le due cose differiscono.
   *
   * Ma un campo non applicabile va RIFIUTATO, non ignorato. Qui la PATCH
   * rispondeva 200 senza spostare niente (seconda occorrenza dello stesso
   * difetto, dopo `parentTaskId` sulla card `b06bb837`), e chi la chiamava per
   * «dire alla card che il ramo è andato avanti» credeva di esserci riuscito.
   * Serviva a un solo scopo, e quello scopo non esiste più: il land riallinea il
   * ramo su main da sé e pubblica la PUNTA quando il commit registrato è un suo
   * antenato. Una porta sola per tutte e due le PATCH (l'umana e quella degli
   * agenti): un campo rifiutato da una e ingoiato dall'altra è di nuovo il 200
   * muto, da un'altra parte.
   */
  function rejectDeliveryPatch(body: any): Response | null {
    const touched = ["deliveryCommit", "delivery_commit", "deliveryBranch", "delivery_branch"]
      .filter((k) => body?.[k] !== undefined);
    if (touched.length === 0) return null;
    return json({
      error:
        `${touched.join(", ")}: the delivery snapshot is not edited from here. It is what the reviewer ` +
        "approved, and the distance between it and the tip of the branch is information, not an error to " +
        "correct. If the branch moved on, or sits behind main, press \"Land on main\" again: the land " +
        "realigns the branch by itself and publishes the tip, saying in the thread what it realigned.",
      code: "invalid_input",
    }, 400);
  }

  /**
   * Resolve the board project id + the ACTOR behind a session key. Works for
   * BOTH a chat topic bound to a project and a Claude terminal tab (which has a
   * cwd but no chat topic). Returns null when the session is unbound.
   * `topicId` (chat sessions only) feeds the "own steps" carve-out: it lets the
   * service recognise subtasks of the task dispatched to THIS agent.
   *
   * ONE field, not two. This used to hand out a separate `author`, the topic
   * NAME, on the theory that a name is what reads well above a comment. For a
   * dispatched agent the topic name is the task title cut at 60 characters
   * (`task-dispatcher.ts`: `name: task.text.slice(0, 60)`), so what landed in
   * `task_comments.author` was half a sentence, and the card tooltip printed it
   * where a speaker's name belongs. The identity is the durable thing to store;
   * the label is derived when it is read (`shared/comment-author.ts`).
   */
  function resolveSession(sessionKey: string): { projectId: string; actor: string; topicId: string | null } | null {
    // The registry-backed coordinator never gains the ordinary session surface,
    // even if a stale/manual data mutation managed to add a project path. Its
    // only cross-board authority is the narrow wrapper below; this prevents a
    // special session from becoming a second project-scoped task principal.
    if (isGlobalOrchestratorSession(db, sessionKey)) return null;
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      // A dispatched agent's board is the board of the task bound to its topic,
      // NOT the topic's cwd: a catch-all ("generale") task runs in a per-task
      // private dir (~/.openclaw/workspace/tasks/<id8>) that maps to no real
      // board, so cwd-derived scoping 404s every one of the agent's own task
      // ops. When the topic carries a bound task, scope to THAT board.
      const boundProject = topic.id ? svc.boardProjectForTopic(topic.id) : null;
      const projectId = boundProject ?? projectIdForPath(topic.projectPath);
      return {
        projectId,
        actor: topic.id ? `${AGENT_AUTHOR_PREFIX}${topic.id}` : AGENT_AUTHOR,
        topicId: topic.id ?? null,
      };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      // A terminal tab has no topic, so the actor is the session itself.
      return {
        projectId: projectIdForPath(term.cwd),
        actor: `${AGENT_AUTHOR_PREFIX}${sessionKey.slice(0, 16)}`,
        topicId: null,
      };
    }
    return null;
  }

  /**
   * The global board coordinator is an ordinary, unbound Topic. Its cross-board
   * authority does not come from its title, path, or an MCP policy: this
   * registry lookup is the sole role gate. Keep this separate from
   * `resolveSession`, which intentionally remains project-bound for every
   * ordinary session route below.
   */
  function resolveGlobalOrchestratorSession(sessionKey: string): { actor: string; topicId: string } | null {
    // The raw registry identity deliberately still blocks ordinary session
    // routes above. This *capability* route is stricter: a manually corrupted
    // bound/non-Codex row must not retain cross-board authority either.
    const registered = getEligibleGlobalOrchestratorSessionBySessionKey(db, sessionKey);
    if (!registered) return null;
    return {
      actor: `${AGENT_AUTHOR_PREFIX}${registered.topicId}`,
      topicId: registered.topicId,
    };
  }

  /**
   * Global reads/mutations start from the task id and discover its board in
   * storage. A caller never supplies a project id for this path, so it cannot
   * turn a task id into cross-board authority by changing a request field.
   */
  function resolveGlobalTask(taskId: string) {
    const got = svc.get(taskId);
    return got ? { got, projectId: got.task.projectId } : null;
  }

  /**
   * The only caller-selected board is the target for a new task. Accept a
   * board id only when it is the id derived from one of this host's known
   * project directories. In particular, do not route through the historical
   * auto/catch-all resolver: a coordinator must name a real board explicitly.
   */
  function resolveExplicitGlobalBoard(rawBoardId: unknown): string | null {
    if (typeof rawBoardId !== "string") return null;
    const boardId = rawBoardId.trim();
    if (!boardId || boardId === AUTO_PROJECT_ID || boardId === UNASSIGNED_PROJECT_ID) return null;

    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { return null; }
    for (const rawPath of dirs) {
      if (typeof rawPath !== "string" || !rawPath.startsWith("/")) continue;
      const projectPath = rawPath.replace(/\/+$/, "") || "/";
      // `generale` is the old catch-all, not an explicit durable board target.
      if (basename(projectPath).toLowerCase() === "generale") continue;
      const knownBoardId = projectIdForPath(projectPath);
      if (knownBoardId === boardId) return knownBoardId;
    }
    return null;
  }

  /** Reject fields outside the focused global tool contract instead of ignoring them. */
  function rejectUnexpectedGlobalFields(
    body: unknown,
    allowed: readonly string[],
  ): Response | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const unexpected = Object.keys(body as Record<string, unknown>).filter((key) => !allowed.includes(key));
    if (!unexpected.length) return null;
    return json({
      error: `global orchestrator does not accept: ${unexpected.join(", ")}`,
      code: "invalid_input",
    }, 400);
  }

  /**
   * `?status=` dal query string, SENZA `as any`.
   *
   * Il cast passava «in-progress» dritto al servizio, che lo metteva in un
   * `WHERE status = ?` dove non matcha niente: 200 con zero card. Una board
   * vuota è una risposta plausibilissima, quindi il refuso restava invisibile e
   * si andava a cercare il guasto nel dispatcher. Qui il dominio è chiuso e lo
   * sbaglio si dichiara — 400 con l'elenco degli stati veri. La stessa guardia
   * sta anche in `svc.list`, che è la porta comune: questa nomina il valore che
   * è arrivato dalla rete, quella copre chi il servizio lo chiama da dentro.
   */
  function asTaskStatus(raw: string | null | undefined): TaskStatus | undefined {
    if (!raw) return undefined;
    const found = TASK_STATUSES.find((s) => s === raw);
    if (!found) {
      throw new TaskServiceError("invalid_input", `stato "${raw}" inesistente: gli stati sono ${TASK_STATUSES.join(", ")}`);
    }
    return found;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
    // Un valore fuori da un dominio chiuso è colpa di chi chiama, non del
    // server: 400, e con la regola detta a parole. Prima usciva 500 col testo
    // grezzo di SQLite (`CHECK constraint failed: priority BETWEEN 0 AND 4`),
    // che manda a cercare un guasto dove non c'è e si legge solo sapendo che
    // esiste un CHECK. Vedi `checkConstraintBody` in task-patch.ts.
    const violated = checkConstraintBody(e);
    if (violated) return json(violated, 400);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  /**
   * Gate del fan-out sulla superficie AGENTE.
   *
   * Mentre N tentativi lavorano in parallelo lo STESSO task, il task appartiene
   * al GIRO, non a un agente: chi lo muove in review, lo rinomina o lo parcheggia
   * parlerebbe a nome di tutti — e il primo dei cinque a farlo deciderebbe per gli
   * altri quattro, prima ancora che l'umano veda un confronto. Il kickoff dei
   * tentativi lo dice a parole; questo lo rende vero anche se il modello legge di
   * fretta. Niente va perso: il dispatcher raccoglie l'ultima prosa di OGNI
   * tentativo e la mette nel confronto che scrive alla chiusura.
   *
   * Zero effetto sul dispatch normale: righe in `task_attempts` esistono solo per
   * un fan-out (`launch()` non ne crea nessuna).
   */
  /**
   * THE PRE-REVIEW CHECKS GATE, for the gestures that close a card.
   *
   * Not a ban: `force` overrides it, and it is there for the cases where you
   * know the red is harmless (a command that is beside the point, a known
   * failing test). Its job is to make the exception a CHOICE instead of the
   * silent default.
   *
   * It is one function because the gestures are TWO and for months it guarded
   * one: the gate lived inside the `approve` branch while `POST …/land` queued
   * the merge without looking at anything. Landing CONTAINS the acceptance and
   * puts the branch on main on top of it, so the less reversible of the two was
   * the only one with no gate. On a review card with a branch it was the green
   * button, too.
   *
   * The sentence is written for whoever reads it from the board: it names the
   * normal road, not a field of the JSON body. `force: true` stays in the code
   * comment (where it serves an API caller) and out of the message (where the
   * reader has no way to pass it).
   */
  function checksRedGate(projectId: string, taskId: string, force: unknown): Response | null {
    if (force === true) return null;
    let cur: { checksState?: string | null; checks?: Array<{ ok: boolean; name: string }> | null } | undefined;
    // The watchdog must never be able to block an acceptance: if the read
    // throws, the gesture goes through.
    try { cur = svc.get(taskId, { projectId })?.task; } catch { return null; }
    if (cur?.checksState !== "fail") return null;
    const red = (cur.checks ?? []).find((r) => !r.ok);
    return json({
      error:
        `the pre-review checks are RED${red ? ` (\`${red.name}\`)` : ""}. ` +
        "The normal road is to send it back to the agent; to accept it anyway use the card button that says \"anyway\".",
      code: "checks_failed",
    }, 409);
  }

  function fanOutGate(taskId: string, forbidden: string): Response | null {
    // A fan-out is recognised by its SIBLINGS: running rows on topics other
    // than the one the task is bound to. A single launch records its own row
    // as history, and counting that row gated every first turn with a 409.
    let running: TaskAttempt[] = [];
    try { running = attempts.list(taskId).filter((a) => a.state === "running"); } catch { return null; }
    const bound = svc.get(taskId)?.task.assignedTopicId ?? null;
    if (!running.some((a) => !bound || a.topicId !== bound)) return null;
    return json({
      error:
        `this task is in fan-out: ${running.length} parallel attempts are working the same task. ${forbidden}. ` +
        "work in YOUR worktree, commit everything on your branch, and end your turn with 2-3 sentences " +
        "describing what you did: the board composes the comparison from those.",
      code: "fanout_running",
    }, 409);
  }

  /**
   * The two structural gates a DELIVERY passes before the store sees the
   * PATCH, shared by the session route and the global coordinator route so
   * they cannot drift: (1) the worktree must be clean, or unreachable-but-
   * branchless; (2) the board's review checks must be green, with the 202
   * "still running" leg remembered in `pendingDeliveries` so the server can
   * re-issue THIS request on `pathname` when the run ends.
   *
   * The probe's `null` answer ("no branch worktree found") is refused when the
   * task has, or had, a branch: a worktree deleted before review or a topic
   * link broken by the release both mean "do not know", and in a gate that
   * means "no". A task that never had a branch (in-place work) passes.
   *
   * Questions are exempt: an agent asking mid-work legitimately has a dirty
   * worktree. "Is it a question" is `commentAsksHuman`, NOT the presence of
   * the ```question fence, which the server wraps around every options list
   * (measured 13/08: 331 of 437 fenced comments were deliveries).
   *
   * Returns the refusal (or the 202) to send, `null` when the PATCH may go on.
   */
  async function reviewDeliveryGate(
    taskId: string,
    projectId: string,
    body: Record<string, unknown> | null,
    legMs: number,
    pathname: string,
    chat: { sessionKey: string; topicId: string | null },
  ): Promise<Response | null> {
    if (body?.status !== "review") return null;
    let isDelivery = false;
    let reviewGateTask: ReturnType<typeof svc.get> | null = null;
    try {
      reviewGateTask = svc.get(taskId, { projectId });
      const lastOwn = reviewGateTask ? [...reviewGateTask.comments].reverse().find(
        (comment) => comment.author !== "user" && comment.author !== "system" && comment.kind === "comment",
      ) : null;
      const isQuestion = commentAsksHuman(lastOwn?.content);
      isDelivery = !!reviewGateTask && reviewGateTask.task.status !== "review" && !isQuestion;
    } catch { /* best-effort: a store hiccup must never block a delivery */ }
    if (!isDelivery) return null;

    // THE USER'S OWN GATE COMES FIRST (HOOKS-02): a `task-deliver` hook that
    // exits non-zero refuses the move with a code of its own and its stderr
    // as the reason, the twin of the refusals below. It is the cheapest gate
    // of the chain, so it runs BEFORE the dirt probe and the checks: a rule
    // that says no must not cost a git status and a full check run first.
    // The command runs in the worktree of the card when there is one, else
    // in the repo root.
    if (opts?.hooks) {
      const ref = opts.taskCheckoutRef ? await opts.taskCheckoutRef(taskId).catch(() => null) : null;
      const cwd = ref?.cwd
        ?? opts.repoRootFor?.({ taskId, projectId, assignedTopicId: reviewGateTask?.task.assignedTopicId ?? null })
        ?? "";
      const verdict = await opts.hooks.run("task-deliver", {
        hook_event_name: "task-deliver",
        session_id: chat.sessionKey,
        cwd,
        task_id: taskId,
        project_id: projectId,
        commit: ref?.commit ?? null,
      });
      if (!verdict.ok) return json({ error: verdict.reason, code: "review_hook_refused" }, 409);
    }

    if (opts?.taskWorktreeDirtProbe) {
      try {
        const probe = await opts.taskWorktreeDirtProbe(taskId);
        if (probe === null) {
          const hasBranch =
            !!reviewGateTask?.task.deliveryBranch ||
            opts.taskHasBranchAttempt?.(taskId) === true;
          if (hasBranch) {
            return json({
              error:
                "cannot verify the worktree state: the branch worktree is no longer " +
                "reachable (the slot was released before review). " +
                "commit your work and ensure the worktree is still linked, " +
                "THEN set status='review'",
              code: "review_needs_commit",
            }, 409);
          }
        } else if (!probe.ok || probe.paths.length > 0) {
          const dirt = probe.paths;
          if (!probe.ok) {
            return json({
              error:
                "cannot read the worktree status (git status failed). " +
                "make sure your worktree has no uncommitted changes, " +
                "THEN set status='review'",
              code: "review_needs_commit",
            }, 409);
          }
          return json({
            error:
              `your worktree has ${dirt.length} uncommitted change${dirt.length === 1 ? "" : "s"} ` +
              `(${dirt.slice(0, 3).join(", ")}${dirt.length > 3 ? ", …" : ""}). ` +
              "commit them on your branch (or discard leftovers), THEN set status='review'",
            code: "review_needs_commit",
          }, 409);
        }
      } catch { /* best-effort: a git/store hiccup must never block a delivery */ }
    }

    // THE PREVIEW GATE, and it runs BEFORE the commands because it costs a
    // field read while they cost minutes: a delivery that cannot pass should
    // learn it now, not after the suite.
    //
    // It only ever looks at cards the board has ALREADY labelled `visibile`
    // (`deriveCloser`: they touch `client/src/**` outside the tests), which is
    // the narrow reading on purpose. A card whose label has not been derived
    // yet — the derivation happens further down the same delivery — is NOT
    // held back: the gate answers about what is written, never about what it
    // guesses will be written. `decisione` and `invisibile` pass untouched,
    // and so does a human moving a card by hand.
    //
    // Why only that class: asking every card for a preview manufactures
    // artefacts on deliveries with nothing to show, which is how a gate starts
    // producing evidence for itself instead of for the person reading it.
    const reviewLabels = reviewGateTask?.task.labels ?? [];
    if (reviewLabels.some((l) => l.label === "visibile")) {
      const preview = (reviewGateTask?.task.previewImage ?? "").trim();
      if (!preview) {
        return json({
          error:
            "this card is labelled `visibile` (it touches client/src), so the reviewer " +
            "opens it to LOOK at something. attach the durable evidence with " +
            "update_task(previewImage=<absolute path>): a screenshot of one state, a " +
            "clip of a behaviour, or a diagram. THEN set status='review'",
          code: "review_needs_preview",
        }, 409);
      }
    }

    // Second gate, AFTER the commit one: the commands run on committed code,
    // so it only makes sense once there is some. A red goes back to the agent
    // with the command output, the real reason, so the repair starts there.
    //
    // In LEGS, not in one breath: the run lives in the registry and this
    // request waits at most `legMs`. The 202 is not a verdict, it is "call
    // again": the task does not move until there is one, and the MCP client
    // (callUpdateTask) is the one that polls.
    const outcome = await runChecksGate(taskId, projectId, legMs).catch(() => null);
    const legInFlight = (task: Task | undefined) => json({
      pending: true,
      code: "review_checks_running",
      legMs,
      status: task?.status ?? null,
      checksState: task?.checksState ?? "running",
    }, 202);
    // THE SERVER STOPPED THE ROUND: nothing was measured, so this is neither a
    // red nor "no checks". Read as `null` it let the PATCH go on and the card
    // entered review with `checksState: running` on every watcher reload. The
    // answer is the one of a leg still in flight, not an error: the only
    // client (`callUpdateTask`) calls again, meets the closed socket and
    // retries it within its transport grace, and after the restart a fresh
    // round measures the delivery. A 503 was thrown at the agent instead, which
    // cannot wait a minute and called again into the dead server.
    if (outcome && "interrupted" in outcome) {
      // NOTHING WAS MEASURED, AND THE DELIVERY IS NOT LOST EITHER. The swap
      // brake's round restarts in THIS process (`settleDelivery`); the
      // shutdown's restarts in the NEXT one, from the row
      // (`resumePendingDeliveries`).
      //
      // A shutdown used to forget it here, and that was safe only while a card
      // turn held every planned reload back: the agent's leg came back after
      // the restart and asked again. Since 2026-09-16 a reload no longer waits
      // for a delivery whose checks are only waiting, so the leg may never come
      // back - the turn died with the process - and forgetting the delivery
      // would leave the card `in_progress` with nobody left to ask.
      if (body && typeof body === "object") rememberDelivery(taskId, pathname, body as Record<string, unknown>);
      return legInFlight(svc.get(taskId, { projectId })?.task);
    }
    if (outcome && "pending" in outcome) {
      // Remembered with the body as sent: the server re-issues THIS request
      // on the same path when the run ends, should the client stop polling -
      // or should the process itself go away first.
      if (body && typeof body === "object") rememberDelivery(taskId, pathname, body as Record<string, unknown>);
      const task = svc.get(taskId, { projectId })?.task;
      tellChatAboutChecksWait(chat.sessionKey, chat.topicId, taskId, projectId, task);
      return legInFlight(task);
    }
    forgetDeliveryMemo(taskId);
    checksWaitSince.delete(taskId);
    if (outcome && !outcome.ok) {
      return json({ error: outcome.comment, code: "review_needs_green_checks" }, 409);
    }
    return null;
  }

  /**
   * The global coordinator uses the same agent transition path as a normal
   * Topic session. It only differs in how the board and actor were resolved
   * (both server-side above), so review/done gates, delivery capture, checks,
   * and broadcasts cannot silently diverge from the ordinary task surface.
   */
  async function patchGlobalOrchestratorTask(
    taskId: string,
    projectId: string,
    session: { actor: string; sessionKey: string; topicId: string },
    body: Record<string, unknown> | null,
    pathname: string,
    origin: "mcp" | "api",
  ): Promise<Response> {
    const noDelivery = rejectDeliveryPatch(body);
    if (noDelivery) return noDelivery;
    const unexpected = rejectUnexpectedGlobalFields(
      body,
      ["status", "priority", "assignee", "text", "description", "summary", "legMs"],
    );
    if (unexpected) return unexpected;
    // `legMs` is transport for the review-check polling loop, not a persisted
    // task field. Strip it before the normal agent patch parser sees the body.
    const legMs = clampLegMs(body?.legMs);
    if (body && typeof body === "object") delete body.legMs;

    const gatedDelivery = await reviewDeliveryGate(taskId, projectId, body, legMs, pathname, {
      sessionKey: session.sessionKey,
      topicId: session.topicId,
    });
    if (gatedDelivery) return gatedDelivery;

    const parsed = parseTaskPatch(body, "agent", acceptPreview);
    if (!parsed.ok) return json(unapplicableFieldsBody(parsed.errors), 400);
    try {
      // Re-read immediately before mutation. The project id used here came from
      // the task row, never from the caller, and this guard also handles a
      // concurrent removal/move as a normal not-found result.
      const prevStatus = svc.get(taskId, { projectId })?.task.status;
      let task = svc.update({
        taskId,
        actor: "agent",
        by: session.actor,
        origin,
        projectId,
        // Deliberately no `agentTopicId`: that ordinary dispatched-agent
        // ownership carve-out would make a registry-authorized cross-board
        // coordinator depend on whichever task happens to own its Topic.
        patch: parsed.patch,
      });
      task = await captureDelivery(task, prevStatus);
      broadcastToAll({ type: "task:updated", projectId, task });
      // A registry-backed update changes a normal board card, not a parallel
      // status model. Preserve the board's queue accounting exactly: entering
      // Todo may be picked up by that board's configured dispatcher, while
      // leaving it cancels a queued grace timer. This is lifecycle accounting,
      // not a direct spawn/send/stop capability for the coordinator.
      if (dispatcher && prevStatus !== task.status) {
        if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
        else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
        if (task.status === "done") dispatcher.onBlockerDone(taskId);
      }
      emitReviewReadyEdge(broadcastToAll, projectId, task, prevStatus, undefined,
        () => svc.get(task.id)?.comments);
      triggerUrlProbe(taskId, task.outputUrl ?? null, projectId);
      return json(task);
    } catch (e) { return fail(e); }
  }

  /**
   * THE TWO WRITES A GUEST MAY MAKE, each gated by its own level - never
   * behind `edit` on the HUMAN/agent routes (run, stop, retitle, label, move,
   * merge, land, publish, deploy, ...): those stay out of reach at any level,
   * because "start an agent", "code changes", "approval" and "publishing" are
   * distinct actions that no collaboration level grants implicitly.
   */
  async function handleGuestComment(taskId: string, deviceId: string, req: Request): Promise<Response> {
    const body = (await readJSON(req)) as { content?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return json({ error: "empty comment", code: "bad_request" }, 400);
    const got = svc.get(taskId);
    if (!got) return json({ error: "task not found", code: "not_found" }, 404);
    const comment = svc.addComment({
      taskId,
      author: `guest:${deviceId}`,
      content,
      projectId: got.task.projectId,
    });
    const task = svc.get(taskId)?.task ?? got.task;
    broadcastToAll({ type: "task:updated", projectId: got.task.projectId, task });
    return json(comment);
  }

  async function handleGuestEdit(taskId: string, deviceId: string, req: Request): Promise<Response> {
    const body = (await readJSON(req)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text is required", code: "bad_request" }, 400);
    const got = svc.get(taskId);
    if (!got) return json({ error: "task not found", code: "not_found" }, 404);
    const task = svc.update({
      taskId,
      actor: "human",
      by: `guest:${deviceId}`,
      projectId: got.task.projectId,
      patch: { text },
    });
    broadcastToAll({ type: "task:updated", projectId: got.task.projectId, task });
    return json(task);
  }

  // The human board routes live in tasks-board.ts; same closure values, passed by name.
  const boardRoutes = createBoardRoutes({
    ctx, dispatcher, opts, matchRoute, json, readJSON, broadcastToAll, svc, askRouting, landings,
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
      || pathname === "/api/system/dispatch-capacity";
    if (identita?.role === "guest" && miePath) {
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
        return json({ tasks: svc.list({ scope: "all", rootsOnly: true, ids: [...condivisi], doneLimit: DONE_FEED_LIMIT }) });
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
    if (!isSession && !isOrchestratorSession && !isBoard && !isAllBoards && !isCapacity) return null;

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
      try { return json({ tasks: svc.list({ scope: "all", status: asTaskStatus(status), rootsOnly: true, includeOrphanSubtasks: true, doneLimit: DONE_FEED_LIMIT }) }); }
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

    const allTaskItem = matchRoute(pathname, "/api/all-boards/tasks/:taskId");
    if (allTaskItem && method === "GET") {
      try { return json({ task: svc.get(allTaskItem.taskId)?.task ?? null }); }
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
      try { admission = dispatcher?.admissionPreview?.() ?? null; } catch { /* best-effort */ }
      return json({
        ...computeDispatchCapacity(running, undefined, resolveAgentRuntime() === "cli", undefined, {
          share: budgetShare(svc.getGlobalCap()),
          frozen: activeFrozenCount(),
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
        const seen = new Set<string>();
        const projects: Array<{ projectId: string; name: string; path: string }> = [];
        for (const raw of knownDirs()) {
          if (typeof raw !== "string" || !raw.startsWith("/")) continue;
          const path = raw.replace(/\/+$/, "");
          if (!path || seen.has(path)) continue;
          seen.add(path);
          projects.push({ projectId: projectIdForPath(path), name: basename(path), path });
        }
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return json({ projects, newProjectDir: newDir() });
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
      const globalSession = resolveGlobalOrchestratorSession(sk);
      if (!globalSession) {
        return json({ error: "global orchestrator session required", code: "global_orchestrator_required" }, 403);
      }

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
        } | null;
        const unexpected = rejectUnexpectedGlobalFields(
          body,
          ["board_id", "text", "description", "priority", "assignee", "idempotency_key", "allow_duplicate"],
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
          });
          broadcastToAll({ type: "task:created", projectId, task });
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
      const globalSession = resolveGlobalOrchestratorSession(sk);
      if (!globalSession) {
        return json({ error: "global orchestrator session required", code: "global_orchestrator_required" }, 403);
      }
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
        return json(comment, 201);
      } catch (e) { return fail(e); }
    }

    // GET/PATCH /api/orchestrator-sessions/:sessionKey/tasks/:taskId
    const globalItem = matchRoute(pathname, "/api/orchestrator-sessions/:sessionKey/tasks/:taskId");
    if (globalItem) {
      const sk = decodeURIComponent(globalItem.sessionKey);
      const globalSession = resolveGlobalOrchestratorSession(sk);
      if (!globalSession) {
        return json({ error: "global orchestrator session required", code: "global_orchestrator_required" }, 403);
      }

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
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

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
          });
          broadcastToAll({ type: "task:created", projectId: sess.projectId, task });
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
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
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
      const sess = resolveSession(decodeURIComponent(sLabels.sessionKey));
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
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
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
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
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

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
          const prevStatus = svc.get(item.taskId, { projectId: sess.projectId })?.task.status;
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
          task = await captureDelivery(task, prevStatus);
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          // È QUESTA la porta che conta per i tasti del banner: l'agente commenta
          // la domanda con `options` e poi si sposta in review da qui (MCP
          // update_task). Al momento del fronte la domanda è l'ultima riga del
          // thread — esattamente ciò che la card mostra come quick-reply.
          emitReviewReadyEdge(broadcastToAll, sess.projectId, task, prevStatus, undefined,
            () => svc.get(task.id)?.comments);
          triggerUrlProbe(item.taskId, task.outputUrl ?? null, sess.projectId);
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
  resumePendingDeliveries();
  return tasksRouter;
}
