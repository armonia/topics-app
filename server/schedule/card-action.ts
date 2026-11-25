/**
 * The `card` action: the board recurrence of before, as the first kind of job.
 * The card is born inside the transaction of the run (the engine calls `start`
 * from within it), so there is never a run without its card or a card without
 * its run.
 */
import type { Database } from "bun:sqlite";
import { normalizeLabels } from "../../shared/task-labels";
import type { TaskService } from "../services/tasks";
import type { ActionExecutor } from "./engine";

export function createCardAction(db: Database, tasks: TaskService): ActionExecutor {
  return {
    atomic: true,
    // The previous card is still on the board: a new one would pile up (R6, judged on the card itself).
    isBusy(job) {
      return db.query(`SELECT 1 FROM scheduled_job_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.job_id = ? AND t.status != 'done' AND t.archived = 0 LIMIT 1`).get(job.id) !== null;
    },
    start(job, _run, now) {
      if (job.action.kind !== "card" || !job.projectId) throw new Error("Card action without a board.");
      const task = tasks.create({ projectId: job.projectId, text: job.action.text, status: job.action.status, description: null, createdBy: "cron:scheduled-card" });
      const addLabel = db.prepare("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'human', ?)");
      for (const label of normalizeLabels(job.action.labels)) addLabel.run(task.id, label, now.toISOString());
      return { status: "ok", taskId: task.id };
    },
  };
}
