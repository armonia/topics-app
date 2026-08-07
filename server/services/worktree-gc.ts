/**
 * Worktree garbage collection — the ORIGIN fix for worktree pile-up.
 *
 * Worktrees were only ever reaped on a successful approve→automerge (routes/
 * tasks.ts). Everything that finished WITHOUT that exact path leaked forever:
 * a task rejected then abandoned, a task deleted, an approve that the (old)
 * dirty-main bug skipped, an orphaned dispatch. 27 stale worktrees had piled
 * up by 2026-07-18.
 *
 * This sweep applies the SAME safety contract as the approve-time reap to the
 * whole population, periodically. The contract lives in `decideWorktreeReap`
 * as a pure function so it is exhaustively unit-testable: we only ever destroy
 * a worktree when there is provably nothing to lose.
 *
 * Never reaped: a worktree whose task is still active (backlog/todo/
 * in_progress/review), one with real uncommitted work (junk excluded), one
 * with unmerged commits when we can't safely land them, or one under a live
 * agent turn. A closed task whose clean commits never landed is re-merged
 * first (land-then-reap), never dropped.
 *
 * The one exception to "active ⇒ untouchable" is `abandon`: a task stuck in
 * `in_progress` with no sign of life for days is active only on paper, and it
 * held its checkout forever. That path keeps the BRANCH and parks the task —
 * it frees a directory, never a commit (see `isAbandoned`).
 */

export type WorktreeReapAction = "reap" | "land-then-reap" | "abandon" | "keep";

export interface WorktreeReapDecision {
  action: WorktreeReapAction;
  reason: string;
}

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export interface WorktreeReapInput {
  /** Bound task status, or null when the worktree is orphaned (no task/topic). */
  taskStatus: TaskStatus | null;
  /** Bound task archived flag (archived tasks are terminal regardless of status). */
  taskArchived: boolean;
  /** Non-junk uncommitted paths present (from worktreeRealDirt). */
  hasRealDirt: boolean;
  /** Worktree tip is an ancestor of main → no unmerged commits to lose. */
  mergedIntoMain: boolean;
  /** The task's board opted into auto-merge (so land-then-reap is allowed). */
  autoMergeEnabled: boolean;
  /** Only `branch`-mode worktrees own a landable branch. */
  mode: "branch" | "reuse" | "detached";
  /**
   * Days since the last sign of life on the bound task — a turn, a comment, a
   * chat message, a write to the agent's transcript. `null` = the host can't
   * measure it, and ignorance is never abandonment (same rule as the
   * dispatcher's liveness net: only a POSITIVE signal of death acts).
   */
  idleDays?: number | null;
  /** TTL for `abandon`: idle days after which an `in_progress` task counts as abandoned. `0`/absent = off. */
  abandonAfterDays?: number;
}

/**
 * The one non-terminal case that is nonetheless finished: a task stuck in
 * `in_progress` — agent dead, or a turn that simply never came back — holding
 * its worktree forever. `decideWorktreeReap` calls it `abandon`, deliberately
 * NOT `reap`: the branch survives (nothing committed is ever lost), only the
 * checkout goes, and the task is parked so nothing resumes into a directory
 * that no longer exists.
 *
 * Every condition here is a reason not to act, in the order that matters:
 * a TTL that's off, the wrong status, an unmeasurable idle, work that is still
 * only in the tree, or commits that live in a detached HEAD and would become
 * unreachable the moment the checkout goes.
 */
function isAbandoned(input: WorktreeReapInput): boolean {
  const ttl = input.abandonAfterDays ?? 0;
  if (ttl <= 0) return false;
  // Only `in_progress` — the state that CLAIMS an agent is at work right now.
  // `todo`/`backlog` are queued (a re-dispatch reuses the tree), `review` is a
  // human's pending decision and its worktree is the evidence they inspect.
  if (input.taskStatus !== "in_progress") return false;
  if (input.idleDays == null || input.idleDays < ttl) return false;
  if (input.hasRealDirt) return false;
  if (input.mode === "detached") return false;
  return true;
}

/**
 * The safety contract. Pure. Order matters — each guard is a reason NOT to
 * destroy, checked before any reap is allowed.
 */
