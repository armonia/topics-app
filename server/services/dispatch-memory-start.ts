import type { Task } from "./tasks";

export interface DispatchMemoryStartResult {
  ok: boolean;
  code?: string;
}

export function createDispatchMemoryStartController(deps: {
  getTask(projectId: string, taskId: string): Task | null | undefined;
  isInFlight(taskId: string): boolean;
  isRemoteTask(task: Task): boolean;
  isMemoryWaiter(task: Task): boolean;
  localMemorySeatOccupied(): boolean;
  checksRunning(): number;
  dispatch(projectId: string): Promise<void>;
  notifyQueue(): void;
}) {
  let owner: string | null = null;
  const admitted = new Set<string>();
  const selectedByProject = new Map<string, string>();
  const promises = new Map<string, Promise<DispatchMemoryStartResult>>();

  function clearAdmittedWhenIdle(taskId: string): void {
    if (!promises.has(taskId) && !deps.isInFlight(taskId)) admitted.delete(taskId);
  }

  async function startAnyway(projectId: string, taskId: string): Promise<DispatchMemoryStartResult> {
    const pending = promises.get(taskId);
    if (pending) return pending;
    let task: Task | null | undefined;
    try { task = deps.getTask(projectId, taskId); } catch { /* checked below */ }
    if (!task) return { ok: false, code: "not_found" };
    if (task.status === "in_progress" && deps.isInFlight(taskId)) {
      return admitted.has(taskId) ? { ok: true } : { ok: false, code: "not_memory_queued" };
    }
    if (!deps.isMemoryWaiter(task)) return { ok: false, code: "not_memory_queued" };
    if (deps.isRemoteTask(task)) return { ok: false, code: "not_local_task" };
    if ((owner && owner !== taskId) || deps.localMemorySeatOccupied() || deps.checksRunning() > 0) {
      return { ok: false, code: "memory_slot_busy" };
    }

    owner = taskId;
    admitted.add(taskId);
    const promise = Promise.resolve().then(async () => {
      selectedByProject.set(projectId, taskId);
      try {
        await deps.dispatch(projectId);
        const current = deps.getTask(projectId, taskId);
        const started = current?.status === "in_progress" && deps.isInFlight(taskId);
        if (!started) admitted.delete(taskId);
        return started ? { ok: true } : { ok: false, code: "start_rejected" };
      } finally {
        if (selectedByProject.get(projectId) === taskId) selectedByProject.delete(projectId);
        if (owner === taskId) owner = null;
        if (!deps.isInFlight(taskId)) admitted.delete(taskId);
        promises.delete(taskId);
        deps.notifyQueue();
      }
    });
    promises.set(taskId, promise);
    return promise;
  }

  return {
    startAnyway,
    selectedTask(projectId: string): string | null { return selectedByProject.get(projectId) ?? null; },
    hasPending(taskId: string): boolean { return promises.has(taskId); },
    clearAdmittedWhenIdle,
  };
}
