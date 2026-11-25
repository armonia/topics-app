/**
 * THE WORKTREE OF A CARD ON THIS MACHINE, OR NONE.
 *
 * First the live link the dispatcher keeps (task -> assigned topic -> topic's
 * worktree). After a `release()` that link is empty, and the last attempt that
 * had a worktree answers instead (18/08, `171b787d`: 279 uncommitted lines read
 * as a clean card because nobody answered).
 *
 * That fallback is only true for a card whose round runs HERE. A card on a node
 * (`machineId` set, and not this machine: a card pinned to this Mac runs here
 * like any other) has its round's worktree on the node, and the last local
 * attempt is a round a person already sent back. On 25/11 `90cd0fcd` came back
 * from the PC with `topics/warm-spear` planted, and the delivery capture, which
 * asks this first, wrote the old local `topics/placid-storm` back over it: the
 * land, which asks this first too, would have merged the rejected round and
 * dropped the new one. For such a card the answer is none, and the delivery
 * branch the node planted is what everyone reads.
 */
export interface TaskWorktreeDeps<W> {
  task: (taskId: string) => { assignedTopicId?: string | null; machineId?: string | null } | null | undefined;
  topicWorktreeId: (topicId: string) => string | null | undefined;
  worktree: (worktreeId: string) => W | null | undefined;
  /** The worktree of the card's last attempt that had one. */
  lastAttemptWorktreeId: (taskId: string) => string | null | undefined;
  /** This machine's id in the fleet: a card pinned to it runs here. */
  localMachineId: () => string | null | undefined;
}

export function createWorktreeOfTask<W>(deps: TaskWorktreeDeps<W>): (taskId: string) => W | null {
  return (taskId) => {
    const task = deps.task(taskId);
    const topicId = task?.assignedTopicId;
    if (topicId) {
      const worktreeId = deps.topicWorktreeId(topicId);
      if (worktreeId) return deps.worktree(worktreeId) ?? null;
    }
    if (task?.machineId && task.machineId !== localMachine(deps)) return null;
    try {
      const worktreeId = deps.lastAttemptWorktreeId(taskId);
      if (worktreeId) return deps.worktree(worktreeId) ?? null;
    } catch { /* the fallback is best-effort */ }
    return null;
  };
}

function localMachine(deps: { localMachineId: () => string | null | undefined }): string | null {
  try { return deps.localMachineId() ?? null; } catch { return null; }
}
