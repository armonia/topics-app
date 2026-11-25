/**
 * The worktree of a card here: the live link, then the last attempt, and never
 * the last local attempt of a card whose round runs on a node (25/11, 90cd0fcd).
 *
 * @covers KANBAN-76
 */
import { describe, expect, test } from "bun:test";
import { createWorktreeOfTask } from "./task-worktree";

type Card = { assignedTopicId?: string | null; machineId?: string | null };
const worktrees: Record<string, string> = { "wt-live": "topics/live", "wt-old": "topics/placid-storm" };

function worktreeOf(card: Card, attempt: string | null = "wt-old") {
  return createWorktreeOfTask({
    task: () => card,
    topicWorktreeId: (topicId) => (topicId === "topic-live" ? "wt-live" : null),
    worktree: (id) => worktrees[id] ?? null,
    lastAttemptWorktreeId: () => attempt,
    localMachineId: () => "questo-mac",
  })("t1");
}

describe("il worktree di una card su questa macchina", () => {
  test("il legame vivo del dispatcher viene prima", () => {
    expect(worktreeOf({ assignedTopicId: "topic-live" })).toBe("topics/live");
  });

  test("card locale rilasciata: risponde l'ultimo tentativo", () => {
    expect(worktreeOf({ assignedTopicId: null, machineId: null })).toBe("topics/placid-storm");
  });

  test("card che gira su un nodo: il tentativo locale vecchio non è il suo giro", () => {
    expect(worktreeOf({ assignedTopicId: null, machineId: "pc" })).toBeNull();
  });

  test("card fissata a questa macchina: gira qui, e il suo tentativo risponde", () => {
    expect(worktreeOf({ assignedTopicId: null, machineId: "questo-mac" })).toBe("topics/placid-storm");
  });

  test("nessun legame e nessun tentativo: nessun worktree", () => {
    expect(worktreeOf({}, null)).toBeNull();
    expect(createWorktreeOfTask({
      task: () => undefined, topicWorktreeId: () => null, worktree: () => null,
      lastAttemptWorktreeId: () => { throw new Error("db"); }, localMachineId: () => null,
    })("t1")).toBeNull();
  });
});