export function decideWorktreeReap(input: WorktreeReapInput): WorktreeReapDecision {
  // A task that is still being worked or is awaiting human review owns its
  // worktree — never touch it. Orphans (taskStatus === null) ARE terminal.
  const terminal = input.taskStatus === null || input.taskStatus === "done" || input.taskArchived;
  if (!terminal) {
    // Active on paper, abandoned in fact: see `isAbandoned`. The branch is kept,
    // so this frees a checkout and never a commit.
    if (isAbandoned(input)) {
      return { action: "abandon", reason: `task fermo in 'in_progress' da ${Math.floor(input.idleDays!)} giorni` };
    }
    return { action: "keep", reason: `task '${input.taskStatus}' attivo` };
  }

  // Real uncommitted work sitting in the tree is the only copy — a closed task
  // can still carry it (a system-forced review). Human decides; we don't nuke.
  if (input.hasRealDirt) return { action: "keep", reason: "modifiche non committate (junk escluso)" };

  // Fully on main already → the worktree holds nothing main doesn't. Safe.
  if (input.mergedIntoMain) return { action: "reap", reason: "già interamente su main" };

  // Closed task, clean tree, but commits never landed (e.g. an approve the
  // old dirty-main bug skipped). Land them first, THEN reap — never drop.
  if (input.autoMergeEnabled && input.mode === "branch") {
    return { action: "land-then-reap", reason: "task chiuso con commit non ancora su main" };
  }

  // Unmerged commits we can't safely auto-land (automerge off / non-branch).
  // Keep for an explicit human decision rather than lose the commits.
  return { action: "keep", reason: "commit non mergiati, automerge non disponibile → decisione umana" };
}

// ─────────────────────────────────────────────────────────────────────────

export type LandOutcome = "landed" | "nothing" | "conflict" | "skipped";

export interface PostLandInput {
  /** What `tryLand` reported. */
  outcome: LandOutcome;
  /** Branch state re-read from the repo AFTER the land attempt. */
  branchAfter: BranchStatus;
  /** Non-junk uncommitted paths still in the worktree AFTER the land. */
  dirtAfter: string[];
}

/**
 * The post-land guard — the ONE place that decides whether a landing earned the
 * right to destroy a branch. Pure, so both callers (the GC sweep and the manual
 * `landTask`) share the exact same contract instead of each growing their own
 * half of it.
 *
 * Why it exists: `tryLand` reporting `"landed"` — or `"nothing"`, meaning "the
 * branch has no commits main doesn't" — is a CLAIM, not proof. On 2026-07-19 a
 * task's only copy of 139 lines (the `watching` phase) was reaped on the back of
 * that claim: the branch was deleted, the commit survived only in the reflog.
 * The old code said as much in a comment — *"landed OR nothing (superseded) →
 * the branch holds nothing to lose now"* — and never checked.
 *
 * So we re-READ the repo after the attempt and reap only against evidence:
 *   • conflict/skipped → the land didn't happen at all;
 *   • dirt still in the tree → uncommitted work is the only copy (task `e8780726`,
 *     the same hole seen from the other side: not-landed vs not-committed);
 *   • branch still `unmerged` → the content is provably NOT on main.
 * Anything else and the branch keeps living until a human says otherwise.
 */
export function decidePostLandReap(input: PostLandInput): WorktreeReapDecision {
  if (input.outcome === "conflict" || input.outcome === "skipped") {
    return { action: "keep", reason: `land ${input.outcome}` };
  }
  if (input.dirtAfter.length > 0) {
    return { action: "keep", reason: `modifiche non committate dopo il land (${input.dirtAfter.length} file)` };
  }
  // `gone` = the land itself deleted the ref; there is no branch left to lose.
  if (input.branchAfter === "unmerged") {
    return {
      action: "keep",
      reason: `land '${input.outcome}' ma il contenuto NON risulta su main — branch conservato`,
    };
  }
  return { action: "reap", reason: `land '${input.outcome}' verificato su main` };
}

// ─────────────────────────────────────────────────────────────────────────

export interface GcWorktree {
  id: string;
  projectId: string;
  absPath: string;
  branchName: string | null;
  mode: "branch" | "reuse" | "detached";
}

