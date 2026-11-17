/**
 * The board's two automatic moves after a delivery, out of the tasks router:
 * a red card goes back to its agent (`services/red-bounce.ts`), and accepted
 * work goes through the CI phase (`services/integration-queue.ts`) before it
 * lands. The router hands in its own doors (the land, the review decision, the
 * broadcast) and calls `afterDelivery`, `enterCiPhase` and `bounceRed`.
 */
import type { Database } from "bun:sqlite";
import { isCiEvidenceCheck } from "../../shared/board";
import type { CiPhaseMode } from "../../shared/workflow";
import { FRESH_SESSION_NOTE } from "../../shared/task-comment-service";
import { SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import { awaitCiEvidence, closeCiDraft, spawnCapped } from "../services/ci-evidence";
import { createIntegrationQueue, type IntegrationMeasure } from "../services/integration-queue";
import { measureIntegration } from "../services/integration-measure";
import { personPlace } from "../services/auto-land";
import { readWorkflowRules } from "../services/board-workflow";
import { MAX_AUTO_BOUNCES, bouncesSinceHuman, redBounceMessage, redBounceVerdict } from "../services/red-bounce";
import { formatChecksComment } from "../services/review-checks";
import type { TaskDispatcher } from "../services/task-dispatcher";
import type { Task, TaskService } from "../services/tasks";

export interface CiPhaseDeps {
  svc: TaskService;
  db: Database;
  dispatcher?: TaskDispatcher;
  broadcast(msg: { type: "task:updated"; projectId: string; task: Task }): void;
  cardTurnIsLive(task: Task): boolean;
  /** The land queue's own door: merge, confirm on main, close. Returns the queue ticket. */
  landDirect(projectId: string, taskId: string, landOpts?: LandRunOpts): unknown;
  /**
   * "Asked, not on main yet": the same stamp the direct land writes before it queues. Entering the CI
   * phase is a land asked, not a land done, and a `landed` left over from a deduction must not survive it.
   */
  markLandPending?: (taskId: string) => void;
  whenLanded(taskId: string): Promise<unknown> | null;
  tryAutoLand(projectId: string, taskId: string): Promise<unknown>;
  integrationRepo?: (taskId: string) => Promise<string | null>;
  integrationMeasure?: (projectId: string, taskIds: string[]) => Promise<IntegrationMeasure>;
  integrationCollectMs?: number;
  /** Files that differ between two commits of the card's repo; `null` = git could not say. */
  filesBetween?: (taskId: string, from: string, to: string) => Promise<string[] | null>;
}

type LandRunOpts = { recheck?: unknown };

/**
 * Is this card's work ON MAIN, as far as closing it goes? Only a `landed` a land WITNESSED (it saw the
 * merge on main) counts. A deduced `landed` (the audit's guess, `landing_witnessed = 0`) is not a merge:
 * card 572f8a09 carried one, and every "already on main" that trusted it was wrong (c2908b93).
 */
export function landedOnMain(db: CiPhaseDeps["db"], task: Pick<Task, "id" | "landingState">): boolean {
  if (task.landingState !== "landed") return false;
  const row = db.query("SELECT landing_witnessed AS w FROM tasks WHERE id = ?").get(task.id) as { w?: number | null } | null;
  return row?.w === 1;
}

export function createCiPhase(deps: CiPhaseDeps) {
  /**
   * A RED CARD GOES BACK TO ITS AGENT BY ITSELF (`services/red-bounce.ts`).
   * The same moves a person's reject makes: the review decision, then the
   * resume of the bound session, or the queue when nobody is bound (a node
   * delivery, a released binding). `true` = the card left review.
   */
  async function bounceRed(projectId: string, taskId: string): Promise<boolean> {
    let got: ReturnType<typeof deps.svc.get>;
    try { got = deps.svc.get(taskId, { projectId }); } catch { return false; }
    if (!got) return false;
    const t = got.task;
    const row = deps.db.query("SELECT archived FROM tasks WHERE id = ?").get(taskId) as { archived?: number } | null;
    const verdict = redBounceVerdict(
      { status: t.status, archived: !!row?.archived, checksState: t.checksState ?? null, checksCommit: t.checksCommit ?? null, deliveryCommit: t.deliveryCommit ?? null, humanAsk: t.humanAsk ?? null, failedCheck: t.checks?.find((r) => !r.ok)?.name ?? null },
      got.comments,
      { turnLive: deps.cardTurnIsLive(t) },
    );
    if (!verdict.bounce) {
      if (verdict.exhausted && !t.humanAsk) {
        try {
          const asked = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { humanAsk: "Tre giri rossi di fila senza uscirne: guarda il log dei check e decidi come procedere." } });
          deps.broadcast({ type: "task:updated", projectId, task: asked });
        } catch { /* the card stays in review either way */ }
      }
      return false;
    }
    const message = redBounceMessage(verdict.round, formatChecksComment(t.checks ?? [], { commit: t.checksCommit }));
    return sendBackToAgent(projectId, taskId, message);
  }

  /**
   * The moves a person's reject makes, made by the system: the review
   * decision, then the resume of the bound session, or the queue when nobody
   * is bound (a node delivery, a released binding). `land_intent` survives it.
   */
  function sendBackToAgent(projectId: string, taskId: string, message: string): boolean {
    let task: Task;
    try {
      task = deps.svc.reviewDecision({ taskId, by: "system", decision: "reject", comment: message, projectId });
    } catch (err) {
      console.warn(`[red-bounce] ${taskId.slice(0, 8)} non rimandata:`, err);
      return false;
    }
    deps.broadcast({ type: "task:updated", projectId, task });
    console.warn(`[red-bounce] ${taskId.slice(0, 8)} rimandata all'agente`);
    const dispatcher = deps.dispatcher;
    if (!dispatcher) return true;
    if (task.assignedTopicId) {
      dispatcher.resume(taskId, message).catch((err) => console.warn(`[red-bounce] resume fallito per ${taskId}:`, err));
      return true;
    }
    try {
      const queued = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { status: "todo" } });
      try { deps.svc.addComment({ taskId, author: "system", kind: "service", content: FRESH_SESSION_NOTE }); } catch { /* the requeue is what matters */ }
      deps.broadcast({ type: "task:updated", projectId, task: queued });
      if (queued.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
    } catch (err) { console.warn(`[red-bounce] ${taskId.slice(0, 8)} non rimessa in coda:`, err); }
    return true;
  }

  /** The commit each card was measured on in the CI phase: it lands only if it still delivers that one. */
  const ciMeasured = new Map<string, string>();

  /**
   * The board's CI mode as far as it can act: `off` unless the board has what the phase needs (CI rows, a
   * repo and the merge switch on), whatever its workflow rules say. The rule is `before` (measure, then
   * land) or `after` (land, then measure); `off` has no phase and the land is the only step.
   */
  function boardCiMode(projectId: string): CiPhaseMode {
    if (!deps.integrationRepo && !deps.integrationMeasure) return "off";
    try {
      const mode = readWorkflowRules(deps.db, projectId).ciPhase;
      if (mode === "off") return "off";
      const s = deps.svc.getBoardSettings(projectId);
      return s.dispatchAutoMerge && s.reviewChecks.some(isCiEvidenceCheck) ? mode : "off";
    } catch { return "off"; }
  }

  /** Does accepted work wait for the CI BEFORE it lands (the queue below)? */
  function boardHasCiPhase(projectId: string): boolean {
    return boardCiMode(projectId) === "before";
  }

  /**
   * THE CI PHASE (`services/integration-queue.ts`). Every land asked for enters
   * it: the card keeps its status (review), moves to the `ci` column, and
   * carries who decided (`land_intent`) across a red or a conflict. `false` =
   * no CI phase here, the caller lands directly.
   */
  function enterCiPhase(projectId: string, taskId: string, landOpts?: LandRunOpts): boolean {
    // `after`: the card lands at once and the CI reads main later; the land is asked here, the verdict comes later.
    if (boardCiMode(projectId) === "after") return landThenMeasure(projectId, taskId, landOpts) !== null;
    if (!boardHasCiPhase(projectId)) return false;
    const cur = deps.svc.get(taskId, { projectId })?.task;
    // A card with no code of its own (an analysis) has nothing to measure: it closes as before.
    if (!cur || cur.status !== "review" || !cur.deliveryBranch || !cur.deliveryCommit) return false;
    // Code already on main has nothing left to integrate: measuring it again pays a CI run for nothing.
    // "On main" is a merge a land SAW, never the field alone: the `landed` card 572f8a09 carried here
    // was a deduction, its work was not on main, and trusting it closed the card outside main (c2908b93).
    if (landedOnMain(deps.db, cur)) return false;
    // The automatic land comes with its last look (`recheck`); a person's gesture does not.
    const who = landOpts?.recheck ? "auto" : "human";
    let task: Task;
    try { task = deps.svc.setLandIntent({ taskId, who, inCi: true }); } catch { return false; }
    // Card 572f8a09 entered the phase carrying a `landed` the audit had deduced from a merge commit, and
    // everything downstream (the phase, a session closing it as "already on main") read it as a merge.
    try { deps.markLandPending?.(taskId); } catch { /* the queue is what matters */ }
    const already = integration.pending(projectId).includes(taskId);
    if (!already) {
      try {
        deps.svc.addComment({
          taskId, author: "system", kind: "service",
          replaces: "Fase CI:",
          content: "Fase CI: la misuro insieme a main e alle altre card accettate, con la CI della board. Se è verde atterra da sola; se si rompe torna all'agente e poi qui, senza ripassare dalla review.",
        });
      } catch { /* the queue is what matters */ }
    }
    deps.broadcast({ type: "task:updated", projectId, task: deps.svc.get(taskId, { projectId })?.task ?? task });
    integration.request(projectId, taskId);
    return true;
  }

  /**
   * Builds the integration commit of these cards on `origin/main` and reads the board's CI rows on it.
   * `commitOf` says which commit each card brings; `repoOf` where to build it (default: the repo the
   * card's delivery lives in); `remember` keeps the measured commit for the `before` land to check.
   */
  async function measureCards(
    projectId: string,
    taskIds: string[],
    how: { commitOf: (taskId: string) => string | null; repoOf?: (taskId: string) => Promise<string | null>; remember?: boolean },
  ): Promise<IntegrationMeasure> {
    if (deps.integrationMeasure) {
      if (how.remember) for (const id of taskIds) { const c = how.commitOf(id); if (c) ciMeasured.set(id, c); }
      return deps.integrationMeasure(projectId, taskIds);
    }
    const cards = taskIds.flatMap((id) => {
      const commit = how.commitOf(id);
      return commit ? [{ taskId: id, commit }] : [];
    });
    if (how.remember) for (const c of cards) ciMeasured.set(c.taskId, c.commit);
    const repoOf = how.repoOf ?? ((id: string) => deps.integrationRepo!(id).catch(() => null));
    const repo = cards.length ? await repoOf(cards[0]!.taskId) : null;
    if (!repo) return { measured: [], conflicts: [], verdict: "unmeasured", why: "il repository della card non si trova" };
    const checks = deps.svc.getBoardSettings(projectId).reviewChecks.filter(isCiEvidenceCheck);
    return measureIntegration(repo, cards, checks, {
      git: async (cwd, args, env) => {
        const r = await runGit(cwd, args, { timeoutMs: SPAWN_TIMEOUT.write, env: { GIT_TERMINAL_PROMPT: "0", ...env } });
        return { code: r.code, out: r.stdout, err: r.stderr };
      },
      awaitCi: (input) => awaitCiEvidence(input),
      closeDraft: (input) => closeCiDraft({ ...input, closePr: true }),
      describeRed: (runs, commit) => formatChecksComment(runs, { commit }),
      rerunFailed: async (cwd, sha) => {
        // The same capped door every other gh call of the board goes through (deadline, process group).
        const gh = async (args: string[]) => {
          const r = await spawnCapped(["gh", ...args], cwd);
          return { code: r.code, out: r.out };
        };
        const list = await gh(["run", "list", "--commit", sha, "--workflow", "ci.yml", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"]);
        const id = list.out.trim();
        if (list.code !== 0 || !id) return false;
        return (await gh(["run", "rerun", id, "--failed"])).code === 0;
      },
    });
  }

  const integration = createIntegrationQueue({
    collectMs: deps.integrationCollectMs,
    measure: (projectId, taskIds) => measureCards(projectId, taskIds, { commitOf: (id) => deps.svc.get(id, { projectId })?.task.deliveryCommit ?? null, remember: true }),
    // Landed like a person's «Landa»: the integration commit measured main plus this branch, so the land may
    // bring origin/main into the branch first (the automatic land's `noRealign` would refuse every branch
    // that fell behind). The one fact re-read here is the commit: a card that moved on is measured again.
    land: async (projectId, taskId) => {
      const measured = ciMeasured.get(taskId);
      ciMeasured.delete(taskId);
      const now = deps.svc.get(taskId, { projectId })?.task.deliveryCommit ?? null;
      if (!measured || !now || measured !== now) { integration.request(projectId, taskId); return; }
      // A person who wrote on the card while it was in the phase ("wait", "not this") is waiting for an answer, not for a merge.
      const since = (deps.db.query("SELECT land_intent_at FROM tasks WHERE id = ?").get(taskId) as { land_intent_at?: string | null } | null)?.land_intent_at;
      const spoke = since && (deps.svc.get(taskId, { projectId })?.comments ?? []).some((c) => c.author === "user" && (c.kind ?? "comment") === "comment" && !!c.createdAt && c.createdAt > since);
      if (spoke) { giveUp(projectId, taskId, "hai scritto sulla card mentre era in fase CI: non la atterro finché non rispondi"); return; }
      deps.landDirect(projectId, taskId);
      await deps.whenLanded(taskId)?.catch(() => undefined);
      const after = deps.svc.get(taskId, { projectId })?.task;
      if (!after) return;
      if (after.status === "done") { try { deps.svc.setLandIntent({ taskId, who: null }); } catch { /* landed is what matters */ } return; }
      // Back with the agent (a conflict the land met): the decision stays, the fix comes back here.
      if (after.status !== "review") return;
      // Merged and confirmed on main, still in review (open steps): the land's own witness, not a
      // deduction. A deduced `landed` after a land that merged nothing is exactly what kept card
      // 572f8a09 in the phase, measured again and again "as already landed" (c2908b93).
      if (landedOnMain(deps.db, after)) return;
      // Still in review after a green CI: the land refused (dirty checkout, open steps, nothing to land...).
      // Measuring again would pay a CI run for the same refusal, so a person reads why.
      giveUp(projectId, taskId, "il land dopo la CI verde non è andato: leggi l'ultima riga del sistema nel thread");
    },
    bounce: async (projectId, taskId, why) => {
      ciMeasured.delete(taskId);
      const got = deps.svc.get(taskId, { projectId });
      if (!got) return;
      const done = bouncesSinceHuman(got.comments);
      if (done >= MAX_AUTO_BOUNCES) {
        // Three rounds the agent did not get out of: the person decides, with the reason in front.
        try {
          deps.svc.setLandIntent({ taskId, who: null });
          const asked = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { humanAsk: `Tre giri nella fase CI senza uscirne: ${why.split("\n")[0]!.slice(0, 200)}` } });
          deps.broadcast({ type: "task:updated", projectId, task: asked });
        } catch { /* stays where it is */ }
        return;
      }
      sendBackToAgent(projectId, taskId, redBounceMessage(done + 1, why));
    },
    giveUp: (projectId, taskId, why) => giveUp(projectId, taskId, why),
    // No green bar on the card's own exact commit: measured alone (services/integration-queue.ts, `solo`).
    solo: (projectId, taskId) => {
      const t = deps.svc.get(taskId, { projectId })?.task;
      return !t || t.checksState !== "pass" || !t.deliveryCommit || t.checksCommit !== t.deliveryCommit;
    },
    stillWanted: (projectId, taskId) => {
      const t = deps.svc.get(taskId, { projectId })?.task;
      if (!t || t.status !== "review" || !t.landIntent || !t.deliveryCommit) return false;
      if (landedOnMain(deps.db, t)) return false;
      if (t.checksState === "fail" || t.checksState === "running" || (t.humanAsk ?? "").trim()) return false;
      if (deps.cardTurnIsLive(t)) return false;
      const row = deps.db.query("SELECT archived FROM tasks WHERE id = ?").get(taskId) as { archived?: number } | null;
      return !row?.archived;
    },
    // One slot per kind of news: a CI that stays unmeasured is retried every sweep, and must not pile a row each time.
    note: (taskId, text) => {
      deps.svc.addComment({ taskId, author: "system", kind: "service", content: text, replaces: ["CI non misurata", "CI rossa su", "CI verde su"] });
    },
    log: (line) => console.warn(line),
  });

  /** The CI phase stops for this card: the decision goes back to a person, with the reason in front. */
  function giveUp(projectId: string, taskId: string, why: string): void {
    try {
      deps.svc.setLandIntent({ taskId, who: null });
      const asked = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { humanAsk: `Fase CI ferma: ${why.split("\n")[0]!.slice(0, 220)}` } });
      deps.broadcast({ type: "task:updated", projectId, task: asked });
    } catch (err) { console.warn(`[integration] ${taskId.slice(0, 8)} non restituita a una persona:`, err); }
  }

  // ── THE `after` RULE: THE CARD LANDS AT ONCE, THE CI READS MAIN LATER ─────────────────────────────────
  //
  // What a person waited 15-20 minutes for (the queue above: collect, batch, draft pull request, CI) is
  // now the CI's own time, not the land's: the change is on main, and in the person's app, when it is
  // approved. The CI still measures it, with the same machine, and a red goes back to who made it.
  // Nothing reverts main by itself: the fix goes forward, and after the third round the person is asked
  // (and offered the revert).

  type AfterMark = { commit: string; who: "human" | "auto" | null; repo: string | null };

  function readAfter(taskId: string): AfterMark | null {
    try {
      const r = deps.db.query("SELECT ci_after FROM tasks WHERE id = ?").get(taskId) as { ci_after?: string | null } | null;
      return r?.ci_after ? (JSON.parse(r.ci_after) as AfterMark) : null;
    } catch { return null; }
  }

  function writeAfter(taskId: string, mark: AfterMark | null): void {
    try { deps.db.query("UPDATE tasks SET ci_after = ? WHERE id = ?").run(mark ? JSON.stringify(mark) : null, taskId); }
    catch (err) { console.warn(`[ci-after] ${taskId.slice(0, 8)} marca non scritta:`, err); }
  }

  /** Did a land SEE this card's work on main (`unpushed` is on main in this machine, not yet on origin)? */
  function witnessedOnMain(taskId: string): boolean {
    const r = deps.db.query("SELECT landing_state AS s, landing_witnessed AS w FROM tasks WHERE id = ?").get(taskId) as { s?: string | null; w?: number | null } | null;
    return r?.w === 1 && (r.s === "landed" || r.s === "unpushed");
  }

  /**
   * The land of the `after` rule: the same land a board without the CI phase makes, then the card is
   * put in the measure queue once main has CONFIRMED it. `null` = this board or card does not take it
   * (the caller goes on as it always did). Returns the land's queue ticket.
   */
  function landThenMeasure(projectId: string, taskId: string, landOpts?: LandRunOpts): unknown | null {
    if (boardCiMode(projectId) !== "after") return null;
    const cur = deps.svc.get(taskId, { projectId })?.task;
    // The same cards the `before` phase takes: code of their own, not on main yet.
    if (!cur || cur.status !== "review" || !cur.deliveryBranch || !cur.deliveryCommit) return null;
    if (landedOnMain(deps.db, cur)) return null;
    const who = landOpts?.recheck ? "auto" : "human";
    let intent: "human" | "auto" = who;
    // The decision is kept across a red: the fixed delivery lands again without asking anybody.
    try { intent = deps.svc.setLandIntent({ taskId, who }).landIntent ?? who; } catch { return null; }
    // The branch and its worktree are gone once the land has reaped them: the repo is asked now.
    const repo = deps.integrationRepo ? deps.integrationRepo(taskId).catch(() => null) : Promise.resolve(null);
    const commit = cur.deliveryCommit;
    const ticket = deps.landDirect(projectId, taskId, landOpts);
    void deps.whenLanded(taskId)?.then(async () => {
      if (!witnessedOnMain(taskId)) return; // a refusal or a conflict: the land already said it, the card stays with its agent or in review
      writeAfter(taskId, { commit, who: intent, repo: await repo });
      try { deps.svc.setLandIntent({ taskId, who: null }); } catch { /* the mark is what matters */ }
      afterQueue.request(projectId, taskId);
    }).catch((err) => console.warn(`[ci-after] ${taskId.slice(0, 8)} non messa in misura:`, err));
    return ticket;
  }

  /** The card goes back to a person (review, with the question), main stays as it is. */
  function askPersonAfter(projectId: string, taskId: string, question: string): void {
    try {
      let t: Task;
      try { t = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { status: "review", humanAsk: question }, statusReason: "la CI dopo il land non si risolve da sola" }); }
      catch { t = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { humanAsk: question } }); }
      deps.broadcast({ type: "task:updated", projectId, task: t });
    } catch (err) { console.warn(`[ci-after] ${taskId.slice(0, 8)} non restituita a una persona:`, err); }
  }

  /**
   * A red on main after the land: the card leaves `done` and goes back to its agent with the log, the
   * same round count as a red before the land (`bouncesSinceHuman`, `MAX_AUTO_BOUNCES`). Its work is
   * ALREADY on main and its branch is reaped, so the agent starts from the updated main and fixes forward.
   */
  async function bounceAfterLand(projectId: string, taskId: string, why: string): Promise<void> {
    const mark = readAfter(taskId);
    writeAfter(taskId, null);
    const got = deps.svc.get(taskId, { projectId });
    if (!got) return;
    const done = bouncesSinceHuman(got.comments);
    if (done >= MAX_AUTO_BOUNCES) {
      askPersonAfter(projectId, taskId,
        `Tre giri di CI rossa dopo il land senza uscirne: ${why.split("\n")[0]!.slice(0, 200)}. Il lavoro è già su main: lascia riprovare l'agente rispondendo qui, oppure annulla il land con \`git revert -m 1 <commit>\` (il commit è nella riga «Mergiato su main» di questa card).`);
      return;
    }
    const message = redBounceMessage(done + 1, why) + "\n\n" +
      "ATTENZIONE: il tuo lavoro è GIÀ SU MAIN (la riga «Mergiato su main» di questa card dice il commit) e il tuo ramo è stato rimosso. " +
      "Parti dal main aggiornato (`git fetch origin main`, ramo nuovo da `origin/main`), correggi IN AVANTI con un commit nuovo, niente revert. " +
      "Quando rimetti in review atterra da sola, senza passare da una persona.";
    try {
      deps.svc.addComment({ taskId, author: "system", content: message });
      // Fresh from the queue: the worktree the old session ran in is gone, the thread carries the context.
      const queued = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { status: "todo" }, statusReason: "la CI su main è rossa dopo il land" });
      try { deps.svc.addComment({ taskId, author: "system", kind: "service", content: FRESH_SESSION_NOTE }); } catch { /* the requeue is what matters */ }
      // `land_intent` survives the round: the next green delivery comes back to land by itself.
      let back = queued;
      if (mark?.who) { try { back = deps.svc.setLandIntent({ taskId, who: mark.who }); } catch { /* a person decides again */ } }
      deps.broadcast({ type: "task:updated", projectId, task: back });
      console.warn(`[ci-after] ${taskId.slice(0, 8)} rimandata all'agente: CI rossa su main`);
      if (queued.status === "todo") deps.dispatcher?.onEnterTodo(projectId, taskId);
    } catch (err) {
      console.warn(`[ci-after] ${taskId.slice(0, 8)} non rimandata:`, err);
      askPersonAfter(projectId, taskId, `La CI è rossa su main dopo il land e non sono riuscito a rimandare la card all'agente: ${why.split("\n")[0]!.slice(0, 200)}`);
    }
  }

  const afterQueue = createIntegrationQueue({
    landed: true,
    collectMs: deps.integrationCollectMs,
    measure: (projectId, taskIds) => measureCards(projectId, taskIds, {
      commitOf: (id) => readAfter(id)?.commit ?? null,
      repoOf: async (id) => readAfter(id)?.repo ?? (await deps.integrationRepo?.(id).catch(() => null)) ?? null,
    }),
    // Green: nothing left to do but say so (the queue writes the note) and drop the mark.
    land: async (projectId, taskId) => {
      writeAfter(taskId, null);
      const t = deps.svc.get(taskId, { projectId })?.task;
      if (t) deps.broadcast({ type: "task:updated", projectId, task: t });
    },
    bounce: (projectId, taskId, why) => bounceAfterLand(projectId, taskId, why),
    giveUp: (projectId, taskId, why) => {
      writeAfter(taskId, null);
      askPersonAfter(projectId, taskId, `La CI dopo il land non dà un esito: ${why.split("\n")[0]!.slice(0, 220)}. Il lavoro è già su main.`);
    },
    stillWanted: (_projectId, taskId) => {
      if (!readAfter(taskId)) return false;
      const row = deps.db.query("SELECT archived FROM tasks WHERE id = ?").get(taskId) as { archived?: number } | null;
      return !row?.archived;
    },
    note: (taskId, text) => {
      deps.svc.addComment({ taskId, author: "system", kind: "service", content: text, replaces: ["CI non misurata", "CI rossa su", "CI verde su"] });
    },
    log: (line) => console.warn(line),
  });

  /**
   * Every landed card still carrying its mark goes back in the measure queue: the queue lives in memory
   * and a restart drops it. A board that turned the CI off since does not measure: the marks are dropped.
   * Returns how many cards were asked.
   */
  function resumeAfterMeasures(): number {
    let rows: Array<{ id: string; project_id: string }> = [];
    try { rows = deps.db.query("SELECT id, project_id FROM tasks WHERE ci_after IS NOT NULL").all() as typeof rows; } catch { return 0; }
    let asked = 0;
    for (const r of rows) {
      if (boardCiMode(r.project_id) === "off") { writeAfter(r.id, null); continue; }
      afterQueue.request(r.project_id, r.id);
      asked += 1;
    }
    return asked;
  }

  /**
   * A card carrying a decision to land, back in review: does it go straight to
   * the CI phase? `auto` = the automatic land decides again, on the new commit,
   * with all its rules (`personPlace` on the whole delivery). A person's
   * decision holds for what they saw: a new commit whose changes since then
   * touch a person's place goes back to the person.
   */
  async function returnToCiPhase(projectId: string, taskId: string): Promise<"ci" | "auto" | "person" | "no"> {
    const t = deps.svc.get(taskId, { projectId })?.task;
    if (!t || t.status !== "review" || !t.landIntent || !t.deliveryCommit) return "no";
    // The decision was "this goes to main", and it is there: the card closes, nothing is measured.
    if (landedOnMain(deps.db, t)) {
      try {
        const done = deps.svc.reviewDecision({ taskId, by: "system", decision: "approve", projectId });
        deps.svc.setLandIntent({ taskId, who: null });
        deps.broadcast({ type: "task:updated", projectId, task: deps.svc.get(taskId, { projectId })?.task ?? done });
      } catch (err) { console.warn(`[integration] ${taskId.slice(0, 8)} già su main ma non chiusa:`, err); }
      return "person";
    }
    if ((t.humanAsk ?? "").trim() || t.checksState === "fail" || t.checksState === "running") return "no";
    if (t.landIntent === "auto") return "auto";
    const from = t.landIntentCommit ?? null;
    if (from && from !== t.deliveryCommit) {
      // A delivery other than the one approved must be measured green on its own commit first.
      if (t.checksState !== "pass" || t.checksCommit !== t.deliveryCommit) return "no";
      const files = deps.filesBetween ? await deps.filesBetween(taskId, from, t.deliveryCommit).catch(() => null) : [];
      let extra: ReturnType<typeof readWorkflowRules>["personPaths"] | null = null;
      try { extra = readWorkflowRules(deps.db, projectId).personPaths; } catch { extra = null; }
      const touched = files === null || extra === null ? null : files.filter((f) => personPlace(f, extra!) !== null);
      if (touched === null || touched.length > 0) {
        try {
          deps.svc.setLandIntent({ taskId, who: null });
          const what = touched === null ? "non so dire cosa è cambiato dopo il tuo ok" : `dopo il tuo ok ha cambiato ${touched.slice(0, 3).join(", ")}`;
          const asked = deps.svc.update({ taskId, actor: "human", by: "system", projectId, patch: { humanAsk: `L'agente ${what}: guardalo e riapprova.` } });
          deps.broadcast({ type: "task:updated", projectId, task: asked });
        } catch { /* stays in review either way */ }
        return "person";
      }
    }
    return enterCiPhase(projectId, taskId) ? "ci" : "no";
  }

  /**
   * After a delivery enters review: a card someone already decided to land
   * goes back to the CI phase by itself (`returnToCiPhase`); any other card, and an
   * automatic decision, is offered to the automatic land.
   */
  async function afterDelivery(projectId: string, taskId: string): Promise<void> {
    const r = await returnToCiPhase(projectId, taskId);
    if (r === "ci" || r === "person") return;
    await deps.tryAutoLand(projectId, taskId);
  }

  return {
    bounceRed, enterCiPhase, afterDelivery, returnToCiPhase, boardHasCiPhase, boardCiMode, landThenMeasure, resumeAfterMeasures,
    pending: (projectId: string) => integration.pending(projectId),
    pendingAfter: (projectId: string) => afterQueue.pending(projectId),
    idleAfter: (projectId: string) => afterQueue.idle(projectId),
  };
}
