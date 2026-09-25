/**
 * The delivery note that waits on git, seen from the board: the PATCH has
 * already broadcast the card when the note lands, so the router sends it again.
 * On main the note was written inside the update, and the first broadcast
 * carried it.
 *
 * @covers KANBAN-11
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { deliveryNotesInFlight } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

let db: Database;
let broadcasts: Array<{ type: string; task?: { id: string } }>;
beforeEach(() => { db = freshDb(); broadcasts = []; });

test("a delivery note that waits on git reaches the open board: the card is sent again once it lands", async () => {
  const answering = {
    shaExists: () => true, migrations: () => [], readMigration: () => "",
    fileMatches: () => true, readLine: () => null, symbolInHistory: () => false,
  };
  const r = createTasksRouter(makeCtx(db, broadcasts), undefined, {
    repoRootFor: () => "/repos/any",
    probeFor: () => ({ ...answering, symbolInHistory: () => true, prepare: () => new Promise((ok) => setTimeout(() => ok(answering), 20)) }),
  });
  const t = await (await call(r, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
  const rev = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", summary: "Nuovo `neverWrittenSymbol`." }))!;
  expect(rev.status).toBe(200);
  const sent = () => broadcasts.filter((b) => b.type === "task:updated" && b.task?.id === t.id).length;
  const afterPatch = sent();
  await deliveryNotesInFlight();
  const notes = db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(t.id) as Array<{ content: string }>;
  expect(notes.map((n) => n.content).join("\n")).toContain("neverWrittenSymbol");
  expect(sent(), "the note landed and nobody told the board").toBe(afterPatch + 1);
});