/** Branch state read from the PROJECT repo (robust to a removed worktree dir). */
export type BranchStatus = "gone" | "merged" | "unmerged";

export interface WorktreeGcDeps {
  /** Ready worktrees to consider (the manager's store, status='ready'). */
  listWorktrees: () => GcWorktree[];
  /**
   * Resolve the task bound to a worktree (worktree → topic → task).
   * `null` task ⇒ orphan. Returns the bits the decision needs.
   */
  resolveTask: (worktreeId: string) =>
    | { taskId: string; status: TaskStatus; archived: boolean }
    | { taskId: null };
  /** True while a dispatched turn for the task is in flight — never reap under it. */
  isBusy: (taskId: string) => boolean;
  /** Whether the worktree directory still exists on disk. */
  diskPresent: (absPath: string) => boolean;
  /** Non-junk uncommitted paths (worktreeRealDirt). Only meaningful when disk present. */
  realDirt: (absPath: string) => Promise<string[]>;
  /**
   * The branch's state relative to main, read from the project repo (so it's
   * correct even after the worktree dir was removed): `gone` (branch deleted),
   * `merged` (ancestor of main → nothing to lose), or `unmerged`.
   */
  branchStatus: (wt: GcWorktree) => Promise<BranchStatus>;
  /** The worktree's board opted into auto-merge. */
  autoMergeEnabled: (projectId: string) => boolean;
  /**
   * Days since the last sign of life on the task, or `null` when unmeasurable.
   * Absent ⇒ the abandon TTL is off entirely.
   */
  idleDays?: (taskId: string) => number | null;
  /** TTL in days for the abandon path (see `isAbandoned`). Absent/0 = off. */
  abandonAfterDays?: number;
  /**
   * Retire an abandoned task: park it (freeing its topic binding) and remove
   * ONLY the checkout, keeping the branch. Both halves belong together — a
   * worktree removed under a task that still reads `in_progress` would let a
   * later resume run in the base repo, next to the human's own work.
   * Returns false if it couldn't complete (kept, then).
   */
  abandon?: (taskId: string, wt: GcWorktree, reason: string) => Promise<boolean>;
  /** Land the task's branch. Returns the coarse outcome. */
  tryLand: (taskId: string) => Promise<LandOutcome>;
  /** Reap worktree + branch + row (worktreeManager.delete). */
  reap: (worktreeId: string) => Promise<boolean>;
  /**
   * Surface a refused reap on the task itself (a system comment). A branch kept
   * because its content never reached main is exactly the failure that went
   * unnoticed for 8 days — it must be visible where the human looks.
   */
  noteOnTask?: (taskId: string, message: string) => void;
  log: (msg: string) => void;
}

export interface WorktreeGcSummary {
  total: number;
  reaped: number;
  landed: number;
  /** Checkouts freed under a task abandoned in `in_progress` (branch kept). */
  abandoned: number;
  kept: number;
  errors: number;
  /**
   * PERCHÉ i `kept` sono stati tenuti, contati per motivo.
   *
   * Il motivo veniva calcolato (`decideWorktreeReap` lo restituisce) e poi
   * buttato via: la passata stampava «38 kept» e nient'altro. Con quel numero
   * soltanto, un accumulo LEGITTIMO (lavoro non ancora landato) e uno PATOLOGICO
   * (righe fantasma, decisioni bloccate) sono indistinguibili — e uno sprawl che
   * non si sa spiegare ricresce in silenzio, che è esattamente com'è ricresciuto.
   *
   * Il testo è la ragione della decisione, normalizzata: le parti variabili
   * (numero di giorni, di file) sono tolte, altrimenti ogni worktree sarebbe una
   * categoria a sé e il conteggio non aggregherebbe niente.
   */
  keptReasons: Record<string, number>;
}

/**
 * Toglie le parti variabili da una ragione, così motivi uguali si sommano.
 *
 * Solo i NUMERI: «fermo da 9 giorni» e «fermo da 12 giorni» sono la stessa
 * categoria. Gli stati fra apici (`task 'review' attivo`) restano, perché sono
 * un insieme chiuso di cinque valori e distinguerli è l'informazione utile —
 * «tenuti perché il task è in review» e «tenuti perché è in backlog» chiedono
 * due azioni diverse.
 */
