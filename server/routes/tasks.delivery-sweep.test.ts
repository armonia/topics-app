/**
 * THE DRAFT AND THE ORIGIN BRANCH CLOSE AT THE DOORS THAT CLOSE THE BRANCH.  @covers LAND-05
 *
 * Split out of `tasks.landing.test.ts` on 17/09, when that file had blown
 * through `check:bloat` at 1,076 lines. The remote half of the reap shares
 * nothing with the landing verdict except the door it starts from.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { projectIdForPath } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

/**
 * THE OTHER HALF OF THE REAP, the remote one. `reapAfterLand` has always deleted
 * the worktree and the local branch; nothing ever closed the draft pull request
 * the delivery opens, nor deleted the branch it pushes. Measured on 17/09: 41
 * `topics/*` branches on origin, 39 of them already inside `main`, none deleted,
 * and 121 entries into review in 7 days now each opening a draft.
 */
describe("the draft and the origin branch are closed at the doors that end the branch", () => {
  let db: Database;
  const REPO = "/repo";
  const PID = projectIdForPath(REPO);
  let swept: Array<{ cwd: string; branch: string; reason: string; closePr: boolean }>;

  const routerWith = (extra: Record<string, unknown> = {}) => {
    const broadcasts: unknown[] = [];
    return createTasksRouter(makeCtx(db, broadcasts), undefined, {
      listProjectDirs: () => [REPO],
      closeDelivery: async (i) => { swept.push(i); return { pr: { number: 78, url: "u" }, branchDeleted: true, problems: [] }; },
      ...extra,
    });
  };

  const comments = (id: string): string[] =>
    (db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(id) as Array<{ content: string }>)
      .map((r) => r.content);

  beforeEach(() => { db = freshDb(); swept = []; });

  async function delivered(router: ReturnType<typeof createTasksRouter>): Promise<string> {
    const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET status = 'review', delivery_branch = 'topics/scartato', delivery_commit = 'abc12345' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, 'claude', 'consegna', 'comment', ?)")
      .run(`c-${t.id}`, t.id, new Date().toISOString());
    return t.id;
  }

  /** One attempt row, i.e. one more branch this card pushed and one more draft it opened. */
  function attempt(taskId: string, idx: number, branch: string, state = "delivered"): void {
    db.prepare(
      "INSERT INTO task_attempts (id, task_id, idx, branch, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`att-${taskId}-${idx}`, taskId, idx, branch, state, new Date().toISOString());
  }

  // The card is off the board when the sweep runs, so `delivery_branch` is read
  // before the archive - and the attempt rows, which the archive does not touch,
  // bring the OTHER branches the card pushed.
  test("archiviare una card chiude le bozze e cancella su origin OGNI ramo che ha consegnato", async () => {
    const router = routerWith();
    const id = await delivered(router);
    attempt(id, 1, "topics/flowing-dragon");
    await call(router, "DELETE", `/api/boards/${PID}/tasks/${id}`, undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect([...swept.map((s) => s.branch)].sort()).toEqual(["topics/flowing-dragon", "topics/scartato"]);
    expect(swept.every((s) => s.cwd === REPO && s.closePr)).toBe(true);
    expect(swept[0]!.reason).toContain("archived");
  });

  test("un'approvazione `superseded` pure: e' il gesto che dice «questo ramo non atterrera'»", async () => {
    const router = routerWith();
    const id = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${id}/review`, { decision: "approve", force: true, superseded: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ branch: "topics/scartato", closePr: true });
  });

  test("un'approvazione normale e un rifiuto NON toccano niente", async () => {
    const router = routerWith();
    const first = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${first}/review`, { decision: "approve", force: true });
    const second = await delivered(router);
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(second);
    await call(router, "POST", `/api/boards/${PID}/tasks/${second}/review`, { decision: "reject", comment: "rifai" });
    await new Promise((r) => setTimeout(r, 20));
    // An approval leaves real work on that branch, and a rejection sends the
    // agent back to the SAME branch to deliver again. Deleting it, in either
    // case, throws away work the card is still carrying.
    expect(swept).toEqual([]);
  });

  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: REPO,
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };
  const autoMerge = { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any;

  test("il land spazza solo quando main ha CONFERMATO la fusione", async () => {
    const unproven = routerWith({ autoMerge });
    const a = await delivered(unproven);
    await call(unproven, "POST", `/api/boards/${PID}/tasks/${a}/land`, {});
    await new Promise((r) => setTimeout(r, 30));
    // With no proof on main the merge merely exited zero: the branch stays on
    // origin, because that is the case where the card asks a person to go and
    // look.
    expect(swept).toEqual([]);

    const proven = routerWith({ autoMerge, confirmLandedOnMain: async () => true });
    const b = await delivered(proven);
    await call(proven, "POST", `/api/boards/${PID}/tasks/${b}/land`, {});
    await new Promise((r) => setTimeout(r, 30));
    // The MERGED branch, not the one the card remembers: it is the one the land
    // actually carried onto main.
    expect(swept.map((s) => s.branch)).toContain("topics/wooly-saunter");
    expect(swept.every((s) => s.cwd === REPO)).toBe(true);
  });

  /**
   * THE REGRESSION AGAINST THE BRIEF. `confirmLandedOnMain` re-reads the LOCAL
   * main and nothing in this server pushes main, so the sweep runs while
   * `origin/main` still lacks the merge and a person pushes it seconds later.
   * GitHub then marks that pull request MERGED on its own - measured on #78,
   * 17/09/2026, a minute after the land. Closing it here would stamp "Closed"
   * instead, on the ~32 cards that land in a week.
   */
  test("il ramo ATTERRATO perde il ramo su origin ma non la sua bozza: quella GitHub la marca MERGED da sola", async () => {
    const router = routerWith({ autoMerge, confirmLandedOnMain: async () => true });
    const id = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${id}/land`, {});
    await new Promise((r) => setTimeout(r, 30));
    const landed = swept.find((s) => s.branch === "topics/wooly-saunter");
    expect(landed).toBeDefined();
    expect(landed!.closePr).toBe(false);
  });

  /**
   * T4.2's real hole. Every delivery through the checks gate pushes the branch of
   * ITS OWN worktree and opens its own draft; the card remembers only the last.
   * On the live DB 151 cards carry two or more distinct attempt branches and 83
   * branches belong to a `delivered` attempt that is not the card's
   * `delivery_branch` - each one a branch and a draft left on origin forever by a
   * sweep that only knows about one.
   */
  test("una card che ha consegnato su PIU' rami li spazza tutti, e chiude la bozza di quelli che non sono atterrati", async () => {
    const router = routerWith({ autoMerge, confirmLandedOnMain: async () => true });
    const id = await delivered(router);
    attempt(id, 1, "topics/flowing-dragon");
    attempt(id, 2, "topics/wooly-saunter", "selected");
    await call(router, "POST", `/api/boards/${PID}/tasks/${id}/land`, {});
    await new Promise((r) => setTimeout(r, 30));
    expect([...swept.map((s) => s.branch)].sort())
      .toEqual(["topics/flowing-dragon", "topics/scartato", "topics/wooly-saunter"]);
    // Only the branch the merge actually carried keeps its pull request; the
    // others will never land, so this is the only moment anything closes them.
    expect(swept.filter((s) => s.closePr).map((s) => s.branch).sort())
      .toEqual(["topics/flowing-dragon", "topics/scartato"]);
    // One branch, one sweep: the same branch under two names must not be pushed
    // to `gh` twice.
    expect(new Set(swept.map((s) => s.branch)).size).toBe(swept.length);
  });

  /**
   * THE RECEIPT SAYS ONLY WHAT HAPPENED. `gh` logged out is the path this code is
   * built to survive - it must not turn a land into a failure - and with both
   * halves false the card would otherwise read «Pulizia su GitHub: .».
   */
  test("con `gh` che non fa niente la card NON riceve una ricevuta vuota", async () => {
    const router = routerWith({
      closeDelivery: async (i: (typeof swept)[number]) => {
        swept.push(i);
        return { pr: null, branchDeleted: false, problems: ["gh: not logged in"] };
      },
    });
    const id = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${id}/review`, { decision: "approve", force: true, superseded: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(swept).toHaveLength(1);
    expect(comments(id).filter((c) => c.includes("Pulizia su GitHub"))).toEqual([]);
  });

  /**
   * THE SWEEP IS HOUSEKEEPING, THE QUEUE IS THE PRODUCT. `landTask` runs inside
   * `landings.enqueue`, one land at a time per project, and the sweep is `gh pr
   * list` + `git push --delete` per branch with a 60 s cap each. The worst card
   * on the live DB carries 11 branches, so an AWAITED sweep with `gh` logged out
   * or rate-limited held the whole queue for ~22 minutes instead of ~3 - and 124
   * archived cards carry attempt branches that never delivered, i.e. calls that
   * buy nothing. Here `gh` never answers at all: the second land must still go.
   */
  test("un `gh` che non risponde non tiene ferma la coda seriale dei land", async () => {
    let release = () => {};
    const stuck = new Promise<void>((r) => { release = r; });
    const merged: string[] = [];
    const router = routerWith({
      autoMerge: {
        tryMerge: async (taskId: string) => { merged.push(taskId); return MERGED; },
        buildClient: async () => ({ code: 0, stderr: "" }),
      },
      confirmLandedOnMain: async () => true,
      closeDelivery: async (i: (typeof swept)[number]) => {
        swept.push(i);
        await stuck;
        return { pr: null, branchDeleted: true, problems: [] };
      },
    });
    const first = await delivered(router);
    const second = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${first}/land`, {});
    await call(router, "POST", `/api/boards/${PID}/tasks/${second}/land`, {});
    await new Promise((r) => setTimeout(r, 80));
    // The first card's sweep is still hanging on `gh`...
    expect(swept.length).toBeGreaterThan(0);
    // ...and the card behind it in the queue landed anyway.
    expect(merged).toContain(second);
    release();
    await new Promise((r) => setTimeout(r, 20));
  });

  test("quando invece qualcosa succede, la ricevuta lo dice e nomina il ramo", async () => {
    const router = routerWith();
    const id = await delivered(router);
    await call(router, "POST", `/api/boards/${PID}/tasks/${id}/review`, { decision: "approve", force: true, superseded: true });
    await new Promise((r) => setTimeout(r, 20));
    const receipt = comments(id).find((c) => c.includes("Pulizia su GitHub"));
    expect(receipt).toContain("#78");
    expect(receipt).toContain("topics/scartato");
  });
});
