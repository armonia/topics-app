import type { AppContext } from "../types";
import {
  closeCommandProcessGroups, reconcileClosedCardProcessGroups,
  type CommandProcessGroupHooks,
} from "../lib/command-process-groups";

interface CommandGroupRow {
  processId: string;
  status: "running" | "done" | "error";
  cmd?: {
    closing?: boolean;
    stopped?: boolean;
    stopFailed?: boolean;
    wake: boolean;
  };
  closing?: boolean;
  stopFailed?: boolean;
  exitCode?: number;
  completedAt?: string;
}

interface CommandGroupLifecycleDeps<T extends CommandGroupRow> {
  find: (processId: string) => T | undefined;
  publish: (row: T) => void;
  finishCommand: (row: T) => void;
  finishOther: (row: T) => void;
}

let configuredLifecycle: {
  hooks: CommandProcessGroupHooks;
  load: () => void;
} | undefined;

export function configureCommandGroupLifecycle(
  hooks: CommandProcessGroupHooks,
  load: () => void,
): void {
  configuredLifecycle = { hooks, load };
}

function lifecycle(): NonNullable<typeof configuredLifecycle> {
  if (!configuredLifecycle) throw new Error("command process lifecycle is not configured");
  return configuredLifecycle;
}

export function createCommandGroupHooks<T extends CommandGroupRow>(
  deps: CommandGroupLifecycleDeps<T>,
): CommandProcessGroupHooks {
  return {
    onRetiring(group) {
      const row = deps.find(group.processId);
      if (!row) return;
      if (row.cmd) {
        row.cmd.closing = true;
        row.cmd.stopFailed = false;
        row.cmd.wake = false;
      } else {
        row.closing = true;
        row.stopFailed = false;
      }
      deps.publish(row);
    },
    onSettled(group, stopped) {
      const row = deps.find(group.processId);
      if (!row) return;
      if (row.cmd) {
        row.cmd.closing = false;
        row.cmd.stopFailed = !stopped;
        row.cmd.wake = false;
        if (stopped) {
          row.cmd.stopped = true;
          if (row.status === "running") {
            deps.finishCommand(row);
            return;
          }
          row.status = "error";
          row.exitCode = -1;
          row.completedAt = new Date().toISOString();
        }
      } else {
        row.closing = false;
        row.stopFailed = !stopped;
        if (stopped && row.status === "running") {
          row.status = "error";
          row.exitCode = -1;
          row.completedAt = new Date().toISOString();
          deps.finishOther(row);
        }
      }
      deps.publish(row);
    },
  };
}

export function stopCardCommandGroups(
  cardId: string,
  hooks: CommandProcessGroupHooks,
  load: () => void,
): void {
  load();
  void closeCommandProcessGroups((group) => group.cardId === cardId, hooks);
}

export function stopTopicCommandGroups(
  topicId: string,
  hooks: CommandProcessGroupHooks,
  load: () => void,
): void {
  load();
  void closeCommandProcessGroups((group) => group.topicId === topicId, hooks);
}

export function reconcileClosedCommandGroups(
  db: AppContext["db"],
  hooks: CommandProcessGroupHooks,
  load: () => void,
): void {
  load();
  void reconcileClosedCardProcessGroups((cardId) => {
    try {
      const card = db.prepare("SELECT status, archived FROM tasks WHERE id = ?").get(cardId) as { status?: string; archived?: number | boolean } | undefined;
      return !card || card.status === "done" || card.archived === 1 || card.archived === true;
    } catch {
      return false;
    }
  }, hooks);
}

export function stopCardCommandProcesses(cardId: string): void {
  const { hooks, load } = lifecycle();
  stopCardCommandGroups(cardId, hooks, load);
}

export function stopTopicCommandProcesses(topicId: string): void {
  const { hooks, load } = lifecycle();
  stopTopicCommandGroups(topicId, hooks, load);
}

export function reconcileClosedCommandProcesses(db: AppContext["db"]): void {
  const { hooks, load } = lifecycle();
  reconcileClosedCommandGroups(db, hooks, load);
}

export function cardIdForTopic(db: AppContext["db"], topicId: string | null): string | null {
  if (!topicId) return null;
  try {
    const card = db.prepare("SELECT id FROM tasks WHERE assigned_topic_id = ? ORDER BY updated_at DESC LIMIT 1").get(topicId) as { id?: string } | undefined;
    if (typeof card?.id === "string") return card.id;
  } catch {
    // Fan-out attempt topics are indexed separately from the assigned topic.
  }
  try {
    const attempt = db.prepare("SELECT task_id AS id FROM task_attempts WHERE topic_id = ? LIMIT 1").get(topicId) as { id?: string } | undefined;
    return typeof attempt?.id === "string" ? attempt.id : null;
  } catch {
    return null;
  }
}
