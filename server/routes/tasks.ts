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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AppContext, RouteHandler } from "../types";
import { grantedResourceIds } from "../lib/grants-query";
import { resolvePrincipals } from "../lib/principals";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { isAgentWorking, isThreadSpeech, NOTE_ARCHIVED_BY_HUMAN, NOTE_STOPPED_BY_HUMAN, PARKED_STOPPED, PARKED_WAITED_OUT, pendingQuestion, TASK_STATUSES, type PendingQuestionComment, type TaskStatus } from "../../shared/board";
import { AGENT_AUTHOR, AGENT_AUTHOR_PREFIX } from "../../shared/comment-author";
import { findDuplicateGroups } from "../../shared/task-similarity";
import { isPreviewablePath } from "../../shared/media-kind";
import { parseTaskPatch, unapplicableFieldsBody, checkConstraintBody, type FieldRead } from "./task-patch";
import { getTerminalSessionById } from "./terminal";
import { deliverAnswer } from "../lib/ask-user-bridge";
import { answerRoutedAsk, pendingRoutedAsk } from "../services/board-ask-routing";
import { AUTO_PROJECT_ID, commentAsksHuman, createTaskService, isArchiveParkedLabel, isLandActionLabel, isPublishActionLabel, isRequeueParkedLabel, isTakeOverParkedLabel, projectIdForPath, TaskServiceError, UNASSIGNED_PROJECT_ID, type Task } from "../services/tasks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";
import { resolveAgentRuntime } from "../services/app-settings";
import { newProjectParentDir } from "../services/project-path-resolver";
import { parkedEdgeEvent, type TaskDispatcher } from "../services/task-dispatcher";
import { landFallout, type TaskAutoMerge } from "../services/task-automerge";
import type { LandingState } from "../services/landing-audit";
import { createLandingQueue, type LandingTicket, type LandOutcomeResult } from "../services/landing-queue";
import { decidePostLandReap, type BranchStatus, type LandOutcome } from "../services/worktree-gc";
import { MAX_CHECKS, checksVerdict, formatChecksComment, parseReviewChecks, runReviewChecks, type ReviewCheck } from "../services/review-checks";
import { clampLegMs, createChecksGate, type ChecksLeg } from "../services/checks-gate";
import { createTaskAttemptStore, type TaskAttempt } from "../services/task-attempts";
import { linkNotes, proposeLink, type LinkKind } from "../services/task-intake";
import { recordRetirement } from "../services/retirement";
import { attemptHasWork, formatAttemptStat } from "../../shared/task-attempt";
import { listOwnCommits, mergeNameStatus } from "../services/own-commits";
import { createDeliveryCapture } from "../services/task-delivery-capture";
import { resolveTaskDiffRange } from "../services/task-diff-range";
import { isTaskLabel, normalizeLabels, type TaskFile } from "../../shared/task-labels";
import { probeUrl, invalidateProbeCache } from "../services/url-probe-cache";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
  open_subtasks: 409,
  review_needs_summary: 409,
  // Il task e stato tolto all'agente (park/requeue): 409 come gli altri rifiuti
  // di proprieta, non 403 — non e un problema di permessi, e uno stato che nel
  // frattempo e cambiato sotto.
  task_not_yours: 409,
  // La card era chiusa da un umano: riaprirla e' scavalcare quella decisione.
  // 409 come gli altri rifiuti di stato, non 403 — non e un permesso mancante,
  // e una decisione che esiste gia sulla card.
  reopen_needs_human: 409,
  // 403 e non 409: qui NON è uno stato cambiato sotto, è un permesso che non
  // esiste e non esisterà al prossimo tentativo. Un agente non marca
  // `invisibile` il proprio lavoro, punto.
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
   * Il thread del task, PIGRO: chiamato solo quando il fronte scatta davvero.
   * Serve a sapere se l'ultima parola dell'agente è una domanda, perché le sue
   * opzioni diventano i tasti del banner. Pigro e non un parametro già
   * risolto perché questa funzione la chiama ogni PATCH del task — leggere il
   * thread a ogni salvataggio di priorità per un fronte che scatta una volta
   * sola sarebbe una query per niente.
   */
  resolveComments?: () => readonly PendingQuestionComment[] | null | undefined,
): void {
  if (task && task.status === "review" && prevStatus !== "review") {
    let question: { text: string; options: string[] } | null = null;
    // Best-effort: una lettura del thread che fallisce non deve mangiarsi il
    // fronte (il banner senza tasti resta molto meglio di nessun banner).
    let isAsk = false;
    try {
      const comments = resolveComments?.();
      question = pendingQuestion(comments);
      // `question` porta anche le opzioni di una CONSEGNA (l'envelope ordina
      // di allegare `options=["Landa su main"]` a ogni consegna, e il server
      // le avvolge nella stessa fence ```question): non basta a dire se
      // l'ultima parola dell'agente sta chiedendo qualcosa. `isAsk` guarda lo
      // stesso ultimo commento con `commentAsksHuman` (legge le OPZIONI, non
      // la fence), cosi il banner puo' scegliere il titolo giusto senza
      // perdere il tasto "Landa su main" che vive in `question.options`.
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
      // SEMPRE presente, `null` compreso — ed è il punto. Il client decide da
      // qui se il banner porta "Approva" o le risposte alla domanda, e i due
      // lati del filo si aggiornano separatamente (il guscio desktop si porta
      // dietro il suo client, il server è il demone). Con il campo OMESSO
      // quando non c'è domanda, un client nuovo su un server vecchio leggerebbe
      // "nessuna domanda" e metterebbe un tasto "Approva" su un task che sta
      // aspettando una risposta: un click, e il task è chiuso invece di
      // risposto. `null` esplicito rende distinguibile «non c'è» da «questo
      // server non lo sa dire».
      question,
      isAsk,
    });
  }
}

// `pendingQuestion` vive in `shared/board.ts`: i lettori sono tre e stanno su
// due lati del filo (questo emettitore, il ripiego del client su un server che
// il campo non lo manda, e concettualmente la quick-reply della card).
// Ri-esportato perché i test di questo modulo lo importano da qui, dov'era.
export { pendingQuestion, type PendingQuestionComment };

