/**
 * A LAND REACHES ORIGIN, OR SAYS IT DID NOT.
 *
 * 10/11/2026: the live checkout was 18 commits ahead of origin/main, every one
 * a `merge task <id>` of a card in Done. The land merged locally and nobody
 * pushed. Here: the land pushes `main` after a confirmed merge, and a push
 * that fails leaves the card `unpushed` with a line in the thread instead of
 * a silent `landed`.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
  touchedClient: false, touchedServer: false, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};

async function land(push: (repo: string) => Promise<any>) {
  const stamped: string[] = []; const pushed: string[] = [];
  const d = freshDb(); const b: any[] = [];
  const rt = createTasksRouter(makeCtx(d, b), undefined, {
    autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    stampLanding: async (_id: string, v: string) => { stamped.push(v); },
    closeDelivery: async () => ({ pr: null, branchDeleted: false, problems: [] }),
    confirmLandedOnMain: async () => true,
    pushMainAfterLand: async (repo: string) => { pushed.push(repo); return push(repo); },
  } as any);
  d.run("INSERT INTO topics (id) VALUES ('top-p')");
  const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
  d.prepare("UPDATE tasks SET assigned_topic_id='top-p', status='review' WHERE id = ?").run(t.id);
  await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
  await new Promise((r) => setTimeout(r, 30));
  return { stamped, pushed, after: createTaskService(d).get(t.id)! };
}

describe("il land porta main su origin", () => {
  test("land confermato → main si pusha, verdetto landed", async () => {
    const { stamped, pushed } = await land(async () => ({ ok: true, pushed: 1 }));
    expect(pushed).toEqual(["/repo"]);
    expect(stamped).toEqual(["landed"]);
  });

  test("push fallito → la card dice unpushed e lo scrive nel thread, mai landed in silenzio", async () => {
    const { stamped, after } = await land(async () => ({ ok: false, reason: "git push fallito: ssh: connect to host github.com port 22: Operation timed out" }));
    expect(stamped).toEqual(["unpushed"]);
    expect(after.comments.some((c) => c.content.includes("NON su origin") && c.content.includes("port 22"))).toBe(true);
  });

  test("il push che esplode vale come fallito", async () => {
    const { stamped } = await land(async () => { throw new Error("boom"); });
    expect(stamped).toEqual(["unpushed"]);
  });
});
