/**
 * A SUCCESSFUL LAND CLOSES THE CARD, AND STOPS WHOEVER IS STILL WORKING ON IT.  @covers LAND-05
 *
 * THE OTHER face of the 11/08 defect (card `4ec47331`): the land SUCCEEDED —
 * the thread writes «Mergiato su main», the content is in — and the card stayed
 * `in_progress` with the `working` chip and an agent on top of it, burning a
 * whole turn redoing work that had already landed. Two lands in a row paid
 * $5.64 and $8.24 for that turn.
 *
 * One subject here: what the land does WHEN it succeeds — closes the card,
 * clears the chip, cuts the turn in flight, and writes no history lines nobody
 * needs. Split out of `tasks.landing.test.ts` on 17/09, when that file had
 * blown through `check:bloat` at 1,076 lines.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("un land riuscito: cosa chiude e chi ferma", () => {
  /** A merge that worked, in the shape `tryMerge` hands back. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };

  /**
   * The mechanism behind `4ec47331`: the land promoted to `done` only on the
   * way out of `review`. From any other state it merged and left the card where
   * it was, chip and agent included.
   */
  test("un land RIUSCITO da in_progress chiude la card: done, nessun agente dispacciato", async () => {
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    d.run("INSERT INTO topics (id) VALUES ('top-l')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    // The state the real card was in: in progress, agent at work.
    d.prepare("UPDATE tasks SET assigned_topic_id='top-l', status='in_progress', dispatch_state='working' WHERE id = ?").run(t.id);

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const svc = createTaskService(d);
    const after = svc.get(t.id)!;
    expect(after.task.status).toBe("done");
    // «No agent dispatched»: clearing the chip is what takes the card out of
    // the dispatcher's grip — the move the human had to make by hand.
    expect(after.task.dispatchState).toBe(null);
    expect(r).toEqual([]);
    // And the history line says WHY it closed, not just that it closed.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.to).toBe("done");
    expect(parseStatusEvent(ev.content)?.reason).toContain("the code is on main");
  });

  /**
   * Where the money goes. Closing the card takes it out of the queue, but it
   * does NOT cut a turn that already started: on 11/08 two lands in a row paid
   * $5.64 (`4ec47331`) and $8.24 (`56677242`, stopped within a minute) to an
   * agent redoing work already on main. The turn gets cut, and it gets cut
   * AFTER the card is closed — `onTurnEnd` on a card still `in_progress` would
   * resume the agent.
   */
  test("un land riuscito FERMA l'agente che sta ancora lavorando su quella card", async () => {
    const aborted: string[] = [];
    const causes: string[] = [];
    let statusAtStop: string | undefined;
    let taskId = "";
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      // The card's status at the instant of the stop is recorded TOO: the order
      // is not a style detail. `onTurnEnd` on a card still `in_progress`
      // resumes the agent, so cutting before closing would restart it — paying
      // again for the very turn being avoided.
      abortTurn: async (key: string, cause: string) => {
        aborted.push(key);
        causes.push(cause);
        statusAtStop = (d.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as any)?.status;
      },
    });
    d.run("INSERT INTO topics (id) VALUES ('485cb19a-993f-4e36-9823-687ee4235aae')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    taskId = t.id;
    d.prepare(
      "UPDATE tasks SET assigned_topic_id='485cb19a-993f-4e36-9823-687ee4235aae', status='in_progress', dispatch_state='working' WHERE id = ?",
    ).run(t.id);

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    // The session key is `topic:<first 8>` — the same one the Stop button uses.
    expect(aborted).toEqual(["topic:485cb19a"]);
    // The machine closed the card, nobody pressed Stop: never `user` (card C9).
    expect(causes).toEqual(["superseded"]);
    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("done");
    // And the thread says somebody was stopped, otherwise the agent vanishes
    // mid-sentence with no explanation.
    expect(after.comments.some((c) => c.content.includes("Fermato l'agente"))).toBe(true);
    // The order: by the time the stop fires, the card is ALREADY closed.
    expect(statusAtStop).toBe("done");
  });
  test("nessun agente vivo → il land non chiama nessuno stop", async () => {
    // The control on the test above: the normal path (card already delivered
    // and idle) must not send an abort to a session that is not working.
    const aborted: string[] = [];
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      abortTurn: async (key: string) => { aborted.push(key); },
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='done' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));
    expect(aborted).toEqual([]);
  });

  test("un land riuscito su una card GIÀ chiusa non aggiunge righe di storico", async () => {
    // The control on the test above: the normal path (review → «Landa su main»
    // → done → merge) must not gain a done→done transition.
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    d.run("INSERT INTO topics (id) VALUES ('top-d')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-d', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cd', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));
    const svc = createTaskService(d);
    const events = svc.get(t.id)!.comments.filter((c) => c.kind === "status");
    expect(events.map((e) => parseStatusEvent(e.content)?.to)).toEqual(["done"]);
  });
});
