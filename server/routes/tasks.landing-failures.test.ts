/**
 * A LAND THAT FAILS DOES NOT CLOSE THE CARD.  @covers LAND-05
 *
 * One subject: every way `tryMerge` can say no — conflict, commits it cannot
 * isolate, a dirty host checkout, an unresolvable repo, nothing to land — and
 * where the card ends up in each case. The distinction that matters is between
 * a failure the agent can repair (back to in_progress, with the instruction)
 * and one that belongs to the host (stays in review, and nobody bounces work
 * back to an agent that did not cause it).
 *
 * Split out of `tasks.landing.test.ts` on 17/09, when that file had blown
 * through `check:bloat` at 1,076 lines; the harness is still
 * `tasks-test-support.ts`.
 */
import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("un land fallito dice perche', e non lascia la card in done", () => {
  /** A card in review with a real delivery: the state «Landa su main» is clicked from. */
  async function reviewTask(db: Database, router: ReturnType<typeof createTasksRouter>): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  test("un land in CONFLITTO ritira la card da done dicendo perché, e firma la macchina", async () => {
    // The history line read «user → In corso» (allow-italian: the status line is
    // verbatim board text), identical to the one a human writes when pulling a
    // delivery back by hand — except here the human had clicked «Landa su main»
    // and it is the merge that pulled it back. The reviewer saw a reversal with
    // no cause and the wrong author on it.
    const db = freshDb(); const broadcasts: unknown[] = []; const resumed: Array<[string, string]> = [];
    const autoMerge = {
      tryMerge: async () => ({ status: "conflict" }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    const router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge });

    const id = await reviewTask(db, router);
    await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {});
    await new Promise((r) => setTimeout(r, 10)); // the land runs fire-and-forget

    const svc = createTaskService(db);
    const t = svc.get(id)!;
    expect(t.task.status).toBe("in_progress");     // never closed: sent back to reconcile
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");              // not «user»: no human moved it
    // `from: "review"` and no longer `from: "done"`: the land does not approve
    // before landing, so the card never touches `done` at all.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "review", to: "in_progress", reason: "il land ha fatto conflitto con main",
    });
    // And the agent restarts with the instruction, as before.
    expect(resumed.length).toBe(1);
    expect(resumed[0]![1]).toContain("conflitto");
    // The instruction names the RIGHT move: rebase your own branch. It used to
    // offer a merge as an alternative, and the merge did not clear the conflict
    // — three cards stayed stuck there until it was explained by hand.
    expect(resumed[0]![1]).toContain("git rebase main");
    expect(resumed[0]![1]).not.toContain("git merge main");
  });

  /**
   * The 11/08 failure (card `2e6964cb`): the land did NOT work and the thread
   * said so honestly, while the STATUS said the opposite. The thread line was
   * «Land NON riuscito … Il branch del task NON è su main» (allow-italian: it is
   * the note verbatim). On the board the card sat in Done like every other,
   * which is the one column nobody reopens, with the code outside main and a
   * worktree GC free to prune that branch.
   */
  async function landSkipping(code: string | undefined): Promise<{ id: string; db: Database; resumed: Array<[string, string]> }> {
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const autoMerge = {
      tryMerge: async () => ({ status: "skipped", reason: "non so quali commit siano suoi", code }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, { autoMerge });
    d.run("INSERT INTO topics (id) VALUES ('top-s')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-s', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cs', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20)); // the land runs fire-and-forget
    return { id: t.id, db: d, resumed: r };
  }

  test("un land che NON isola i commit ritira la card da done, con la ragione nello STATO", async () => {
    const { id, db: d, resumed: r } = await landSkipping("unisolable");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("in_progress");          // does NOT stay in Done
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");                   // the machine pulled it back, not the human
    // The reason lives in the history line, not only in the thread: the thread
    // is read by opening the card, the status is visible from the board.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "review", to: "in_progress", reason: "il land non ha saputo isolare i commit della card",
    });
    // And the agent restarts with the move that repairs the branch.
    expect(r.length).toBe(1);
    expect(r[0]![1]).toContain("git rebase main");
  });

  test("un land fallito per colpa dell'OSPITE torna in review (l'agente non può ripararlo)", async () => {
    const { id, db: d, resumed: r } = await landSkipping("dirty-checkout");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  /**
   * The third face of the same defect, measured 12/08 on `ee5ebbb4`: the card
   * DECLARED a branch (`delivery_branch`, and it existed) but the land could
   * not resolve where to land it. As long as that case answered `no-branch`,
   * the card stayed closed with the code outside main; now it has a code of its
   * own, and that code pulls the card back.
   */
  test("ramo dichiarato ma checkout introvabile: la card NON resta in done", async () => {
    const { id, db: d, resumed: r } = await landSkipping("repo-unresolved");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  test("«non c'era niente da atterrare» NON chiude la card: lo dice e la lascia in review", async () => {
    // The control on the two tests above: no bounce back to the agent, because
    // there is nothing to repair. But no closure either: a land that carried
    // nothing anywhere is not proof the work is on main, and only a confirmed
    // merge takes a card out of review. If the work is already over there by
    // somebody else's hand, the human who approves is the one who says so.
    const { id, db: d } = await landSkipping("no-branch");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("review");
    expect(t.comments.some((c) => c.content.includes("Niente da atterrare"))).toBe(true);
  });
});