/**
 * Cap for AGENT-authored comments (the session surface only — humans are
 * uncapped). Generous enough for 2-3 dense sentences or a question block,
 * tight enough to reject log dumps; the 400 message coaches a retry.
 */
const AGENT_COMMENT_MAX_CHARS = 600;

export interface TasksRouterOpts {
  /** All project dirs the server knows (same union the dispatcher resolves against). */
  listProjectDirs?: () => string[];
  /** Workspace root for scaffolding a NEW project from the board. */
  workspaceDir?: string;
  /** Abort a running headless turn (human "stop" on a dispatched task). */
  abortTurn?: (sessionKey: string) => Promise<void>;
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
  onChecksGate?: (gate: import("../services/checks-gate").ChecksGate) => void;
}

/**
 * Run git in `cwd`, capturing stdout/stderr/exit. Never throws (code 1 on spawn
 * failure) and disables the credential prompt so a push that needs auth fails
 * fast instead of hanging the request.
 */
async function runGitCap(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code, out, err };
  } catch (e) {
    return { code: 1, out: "", err: String((e as Error)?.message ?? e) };
  }
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

/** Payload cap for a diff patch (~200 KB): a huge range renders the first slice
 *  and flags `truncated` so the UI shows a "…troncato" note rather than shipping
 *  megabytes into the client. */
const DIFF_PATCH_CAP = 200_000;

/** Cap on how many untracked files we fold into a task diff — a runaway worktree
 *  (node_modules never gitignored, a build dir…) must not spawn thousands of git
 *  processes. Beyond this we stop; the patch cap already bounds the payload. */
const UNTRACKED_FILE_CAP = 500;

/**
 * Il path di DESTINAZIONE da una riga di `--numstat`.
 *
 * Su un rename git non stampa un path: stampa la trasformazione, in due forme —
 * `vecchio => nuovo` quando cambia tutto, e `dir/{a => b}/f.ts` quando cambia un
 * pezzo solo. Prese alla lettera nessuna delle due combacia con il `b/…` del
 * patch, quindi la riga dello stat restava orfana: niente `+N −M` accanto al
 * nome, e — da quando l'elenco dei file si costruisce dallo stat — lo stesso file
 * elencato DUE volte, una per lo stat e una per il pezzo di patch.
 */
export function numstatPath(raw: string): string {
  const path = raw.trim();
  if (!path.includes("=>")) return path;
  // Prima la forma con le graffe, che è annidata dentro il path: si sostituisce
  // il gruppo con il suo lato destro (vuoto = il segmento sparisce).
  const braced = path.replace(/\{([^{}]*?) => ([^{}]*?)\}/g, "$2");
  if (braced !== path) return braced.replace(/\/{2,}/g, "/");
  const arrow = path.split(" => ");
  return (arrow[arrow.length - 1] ?? path).trim();
}

/**
 * Build a unified-diff bundle for `range` (any `git diff` selector — a `a..b`
 * range for a publish, or a base sha for a worktree). Returns the per-file stat
 * (additions/deletions/status, -1 count = binary) and the raw unified patch,
 * capped. Reuses `runGitCap`; never throws.
 *
 * `includeUntracked` folds in files git isn't tracking yet (new deliverables an
 * agent wrote but never committed): plain `git diff` ignores them entirely, so a
 * task whose ONLY output is a brand-new file otherwise renders as an empty diff.
 * They're listed as `A` and diffed against /dev/null (no index mutation). Off for
 * publish diffs, which compare two commits and have no working-tree notion.
 */
