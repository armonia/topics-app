/**
 * Task closure side effects: reaping worktrees and remote drafts, delivery capture, url probe.
 */
import { projectIdForPath } from "../services/tasks";
import { decidePostLandReap, type BranchStatus, type LandOutcome } from "../services/worktree-gc";
import { closeCiDraft, type CloseCiDraftInput } from "../services/ci-evidence";
import { type TaskAttempt } from "../services/task-attempts";
import { recordRetirement } from "../services/retirement";
import { createDeliveryCapture } from "../services/task-delivery-capture";
import { probeUrl } from "../services/url-probe-cache";
import { setClosed } from "../attention/store";
import { topicSubject } from "../../shared/attention";
import { ownCommitFiles } from "./tasks-git";
import type { TasksCore, TasksLate } from "./tasks-scope";

export function createTasksReap(core: TasksCore) {
  const { ctx, opts, svc, attempts, broadcastToAll } = core;

  /**
   * Land a task's branch on main (merge locally, reap the worktree, rebuild the
   * client if it changed). ON-DEMAND — this used to ride on every approve, which
   * meant approving a task also merged/built "da sotto". Now approve just accepts
   * the task; landing is an explicit human step (a "Landa su main" quick-reply the
   * agent offers, or the /land endpoint / button). Non si chiama MAI diretta: si
   * passa da `enqueueLand`, che la mette in fila per progetto e le dà un ticket —
   * una git lenta non blocca chi chiama, ma l'esito non si perde più. Tutti gli
   * esiti finiscono anche come commenti di sistema.
   * The merge is local; `main` then goes to origin, fast-forward only (`pushMainAfterLand`).
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
      try {
        void Promise.resolve(opts?.stopTopicProcesses?.(topic.id)).catch((err) => {
          console.error(`[attempts] stop topic processes ${topic.id}`, err);
        });
      } catch (err) {
        console.error(`[attempts] stop topic processes ${topic.id}`, err);
      }
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
    ownCommitFiles: (cwd) => (opts?.ownCommitFiles ?? ownCommitFiles)(cwd),
    ownBranchFiles: opts?.ownBranchFiles,
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

  return { reapAfterLand, sweepRemoteDelivery, reapAttemptWorkspace, captureDelivery, capturaConsegna, triggerUrlProbe } satisfies Partial<TasksLate> & Record<string, unknown>;
}
