import type { DispatchMemoryQueueCard, DispatchMemoryQueueSnapshot } from "../../shared/board";
import { decodeMemoryQueueRef, encodeMemoryQueueRef, memoryQueueConsumerLabel, memoryQueueTitle } from "./dispatch-memory-reference";
import type { Task, TaskService } from "./tasks";
import type { DispatchMemoryHistoryPoint } from "./dispatch-memory-history";
import type { HeldMemory } from "./mem-signal";

export function createDispatchMemoryQueueSnapshot(deps: {
  svc: Pick<TaskService, "get" | "list">;
  activeTaskIds(): string[];
  canWait(task: Task): boolean;
  boardOrder(projectIds: string[]): string[];
  memoryReading?(): { freeGB: number | null; at: number | null };
  heldMemory?(): HeldMemory | null;
  memoryHistory?(): DispatchMemoryHistoryPoint[];
  memoryConsumers?(): Array<{ label: string; gb: number }>;
  costGB(): number;
  startGB(): number;
}): () => DispatchMemoryQueueSnapshot {
  return () => {
    const memory = (() => { try { return deps.memoryReading?.(); } catch { return undefined; } })();
    const held = (() => { try { return deps.heldMemory?.(); } catch { return null; } })();
    const costGB = deps.costGB();
    const active = deps.activeTaskIds().flatMap((taskId) => {
      try {
        const task = deps.svc.get(taskId)?.task;
        return task ? [{ task, weightGB: costGB }] : [];
      } catch { return []; }
    });
    let waiting: Task[] = [];
    try {
      waiting = deps.svc.list({ scope: "all", status: "todo", rootsOnly: true })
        .filter(deps.canWait)
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    } catch { /* An unavailable board feed is an empty queue snapshot. */ }
    const waitingByBoard = new Map<string, Task[]>();
    for (const task of waiting) waitingByBoard.set(task.projectId, [...(waitingByBoard.get(task.projectId) ?? []), task]);
    const orderedBoards = deps.boardOrder([...waitingByBoard.keys()]);
    waiting = orderedBoards.flatMap((projectId) => waitingByBoard.get(projectId) ?? []);
    const total = active.length + waiting.length;
    const queue = waiting.map((task, index) => ({
      taskId: encodeMemoryQueueRef(task.id),
      boardId: encodeMemoryQueueRef(task.projectId),
      reason: "waiting-memory" as const,
      position: active.length + index + 1,
      total,
      costGB,
    }));
    const consumers = (() => {
      try {
        return (deps.memoryConsumers?.() ?? [])
          .filter((consumer) => consumer.label.trim() && Number.isFinite(consumer.gb) && consumer.gb > 0)
          .sort((a, b) => b.gb - a.gb)
          .slice(0, 3)
          .map((consumer) => ({ label: memoryQueueConsumerLabel(consumer.label), gb: consumer.gb }));
      } catch { return []; }
    })();
    let history: DispatchMemoryHistoryPoint[] = [];
    try { history = deps.memoryHistory?.() ?? []; } catch { /* Empty history is a valid cold start. */ }
    const freeGB = memory?.freeGB ?? held?.latestGB ?? null;
    const at = memory?.at ?? null;
    return {
      reading: { freeGB, at: at == null ? null : new Date(at).toISOString() },
      threshold: { startGB: deps.startGB() },
      queue,
      running: active.map(({ task, weightGB }) => ({ taskId: encodeMemoryQueueRef(task.id), title: memoryQueueTitle(task.text), weightGB })),
      consumers,
      history: history.map((point) => ({ at: new Date(point.at).toISOString(), freeGB: point.freeGB })),
    };
  };
}

export function createDispatchMemoryQueuePublisher(deps: {
  snapshot(): DispatchMemoryQueueSnapshot;
  getTask(taskId: string): Task | null | undefined;
  broadcast(task: Task): void;
}) {
  const cards = new Map<string, DispatchMemoryQueueCard>();
  let lastSignature = "";

  return {
    cardFor(taskId: string): DispatchMemoryQueueCard | null {
      return cards.get(taskId) ?? null;
    },
    emit(task: Task): void {
      try { deps.broadcast({ ...task, dispatchQueue: cards.get(task.id) ?? null }); }
      catch { /* best-effort */ }
    },
    notify(): void {
      const snapshot = deps.snapshot();
      const next = new Map(snapshot.queue.map((item) => [decodeMemoryQueueRef(item.taskId) ?? item.taskId, {
        reason: item.reason, position: item.position, total: item.total, costGB: item.costGB,
      } satisfies DispatchMemoryQueueCard]));
      const signature = JSON.stringify(snapshot.queue.map(({ taskId, boardId, position, total, costGB }) => ({ taskId, boardId, position, total, costGB })));
      if (signature === lastSignature) return;
      const changed = new Set([...cards.keys(), ...next.keys()]);
      const changedIds = [...changed].filter((taskId) =>
        JSON.stringify(cards.get(taskId) ?? null) !== JSON.stringify(next.get(taskId) ?? null),
      );
      cards.clear();
      for (const [taskId, state] of next) cards.set(taskId, state);
      lastSignature = signature;
      for (const taskId of changedIds) {
        try {
          const task = deps.getTask(taskId);
          if (task) this.emit(task);
        } catch { /* The task may have left the queue during this snapshot. */ }
      }
    },
  };
}
