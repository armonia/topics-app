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
import type { AppContext, RouteHandler } from "../types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { isAgentWorking } from "../../shared/board";
import { getTerminalSessionById } from "./terminal";
import { AUTO_PROJECT_ID, createTaskService, isLandActionLabel, isPublishActionLabel, projectIdForPath, TaskServiceError, UNASSIGNED_PROJECT_ID } from "../services/tasks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";
import type { TaskDispatcher } from "../services/task-dispatcher";
import type { TaskAutoMerge } from "../services/task-automerge";
import { decidePostLandReap, type BranchStatus, type LandOutcome } from "../services/worktree-gc";
import { formatChecksComment, parseReviewChecks, runReviewChecks, type ReviewCheck } from "../services/review-checks";
import { createTaskAttemptStore, type TaskAttempt } from "../services/task-attempts";
import { attemptHasWork, formatAttemptStat } from "../../shared/task-attempt";

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
): void {
  if (task && task.status === "review" && prevStatus !== "review") {
    broadcast({
      type: "task:review-ready",
      projectId,
      taskId: task.id,
      taskTitle: task.text || "Task",
      ...(reason ? { reason } : {}),
    });
  }
}

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
   * The task branch and its current tip, for the delivery snapshot taken when a
   * task enters `review`. `null` ⇒ no branch worktree (in-place task), nothing
   * to audit later.
   */
  taskDeliveryRef?: (taskId: string) => Promise<{ branch: string; commit: string } | null>;
  /**
   * Dove girano i checks pre-review: la cartella del worktree del task e il commit
   * su cui sta in quel momento. `null` ⇒ nessun worktree di branch (task in-place),
   * niente su cui eseguire → gate saltato. Il commit serve a datare l'esito: un
   * "verde" vale per QUEL codice, non per il branch a vita.
   */
  taskCheckoutRef?: (taskId: string) => Promise<{ cwd: string; commit: string | null } | null>;
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
   * Boot the review preview from the task's worktree. Serve alla scelta del
   * vincitore di un fan-out: la consegna arriva in review PRIMA che il task abbia
   * un worktree suo (quello del tentativo 1 può non essere il vincitore), quindi
   * l'anteprima non può partire alla consegna — parte quando il worktree del task
   * diventa quello scelto. Assente ⇒ nessuna anteprima, la scelta funziona lo stesso.
   */
  preparePreview?: (taskId: string) => Promise<void>;
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

/** Payload cap for a diff patch (~200 KB): a huge range renders the first slice
 *  and flags `truncated` so the UI shows a "…troncato" note rather than shipping
 *  megabytes into the client. */
const DIFF_PATCH_CAP = 200_000;

/** Cap on how many untracked files we fold into a task diff — a runaway worktree
 *  (node_modules never gitignored, a build dir…) must not spawn thousands of git
 *  processes. Beyond this we stop; the patch cap already bounds the payload. */
