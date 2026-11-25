/**
 * A CARD THAT DECLARES A WAIT KEEPS THE BRANCH IT WORKED ON.
 *
 * Card f3c5a186: the work was committed on the worktree's branch, the pre-review
 * failed under load and the agent declared a wait. The wait path cleared
 * `assigned_topic_id` and wrote no `prior_branch`: the worktree later vanished
 * and the card pointed at a dead branch, so a rerun started from main.
 *
 * @covers WORKTREE-18
 */
import { test, expect, describe } from "bun:test";
import { createTaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";

function service(branchAheadOf: (root: string) => string | null) {
  const db = freshDb();
  db.run("PRAGMA foreign_keys = OFF");
  let n = 0;
  const s = createTaskService(db, {
    uuid: () => `id-${++n}`,
    repoRootFor: ({ assignedTopicId }) => (assignedTopicId ? "/worktree/of/the/card" : null),
    branchAheadOf,
  });
  return { db, s };
}

const priorBranchOf = (db: ReturnType<typeof freshDb>, id: string) =>
  (db.prepare("SELECT prior_branch FROM tasks WHERE id = ?").get(id) as { prior_branch: string | null }).prior_branch;

describe("attesa dichiarata con commit sul ramo", () => {
  test("prior_branch viene scritto col ramo del worktree", () => {
    const { db, s } = service((root) => (root === "/worktree/of/the/card" ? "topics/stealthy-bog" : null));
    const t = s.create({ projectId: PID, text: "lavoro col suo ramo", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1' WHERE id = ?", [t.id]);

    s.deferForWait({ taskId: t.id, reason: "il pre-review è caduto sotto carico", minutes: 15, by: "claude" });

    expect(priorBranchOf(db, t.id)).toBe("topics/stealthy-bog");
    expect(s.get(t.id)!.task.assignedTopicId ?? null).toBeNull();
  });

  test("senza commit davanti a main il prior_branch di prima resta com'è", () => {
    const { db, s } = service(() => null);
    const t = s.create({ projectId: PID, text: "nessun lavoro ancora", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1', prior_branch = 'topics/old' WHERE id = ?", [t.id]);

    s.deferForWait({ taskId: t.id, reason: "aspetto", minutes: 15, by: "claude" });

    expect(priorBranchOf(db, t.id)).toBe("topics/old");
  });
});
