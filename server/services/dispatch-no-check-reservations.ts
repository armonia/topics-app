import type { ReviewCheck } from "../../shared/board";
import type { Task, TaskService } from "./tasks";
import type { TaskAttemptStore } from "./task-attempts";
import { boardHasNoLocalChecks, canStartNoCheckExemption, NoCheckExemptionLedger, reservationForRuntime } from "./dispatch-no-check-exemption";
import type { HeldMemory } from "./mem-signal";

export function createNoCheckReservationManager(deps: {
  ledger: NoCheckExemptionLedger;
  attempts?: TaskAttemptStore;
  task(taskId: string): Task | null | undefined;
  checks(projectId: string): readonly ReviewCheck[];
  inFlight(taskId: string): boolean;
  localMemorySeatOccupied(): boolean;
  heldMemory(): HeldMemory | null;
  isCliRuntime(): boolean;
  comments(taskId: string): readonly { content: string }[];
  addComment(input: Parameters<TaskService["addComment"]>[0]): void;
  log(message: string, error?: unknown): void;
}) {
  const { ledger, attempts } = deps;

  function clear(taskId: string): void {
    ledger.release(taskId);
    try { attempts?.setNoLocalChecksReservation?.(taskId, null); }
    catch (err) { deps.log(`prenotazione senza check non azzerata per ${taskId}`, err); }
  }

  function releaseInvalid(): void {
    for (const taskId of ledger.taskIds()) {
      if (!deps.inFlight(taskId)) continue;
      try {
        const task = deps.task(taskId);
        if (!task) continue;
        if (task.dispatchWeight === "heavy" || !boardHasNoLocalChecks(deps.checks(task.projectId))) clear(taskId);
      } catch { /* Keep the reservation until its state can be read safely. */ }
    }
  }

  function releaseInactive(): void {
    releaseInvalid();
    const taskIds = new Set(ledger.taskIds());
    try {
      for (const taskId of attempts?.listNoLocalChecksReservationTaskIds?.() ?? []) taskIds.add(taskId);
    } catch { /* The in-memory ledger is still safe to sweep. */ }
    for (const taskId of taskIds) {
      if (deps.inFlight(taskId)) continue;
      try {
        if (deps.task(taskId)?.status !== "in_progress") clear(taskId);
      } catch { /* A failed read must not release a live reservation. */ }
    }
  }

  function reservationFor(task: Task): number | null {
    if (task.dispatchWeight === "heavy" || ledger.hasAny() || deps.localMemorySeatOccupied()
      || !attempts?.setNoLocalChecksReservation || !attempts.getNoLocalChecksReservation) return null;
    let checks: readonly ReviewCheck[];
    try { checks = deps.checks(task.projectId); } catch { return null; }
    if (!boardHasNoLocalChecks(checks)) return null;
    let heldGB: number | null = null;
    try { heldGB = deps.heldMemory()?.heldGB ?? null; } catch { return null; }
    const reservationGB = reservationForRuntime(deps.isCliRuntime());
    return canStartNoCheckExemption({ boardHasNoLocalChecks: true, heldGB, reservationGB }) ? reservationGB : null;
  }

  function restore(task: Task): boolean {
    if (ledger.has(task.id)) return true;
    let persistedGB: number | null = null;
    try { persistedGB = attempts?.getNoLocalChecksReservation?.(task.id) ?? null; }
    catch (err) { deps.log(`prenotazione senza check non letta per ${task.id}`, err); }
    if (persistedGB == null) return false;
    let checksStillClear = false;
    try { checksStillClear = boardHasNoLocalChecks(deps.checks(task.projectId)); }
    catch { checksStillClear = false; }
    const canRestore = !ledger.hasAny() && task.dispatchWeight !== "heavy"
      && Number.isFinite(persistedGB) && persistedGB > 0 && checksStillClear;
    if (!canRestore || !ledger.restore(task.id, persistedGB)) {
      clear(task.id);
      return false;
    }
    return true;
  }

  function noteStart(taskId: string, attemptId: string, reservationGB: number): void {
    const marker = `Partenza in esenzione senza check locali, tentativo ${attemptId}:`;
    if (deps.comments(taskId).some((comment) => comment.content.startsWith(marker))) return;
    try {
      deps.addComment({
        taskId,
        author: "system",
        kind: "service",
        content: `Partenza in esenzione senza check locali, tentativo ${attemptId}: `
          + `prenotati ${reservationGB.toFixed(2)} GB${reservationGB === reservationForRuntime(false) ? " (stima nativa)" : ""}.`,
      });
    } catch (err) { deps.log(`riga di esenzione non scritta per ${taskId}`, err); }
  }

  return { clear, releaseInvalid, releaseInactive, reservationFor, restore, noteStart };
}
