/**
 * `tasks.project_id` must be a BOARD id (`projectIdForPath(path)`). Tasks
 * created by passing the `projects.id` UUID were born on a board nobody
 * reads: the kanban showed two columns for the same project, one named and
 * one a raw UUID.
 *
 * This script moves those rows onto the real board. It does NOT touch a task
 * bound to a live session (`assigned_topic_id`, or a row in `agent_sessions`):
 * those are listed and left where they are.
 *
 * Read-only without `--apply`.
 */
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../shared/board";

const apply = process.argv.includes("--apply");
const dbPath = process.argv.find((a: string) => a.endsWith(".db")) ?? "data/topics.db";
const db = apply ? new Database(dbPath, { readwrite: true }) : new Database(dbPath, { readonly: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projects = db.query("SELECT id, path FROM projects").all() as { id: string; path: string }[];
const byId = new Map(projects.map((p) => [p.id, p.path]));

const rows = db.query(
  "SELECT id, project_id, status, assigned_topic_id, text FROM tasks WHERE project_id IS NOT NULL",
).all() as { id: string; project_id: string; status: string; assigned_topic_id: string | null; text: string }[];

const live = new Set(
  (db.query("SELECT DISTINCT task_id FROM agent_sessions WHERE task_id IS NOT NULL").all() as { task_id: string }[])
    .map((r) => r.task_id),
);

let moved = 0, skipped = 0, unknown = 0;
const update = apply ? db.query("UPDATE tasks SET project_id = ? WHERE id = ?") : null;

for (const r of rows) {
  if (!UUID.test(r.project_id)) continue;
  const path = byId.get(r.project_id);
  if (!path) {
    unknown++;
    console.log(`?  ${r.id.slice(0, 8)}  ${r.project_id}  (no project with this id) — left alone`);
    continue;
  }
  const board = projectIdForPath(path);
  if (r.assigned_topic_id || live.has(r.id)) {
    skipped++;
    console.log(`=  ${r.id.slice(0, 8)}  live session — left on ${r.project_id}`);
    continue;
  }
  moved++;
  console.log(`${apply ? "→" : "·"}  ${r.id.slice(0, 8)}  ${r.project_id} → ${board}  [${r.status}] ${r.text.slice(0, 40)}`);
  update?.run(board, r.id);
}

console.log(`\n${apply ? "moved" : "to move"}: ${moved} · skipped (live session): ${skipped} · unknown ids: ${unknown}`);
if (!apply) console.log("Nothing written. Re-run with --apply.");
