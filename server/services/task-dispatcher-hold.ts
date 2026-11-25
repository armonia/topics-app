/**
 * task-dispatcher-hold.ts: holds that come from the provider, not from the machine.
 * 
 * Plan-window waits, held launches and the classification of a start error as
 * "wait for the provider" or "permanent setup problem".
 */
import { type Task } from "./tasks";
import { effectiveTopicsRouting, taskModelSelection } from "../../shared/task-coding-models";
import { WorktreeRefusalError } from "./worktree-manager";
import { BOARD_HOLD_KEY, providerHold, holdAsksAPerson, holdUntilLabel, claudeEarlyStop } from "../lib/provider-hold";
import { providerHoldKey, providerHoldLabel } from "../../shared/provider-hold";
import { isModelUnavailable } from "./dispatch-overflow";
import { CHIP_QUEUED, PLAN_SPENT_NOTE } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createProviderHold(ctx: DispatcherCtx) {
  const { clock, deps, log, shared } = ctx.core;

  /** Whole days between now and the end of a hold, rounded up: past
   *  `HOLD_ASKS_A_PERSON_MS` this is always two or more, so both sentences that
   *  use it stay plural. */
  function holdDays(hold: { untilMs: number }): number {
    return Math.max(1, Math.ceil((hold.untilMs - clock()) / 86_400_000));
  }

  /**
   * The memo belongs to whichever PROVIDER the task would actually run on,
   * never to the whole machine — AGPT-01 extended: a Codex wall must not wait
   * behind Claude's memo, or hold Claude's cards, or vice versa (card
   * 31be77d3). The approaching-limit early warning stays Claude-only: it
   * comes from the five-hour usage window, which only Claude's plan reports.
   */
  function taskPlanWait(task: Task, model?: string | null, starting = false, quiet = false): { untilMs?: number; reason: string; asksAPerson?: true; slot?: string; provider: "claude" | "codex" } | null {
    const claudeHold = providerHold() ?? providerHold(Date.now(), BOARD_HOLD_KEY);
    const codexHold = providerHold(Date.now(), "codex");
    // The early stop at PLAN_DISPATCH_HOLD_AT, unless a person lifted it for this window.
    const window = starting ? claudeEarlyStop() : null;
    const nearLimit = !!window;
    if (!claudeHold && !codexHold && !nearLimit) return null;
    let topicId = task.assignedTopicId;
    if (!topicId && task.reuseBlockerContext && task.blockedByTaskId) {
      topicId = deps.svc.get(task.blockedByTaskId)?.task.assignedTopicId ?? null;
    }
    const session = topicId ? deps.topicModelSelection?.(topicId) : null;
    let provider = session?.provider;
    if (!provider) {
      const selected = model ?? task.model;
      const selection = taskModelSelection(selected);
      // Same switch the launch reads: the task's, then the board's, then the legacy prefix.
      let boardRouting: boolean | null = null;
      try { boardRouting = deps.svc.getBoardSettings(task.projectId).dispatchTopicsRouting; } catch { /* no board row: the task decides */ }
      const topicsRouting = effectiveTopicsRouting(task.topicsRouting ?? boardRouting, selected, "task", task.createdAt);
      // MSEL-06: the switch no longer narrows the Automatic ballot (GPT stays a
      // candidate with it ON), so a free runtime elsewhere is a way out either way.
      if (!topicId && !selection.model && !selection.provider && deps.automaticModelAvailable?.()) return null;
      try { provider = deps.resolveTaskProvider?.(selected, topicsRouting) ?? taskModelSelection(selected).provider ?? "topics"; }
      catch { return null; } // Unavailable routing is reported by createTopic, not disguised as quota.
    }
    const holdKey = providerHoldKey(provider);
    if (!holdKey) return null;
    const hold = holdKey === "codex" ? codexHold : claudeHold;
    const applicableNearLimit = holdKey === "claude" ? nearLimit : false;
    if (!hold && !applicableNearLimit) return null;
    const label = providerHoldLabel(holdKey);
    if (hold) {
      // AN API OUTAGE IS NO WINDOW. Its end is a horizon every retry pushes on
      // (`holdForApiDown`), and what lifts it is the API answering again. So
      // it names no end: a card's retry waited for that horizon, up to an
      // hour, with the API already back. It waits in the queue for the lift.
      if (hold.window === "api-down") {
        if (!quiet && shared.holdAnnounced !== hold.sinceMs) {
          shared.holdAnnounced = hold.sinceMs;
          log(`${label} dispatch waiting: ${hold.reason}, resumes when the API answers again`);
        }
        return { provider: holdKey, reason: `${label}: ${hold.reason}. Riparte appena l'API torna a rispondere.` }; // allow-italian: task queue reason
      }
      // A WALL OF DAYS IS NOT A WINDOW ROTATING. Held for longer than a day,
      // the queue is not waiting for a reset: the plan is spent, and the only
      // thing that moves the cards is a person changing the board's model or
      // the account. Saying "resumes at 14:45" for six days running (43 such
      // lines between 13/09 and 16/09) is how that stays invisible.
      const asksAPerson = holdAsksAPerson(hold, clock());
      const endsAt = holdUntilLabel(hold, clock());
      if (!quiet && shared.holdAnnounced !== hold.sinceMs) {
        shared.holdAnnounced = hold.sinceMs;
        log(asksAPerson
          ? `${label} dispatch waiting: ${hold.reason}, and the wall is ${holdDays(hold)} days away (until ${endsAt}): this is a spent plan, not a window reset`
          : `${label} dispatch waiting: ${hold.reason}, resumes at ${endsAt}`);
      }
      if (asksAPerson) {
        return {
          untilMs: hold.untilMs, asksAPerson: true, provider: holdKey,
          // THE SLOT THIS NOTE OWNS IN THE THREAD, and it has to be a slot
          // because the sentence CHANGES while the condition does not: the
          // days left count down, so on a wall of six days the same note reads
          // differently on each of six days. `once` alone would let one copy
          // per day through - six paragraphs a card - and the 10 s dedupe
          // window of `addComment` lets through one per BOOT (35 minutes apart
          // on this machine: 44 restarts in 25,7 h, 7 cards in the queue, a
          // Codex wall of 6 days = ~300 identical paragraphs a day, the exact
          // pile KANBAN-91 exists to end).
          slot: `${label}: `,
          reason: `${label}: ${hold.reason}. L'attesa arriva al ${endsAt}, fra ${holdDays(hold)} giorni: non e' il reset di una finestra, e' il piano esaurito. ` // allow-italian: task queue reason
            + PLAN_SPENT_NOTE,
        };
      }
      return { untilMs: hold.untilMs, provider: holdKey, reason: `${label}: ${hold.reason}. Ripresa dopo il reset delle ${endsAt}.` }; // allow-italian: task queue reason
    }
    const untilMs = window!.resetsAtMs;
    const pct = Math.round(window!.utilization);
    const at = holdUntilLabel({ untilMs }, clock());
    if (!quiet && shared.planWindowAnnounced !== untilMs) {
      shared.planWindowAnnounced = untilMs;
      log(`${label} dispatch waiting: five-hour window at ${pct}%, resumes at ${at}`);
    }
    return { untilMs, provider: holdKey, reason: `${label}: finestra di 5 ore al ${pct}%. Nuovi task in attesa del reset delle ${at}.` }; // allow-italian: task queue reason
  }

  function markPlanWait(task: Task, reason: string): void {
    if (task.dispatchState === CHIP_QUEUED && task.dispatchError === reason) return;
    ctx.queue.emit(deps.svc.setDispatchState({ taskId: task.id, state: CHIP_QUEUED, error: reason }));
  }

  /**
   * The bare `queued` chip, written only when the row does not carry it already
   * (the guard `markPlanWait` has). `setDispatchState` moves `updated_at` and
   * every write goes out as a frame, so the tick's holds, which run at every
   * 10 s poll, rewrote the same chip 360 times an hour on each held card.
   * Returns whether it wrote (and sent) the card.
   */
  function queueChip(task: Task, error?: string): boolean {
    const nextError = error ?? null;
    if (task.dispatchState === CHIP_QUEUED && (task.dispatchError ?? null) === nextError) return false;
    try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: task.id, state: CHIP_QUEUED, error: nextError })); return true; } catch { return false; }
  }

  /** A hold may arrive while the async model picker runs, before any resources exist. */
  function deferHeldLaunch(task: Task, model?: string): boolean {
    const wait = taskPlanWait(task, model, true);
    if (!wait) return false;
    const queued = ctx.queue.releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true, reason: wait.reason });
    markPlanWait(queued, wait.reason);
    return true;
  }

  function pendingProviderReason(error: unknown): string | null {
    return error instanceof Error && 'code' in error && error.code === 'task_provider_pending' ? error.message : null;
  }

  /**
   * Un guasto che rimettere in coda NON risolve: una combinazione di provider e modello che questa macchina non puo' eseguire, dove riprovare ripete lo stesso errore per sempre. Si parcheggia col motivo, l'unica cosa che dice all'umano cosa cambiare. allow-italian: il confine fra guasto permanente e passeggero
   * Il catalogo ancora in scoperta NON e' qui: quello e' `TaskProviderPendingError`, che aspetta e rimette in coda. allow-italian: la distinzione che una review ha gia' pagato
   */
  function hardRoutingBlock(error: unknown): string | null {
    // No agent for the model on THIS machine: no retry finds one, and the origin reads the phrase to move the card.
    if (error instanceof Error && isModelUnavailable(error)) return error.message;
    if (!(error instanceof Error) || !('code' in error)) return null;
    // MSEL-06: the switch is no longer a gate, so `task_model_unavailable` is the one permanent code left.
    return error.code === 'task_model_unavailable' ? error.message : null;
  }

  /**
   * A failure requeuing cannot fix, as the reason the card parks with: a hard
   * routing block, or a worktree the manager REFUSED to create (the project
   * path is not a git repository, is itself a worktree, or a hook said no).
   * Retrying the refusal repeats it until the cap, then parks the card with a
   * generic "launch failed" that hides the cause. A WorktreeOperationError
   * (git itself failed) is not here: that one can be flaky and keeps the retry.
   */
  function permanentSetupBlock(error: unknown): string | null {
    if (error instanceof WorktreeRefusalError) {
      return `${error.message}. Disattiva 'worktree isolato' nelle impostazioni del board per eseguire in-place.`;
    }
    return hardRoutingBlock(error);
  }

  function deferPendingProvider(taskId: string, reason: string): void {
    const queued = ctx.queue.releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true, reason });
    markPlanWait(queued, reason);
  }
  return { deferHeldLaunch, deferPendingProvider, markPlanWait, pendingProviderReason, permanentSetupBlock, queueChip, taskPlanWait };
}
