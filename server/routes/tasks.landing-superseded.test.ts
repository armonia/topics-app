/**
 * A CARD CLOSED ON PURPOSE WITHOUT LANDING CAN SAY SO.  @covers LAND-05
 *
 * Split out of `tasks.landing.test.ts` on 17/09, when that file had blown
 * through `check:bloat` at 1,076 lines: here live the `superseded` gesture and
 * the two doors that must NOT write it.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

/**
 * CLOSED ON PURPOSE WITHOUT LANDING — a debt nobody intends to pay.
 *
 * An `approve` that does not land leaves the card `unlanded` with a real
 * commit, and from outside that is indistinguishable from an oversight: a «not
 * on main» chip on the card and a red counter at the top of the board, forever.
 * Measured 18/08/2026: three cards closed deliberately — two whose branch
 * carried a duplicate of a gate already on main, one where of two fixes for the
 * same failure the other was chosen — all three counted as debt. Noise on a
 * counter makes it unwatchable, and then it stops serving the real debts too.
 *
 * `superseded` is not DERIVED: from the repo, a branch outside main is outside
 * main, discarded or forgotten alike. The reviewer says it, once.
 */
describe("una card chiusa senza landare puo' dirlo", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    const broadcasts: unknown[] = [];
    router = createTasksRouter(makeCtx(db, broadcasts), undefined, {});
  });

  /** A card in review with a real delivery: the case where the chip lights up. */
  async function deliveredCard(): Promise<string> {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET status = 'review', delivery_branch = 'topics/scartato', delivery_commit = 'abc12345' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  const stateLanding = (id: string) =>
    (db.prepare("SELECT landing_state FROM tasks WHERE id = ?").get(id) as { landing_state: string | null }).landing_state;

  test("con `superseded` la card si chiude e lo dichiara", async () => {
    const id = await deliveredCard();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true, superseded: true,
    });
    expect(r?.status).toBe(200);
    expect(stateLanding(id)).toBe("superseded");
  });

  test("senza il gesto NON si inventa niente: resta un debito da guardare", async () => {
    // The case that keeps the one above honest. If `approve` stamped it on its
    // own, every card closed without landing would drop off the counter — the
    // opposite defect, and a far worse one: forgotten work would have nobody
    // left to report it.
    const id = await deliveredCard();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true,
    });
    expect(r?.status).toBe(200);
    expect(stateLanding(id)).not.toBe("superseded");
  });

  test("un rifiuto non lo scrive nemmeno se glielo chiedi", async () => {
    // `superseded` speaks about a CLOSED card. On a rejection the card goes
    // back to work, and a «will never land» stamp on work that is restarting
    // would be a lie shaped like a decision.
    const id = await deliveredCard();
    await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "reject", comment: "rifai", superseded: true,
    });
    expect(stateLanding(id)).not.toBe("superseded");
  });
});
