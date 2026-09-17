/**
 * A REALIGN BEFORE THE LAND IS DECLARED.  @covers LAND-03, LAND-05
 *
 * A land that finds the branch behind pulls main back into it, and what lands
 * is a commit nobody measured: the checks — the local commands and the two CI
 * rows — ran on the DELIVERED commit, hours earlier (1.93 h in review on
 * average, 32 lands over 7 days). 22 of those 32 carried the realign line and
 * only 4 also warned that the land differed from the delivery: 18 said nothing,
 * while `checks_commit` kept naming a commit that is not the one that landed.
 *
 * One subject: what reaches the thread when the land realigns, and what happens
 * when the realign is itself the thing that conflicts — two different
 * conflicts, two different jobs. Split out of `tasks.landing.test.ts` on 17/09,
 * when that file had blown through `check:bloat` at 1,076 lines.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("il riallineamento prima del land finisce nel thread", () => {
  /** A merge that worked, in the shape `tryMerge` hands back. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };

  test("il ramo riallineato dal land finisce nel thread, PRIMA del «Mergiato»", async () => {
    // A merge commit no human made shows up on the branch: if the thread does
    // not say so, whoever reads that branch's history later cannot tell where
    // it came from.
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: {
        tryMerge: async () => ({ ...MERGED, realigned: "il ramo era indietro di 2 commit su 'main': ci ho riportato main dentro" }),
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const comments = createTaskService(d).get(t.id)!.comments.map((c) => c.content);
    const realignedAt = comments.findIndex((c) => c.includes("Riallineato prima del land"));
    const mergedAt = comments.findIndex((c) => c.includes("Mergiato su main"));
    expect(realignedAt).toBeGreaterThanOrEqual(0);
    expect(realignedAt).toBeLessThan(mergedAt);
    expect(comments[realignedAt]).toContain("indietro di 2 commit");
  });

  /**
   * The note has to name the commit the checks actually ran on, and the verdict
   * has to stop claiming it describes what landed. Those are the 18 silent
   * lands of the header, turned into one assertion.
   */
  test("un land che riallinea dice che cosa i check hanno misurato, e azzera checks_commit", async () => {
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: {
        tryMerge: async () => ({ ...MERGED, realigned: "il ramo era indietro di 2 commit su 'main': ci ho riportato main dentro" }),
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    createTaskService(d).recordChecks({
      taskId: t.id, state: "pass", commit: "abc1234def",
      runs: [{ name: "unit-ci", cmd: "gh", ok: true, code: 0, ms: 10, timedOut: false, tail: "" }],
    });
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const after = createTaskService(d).get(t.id)!;
    const note = after.comments.map((c) => c.content).find((c) => c.includes("Riallineato prima del land"))!;
    expect(note).toContain("abc1234d");
    expect(note).toContain("non la fusione che sta atterrando");
    // The verdict itself stays: it was really measured, on the commit the note
    // now names. Only the claim that it describes what landed goes.
    expect(after.task.checksCommit).toBeNull();
    expect(after.task.checksState).toBe("pass");
    expect(after.task.checks).toHaveLength(1);
  });

  test("senza riallineamento la nota non c'e' e il commit dei check resta", async () => {
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    createTaskService(d).recordChecks({ taskId: t.id, state: "pass", commit: "abc1234def", runs: [] });
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.comments.some((c) => c.content.includes("Riallineato prima del land"))).toBe(false);
    expect(after.task.checksCommit).toBe("abc1234def");
  });

  test("conflitto nel RIALLINEAMENTO: nomina i file e chiede una fusione, non una rebase", async () => {
    // Two different conflicts, two different jobs. Telling «rebase onto the
    // updated main» to someone who just watched that merge fail sends them to
    // redo by hand the attempt the machine already made — without telling them
    // on which files.
    const d = freshDb(); const b: any[] = []; const r: Array<[string, string]> = [];
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { r.push([id, msg]); },
    } as any;
    const rt = createTasksRouter(makeCtx(d, b), dispatcher, {
      autoMerge: {
        tryMerge: async () => ({
          status: "conflict", branch: "topics/ramo-vecchio",
          realignConflict: { behind: 3, files: ["server/db.ts", "client/src/App.tsx"] },
        }),
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as any,
    });
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET status='review' WHERE id = ?").run(t.id);
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("in_progress");
    // The thread names the files, and says that NOTHING was landed.
    const thread = after.comments.map((c) => c.content).join("\n");
    expect(thread).toContain("server/db.ts");
    expect(thread).toContain("client/src/App.tsx");
    expect(thread).toContain("Non ho landato niente");
    // The history line tells the two causes apart.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.reason).toContain("riportare main nel ramo");
    // And the instruction to the agent says `git merge main`, not rebase.
    expect(r).toHaveLength(1);
    expect(r[0][1]).toContain("git merge main");
    expect(r[0][1]).toContain("server/db.ts");
    expect(r[0][1]).not.toContain("git rebase main");
  });
});