export function normalizeKeepReason(reason: string): string {
  return reason.replace(/\d+/g, "N").trim();
}

/**
 * One sweep pass. Best-effort and side-effect-isolated: any single worktree
 * failing (git hiccup, race with a manual delete) is logged and skipped, never
 * aborting the rest.
 */
export async function sweepWorktrees(deps: WorktreeGcDeps): Promise<WorktreeGcSummary> {
  const worktrees = deps.listWorktrees();
  const summary: WorktreeGcSummary = {
    total: worktrees.length, reaped: 0, landed: 0, abandoned: 0, kept: 0, errors: 0, keptReasons: {},
  };
  /** Un keep senza motivo registrato e' un keep che nessuno puo' spiegare. */
  const keep = (reason: string) => {
    summary.kept += 1;
    const k = normalizeKeepReason(reason);
    summary.keptReasons[k] = (summary.keptReasons[k] ?? 0) + 1;
  };

  for (const wt of worktrees) {
    try {
      const t = deps.resolveTask(wt.id);
      const taskId = t.taskId;

      // Never reap under a live turn, even if the task row reads terminal.
      if (taskId && deps.isBusy(taskId)) { keep("turno in corso sul task"); continue; }

      const branch = wt.mode === "branch" ? await deps.branchStatus(wt).catch(() => "unmerged" as BranchStatus) : "merged";

      // Ghost row: a `branch`-mode worktree whose branch is already gone holds
      // nothing — the disk dir (if any) is a leftover, the row is dead weight.
      // Reap directly (the manager prunes the missing dir + deletes the row).
      if (wt.mode === "branch" && branch === "gone") {
        // …unless a task still claims to be working in it. Deleting the row
        // under a live binding leaves the task pointing at a cwd that no longer
        // resolves, and its next resume would run in the base repo. Park it
        // first, same as an abandonment — the branch is already gone, so there
        // is nothing left to preserve but the task's honesty.
        const status = taskId ? (t as { status: TaskStatus }).status : null;
        const stillClaimed = status !== null && status !== "done" && !(t as { archived?: boolean }).archived;
        if (taskId && stillClaimed && deps.abandon) {
          const ok = await deps.abandon(taskId, wt, "il branch del worktree non esiste più");
          if (ok) { summary.abandoned += 1; deps.log(`[worktree-gc] abbandonato ${wt.branchName ?? wt.id} — branch sparito sotto un task '${status}'`); }
          else keep("parcheggio fallito su branch sparito");
          continue;
        }
        const ok = await deps.reap(wt.id);
        if (ok) { summary.reaped += 1; deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — branch già sparito (riga fantasma)`); }
        else summary.errors += 1;
        continue;
      }

      // A removed worktree dir can hold no uncommitted work; only inspect the
      // tree for dirt when it actually exists.
      const present = deps.diskPresent(wt.absPath);
      const dirt = present ? await deps.realDirt(wt.absPath).catch(() => [] as string[]) : [];

      const decision = decideWorktreeReap({
        taskStatus: taskId ? (t as { status: TaskStatus }).status : null,
        taskArchived: taskId ? (t as { archived: boolean }).archived : false,
        hasRealDirt: dirt.length > 0,
        mergedIntoMain: branch === "merged",
        autoMergeEnabled: deps.autoMergeEnabled(wt.projectId),
        mode: wt.mode,
        // Measured only for a task that could BE abandoned: for everything else
        // the answer changes nothing and the probe (a stat on the transcript)
        // isn't worth doing.
        idleDays:
          taskId && deps.idleDays && (t as { status: TaskStatus }).status === "in_progress"
            ? deps.idleDays(taskId)
            : null,
        abandonAfterDays: deps.abandonAfterDays,
      });

      if (decision.action === "keep") { keep(decision.reason); continue; }

      if (decision.action === "abandon") {
        // Needs both a task to park and a host able to do it; without either,
        // keeping is the only safe answer.
        if (!taskId || !deps.abandon) { keep(taskId ? "da abbandonare ma l'host non sa parcheggiare" : "da abbandonare ma senza task a cui agganciarsi"); continue; }
        const ok = await deps.abandon(taskId, wt, decision.reason);
        if (ok) {
          summary.abandoned += 1;
          deps.log(`[worktree-gc] abbandonato ${wt.branchName ?? wt.id} — ${decision.reason} (branch conservato)`);
        } else {
          keep("parcheggio del task abbandonato fallito");
        }
        continue;
      }

      if (decision.action === "land-then-reap") {
        // Needs a real task to land. An orphan (taskId null) with unmerged
        // commits can't be landed → keep it for a human rather than lose work.
        if (!taskId) { keep("commit non su main e nessun task a cui landarli (orfano)"); continue; }
        const outcome = await deps.tryLand(taskId);
        if (outcome === "landed") summary.landed += 1;

        // VERIFY BEFORE DESTROY. Re-read the repo — the land's own verdict is
        // not evidence (see `decidePostLandReap`).
        const [branchAfter, dirtAfter] = await Promise.all([
          deps.branchStatus(wt).catch(() => "unmerged" as BranchStatus),
          deps.diskPresent(wt.absPath)
            ? deps.realDirt(wt.absPath).catch(() => [] as string[])
            : Promise.resolve([] as string[]),
        ]);
        const post = decidePostLandReap({ outcome, branchAfter, dirtAfter });
        if (post.action === "keep") {
          deps.log(`[worktree-gc] keep ${wt.branchName ?? wt.id}: ${post.reason}`);
          if (outcome === "landed" || outcome === "nothing") {
            // Anche qui si dice solo ciò che è stato VERIFICATO: `branchAfter` è
            // la ri-lettura del repo dopo il land. Un keep può nascere dallo
            // sporco nel tree con il branch già cancellato dal land stesso, e in
            // quel caso «il branch è stato conservato» sarebbe falso — la stessa
            // bugia del task `5770b9de`, vista da questo lato.
            const branchNote = branchAfter === "gone"
              ? `Il branch \`${wt.branchName ?? wt.id}\` NON è più nel repo: quello che resta è nel worktree, controllalo prima che sparisca.`
              : `Il branch \`${wt.branchName ?? wt.id}\` è stato conservato — verifica a mano prima di cancellarlo.`;
            deps.noteOnTask?.(taskId, `⚠️ Worktree NON ripulito: ${post.reason}. ${branchNote}`);
          }
          keep(post.reason);
          continue;
        }
      }

      const ok = await deps.reap(wt.id);
      if (ok) {
        summary.reaped += 1;
        deps.log(`[worktree-gc] reaped ${wt.branchName ?? wt.id} — ${decision.reason}`);
      } else {
        summary.errors += 1;
      }
    } catch (err) {
      summary.errors += 1;
      deps.log(`[worktree-gc] error on ${wt.id}: ${(err as Error)?.message ?? err}`);
    }
  }

  if (summary.reaped || summary.landed || summary.abandoned || summary.errors) {
    deps.log(
      `[worktree-gc] sweep done: ${summary.reaped} reaped, ${summary.landed} landed, ` +
      `${summary.abandoned} abbandonati, ${summary.kept} kept, ${summary.errors} errors (of ${summary.total})`,
    );
  }
  // I MOTIVI dei kept, sempre — anche quando la passata non ha fatto altro.
  //
  // La riga sopra è condizionata a reap/land/abbandoni/errori: una passata che
  // tiene TUTTO non stampava niente. È così che 38 worktree tenuti sono
  // diventati invisibili — nessuna riga, nessun numero, nessun perché, mentre
  // sul disco crescevano. Un GC che tace quando non agisce è indistinguibile da
  // un GC che non gira.
  //
  // Ordinati per frequenza: la categoria più grossa è quella su cui vale la
  // pena agire, e va letta per prima.
  const reasons = Object.entries(summary.keptReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    deps.log(
      `[worktree-gc] ${summary.kept} tenuti (di ${summary.total}) — ` +
      reasons.map(([r, n]) => `${n}× ${r}`).join("; "),
    );
  }
  return summary;
}
