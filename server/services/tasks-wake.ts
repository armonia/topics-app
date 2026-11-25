/**
 * «Rimanda a»: a `backlog` card whose `wake_at` has passed goes back to `todo`
 * on its own, through the same `update()` a human dragging it there calls — so
 * it gets the same side effects (the status write itself; the dispatch pickup
 * is the caller's job, see `onEnterTodo` in `boot/dispatch-prep.ts`).
 *
 * Replaces the external script and cron that moved these cards by hand,
 * outside Topics (card 975aba21).
 */
import type { Database } from "bun:sqlite";
import type { Task } from "./task-shapes";
import type { TaskService } from "./tasks-service-types";

export function releaseWakingTasks(
  db: Database,
  tasks: Pick<TaskService, "update">,
  now: () => Date = () => new Date(),
): Task[] {
  const due = db.query(
    "SELECT id, project_id FROM tasks WHERE status = 'backlog' AND wake_at IS NOT NULL AND wake_at <= ? AND archived = 0",
  ).all(now().toISOString()) as { id: string; project_id: string }[];
  const released: Task[] = [];
  for (const row of due) {
    try {
      released.push(tasks.update({ taskId: row.id, actor: "agent", by: "schedule", projectId: row.project_id, patch: { status: "todo" } }));
    } catch (error) { console.warn("[wake-card] release failed:", row.id, error); }
  }
  return released;
}
