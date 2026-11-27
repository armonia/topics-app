/**
 * A commit already on main beats the unmeasured-delivery gate.  @covers LAND-05
 *
 * 26/11: card 1178675b sat in review re-offering a land every 10 minutes
 * because `unmeasuredStop` ran BEFORE anyone asked whether the delivery had
 * already landed — PR #1710 had merged it on GitHub hours earlier, checks
 * null and all. Here: a proven commit closes the card without ever asking
 * for the measure; an unproven one is refused exactly as before.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

async function setup(proof: string | null) {
  const db = freshDb(); const broadcasts: unknown[] = [];
  const merges: string[] = [];
  const autoMerge = {
    tryMerge: async (id: string) => { merges.push(id); return { status: "skipped", code: "auto-land-stopped", reason: "stopped" }; },
    buildClient: async () => ({ code: 0, stderr: "" }),
    resolveRepoPath: () => "/repo",
  } as any;
  const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
    autoMerge,
    alreadyLandedProof: async () => proof,
    stampLanding: async (taskId, verdict) => {
      createTaskService(db).recordLandingState({ taskId, state: verdict as any, checkedAt: new Date().toISOString() });
    },
  });
  db.run("INSERT INTO topics (id) VALUES ('top-already')");
  const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "card" }))!.json();
  db.prepare(
    "UPDATE tasks SET assigned_topic_id='top-already', status='review', delivery_branch='topics/y', delivery_commit='bdfcf0cbaa', checks_state=NULL, checks_json=NULL WHERE id = ?",
  ).run(t.id);
  db.run("INSERT OR REPLACE INTO board_settings (project_id, review_checks) VALUES ('pX', ?)",
    [JSON.stringify([{ name: "gates", cmd: "true" }])]);
  await call(router, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
  await new Promise((r) => setTimeout(r, 50));
  const after = createTaskService(db).get(t.id)!;
  const said = after.comments.map((c) => c.content).join(" ");
  return { after, said, merges };
}

describe("il land chiude senza misura quando il commit è già su main", () => {
  test("checks nullo ma commit già provato su main → landed e done, nessun rifiuto", async () => {
    const { after, said, merges } = await setup("bdfcf0cbaa0011");
    expect(after.task.status).toBe("done");
    expect(after.task.landingState).toBe("landed");
    expect(said).toContain("Già su main");
    expect(said).not.toContain("Land rifiutato");
    expect(merges).toEqual([]); // no measure, no merge attempt: the proof alone closes it
  });

  test("checks nullo e commit NON provato su main → resta rifiutato come oggi", async () => {
    const { after, said, merges } = await setup(null);
    expect(after.task.status).toBe("review");
    expect(said).toContain("checks nullo");
    expect(merges).toEqual([]);
  });
});
