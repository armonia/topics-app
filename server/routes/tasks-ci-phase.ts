/**
 * The board's two automatic moves after a delivery, out of the tasks router:
 * a red card goes back to its agent (`services/red-bounce.ts`), and accepted
 * work goes through the CI phase (`services/integration-queue.ts`) before it
 * lands. The router hands in its own doors (the land, the review decision, the
 * broadcast) and calls `afterDelivery`, `enterCiPhase` and `bounceRed`.
 */
import type { Database } from "bun:sqlite";
import { isCiEvidenceCheck } from "../../shared/board";
import { FRESH_SESSION_NOTE } from "../../shared/task-comment-service";
import { SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import { awaitCiEvidence, closeCiDraft } from "../services/ci-evidence";
import { createIntegrationQueue, type IntegrationMeasure } from "../services/integration-queue";
import { measureIntegration } from "../services/integration-measure";
import { personPlace } from "../services/auto-land";
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
  /** The land queue's own door: merge, confirm on main, close. */
  landDirect(projectId: string, taskId: string): unknown;
  whenLanded(taskId: string): Promise<unknown> | null;
  tryAutoLand(projectId: string, taskId: string): Promise<unknown>;
  integrationRepo?: (taskId: string) => Promise<string | null>;
  integrationMeasure?: (projectId: string, taskIds: string[]) => Promise<IntegrationMeasure>;
  integrationCollectMs?: number;
  /** Files that differ between two commits of the card's repo; `null` = git could not say. */
  filesBetween?: (taskId: string, from: string, to: string) => Promise<string[] | null>;
}

type LandRunOpts = { recheck?: unknown };

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

  /** Does this board measure accepted work in the CI phase? Only with CI rows, a repo and the merge switch on. */
  function boardHasCiPhase(projectId: string): boolean {
    if (!deps.integrationRepo && !deps.integrationMeasure) return false;
    try {
      const s = deps.svc.getBoardSettings(projectId);
      return s.dispatchAutoMerge && s.reviewChecks.some(isCiEvidenceCheck);
    } catch { return false; }
  }

  /**
   * THE CI PHASE (`services/integration-queue.ts`). Every land asked for enters
   * it: the card keeps its status (review), moves to the `ci` column, and
   * carries who decided (`land_intent`) across a red or a conflict. `false` =
   * no CI phase here, the caller lands directly.
   */
  function enterCiPhase(projectId: string, taskId: string, landOpts?: LandRunOpts): boolean {
    if (!boardHasCiPhase(projectId)) return false;
    const cur = deps.svc.get(taskId, { projectId })?.task;
    // A card with no code of its own (an analysis) has nothing to measure: it closes as before.
    if (!cur || cur.status !== "review" || !cur.deliveryBranch || !cur.deliveryCommit) return false;
    // The automatic land comes with its last look (`recheck`); a person's gesture does not.
    const who = landOpts?.recheck ? "auto" : "human";
    let task: Task;
    try { task = deps.svc.setLandIntent({ taskId, who, inCi: true }); } catch { return false; }
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

  const integration = createIntegrationQueue({
    collectMs: deps.integrationCollectMs,
    measure: async (projectId, taskIds) => {
      if (deps.integrationMeasure) {
        for (const id of taskIds) { const c = deps.svc.get(id, { projectId })?.task.deliveryCommit; if (c) ciMeasured.set(id, c); }
        return deps.integrationMeasure(projectId, taskIds);
      }
      const cards = taskIds.flatMap((id) => {
        const t = deps.svc.get(id, { projectId })?.task;
        return t?.deliveryCommit ? [{ taskId: id, commit: t.deliveryCommit }] : [];
      });
      for (const c of cards) ciMeasured.set(c.taskId, c.commit);
      const repo = cards.length ? await deps.integrationRepo!(cards[0]!.taskId).catch(() => null) : null;
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
          const gh = async (args: string[]) => {
            const p = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
            const out = await new Response(p.stdout).text();
            return { code: await p.exited, out };
          };
          const list = await gh(["run", "list", "--commit", sha, "--workflow", "ci.yml", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"]);
          const id = list.out.trim();
          if (list.code !== 0 || !id) return false;
          return (await gh(["run", "rerun", id, "--failed"])).code === 0;
        },
      });
    },
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
      if (after.status !== "review" || after.landingState === "landed") return;
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
    stillWanted: (projectId, taskId) => {
      const t = deps.svc.get(taskId, { projectId })?.task;
      if (!t || t.status !== "review" || !t.landIntent || !t.deliveryCommit) return false;
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
    if ((t.humanAsk ?? "").trim() || t.checksState === "fail" || t.checksState === "running") return "no";
    if (t.landIntent === "auto") return "auto";
    const from = t.landIntentCommit ?? null;
    if (from && from !== t.deliveryCommit) {
      // A delivery other than the one approved must be measured green on its own commit first.
      if (t.checksState !== "pass" || t.checksCommit !== t.deliveryCommit) return "no";
      const files = deps.filesBetween ? await deps.filesBetween(taskId, from, t.deliveryCommit).catch(() => null) : [];
      const touched = files === null ? null : files.filter((f) => personPlace(f) !== null);
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
    bounceRed, enterCiPhase, afterDelivery, returnToCiPhase, boardHasCiPhase,
    pending: (projectId: string) => integration.pending(projectId),
  };
}
