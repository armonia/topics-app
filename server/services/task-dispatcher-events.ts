/**
 * task-dispatcher-events.ts: the entry points the rest of the server calls.
 * 
 * Todo enter/leave, blocker done, deferred wait, interruption, delegated
 * cancellation, shutdown and the night-mode status.
 */
import { UNASSIGNED_PROJECT_ID, type Task } from "./tasks";
import { hasDeliveredWork, PARKED_WAITED_OUT } from "../../shared/board";
import { setHeldResumeBlock } from "./dispatch-block-signal";
import { isMirrorCard, CHIP_QUEUED, CHIP_BLOCKED, parkedEdgeEvent } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createBoardEvents(ctx: DispatcherCtx) {
  const { commandWaits, deps, evaluateNight, graceMs, graceTimers, heldWritten, inFlight, log, pendingResume, recordDelegated, retryWaits, slotWaits, spendHeldNoted, waitingForSlot, shared } = ctx.core;

  function onEnterTodo(projectId: string, taskId: string): void {
    // A fresh entry into Todo is a fresh wait: the overflow's clock starts over.
    ctx.overflow.forgetOverflowClock(taskId);
    // No project = no dispatch (and no stranded chip): assign a board first.
    if (projectId === UNASSIGNED_PROJECT_ID) return;
    ctx.queue.clearGrace(taskId);
    // Off-switch: with auto_dispatch off this is a plain manual board — no chip,
    // no timer, nothing starts. (Guarding here, not just in tick(), keeps the
    // `queued` chip from lingering on a board that never dispatches.)
    try { if (!deps.svc.getBoardSettings(projectId).autoDispatch) return; } catch { return; }
    // Steps are never dispatch-eligible (tick filters rootsOnly): no queued
    // chip either, or it would strand forever on the subtask.
    try { if (deps.svc.get(taskId)?.task?.parentTaskId) return; } catch { return; }
    if (deps.isActive?.() === false) {
      try { if (!isMirrorCard(deps.svc.get(taskId)?.task)) return; } catch { return; }
    }
    // A blocked task WAITS in todo without a queued chip (the claim would
    // never fire — the chip would strand). The client derives its own
    // "in attesa di…" chip from blockedByTaskId; onBlockerDone re-kicks it.
    try { if (deps.svc.isDispatchBlocked(taskId)) return; } catch { /* fall through */ }
    // A card a scheduled run works is planned, not queued: no chip, no grace timer.
    try { if (deps.svc.get(taskId)?.task?.scheduled) return; } catch { return; }
    // Show "queued" immediately; the claim waits out the grace window so a quick
    // drag-through never spawns. If the task still carries a topic binding (it was
    // dispatched before and dragged back from review/done), clear the binding via
    // release so it's eligible for a FRESH dispatch — otherwise the tick filter
    // skips it and the chip would strand on "queued" forever.
    try {
      const t = deps.svc.get(taskId)?.task;
      if (t?.assignedTopicId) ctx.queue.releaseAndEmit({ taskId, requeue: true });
      else ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_QUEUED }));
    } catch { /* task may have moved */ }
    const timer = setTimeout(() => {
      graceTimers.delete(taskId);
      void ctx.tick.tick(projectId).catch((err) => log(`tick after grace failed for ${projectId}`, err));
    }, graceMs);
    graceTimers.set(taskId, timer);
  }

  function onLeaveTodo(taskId: string): void {
    ctx.queue.clearGrace(taskId);
    ctx.overflow.forgetOverflowClock(taskId);
    // IL CHIP «IN CODA» SI SPEGNE ANCHE FUORI DALLA FINESTRA DI GRAZIA.
    //
    // Prima questa riga viveva dentro `if (graceTimers.has(taskId))`, e quella
    // guardia copriva solo il trascinamento IMMEDIATO. Una card rimasta in Todo
    // piu' a lungo della grazia ha gia' visto il suo tick: se nessuno l'ha
    // reclamata (tetto pieno, notte, pesante in attesa) il tick le scrive
    // comunque `queued`, e il timer non c'e' piu'. Trascinandola in Backlog il
    // chip restava acceso per sempre — e con lui il bottone «Ferma», che offre
    // di fermare un agente mai nato.
    //
    // Era un chip che MENTE: il `claim` reclama `status = 'todo'` e basta,
    // quindi da Backlog non parte piu' niente. Da qui il giro muto segnalato
    // sulla card 05ae83f7: il gesto e' legittimo, la transizione no, e nessuna
    // delle due cose si vedeva.
    //
    // Si spegne SOLO `queued`, e solo senza un turno in volo: `starting` e
    // `working` sono un processo vero, e li' lo stato lo chiude `onTurnEnd`.
    if (!inFlight.has(taskId)) {
      try {
        if (deps.svc.get(taskId)?.task?.dispatchState === CHIP_QUEUED) {
          ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: null }));
        }
      } catch { /* Best-effort: the row may already have disappeared. */ }
    }
    ctx.queue.notifyMemoryQueue();
  }

  function deferWait(taskId: string, reason: string, minutes?: number, source: "agent" | "machine" = "agent", mail?: { until: string; waitId: string }): Task {
    // A pending grace timer would re-tick this task the moment it lands in todo,
    // defeating the wait — clear it (harmless if none is set).
    ctx.queue.clearGrace(taskId);
    const t = deps.svc.deferForWait({ taskId, reason, minutes, by: "agent", source, ...(mail ? { until: mail.until, mailWaitId: mail.waitId } : {}) });
    ctx.queue.emit(t);
    // Il park dell'attesa sfondata è l'UNICO park terminale che non passa da
    // `releaseAndEmit`: lo decide il service, guardando i tetti della serie, e
    // il dispatcher lo scopre solo dal chip che si ritrova in mano. Senza
    // questa riga la card cambiava chip in tempo reale sulla board e nessuno
    // veniva avvisato — proprio del park che esiste per dire «decidi tu», cioè
    // quello che l'umano ha più bisogno di sapere senza guardare.
    //
    // Il taglio è il chip, non il ritorno: `deferForWait` ritorna un task
    // parcheggiato SOLO quando ha sfondato un tetto, mentre l'attesa normale
    // torna in coda con chip `waiting` e non si annuncia (riparte da sola, e
    // un banner per ogni attesa sarebbe rumore).
    if (t.dispatchState === PARKED_WAITED_OUT) {
      const parked = parkedEdgeEvent(t, { requeue: false, parkState: PARKED_WAITED_OUT });
      if (parked) {
        try { deps.broadcast(parked); } catch { /* best-effort */ }
      }
    }
    return t;
  }

  function onBlockerDone(taskId: string): void {
    if (!inFlight.has(taskId)) {
      if (shared.memorySeatTaskId === taskId) shared.memorySeatTaskId = null;
      ctx.admission.clearNoCheckReservation(taskId);
    }
    // The blocker completed: every todo that was waiting on it is now
    // claimable — give each one the normal enter-todo treatment (queued chip +
    // grace + tick). The periodic reconcile would catch them anyway; this makes
    // the unblock immediate.
    let dependents: Task[] = [];
    try { dependents = deps.svc.listBlockedBy(taskId); } catch { return; }
    for (const dep of dependents) {
      if (dep.status !== "todo" || dep.parentTaskId) continue;
      // "Release whatever was waiting on this task" is right for a peer blocker:
      // that one was waiting to START. A card that has ALREADY DELIVERED is not,
      // and re-dispatching it puts an agent on a fresh empty worktree over work
      // that is already merged. `hasDeliveredWork` reads the marks the record
      // already carries; nothing here has to guess.
      if (hasDeliveredWork(dep)) continue;
      try { onEnterTodo(dep.projectId, dep.id); } catch { /* best-effort */ }
    }
  }

  /**
   * `inFlight` in quel momento contiene ESATTAMENTE le card che stanno
   * lavorando: e' la sola fotografia che il processo ha, e muore con lui.
   * Costa una UPDATE per card e una riga di log.
   */
  function markInterrupted(by: string): number {
    try {
      const ids = [...inFlight.keys()];
      if (!ids.length) return 0;
      const marcate = deps.svc.markInterrupted({ taskIds: ids, by });
      if (marcate > 0) {
        log(`spegnimento (${by}): ${marcate} ${marcate === 1 ? "card tagliata" : "card tagliate"} a meta' turno`);
      }
      return marcate;
    } catch (err) {
      log("spegnimento: le card in volo non si sono lasciate marcare", err);
      return 0;
    }
  }

  async function cancelDelegatedTask(task: Task, outcome: string): Promise<boolean> {
      ctx.queue.clearGrace(task.id);
      ctx.runs.clearRetryWait(task.id);
      ctx.runs.clearSlotWait(task.id, false);
      const remoteCancellation = await ctx.runs.remote.cancelTask(task.id);
      if (remoteCancellation === true) {
        ctx.admission.clearNoCheckReservation(task.id);
        recordDelegated(task.id, "cancelled", { outcome });
        return true;
      }
      if (remoteCancellation === false) return false;
      const slot = inFlight.get(task.id);
      if (slot) {
        if (slot.sessionKey && deps.abortTurn) {
          try { await deps.abortTurn(slot.sessionKey, "superseded"); } catch { /* release still closes authority */ }
        }
      } else if (task.assignedTopicId && deps.abortTurn) {
        ctx.admission.clearNoCheckReservation(task.id);
        try { await deps.abortTurn(`topic:${task.assignedTopicId.slice(0, 8)}`, "superseded"); } catch { /* release still closes authority */ }
      } else ctx.admission.clearNoCheckReservation(task.id);
      if (task.status === "todo") {
        try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: task.id, state: null, error: "delegated_capability_revoked" })); }
        catch { /* task may have moved */ }
        recordDelegated(task.id, "cancelled", { outcome });
        return true;
      }
      if (task.status === "in_progress") {
        try {
          ctx.queue.releaseAndEmit({
            taskId: task.id,
            requeue: false,
            rollbackAttempt: true,
            parkState: CHIP_BLOCKED,
            reason: "Delegated start authorization was revoked.",
          });
        } catch { /* task may have moved */ }
        recordDelegated(task.id, "cancelled", { outcome });
        return true;
      }
      return false;
  }

  async function revokeDelegatedCapability(capabilityId: string): Promise<number> {
    let tasks: Task[] = [];
    try { tasks = deps.svc.list({ scope: "all" }); } catch { return 0; }
    let canceled = 0;
    for (const task of tasks) {
      if (task.delegatedStartCapabilityId !== capabilityId) continue;
      if (await cancelDelegatedTask(task, "capability_revoked")) canceled++;
    }
    return canceled;
  }

  function shutdown(): void {
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
    // Un dispatcher spento non deve svegliarsi fra 5s per riprendere un task su
    // un DB che non è più il suo — ed è anche il modo in cui i test, che ne
    // creano uno per caso, non si passano le attese a vicenda.
    for (const [taskId, w] of slotWaits) { clearTimeout(w.timer); setHeldResumeBlock(taskId, null); }
    slotWaits.clear();
    for (const t of retryWaits.values()) clearTimeout(t);
    retryWaits.clear();
    commandWaits.clear();
    waitingForSlot.clear();
    heldWritten.clear();
    spendHeldNoted.clear();
    pendingResume.clear();
    // Senza questa riga un dispatcher spento resterebbe iscritto e continuerebbe
    // a scrivere chip su un DB che non è più il suo — e i test, che ne creano
    // uno per caso, si passerebbero gli ascoltatori a vicenda.
    ctx.runs.unsubscribeHumanHold();
  }

  /**
   * Lo stato della modalità notturna per l'interfaccia. Sola lettura.
   *
   * Serve a rispondere alla domanda che una casella di spunta non risponde:
   * «è accesa, e allora perché non parte niente?». Senza, l'unico modo di
   * saperlo è leggere i log del server.
   */
  function nightStatus(projectId: string): {
    enabled: boolean;
    until: string | null;
    startedAt: string | null;
    action: "off" | "dispatch" | "wait" | "expire";
    reason: string | null;
    load1: number;
    cores: number;
    busySessions: number;
    endsInMs: number | null;
  } {
    let settings: { nightMode?: boolean; nightModeUntil?: string | null; nightModeStartedAt?: string | null };
    try { settings = deps.svc.getBoardSettings(projectId) as typeof settings; }
    catch { return { enabled: false, until: null, startedAt: null, action: "off", reason: null, load1: 0, cores: 0, busySessions: 0, endsInMs: null }; }
    const ev = evaluateNight(settings);
    return {
      enabled: !!settings.nightMode,
      until: settings.nightModeUntil || null,
      startedAt: settings.nightModeStartedAt || null,
      action: ev.decision.action,
      reason: "reason" in ev.decision ? ev.decision.reason : null,
      load1: ev.load1,
      cores: ev.cores,
      busySessions: ev.busySessions,
      endsInMs: ev.endsInMs,
    };
  }
  return { cancelDelegatedTask, deferWait, markInterrupted, nightStatus, onBlockerDone, onEnterTodo, onLeaveTodo, revokeDelegatedCapability, shutdown };
}
