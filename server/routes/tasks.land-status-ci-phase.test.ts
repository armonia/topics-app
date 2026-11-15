/**
 * GET …/land AFTER A REFUSED LAND THAT WAS ASKED AGAIN.  @covers LAND-05
 *
 * 14/11: the first land of a card was refused (its worktree was half torn
 * down), the second one entered the CI phase. GET …/land kept handing back the
 * first ticket, settled and refused, so whoever polled it read «refused» twice
 * while the card was in fact waiting for the CI to land it.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("lo stato del land dopo un rifiuto e la fase CI", () => {
  const REFUSED = { status: "skipped", reason: "riallineamento non partito", code: "realign-blocked" };

  async function refusedThenCi(stage: string | null) {
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => REFUSED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));
    // What the CI phase does to the card on the second request.
    d.prepare("UPDATE tasks SET status='review', stage=? WHERE id = ?").run(stage, t.id);
    return (await (await call(rt, "GET", `/api/boards/pX/tasks/${t.id}/land`))!.json()) as any;
  }

  test("una card in fase CI dice «fase CI», non il rifiuto di prima", async () => {
    const body = await refusedThenCi("ci");
    expect(body.landing.phase).toBe("queued");
    expect(body.landing.reason).toBe("fase CI");
  });

  test("fuori dalla fase CI il ticket chiuso resta la risposta", async () => {
    const body = await refusedThenCi(null);
    expect(body.landing.phase).toBe("settled");
    expect(body.landing.outcome).not.toBe(null);
  });
});