async function gitDiffBundle(cwd: string, range: string, gopts?: { includeUntracked?: boolean }): Promise<{
  stat: { path: string; additions: number; deletions: number; status: string }[];
  patch: string;
  truncated: boolean;
}> {
  const [numstat, nameStatus] = await Promise.all([
    runGitCap(cwd, ["diff", "--numstat", range]).then((r) => r.out),
    runGitCap(cwd, ["diff", "--name-status", range]).then((r) => r.out),
  ]);
  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const p = parts[parts.length - 1] ?? ""; // rename: status\told\tnew → take new
    if (p) statusByPath.set(p, (parts[0] ?? "M")[0] ?? "M");
  }
  const stat = numstat.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const add = parts[0] ?? "0";
    const del = parts[1] ?? "0";
    const path = numstatPath(parts[parts.length - 1] ?? "");
    return {
      path,
      additions: add === "-" ? -1 : Number.parseInt(add, 10) || 0,
      deletions: del === "-" ? -1 : Number.parseInt(del, 10) || 0,
      status: statusByPath.get(path) ?? "M",
    };
  });
  let full = (await runGitCap(cwd, ["diff", range])).out;

  if (gopts?.includeUntracked) {
    // -z: NUL-separated, so paths with spaces/newlines survive intact.
    const others = (await runGitCap(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).out;
    const files = others.split("\0").filter(Boolean).slice(0, UNTRACKED_FILE_CAP);
    for (const f of files) {
      // `git diff --no-index /dev/null <f>` is a pure file compare (no index
      // touched); exit code 1 just means "differs" — runGitCap returns .out anyway.
      const ns = (await runGitCap(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", f])).out;
      const parts = (ns.split("\n").find(Boolean) ?? "").split("\t");
      const add = parts[0] ?? "0";
      const del = parts[1] ?? "0";
      stat.push({
        path: f,
        additions: add === "-" ? -1 : Number.parseInt(add, 10) || 0,
        deletions: del === "-" ? -1 : Number.parseInt(del, 10) || 0,
        status: "A",
      });
      // Skip fetching more patch text once we're already over the cap (stat is
      // cheap and still complete; the patch just gets flagged truncated below).
      if (full.length <= DIFF_PATCH_CAP) {
        const p = (await runGitCap(cwd, ["diff", "--no-index", "--", "/dev/null", f])).out;
        if (p) full += (full && !full.endsWith("\n") ? "\n" : "") + p;
      }
    }
  }

  const truncated = full.length > DIFF_PATCH_CAP;
  return { stat, patch: truncated ? full.slice(0, DIFF_PATCH_CAP) : full, truncated };
}

export { gitDiffBundle };

export function createTasksRouter(ctx: AppContext, dispatcher?: TaskDispatcher, opts?: TasksRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey, isPathAllowed } = ctx;
  const svc = createTaskService(db);
  const attempts = createTaskAttemptStore(db);

  // Il lato «risposta» dell'instradamento delle domande (board-ask-routing.ts).
  // Qui serve solo `deliver`: il commento con la domanda lo scrive l'altra
  // sponda, la gamba dell'attesa in routes/permission.ts.
  const askRouting = {
    db,
    comment: () => false,
    deliver: (sessionKey: string, answers: Record<string, string>) => deliverAnswer(sessionKey, answers),
  };

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
    if (projectId !== AUTO_PROJECT_ID) return projectId;
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
  const checksGate = createChecksGate();
  // Notifica il chiamante non appena il gate esiste, cosi' puo' passarne
  // `runningCount` al dispatcher senza accoppiamenti circolari.
  try { opts?.onChecksGate?.(checksGate); } catch { /* best-effort */ }

  // Qui, e non nel poll del dispatcher: questo è l'unico istante in cui il
  // registro è VUOTO per costruzione, quindi ogni «running» rimasto nel db è di
  // un processo morto. Nel poll la stessa riga spegnerebbe corse vive.
  try {
    const spente = svc.clearStaleChecksRuns();
    if (spente) console.warn(`[checks] ${spente} spie 'running' spente: erano di un processo morto`);
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
  async function runChecksGate(
    taskId: string,
    projectId: string,
    legMs: number,
  ): Promise<ChecksLeg> {
    if (!opts?.taskCheckoutRef) return null;
    let checks: ReviewCheck[] = [];
    try { checks = svc.getBoardSettings(projectId).reviewChecks; } catch { return null; }
    if (!checks.length) return null;
    const ref = await opts.taskCheckoutRef(taskId).catch(() => null);
    if (!ref) return null;

    return checksGate.leg(taskId, {
      commit: ref.commit ?? null,
      legMs,
      run: async () => {
        // 'running' subito e in broadcast: i comandi possono durare minuti e una
        // board ferma senza spiegazioni si legge come "si è impiantato".
        try {
          const t = svc.recordChecks({ taskId, state: "running", commit: ref.commit, runs: null });
          broadcastToAll({ type: "task:updated", projectId, task: t });
        } catch { /* il gate vale anche senza la spia */ }

        const runs = await runReviewChecks(checks, { cwd: ref.cwd });
        const ok = runs.length === checks.length && runs.every((r) => r.ok);
        const comment = formatChecksComment(runs, { commit: ref.commit });
        try {
          // TRE ESITI, non due. `checksVerdict` e' lo stesso predicato che sceglie
          // la parola del commento: uno SCADUTO non ha misurato niente, e
          // marcarlo `fail` manda chi rivede a cercare un guasto che non c'e'.
          // Misurate il 18/08 sul DB vivo: 6 card su 15 marcate rosse erano solo
          // scadute. `checks` e' l'elenco DICHIARATO — se ne sono tornati meno,
          // qualcuno non e' arrivato in fondo.
          svc.recordChecks({ taskId, state: checksVerdict(runs, checks.length), commit: ref.commit, runs });
          // VERDE ⇒ servizio, ROSSO ⇒ parola. Il verde è già un chip sulla card
          // (`card-checks-green`) e il paragrafo lo ripete comando per comando,
          // bruciando uno slot su OGNI consegna — misurate 92 copie in 7 giorni.
          // Il rosso invece cambia cosa fa l'umano: elenca quali comandi sono
          // caduti, e su una card in review è metà della decisione. Un chip col
          // tooltip non basta a portare quel dettaglio in una colonna.
          svc.addComment({ taskId, author: "system", kind: ok ? "service" : "comment", content: comment });
          const t = svc.get(taskId, { projectId })?.task;
          if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
        } catch { /* l'esito conta più della sua registrazione */ }
        return { ok, comment };
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
    if (opts?.abortTurn) {
      for (const key of keys) void opts.abortTurn(key).catch(() => { /* best-effort */ });
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
  const landings = createLandingQueue({ log: (m) => console.warn(m) });

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
      return { outcome: "skipped", reason: "merge automatico non configurato" };
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
      if (res.status === "merged" && res.realigned) {
        svc.addComment({ taskId, author: "system", kind: "service", content: `Riallineato prima del land: ${res.realigned}.` });
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
        // È QUI che finisce la vita di review della card, non all'inizio del
        // land: l'anteprima si smonta quando il merge è confermato. Smontarla
        // prima di provare a fondere toglieva al reviewer la pagina viva anche
        // quando il land poi falliva e la card gli tornava in mano (idempotente).
        try { await opts?.teardownPreview?.(taskId); } catch { /* best-effort */ }
        // L'ALTRO verso dello stesso difetto. Il land promuoveva a `done` solo
        // passando da `review` (`POST …/land` lo fa prima di chiamare qui): da
        // ogni altro stato mergiava e lasciava la card dov'era. Misurato l'11/08
        // su `4ec47331` — lavoro su main (`a5f83e0e`), card `in_progress` con il
        // chip `working`, e un agente che ha speso un turno intero a rifarlo.
        // Un merge riuscito è l'affermazione più forte che il lavoro è finito:
        // lo stato la deve dire, da qualunque stato si arrivi. Idempotente sulle
        // card già chiuse e ferme (il caso normale), quindi non aggiunge righe
        // di storico al percorso che funzionava.
        const closed = svc.settleLanded({ taskId, by: "system", reason: `il land è riuscito: il codice è su main (${res.commit})` });
        // IL MERGE È AVVENUTO ANCHE QUANDO LA CARD NON SI CHIUDE. `settleLanded`
        // rifiuta di chiudere un padre che ha ancora step aperti (chiuderlo li
        // renderebbe irraggiungibili: il feed è `rootsOnly`), e senza questa riga
        // chi ha cliccato «Landa su main» leggerebbe «Mergiato su main» sopra una
        // card che resta in review, senza sapere perché. Si nominano i passi:
        // sono quelli da chiudere o archiviare prima di approvarla.
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
        // Chi ASPETTAVA questa card lo scopre qui, non più all'approvazione:
        // adesso è questa la porta da cui una card landata arriva in `done`.
        if (closed && closed.status === "done") dispatcher?.onBlockerDone(taskId);
        // …e se un agente stava LAVORANDO su quella card, lo si ferma. Chiudere
        // la card lo toglie dalla coda ma non taglia il turno già partito, ed è
        // lì che vanno i soldi: misurato l'11/08 su due land di fila, $5,64
        // (`4ec47331`) e $8,24 (`56677242`, fermata entro un minuto) spesi a
        // rifare lavoro che era già su main. Non è un caso limite — è successo a
        // due land su due, e il conto sale a ogni land.
        //
        // DOPO `settleLanded`, mai prima: la fine del turno passa da `onTurnEnd`,
        // che su una card ancora `in_progress` RIPRENDE l'agente. Tagliare prima
        // di chiudere la card la farebbe ripartire.
        if (closed && cutLiveTurn(closed, "il lavoro di questa card è atterrato su main: il turno non serve più")) {
          svc.addComment({
            taskId, author: "system",
            content: "Fermato l'agente che stava ancora lavorando su questa card: il suo lavoro è appena atterrato su main.",
          });
        }
        await reapAfterLand(taskId, "landed");
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
          if (res.touchedClient) {
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
                : `Build client fallita (exit ${build.code}). Lancia \`bun run build:client\` a mano.`,
            });
            if (build.code !== 0) console.error("[land] build:client failed for", taskId, build.stderr.slice(-2000));
          }
          if (res.touchedNative) {
            svc.addComment({ taskId, author: "system", content: "Il landing tocca desktop-tauri/: per vederlo nel shell nativo serve un rebuild dell'app (cargo build + relaunch)." });
          }
          if (res.touchedServer) {
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
        const fall = landFallout(res.code);
        const cur = svc.get(taskId, { projectId })?.task;
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
      // ── L'esito si REGISTRA adesso, non si ricostruisce dopo ────────────
      //
      // `landingState` lo scriveva solo una passata ogni 30 minuti che, dato il
      // commit di consegna, prova a DEDURRE se il suo contenuto è su main. Due
      // guai: il verdetto arrivava fino a mezz'ora tardi (rosso su lavoro appena
      // atterrato), e la deduzione sbaglia — provate a mano su 108 card, la
      // patch inversa dà 20 falsi allarmi, la riga distintiva 5, e il messaggio
      // «NON su main» nel thread ce l'hanno anche le card atterrate bene perché
      // è emesso alla CONSEGNA. L'unica prova che regge vale finché il ramo
      // esiste, cioè ADESSO.
      //
      // Quindi qui si scrive ciò che il land HA VISTO — `merged` = atterrato,
      // fallito = non atterrato — e lo si marca testimoniato, così la passata
      // periodica lo salta invece di sovrascriverlo con la sua deduzione. Solo
      // dove il land non sa (nessun ramo da guardare, o «non c'era niente da
      // portare») si chiede al repo.
      const verdict: LandingState | "ask" =
        res.status === "merged" ? (proof === true ? "landed" : "unverifiable")
        : res.status === "conflict" ? "unlanded"
        : res.status === "skipped" && res.code !== "no-branch" ? "unlanded"
        : "ask";
      try { await opts?.stampLanding?.(taskId, verdict); } catch { /* la spia non fa fallire un land */ }
      const updated = svc.get(taskId, { projectId })?.task;
      if (updated) broadcastToAll({ type: "task:updated", projectId, task: updated });
      // Restituisce l'esito al ticket della coda: GET /land lo riporta subito,
      // senza dover rileggere il task da un secondo GET.
      // `verdict === "ask"` copre i casi in cui il land non sa (nessun ramo, o
      // il ramo era gia' su main): li mappa su "skipped" per il chiamante MCP.
      const ticketOutcome: LandOutcomeResult['outcome'] =
        verdict === "ask" ? "skipped" : verdict;
      // La ragione e' utile solo quando il merge e' stato rifiutato: e' quella
      // che l'MCP riporta direttamente invece di lasciare che chi chiama apra
      // il thread della card.
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
      // ── Il percorso che produceva «zero commenti, zero ragione» ─────────────
      //
      // Questo `catch` copriva git, i commenti, la potatura del worktree e il
      // rebuild — e li copriva con un `console.error`. Il risultato per chi
      // guarda la board è una card in Done col codice sul suo ramo e un thread
      // che non dice niente: lo stesso stato che il land fallito «rumoroso»
      // (`skipped`) ha imparato a evitare, raggiunto dalla porta di servizio.
      //
      // Adesso un'eccezione dice tre cose, nell'ordine in cui servono: la riga
      // nel thread, il verdetto `unlanded` sulla card, e il ritiro da Done —
      // perché una card chiusa su lavoro non atterrato è quella che il GC dei
      // worktree può potare. Poi RILANCIA: il ticket in coda è l'unico posto
      // dove chi ha premuto «Landa» può ancora leggere com'è andata.
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

  /** Push a project's current branch to origin (triggers deploy CI where set up).
   *  Shared by the /publish endpoint and the agent-proposed "Landa e pubblica"
   *  option. Never resolves an unknown project — returns {ok:false}. */
  async function publishProject(projectId: string): Promise<{ ok: boolean; branch?: string; output?: string; error?: string }> {
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    const path = dirs.find((d) => projectIdForPath(d) === projectId);
    if (!path) return { ok: false, error: "progetto non trovato" };
    const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
    if (!branch) return { ok: false, error: "HEAD staccato: niente da pubblicare." };
    const push = await runGitCap(path, ["push", "origin", branch]);
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
      return { ok: false, reason: "path fuori dalle cartelle consentite (~/.topics/media, ~/.openclaw/media, workspace)" };
    }
    if (!isPreviewablePath(raw)) {
      return { ok: false, reason: "estensione non mostrabile: servono .png/.jpg, un video o un .svg" };
    }
    if (!existsSync(raw)) {
      return { ok: false, reason: `file non trovato sul disco: ${raw}` };
    }
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
        `${touched.join(", ")}: lo scatto della consegna non si modifica da qui. È ciò che il reviewer ha ` +
        "approvato, e la differenza fra quello e la punta del ramo è un'informazione, non un errore da " +
        "correggere. Se il ramo è andato avanti, o è indietro su main, ripremi «Landa su main»: il land " +
        "riallinea il ramo da sé e pubblica la punta, dicendo nel thread cosa ha riallineato.",
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
  function fanOutGate(taskId: string, forbidden: string): Response | null {
    let running = 0;
    try { running = attempts.runningCount(taskId); } catch { return null; }
    if (running < 1) return null;
    return json({
      error:
        `this task is in fan-out: ${running} parallel attempts are working the same task. ${forbidden}. ` +
        "work in YOUR worktree, commit everything on your branch, and end your turn with 2-3 sentences " +
        "describing what you did: the board composes the comparison from those.",
      code: "fanout_running",
    }, 409);
  }

  return async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
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
      || pathname === "/api/system/dispatch-capacity";
    if (identita?.role === "guest" && miePath) {
      const deviceId = identita.deviceId;
      if (!deviceId) return json({ error: "ospite senza identità" }, 403);
      // Sola lettura, senza eccezioni: un ospite che scrive in un thread o
      // dispaccia un agente è una superficie diversa, e va progettata quando il
      // caso esisterà (vedi `task-sharing-guests`, fuori scope).
      if (method !== "GET") return json({ error: "sola lettura", code: "guest_read_only" }, 403);

      // TUTTI i principali, come il cancello in `server.ts` e come
      // `/api/auth/shared`: il solo `deviceP` rendeva invisibile in questo
      // elenco una scheda condivisa con la PERSONA — che è il soggetto che
      // l'interfaccia offre — pur restando apribile per id dal cancello.
      const condivisi = new Set(
        grantedResourceIds(ctx.db, resolvePrincipals(ctx.db, deviceId).list, "task"),
      );

      // L'elenco: solo i suoi, e il PREDICATO ARRIVA FINO A SQL. Prima si
      // idratava ogni task del database — ogni etichetta, ogni bloccante, ogni
      // conto di coda — per poi tenerne i due condivisi in JS: l'ospite pagava
      // l'intera board per vedere le sue due schede. `ids` rende quel filtro una
      // clausola, e un insieme vuoto esce senza interrogare niente.
      if (pathname === "/api/all-boards/tasks") {
        return json({ tasks: svc.list({ scope: "all", rootsOnly: true, ids: [...condivisi] }) });
      }
      // Un task singolo, il suo thread, i suoi allegati: passa solo se l'id è
      // fra i condivisi. L'id si legge dal path, che è la forma che tutte le
      // rotte di questo router usano.
      const idNelPath = pathname.match(/\/api\/tasks\/([^/]+)/)?.[1];
      if (idNelPath && condivisi.has(decodeURIComponent(idNelPath))) {
        // prosegue allo smistamento normale
      } else {
        return json({ error: "non condiviso", code: "not_shared" }, 403);
      }
    }

    const isSession = pathname.startsWith("/api/sessions/");
    const isBoard = pathname.startsWith("/api/boards/");
    const isAllBoards = pathname.startsWith("/api/all-boards/");
    const isCapacity = pathname === "/api/system/dispatch-capacity";
    if (!isSession && !isBoard && !isAllBoards && !isCapacity) return null;

    // GET /api/all-boards/tasks — the global cross-project feed (human overview).
    // Read-only: per-task mutations still go to /api/boards/:projectId/... using
    // each task's own projectId.
    if (pathname === "/api/all-boards/tasks" && method === "GET") {
      const status = new URL(req.url).searchParams.get("status") || undefined;
      // Columns show ROOT tasks only — steps live in the parent's detail tree.
      // Tranne gli ORFANI (padre chiuso, archiviato o sparito): quello non è
      // l'albero di nessuno, e fuori dalle colonne non lo guarda più niente.
      try { return json({ tasks: svc.list({ scope: "all", status: asTaskStatus(status), rootsOnly: true, includeOrphanSubtasks: true }) }); }
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
      return json(computeDispatchCapacity(running, undefined, resolveAgentRuntime() === "cli"));
    }

    // GET /api/all-boards/publish-status — per-project "commits not yet pushed"
    // summary that feeds the board's Publish control (primarily the GLOBAL board,
    // where every project shows up together). Best-effort git, never throws.
    if (pathname === "/api/all-boards/publish-status" && method === "GET") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
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
      return json({ projects });
    }

    // POST /api/boards/:projectId/publish — push the project's current branch to
    // its remote. On repos with deploy CI (demoapp's deploy.yml runs on push to
    // main) this IS the deploy trigger — a deliberate, human-initiated action
    // (the board UI gates it behind a confirm).
    const bPublish = matchRoute(pathname, "/api/boards/:projectId/publish");
    if (bPublish && method === "POST") {
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
      if (!path) return json({ error: "progetto non trovato", code: "not_found" }, 404);
      const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
      if (!branch) return json({ error: "HEAD staccato", code: "invalid_input" }, 400);
      const upstream = (await runGitCap(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim();
      const range = upstream && !upstream.includes("fatal") ? `${upstream}..HEAD` : `origin/${branch}..HEAD`;
      const bundle = await gitDiffBundle(path, range);
      return json({ branch, range, ...bundle });
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
      const empty = { stat: [], patch: "", truncated: false, base: null, source: null };
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
      const bundle = await gitDiffBundle(range.cwd, range.range, { includeUntracked: range.live });
      const body = { branch, base: range.range, source: range.source, ...bundle };
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
          error: `etichette sconosciute: ${unknown.join(", ")}. Il vocabolario è chiuso (shared/task-labels.ts).`,
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
            error: "il fan-out non è ancora chiuso: aspetta che tutti i tentativi abbiano finito",
            code: "fanout_running",
          }, 409);
        }

        const target = attempts.get(attemptId);
        if (!target || target.taskId !== taskId) return json({ error: "attempt not found", code: "not_found" }, 404);
        if (!target.topicId) {
          return json({
            error: "questo tentativo non ha mai avuto una sessione: non c'è niente da tenere",
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
            error: `il fan-out di questo task è già stato deciso: ha vinto il tentativo #${giaScelto.idx}, e i worktree degli altri sono stati potati`,
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
          const cap = svc.getGlobalCap();
          return json({ autoDispatch: svc.getGlobalAutoDispatch(), maxAgentsAuto: cap.auto, maxAgents: cap.max });
        } catch (e) { return fail(e); }
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        const hasAuto = typeof body?.autoDispatch === "boolean";
        const hasCapAuto = typeof body?.maxAgentsAuto === "boolean";
        const hasCapMax = Number.isFinite(body?.maxAgents);
        if (!hasAuto && !hasCapAuto && !hasCapMax) {
          return json({ error: "autoDispatch, maxAgentsAuto (boolean) and/or maxAgents (number) required", code: "invalid_input" }, 400);
        }
        try {
          let autoDispatch = svc.getGlobalAutoDispatch();
          if (hasAuto) {
            autoDispatch = svc.setGlobalAutoDispatch(body.autoDispatch);
            broadcastToAll({ type: "board:dispatch", autoDispatch });
          }
          // The ONE machine-wide cap lives on the reserved '*' row; the dispatcher
          // reads it via getGlobalCap() and enforces it across every board.
          if (hasCapAuto || hasCapMax) {
            svc.setGlobalCap({
              auto: hasCapAuto ? body.maxAgentsAuto : undefined,
              max: hasCapMax ? body.maxAgents : undefined,
            });
          }
          const cap = svc.getGlobalCap();
          broadcastToAll({ type: "board:global-cap", maxAgentsAuto: cap.auto, maxAgents: cap.max });
          return json({ autoDispatch, maxAgentsAuto: cap.auto, maxAgents: cap.max });
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
        // Nella cartella dei progetti, non nel workspace: il workspace è
        // plumbing dell'agente, e un progetto battuto a mano che finisce lì
        // dispaccia ma non lo ritrovi più.
        const dir = join(newDir() ?? opts.workspaceDir, safeName);
        if (existsSync(dir)) {
          return json({ error: `project "${safeName}" already exists`, code: "project_exists" }, 409);
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "CLAUDE.md"), `# ${safeName}\n`);
          // REGISTRARLO, non solo crearlo. L'indice dei progetti è l'unione di
          // ciò che il server già referenzia (store, topic, worktree, cwd dei
          // terminali) più una scansione del workspace: una cartella nuova FUORI
          // dal workspace non è in nessuna di quelle liste, quindi sparirebbe dal
          // selettore al primo reload e il dispatcher non saprebbe risolvere l'id
          // della sua board. Finché si creava dentro il workspace il problema non
          // esisteva — la scansione lo ripescava — ed è riemerso appena i progetti
          // hanno cominciato a nascere dove l'utente li tiene davvero.
          const store = ctx.projectStore;
          if (store && !store.getByPath(dir)) {
            // Slug già preso da un altro progetto: se ne prova uno derivato
            // invece di lasciare la cartella orfana e invisibile.
            const base = store.slugify(safeName);
            for (const slug of [base, `${base}-${projectIdForPath(dir).split("-").pop()}`]) {
              try { store.create({ name: safeName, slug, path: dir, color: null, icon: null }); break; }
              catch { /* slug in conflitto: prova il prossimo */ }
            }
          }
        } catch (e) { return fail(e); }
        return json({ projectId: projectIdForPath(dir), name: safeName, path: dir }, 201);
      }
      return null;
    }

    // ── Human board API (project-scoped, actor="human") ─────────────────────
    // The board UI knows its projectId and drives these directly. A human MAY
    // move a task to 'done' (the review gate only blocks agents), archive it,
    // and approve/reject a pending review.
    if (isBoard) {
      const HUMAN = "user";

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
      ): Task | null => {
        if (!cutLiveTurn(t, reason)) return null;
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
            return json({ ...settings, worktreeReady: opts?.worktreeReady?.(projectId) ?? true });
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
                  `troppi check: ne hai mandati ${body.reviewChecks.length}, il massimo è ${MAX_CHECKS}. ` +
                  "Non ne salvo un sottoinsieme: avresti un cancello che credi di avere e non hai. " +
                  "Togline qualcuno, o unisci due comandi in uno solo.",
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
              dispatchTimeoutMin: typeof body?.dispatchTimeoutMin === "number" ? body.dispatchTimeoutMin : undefined,
              dispatchMcp: typeof body?.dispatchMcp === "string" ? body.dispatchMcp : undefined,
              dispatchModel: typeof body?.dispatchModel === "string" ? body.dispatchModel : undefined,
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
              blockedByTaskId: typeof body?.blockedByTaskId === "string" ? body.blockedByTaskId : null,
              reuseBlockerContext: body?.reuseBlockerContext === true,
            });
            broadcastToAll({ type: "task:created", projectId: effectiveProjectId, task });
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
                  const rejected = svc.reviewDecision({ taskId: root.id, by: "user", decision: "reject", projectId });
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
          const parked = detachLiveAgent(got.task, NOTE_STOPPED_BY_HUMAN);
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
        // Un task con i checks rossi non si accetta per distrazione. Non è un
        // divieto: `force` lo scavalca, ed è per i casi in cui il rosso sei tu a
        // saperlo innocuo (un comando che non c'entra, un test già noto). Serve a
        // rendere l'eccezione una SCELTA, non il default silenzioso — la strada
        // normale resta rimandarlo all'agente.
        if (decision === "approve" && body?.force !== true) {
          try {
            const cur = svc.get(bReview.taskId, { projectId: bReview.projectId })?.task;
            if (cur?.checksState === "fail") {
              const red = (cur.checks ?? []).find((r) => !r.ok);
              return json({
                error:
                  `i checks pre-review sono ROSSI${red ? ` (\`${red.name}\`)` : ""}` +
                  `${cur.checksAt ? `, ultimo giro ${cur.checksAt}` : ""}. ` +
                  "Rimandalo all'agente, oppure approva comunque se il rosso non c'entra con questa consegna.",
                code: "checks_failed",
              }, 409);
            }
          } catch { /* la spia non deve poter bloccare un'accettazione */ }
        }
        try {
          const comment = typeof body?.comment === "string" ? body.comment : undefined;
          // "Landa e pubblica" = go online: accept + merge to main + push (deploy CI).
          // The agent may offer it at delivery; picking it runs the whole chain.
          // Publishing is a human PICK (this click), executed server-side — the agent
          // never pushes. Check BEFORE the land label (this is the superset action).
          if (isPublishActionLabel(comment)) {
            const { projectId, taskId } = bReview;
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
          // it arrives here as a reject-with-that-text. LANDING = merge THEN accept:
          // la card resta in review e la chiude il land, quando main lo conferma —
          // mai un reject. È il difetto del 13/08 al contrario: l'approvazione
          // raccontava l'intenzione, e il lavoro poteva non arrivare mai.
          // LE DUE RISPOSTE ALLO STALLO DEI SOTTOTASK PARCHEGGIATI. Arrivano
          // qui come un rifiuto che porta l'etichetta, esattamente come «Landa
          // su main» — ma non sono né un rifiuto né un'approvazione: sono la
          // risposta a una domanda che il SISTEMA ha fatto, e la esegue il
          // sistema. Rimandarle all'agent (il ramo `reject` sotto) avrebbe fatto
          // ripartire un turno per spostare due card, cioè avrebbe pagato un
          // agente per fare un UPDATE.
          // La TERZA uscita, che esiste perche' le prime due potevano girare a
          // vuoto: la card torna in mano a una persona, i figli restano dove
          // sono. Non passa da `resolveParkedChildren` — non risolve i figli,
          // toglie il task dal giro dell'agente, che e' cio' che serve quando
          // rimetterli in coda si e' gia' dimostrato circolare.
          if (isTakeOverParkedLabel(comment)) {
            const preso = svc.update({
              taskId: bReview.taskId, actor: "human", by: HUMAN,
              patch: { status: "in_progress", assignedTo: HUMAN },
            });
            broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: preso });
            return json(preso);
          }
          if (isRequeueParkedLabel(comment) || isArchiveParkedLabel(comment)) {
            const decision = isRequeueParkedLabel(comment) ? "requeue" as const : "archive" as const;
            const esito = svc.resolveParkedChildren({ taskId: bReview.taskId, decision, by: HUMAN });
            if (!esito) {
              return json({
                error: "questo task non ha più sottotask parcheggiati: la domanda è già stata risolta",
                code: "no_parked_children",
              }, 409);
            }
            broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: esito.task });
            // I figli non viaggiano nel feed della board (`rootsOnly`), ma il
            // drawer aperto sul padre sì: senza questo, chi guarda vede il padre
            // ripartire e i sottotask ancora parcheggiati finché non ricarica.
            for (const c of esito.children) broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: c });
            if (dispatcher && esito.task.status === "todo") dispatcher.onEnterTodo(bReview.projectId, bReview.taskId);
            return json(esito.task);
          }
          if (isLandActionLabel(comment)) {
            const before = svc.get(bReview.taskId, { projectId: bReview.projectId })?.task;
            if (!before) return json({ error: "task not found", code: "not_found" }, 404);
            const ticket = enqueueLand(bReview.projectId, bReview.taskId);
            const queued = svc.get(bReview.taskId, { projectId: bReview.projectId })?.task ?? before;
            return json({ ...queued, landing: ticket }, 202);
          }
          const task = svc.reviewDecision({
            taskId: bReview.taskId, by: HUMAN, decision, comment,
            projectId: bReview.projectId,
          });
          broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task });
          // Reject re-kicks the SAME agent tab with the human's feedback (a
          // "Serve te" answer routes through here too), so the conversation
          // resumes instead of a fresh agent spawning. reviewDecision already
          // moved it back to in_progress.
          if (dispatcher && decision === "reject" && task.assignedTopicId) {
            dispatcher.resume(bReview.taskId, comment ?? "")
              .catch((err) => console.warn(`[Tasks] resume after reject failed for ${bReview.taskId}:`, err));
          }
          // Approve = ACCEPT the task only (→ done, dependents claimable). It no
          // longer merges/builds/reaps "da sotto": landing is now an EXPLICIT step
          // — the agent's "Landa su main" option above, or POST …/land.
          if (dispatcher && decision === "approve" && task.status === "done") {
            dispatcher.onBlockerDone(bReview.taskId);
            // Accepted (not landed): the preview server is no longer needed.
            void opts?.teardownPreview?.(bReview.taskId).catch(() => {});
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
        if (!ticket) return json({ error: "nessun land richiesto per questo task", code: "not_found" }, 404);
        return json({ landing: ticket, pending: landings.pending(bLand.projectId) });
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
            return json({ error: "preview manager non disponibile", code: "unavailable" }, 503);
          }
          await opts.preparePreview(bPreview.taskId, { explain: true });
          // Rileggo DOPO: previewImage/output_url li scrive il preview manager
          // direttamente sul db, e la card deve aggiornarsi su ogni device.
          const task = svc.get(bPreview.taskId, { projectId: bPreview.projectId })?.task ?? before;
          broadcastToAll({ type: "task:updated", projectId: bPreview.projectId, task });
          return json({ task, previewImage: task.previewImage ?? null, outputUrl: task.outputUrl ?? null });
        } catch (e) { return fail(e); }
      }

      const bComments = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/comments");
      if (bComments && method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const comment = svc.addComment({
            taskId: bComments.taskId, author: HUMAN, content: body?.content,
            mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
            media: filterMedia(body?.media),
            projectId: bComments.projectId,
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
          if (body?.quiet === true) return json(comment, 201);
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
          {
            const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
            const target = root?.id ?? bComments.taskId;
            if (pendingRoutedAsk(target) && answerRoutedAsk(askRouting, target, String(body?.content ?? ""))) {
              return json(comment);
            }
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
            if (dispatcher && root && root.assignedTopicId && (root.status === "review" || root.status === "in_progress")) {
              if (root.status === "review") {
                const rejected = svc.reviewDecision({
                  taskId: root.id, by: HUMAN, decision: "reject", projectId: bComments.projectId,
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
              dispatcher.resume(root.id, msg)
                .catch((err) => console.warn(`[Tasks] resume after comment failed for ${root.id}:`, err));
            }
          } catch { /* the root may have moved meanwhile */ }
          return json(comment, 201);
        } catch (e) { return fail(e); }
      }

      const bItem = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId");
      if (bItem) {
        const { projectId, taskId } = bItem;
        if (method === "GET") {
          const got = svc.get(taskId, { projectId });
          if (!got) return json({ error: "task not found", code: "not_found" }, 404);
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
          try {
            const prevStatus = svc.get(taskId, { projectId })?.task.status;
            // Invalidate probe cache when output_url changes (new URL needs a fresh probe).
            if (parsed.patch.outputUrl !== undefined) {
              const old = svc.get(taskId, { projectId })?.task.outputUrl;
              if (old) invalidateProbeCache(old);
            }
            let task = svc.update({
              taskId, actor: "human", by: HUMAN, projectId,
              patch: parsed.patch,
            });
            task = await captureDelivery(task, prevStatus);
            broadcastToAll({ type: "task:updated", projectId, task });
            emitReviewReadyEdge(broadcastToAll, projectId, task, prevStatus, undefined,
              () => svc.get(taskId)?.comments);
            triggerUrlProbe(taskId, task.outputUrl, projectId);
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
              detachLiveAgent(got.task, NOTE_ARCHIVED_BY_HUMAN);
            }
            const task = svc.archive({ taskId, projectId });
            void opts?.teardownPreview?.(taskId).catch(() => {}); // reap preview on close
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
                error: `una card lo dice già: «${twins[0]!.task.text}». Leggi quella e commentala con add_comment; se è davvero un altro lavoro, ricrea con allow_duplicate: true.`,
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
            text: body?.text,
            description: body?.description ?? null,
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
          error: `etichette sconosciute: ${unknown.join(", ")}. Le etichette che un agente può scrivere sono visibile, decisione, bugfix, feature, chore, misura`,
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
        if (body?.status === "review") {
          let isDelivery = false;
          let reviewGateTask: ReturnType<typeof svc.get> | null = null;
          try {
            reviewGateTask = svc.get(item.taskId, { projectId: sess.projectId });
            const lastOwn = reviewGateTask ? [...reviewGateTask.comments].reverse().find(
              (c) => c.author !== "user" && c.author !== "system" && c.kind === "comment",
            ) : null;
            const isQuestion = commentAsksHuman(lastOwn?.content);
            isDelivery = !!reviewGateTask && reviewGateTask.task.status !== "review" && !isQuestion;
          } catch { /* gate is best-effort: a git/store hiccup must never block a delivery */ }

          if (isDelivery && opts?.taskWorktreeDirtProbe) {
            try {
              const probe = await opts.taskWorktreeDirtProbe(item.taskId);
              if (probe === null) {
                // La sonda non ha trovato nessun worktree di ramo per questo
                // task. Se il task ha (o ha avuto) un ramo, la risposta giusta
                // e' «non so» — che in un cancello vale «rifiuta». Un worktree
                // eliminato prima della review, un legame topic spezzato dal
                // release: in entrambi i casi lasciare passare sarebbe aprire
                // il cancello per ignoranza.
                //
                // Regola: se il task ha un delivery_branch o un tentativo con
                // worktree registrato, rifiuta con ragione leggibile. Se davvero
                // non ha MAI avuto un ramo, lascia passare (task in-place).
                const hasBranch =
                  !!reviewGateTask?.task.deliveryBranch ||
                  opts.taskHasBranchAttempt?.(item.taskId) === true;
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
            } catch { /* gate is best-effort: a git/store hiccup must never block a delivery */ }
          }

          // Secondo gate, DOPO quello sul commit: i comandi girano sul codice
          // committato, quindi ha senso solo una volta che c'è. Un rosso torna
          // all'agente con l'output del comando — non "consegna rifiutata", il
          // motivo vero, così la riparazione parte da lì e non da un'indagine.
          //
          // A GAMBE, non in un fiato: la corsa vive nel registro e questa
          // richiesta aspetta al massimo `legMs`. Il 202 non è un esito, è
          // "richiama": lo stato del task non si muove finché non c'è un
          // verdetto, e chi ricicla è il client MCP (callUpdateTask).
          if (isDelivery) {
            const outcome = await runChecksGate(item.taskId, sess.projectId, legMs).catch(() => null);
            if (outcome && "pending" in outcome) {
              const t = svc.get(item.taskId, { projectId: sess.projectId })?.task;
              return json({
                pending: true,
                code: "review_checks_running",
                legMs,
                status: t?.status ?? null,
                checksState: t?.checksState ?? "running",
              }, 202);
            }
            if (outcome && !outcome.ok) {
              return json({ error: outcome.comment, code: "review_needs_green_checks" }, 409);
            }
          }
        }
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
            projectId: sess.projectId,
            agentTopicId: sess.topicId,
            patch: parsed.patch,
          });
          task = await captureDelivery(task, prevStatus);
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          // È QUESTA la porta che conta per i tasti del banner: l'agente commenta
          // la domanda con `options` e poi si sposta in review da qui (MCP
          // update_task). Al momento del fronte la domanda è l'ultima riga del
          // thread — esattamente ciò che la card mostra come quick-reply.
          emitReviewReadyEdge(broadcastToAll, sess.projectId, task, prevStatus, undefined,
            () => svc.get(task.id)?.comments);
          triggerUrlProbe(item.taskId, task.outputUrl, sess.projectId);
          return json(task);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    return null;
  };
}