const UNTRACKED_FILE_CAP = 500;

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
    const path = parts[parts.length - 1] ?? "";
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

  /**
   * Land a task's branch on main (merge locally, reap the worktree, rebuild the
   * client if it changed). ON-DEMAND — this used to ride on every approve, which
   * meant approving a task also merged/built "da sotto". Now approve just accepts
   * the task; landing is an explicit human step (a "Landa su main" quick-reply the
   * agent offers, or the /land endpoint / button). Fire-and-forget internally: a
   * slow/failed git op never blocks the caller; all outcomes surface as system
   * comments. NEVER pushes (the release/publish pipeline stays the sole pusher).
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
    const [dirtAfter, branchAfter] = await Promise.all([
      opts.taskWorktreeDirt?.(taskId).catch(() => null) ?? Promise.resolve(null),
      opts.taskBranchStatus?.(taskId).catch(() => "unmerged" as BranchStatus) ?? Promise.resolve(null),
    ]);
    // No branch worktree to reason about (in-place task) → nothing to reap.
    if (dirtAfter === null && branchAfter === null) return;
    const post = decidePostLandReap({
      outcome,
      branchAfter: branchAfter ?? "gone",
      dirtAfter: dirtAfter ?? [],
    });
    if (post.action === "keep") {
      svc.addComment({
        taskId, author: "system",
        content: `⚠️ Worktree NON ripulito: ${post.reason}. Il branch del task è stato conservato — recupera il lavoro o cancellalo a mano.`,
      });
      return;
    }
    const reaped = await opts.deleteTaskWorktree(taskId).catch(() => false);
    if (reaped) svc.addComment({ taskId, author: "system", content: "Worktree e branch del task ripuliti." });
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
      topic.archived = true;
      topic.updatedAt = new Date().toISOString();
      ctx.saveSingleTopic(topic);
      broadcastToAll({ type: "topic:archived", topic });
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
  async function captureDelivery<T extends { id: string; status: string }>(task: T, prevStatus?: string): Promise<T> {
    if (task.status !== "review" || prevStatus === "review" || !opts?.taskDeliveryRef) return task;
    try {
      const ref = await opts.taskDeliveryRef(task.id);
      if (!ref) return task; // in-place task: nothing to compare against main
      svc.recordDelivery({ taskId: task.id, branch: ref.branch, commit: ref.commit });
      // Return the REFRESHED row so the response and the broadcast already carry
      // the snapshot — otherwise the board only learns about it on a refetch.
      return (svc.get(task.id)?.task as T | undefined) ?? task;
    } catch { /* best-effort: never block a delivery on git */ }
    return task;
  }

  /**
   * Terzo gate strutturale sulla review, dopo il commit (`review_needs_commit`) e
   * il riassunto (`review_needs_summary`): i comandi dichiarati sulla board devono
   * essere VERDI. Non si chiede all'agente se ha fatto girare i test — si fanno
   * girare, nel suo worktree, sul codice che ha appena committato.
   *
   * Ritorna `null` quando il gate non si applica (board senza comandi, task senza
   * worktree di branch): "nessun check" non è un verde e non deve scriverne uno.
   *
   * Sincrono di proposito: se girasse in background il task entrerebbe in review
   * SUBITO e il reviewer vedrebbe una consegna guardabile mentre i check ancora
   * girano — cioè esattamente la cosa che il gate esiste per impedire. L'agente
   * aspetta, e in cambio riceve l'output del comando rosso senza doverlo cercare.
   */
  async function runChecksGate(
    taskId: string,
    projectId: string,
  ): Promise<{ ok: boolean; comment: string } | null> {
    if (!opts?.taskCheckoutRef) return null;
    let checks: ReviewCheck[] = [];
    try { checks = svc.getBoardSettings(projectId).reviewChecks; } catch { return null; }
    if (!checks.length) return null;
    const ref = await opts.taskCheckoutRef(taskId).catch(() => null);
    if (!ref) return null;

    // 'running' subito e in broadcast: i comandi possono durare minuti e una board
    // ferma senza spiegazioni si legge come "si è impiantato".
    try {
      const t = svc.recordChecks({ taskId, state: "running", commit: ref.commit, runs: null });
      broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch { /* il gate vale anche senza la spia */ }

    const runs = await runReviewChecks(checks, { cwd: ref.cwd });
    const ok = runs.length === checks.length && runs.every((r) => r.ok);
    const comment = formatChecksComment(runs, { commit: ref.commit });
    try {
      svc.recordChecks({ taskId, state: ok ? "pass" : "fail", commit: ref.commit, runs });
      svc.addComment({ taskId, author: "system", content: comment });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
    } catch { /* l'esito conta più della sua registrazione */ }
    return { ok, comment };
  }

  async function landTask(projectId: string, taskId: string): Promise<void> {
    const autoMerge = opts?.autoMerge;
    if (!autoMerge) {
      svc.addComment({ taskId, author: "system", content: "Landing non disponibile: merge automatico non configurato per questo host." });
      const t = svc.get(taskId, { projectId })?.task;
      if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
      return;
    }
    const task = svc.get(taskId, { projectId })?.task;
    if (!task) return;
    // Landing ends the task's review life — reap its preview server (idempotent).
    try { await opts?.teardownPreview?.(taskId); } catch { /* best-effort */ }
    try {
      const res = await autoMerge.tryMerge(taskId, task.text);
      if (res.status === "merged") {
        svc.addComment({ taskId, author: "system", content: `Mergiato su main (commit ${res.commit}).` });
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
              content: build.code === 0
                ? "Client ricostruito: la modifica è visibile (hard refresh se non appare)."
                : `Build client fallita (exit ${build.code}) — lancia \`bun run build:client\` a mano.`,
            });
            if (build.code !== 0) console.error("[land] build:client failed for", taskId, build.stderr.slice(-2000));
          }
          if (res.touchedNative) {
            svc.addComment({ taskId, author: "system", content: "Il landing tocca desktop-tauri/: per vederlo nel shell nativo serve un rebuild dell'app (cargo build + relaunch)." });
          }
          if (res.touchedServer) {
            svc.addComment({ taskId, author: "system", content: "Il landing tocca il server: andrà live al prossimo reload del server (hot-reload watch attivo, o riavvio manuale)." });
          }
        }
      } else if (res.status === "nothing") {
        // "nothing" = the branch has no commits main lacks BY ANCESTRY. That is
        // the exact claim that cost us the `watching` phase — verify it against
        // the repo (content, not ancestry) before destroying anything.
        await reapAfterLand(taskId, "nothing");
      } else if (res.status === "conflict") {
        svc.update({ taskId, actor: "human", by: "user", projectId, patch: { status: "in_progress" } });
        svc.addComment({ taskId, author: "system", content: "Merge automatico in conflitto con main — rimando all'agent per risolvere." });
        dispatcher?.resume(
          taskId,
          'Il merge automatico del tuo branch su main è andato in conflitto. Porta main dentro il tuo branch (git merge main, oppure rebase), risolvi i conflitti, poi rimetti in review con update_task(status="review").',
        ).catch((err) => console.warn(`[Tasks] resume after merge-conflict failed for ${taskId}:`, err));
      } else if (res.status === "skipped") {
        svc.addComment({ taskId, author: "system", content: `⚠️ Land NON riuscito: ${res.reason}. Il branch del task NON è su main — risolvi e rilancia "Landa su main".` });
      }
      const updated = svc.get(taskId, { projectId })?.task;
      if (updated) broadcastToAll({ type: "task:updated", projectId, task: updated });
    } catch (e) {
      console.error("[land] failed for", taskId, e);
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
    if (!branch) return { ok: false, error: "HEAD staccato — niente da pubblicare" };
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
   * Resolve the board project id + a display author from a session key. Works
   * for BOTH a chat topic bound to a project and a Claude terminal tab (which
   * has a cwd but no chat topic). Returns null when the session is unbound.
   * `topicId` (chat sessions only) feeds the "own steps" carve-out: it lets the
   * service recognise subtasks of the task dispatched to THIS agent.
   */
  function resolveSession(sessionKey: string): { projectId: string; author: string; actor: string; topicId: string | null } | null {
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      // A dispatched agent's board is the board of the task bound to its topic,
      // NOT the topic's cwd: a catch-all ("generale") task runs in a per-task
      // private dir (~/.openclaw/workspace/tasks/<id8>) that maps to no real
      // board, so cwd-derived scoping 404s every one of the agent's own task
      // ops. When the topic carries a bound task, scope to THAT board.
      const boundProject = topic.id ? svc.boardProjectForTopic(topic.id) : null;
      const projectId = boundProject ?? projectIdForPath(topic.projectPath);
      // `author` e `actor` sono due cose diverse e finivano nello stesso campo.
      // `author` è un NOME DA MOSTRARE nel thread — e per un topic di agente è
      // il titolo del task, il che va benissimo sopra un commento. `actor` è
      // CHI ha fatto la transizione, e finisce nello storico di stato: lì il
      // titolo del task rendeva la timeline illeggibile, perché non distingueva
      // umano, agente e dispatcher (erano tutti "il nome del task").
      return {
        projectId,
        author: topic.name?.trim() || "claude",
        actor: topic.id ? `agent:${topic.id}` : "agent",
        topicId: topic.id ?? null,
      };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      // Tab di terminale: nessun topic, quindi l'attore è la sessione stessa.
      return {
        projectId: projectIdForPath(term.cwd),
        author: (term.name || "").trim() || "claude",
        actor: `agent:${sessionKey.slice(0, 16)}`,
        topicId: null,
      };
    }
    return null;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
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
        `this task is in fan-out: ${running} parallel attempts are working the same task. ${forbidden} — ` +
        "work in YOUR worktree, commit everything on your branch, and end your turn with 2-3 sentences " +
        "describing what you did: the board composes the comparison from those.",
      code: "fanout_running",
    }, 409);
  }

  return async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // Fast reject: only task paths — agent (session-scoped) or human (board-scoped),
    // plus the machine-wide dispatch-capacity probe (a /api/system/ path that this
    // router owns because it reads the same dispatch config).
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
      try { return json({ tasks: svc.list({ scope: "all", status: status as any, rootsOnly: true }) }); }
      catch (e) { return fail(e); }
    }

    // GET /api/system/dispatch-capacity — the auto concurrency cap this machine
    // can sustain right now (CPU/load), shown in the board settings' "Auto" option.
    if (pathname === "/api/system/dispatch-capacity" && method === "GET") {
      return json(computeDispatchCapacity());
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
    // its remote. On repos with deploy CI ([cliente]'s deploy.yml runs on push to
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

    // GET /api/boards/:projectId/tasks/:taskId/diff — the unified diff of what a
    // dispatched task changed in its own isolated worktree (vs the branch point).
    // Resolves task → topic → worktree (same chain as auto-merge); returns an
    // empty bundle with a code when the task has no isolated worktree yet.
    const bTaskDiff = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/diff");
    if (bTaskDiff && method === "GET") {
      const empty = { stat: [], patch: "", truncated: false };
      let found: ReturnType<typeof svc.get> | null = null;
      try { found = svc.get(bTaskDiff.taskId, { projectId: bTaskDiff.projectId }) ?? null; }
      catch { found = null; }
      if (!found) return json({ code: "no_worktree", branch: null, ...empty });
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
      if (!topicId) return json({ code: "no_worktree", branch: null, ...empty });
      const worktreeId = ctx.getTopicById(topicId)?.worktreeId;
      const wt = worktreeId ? ctx.worktreeStore.get(worktreeId) : null;
      if (!wt || wt.mode !== "branch" || !wt.absPath || !existsSync(wt.absPath)) {
        return json({ code: "no_worktree", branch: wt?.branchName ?? null, ...empty });
      }
      // Diff against the branch point (merge-base) so the bundle is exactly what
      // this task did — committed work on its branch AND any uncommitted edits —
      // without noise from commits main gained meanwhile.
      const base = (await runGitCap(wt.absPath, ["merge-base", "main", "HEAD"])).out.trim() || "main";
      // includeUntracked: a task whose only deliverable is a brand-new (never
      // committed) file must still show a diff, not an empty bundle.
      const bundle = await gitDiffBundle(wt.absPath, base, { includeUntracked: true });
      return json({ branch: wt.branchName, base, ...bundle });
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

        const picked = attempts.select(taskId, attemptId);
        if (!picked) return json({ error: "attempt not found", code: "not_found" }, 404);
        const winner = picked.winner;

        let task = svc.bindTopic({ taskId, topicId: winner.topicId! });

        // La consegna è di ADESSO: branch e commit dell'audit sono quelli del
        // vincitore, non quelli del tentativo 1 a cui il task era legato un
        // istante fa. `captureDelivery` non scatta (il task è in review da
        // quando il fan-out ha chiuso), quindi la fotografia si prende qui.
        if (opts?.taskDeliveryRef) {
          try {
            const ref = await opts.taskDeliveryRef(taskId);
            if (ref) {
              svc.recordDelivery({ taskId, branch: ref.branch, commit: ref.commit });
              task = svc.get(taskId, { projectId })?.task ?? task;
            }
          } catch { /* la scelta vale anche senza fotografia */ }
        }

        const losers = picked.losers;
        await Promise.all(losers.map((l) => reapAttemptWorkspace(l)));

        // Stesso formato del confronto e del pannello (`formatAttemptStat`): due
        // modi di scrivere lo stesso numero si leggono come due numeri diversi.
        const stat = attemptHasWork(winner)
          ? ` (${formatAttemptStat(winner)})`
          : " — che però non ha modificato niente";
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
    //          (projectId = the same hash the boards key on).
    //   POST → scaffold a NEW workspace project (same contract as the session
    //          create-project route: sanitized name, dir + CLAUDE.md, 409 on
    //          collision) so "Nuovo progetto…" works from the board too.
    if (pathname === "/api/all-boards/projects") {
      if (method === "GET") {
        const seen = new Set<string>();
        const projects: Array<{ projectId: string; name: string; path: string }> = [];
        let dirs: string[] = [];
        try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        for (const raw of dirs) {
          if (typeof raw !== "string" || !raw.startsWith("/")) continue;
          const path = raw.replace(/\/+$/, "");
          if (!path || seen.has(path)) continue;
          seen.add(path);
          projects.push({ projectId: projectIdForPath(path), name: basename(path), path });
        }
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return json({ projects });
      }
      if (method === "POST") {
        if (!opts?.workspaceDir) return json({ error: "workspace not configured", code: "invalid_input" }, 500);
        const body = (await readJSON(req)) as any;
        const safeName = (typeof body?.name === "string" ? body.name.trim() : "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required", code: "invalid_input" }, 400);
        const dir = join(opts.workspaceDir, safeName);
        if (existsSync(dir)) {
          return json({ error: `project "${safeName}" already exists`, code: "project_exists" }, 409);
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "CLAUDE.md"), `# ${safeName}\n`);
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
          try {
            const settings = svc.updateBoardSettings(projectId, {
              autoDispatch: typeof body?.autoDispatch === "boolean" ? body.autoDispatch : undefined,
              maxAgents: typeof body?.maxAgents === "number" ? body.maxAgents : undefined,
              dispatchEffort: typeof body?.dispatchEffort === "string" ? body.dispatchEffort : undefined,
              dispatchUseWorktree: typeof body?.dispatchUseWorktree === "boolean" ? body.dispatchUseWorktree : undefined,
              dispatchAutoMerge: typeof body?.dispatchAutoMerge === "boolean" ? body.dispatchAutoMerge : undefined,
              dispatchTimeoutMin: typeof body?.dispatchTimeoutMin === "number" ? body.dispatchTimeoutMin : undefined,
              dispatchMcp: typeof body?.dispatchMcp === "string" ? body.dispatchMcp : undefined,
              dispatchModel: typeof body?.dispatchModel === "string" ? body.dispatchModel : undefined,
              dispatchFanOut: typeof body?.dispatchFanOut === "number" ? body.dispatchFanOut : undefined,
              nightMode: typeof body?.nightMode === "boolean" ? body.nightMode : undefined,
              nightModeUntil: typeof body?.nightModeUntil === "string" ? body.nightModeUntil : undefined,
              // Passa dal parser tollerante: il pannello manda una lista di
              // stringhe (una riga = un comando), la board può averne una lunga
              // salvata a mano. Una sola forma canonica esce da qui.
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

      const bCol = matchRoute(pathname, "/api/boards/:projectId/tasks");
      if (bCol) {
        const projectId = bCol.projectId;
        if (method === "GET") {
          const status = new URL(req.url).searchParams.get("status") || undefined;
          // Root tasks only: a step never renders as its own card (drawer tree).
          try { return json({ tasks: svc.list({ scope: "project", projectId, status: status as any, rootsOnly: true }) }); }
          catch (e) { return fail(e); }
        }
        if (method === "POST") {
          const body = (await readJSON(req)) as any;
          try {
            // Project "Auto": resolve the real board from a known project name
            // mentioned in the task text. Exactly one distinct hit → that board
            // (auto-assigned). None/ambiguous → the catch-all workspace so the
            // task STILL RUNS standalone — a project-less task MUST dispatch (by
            // request). The dispatcher only ticks real boards, so the catch-all
            // is a real (scaffolded, non-git, in-place) board; its "generale"
            // label is hidden client-side (the card treats it as "no project").
            // Only a host with no workspace at all degrades to UNASSIGNED.
            let effectiveProjectId = projectId;
            if (projectId === AUTO_PROJECT_ID) {
              const haystack = `${body?.text ?? ""}\n${body?.description ?? ""}`.toLowerCase();
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
              if (hits.size === 1) {
                effectiveProjectId = [...hits][0];
              } else if (opts?.workspaceDir) {
                const dir = join(opts.workspaceDir, "generale");
                if (!existsSync(dir)) {
                  try {
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(join(dir, "CLAUDE.md"), "# generale\n\nWorkspace catch-all: i task senza progetto girano qui, in-place (non-git).\n");
                    // Non-git → dispatch in-place (no worktree). Nothing else to
                    // set: a fresh board defaults autoDispatch on, so a project-
                    // less task starts without any manual setup.
                    svc.updateBoardSettings(projectIdForPath(dir), { dispatchUseWorktree: false });
                  } catch { /* fall through to unassigned below */ }
                }
                effectiveProjectId = existsSync(dir) ? projectIdForPath(dir) : UNASSIGNED_PROJECT_ID;
              } else {
                effectiveProjectId = UNASSIGNED_PROJECT_ID; // degraded host (no workspace)
              }
            }
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
          const t = got.task;
          const live = t.assignedTopicId || isAgentWorking(t.dispatchState);
          if (!live) return json({ error: "no active agent on this task", code: "invalid_transition" }, 409);
          const sessionKey = t.assignedTopicId ? "topic:" + t.assignedTopicId.slice(0, 8) : null;
          dispatcher?.onLeaveTodo(t.id); // clears a pending grace timer (queued)
          const parked = svc.release({
            taskId: t.id, requeue: false, by: "user",
            reason: "Fermato da te: agent interrotto. Rimetti il task in Todo per ripartire.",
          });
          broadcastToAll({ type: "task:updated", projectId: bStop.projectId, task: parked });
          if (sessionKey && opts?.abortTurn) void opts.abortTurn(sessionKey).catch(() => { /* best-effort */ });
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
                  `${cur.checksAt ? ` — ultimo giro ${cur.checksAt}` : ""}. ` +
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
            const approved = svc.reviewDecision({ taskId: bReview.taskId, by: HUMAN, decision: "approve", projectId: bReview.projectId });
            broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: approved });
            if (dispatcher && approved.status === "done") dispatcher.onBlockerDone(bReview.taskId);
            const { projectId, taskId } = bReview;
            void (async () => {
              await landTask(projectId, taskId);
              const pub = await publishProject(projectId);
              svc.addComment({
                taskId, author: "system",
                content: pub.ok
                  ? `Pubblicato: push di \`${pub.branch}\` su origin (deploy CI dove configurato).`
                  : `Pubblicazione FALLITA: ${pub.error}. Il merge locale (se avvenuto) resta — ripeti la pubblicazione col bottone Pubblica.`,
              });
              const t = svc.get(taskId, { projectId })?.task;
              if (t) broadcastToAll({ type: "task:updated", projectId, task: t });
            })();
            return json(approved);
          }
          // The agent offers "Landa su main" as a quick-reply at delivery; picking
          // it arrives here as a reject-with-that-text. LANDING = accept + merge, so
          // approve the task and run the land — never a reject. This is the ONLY
          // place approve is coupled to a merge, and it happens because YOU chose
          // the land option; a plain approve below is task-only, no "azioni da sotto".
          if (isLandActionLabel(comment)) {
            const approved = svc.reviewDecision({ taskId: bReview.taskId, by: HUMAN, decision: "approve", projectId: bReview.projectId });
            broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task: approved });
            if (dispatcher && approved.status === "done") dispatcher.onBlockerDone(bReview.taskId);
            void landTask(bReview.projectId, bReview.taskId);
            return json(approved);
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
      const bLand = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/land");
      if (bLand && method === "POST") {
        try {
          let task = svc.get(bLand.taskId, { projectId: bLand.projectId })?.task;
          if (!task) return json({ error: "task not found", code: "not_found" }, 404);
          if (task.status === "review") {
            task = svc.reviewDecision({ taskId: bLand.taskId, by: HUMAN, decision: "approve", projectId: bLand.projectId });
            broadcastToAll({ type: "task:updated", projectId: bLand.projectId, task });
            if (dispatcher && task.status === "done") dispatcher.onBlockerDone(bLand.taskId);
          }
          void landTask(bLand.projectId, bLand.taskId);
          return json(task);
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
          try {
            const prevStatus = svc.get(taskId, { projectId })?.task.status;
            let task = svc.update({
              taskId, actor: "human", by: HUMAN, projectId,
              patch: {
                status: typeof body?.status === "string" ? body.status : undefined,
                priority: typeof body?.priority === "number" ? body.priority : undefined,
                assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
                text: typeof body?.text === "string" ? body.text : undefined,
                description: body?.description !== undefined ? body.description : undefined,
                kanbanOrder: typeof body?.kanbanOrder === "number" ? body.kanbanOrder : undefined,
                outputUrl: typeof body?.outputUrl === "string" ? body.outputUrl : undefined,
                // Card preview: stesso fence dei media commenti — un path fuori
                // allowlist è scartato QUI (la patch non arriva al service).
                previewImage: typeof body?.previewImage === "string"
                  ? (body.previewImage.trim() === "" ? "" : (filterMedia([body.previewImage])?.length ? body.previewImage : undefined))
                  : undefined,
                model: body?.model !== undefined ? (typeof body.model === "string" ? body.model : null) : undefined,
                blockedByTaskId: body?.blockedByTaskId !== undefined
                  ? (typeof body.blockedByTaskId === "string" && body.blockedByTaskId ? body.blockedByTaskId : null)
                  : undefined,
                reuseBlockerContext: typeof body?.reuseBlockerContext === "boolean" ? body.reuseBlockerContext : undefined,
                planFirst: typeof body?.planFirst === "boolean" ? body.planFirst : undefined,
              },
            });
            task = await captureDelivery(task, prevStatus);
            broadcastToAll({ type: "task:updated", projectId, task });
            emitReviewReadyEdge(broadcastToAll, projectId, task, prevStatus);
            // Auto-dispatch trigger: the human dragging a task INTO todo is the
            // "vai" signal; dragging it back OUT while still queued cancels it.
            // The dispatcher itself no-ops when auto_dispatch is off for the board.
            if (dispatcher && prevStatus !== task.status) {
              if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
              else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
              // Reaching done releases whatever was waiting on this task.
              if (task.status === "done") dispatcher.onBlockerDone(taskId);
            }
            return json(task);
          } catch (e) { return fail(e); }
        }
        if (method === "DELETE") {
          try {
            const task = svc.archive({ taskId, projectId });
            void opts?.teardownPreview?.(taskId).catch(() => {}); // reap preview on close
            broadcastToAll({ type: "task:deleted", projectId, taskId });
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
          const tasks = svc.list({ scope, projectId: sess.projectId, status: status as any });
          return json({ tasks });
        } catch (e) { return fail(e); }
      }
      if (method === "POST") {
        const body = (await readJSON(req)) as any;
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
          error: `comment too long (${body.content.length} chars, max ${AGENT_COMMENT_MAX_CHARS}) — summarize: 1-2 short sentences, no logs or code dumps`,
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
            "some attachments are outside the allowed dirs — copy the file(s) into ~/.topics/media/ (or the workspace) and re-attach from there",
          code: "media_path_not_allowed",
        }, 400);
      }
      try {
        const comment = svc.addComment({
          taskId: commentsRoute.taskId,
          author: sess.author,
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
        if (!dispatcher) broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
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
        // Structural review gate: a DELIVERY with work still uncommitted in the
        // task's worktree is not reviewable — approve would find nothing to
        // merge and the work would strand ("implementato, NON committato").
        // Questions are exempt: an agent asking mid-work legitimately has a
        // dirty worktree. Prompt instructions alone never fixed this; the 409
        // coaches the retry like review_needs_summary does.
        if (body?.status === "review") {
          let isDelivery = false;
          try {
            const got = svc.get(item.taskId, { projectId: sess.projectId });
            const lastOwn = got ? [...got.comments].reverse().find(
              (c) => c.author !== "user" && c.author !== "system" && c.kind === "comment",
            ) : null;
            const isQuestion = !!lastOwn?.content?.includes("```question");
            isDelivery = !!got && got.task.status !== "review" && !isQuestion;
          } catch { /* gate is best-effort: a git/store hiccup must never block a delivery */ }

          if (isDelivery && opts?.taskWorktreeDirt) {
            try {
              const dirt = await opts.taskWorktreeDirt(item.taskId);
              if (dirt && dirt.length > 0) {
                return json({
                  error:
                    `your worktree has ${dirt.length} uncommitted change${dirt.length === 1 ? "" : "s"} ` +
                    `(${dirt.slice(0, 3).join(", ")}${dirt.length > 3 ? ", …" : ""}) — ` +
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
          if (isDelivery) {
            const outcome = await runChecksGate(item.taskId, sess.projectId).catch(() => null);
            if (outcome && !outcome.ok) {
              return json({ error: outcome.comment, code: "review_needs_green_checks" }, 409);
            }
          }
        }
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
            patch: {
              status: typeof body?.status === "string" ? body.status : undefined,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
              outputUrl: typeof body?.output_url === "string" ? body.output_url : undefined,
              // The agent may refine wording (a raw composer-born title →
              // clear, concise one). Same projectId guard as everything else.
              text: typeof body?.text === "string" && body.text.trim() ? body.text : undefined,
              description: typeof body?.description === "string" ? body.description : undefined,
            },
          });
          task = await captureDelivery(task, prevStatus);
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          emitReviewReadyEdge(broadcastToAll, sess.projectId, task, prevStatus);
          return json(task);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    return null;
  };
}
