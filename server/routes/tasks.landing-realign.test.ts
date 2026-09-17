/**
 * IL RIALLINEAMENTO PRIMA DEL LAND SI DICHIARA.  @covers LAND-03, LAND-05
 *
 * Il land che trova il ramo indietro ci riporta main dentro, e quel che atterra
 * e' un commit che nessuno ha misurato: i check — i comandi locali e le due righe
 * di CI — hanno girato sul commit CONSEGNATO, ore prima (1,93 h di media in
 * review, 32 land in 7 giorni). 22 di quei 32 portavano la riga del
 * riallineamento e solo 4 avvisavano anche che il land differiva dalla consegna:
 * 18 non dicevano niente, mentre `checks_commit` continuava a nominare un commit
 * che non e' quello atterrato.
 *
 * Un argomento solo: cosa finisce nel thread quando il land riallinea, e cosa
 * succede quando e' il riallineamento stesso a fare conflitto — due conflitti
 * diversi, due lavori diversi. Spezzato da `tasks.landing.test.ts` il 17/09,
 * quando quel file aveva sfondato `check:bloat` a 1.076 righe.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("il riallineamento prima del land finisce nel thread", () => {
  /** Un merge andato a buon fine, nella forma che `tryMerge` restituisce. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };

  test("il ramo riallineato dal land finisce nel thread, PRIMA del «Mergiato»", async () => {
    // Sul ramo compare un commit di fusione che nessun umano ha fatto: se il
    // thread non lo dice, chi rilegge la storia del ramo non sa da dove venga.
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
   * The realign makes what LANDS a commit nobody measured: the checks - the
   * local commands and the two CI rows - ran on the delivered commit, hours
   * earlier (1,93 h in review on average, 32 lands in 7 days). 22 of those 32
   * lands carried the realign line and only 4 also warned that the land differed
   * from the delivery: 18 said nothing at all, while `checks_commit` kept naming
   * a commit that is not the one that landed.
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
    // Due conflitti diversi, due lavori diversi. Dire «rifai la base sul main
    // aggiornato» a chi ha appena visto fallire quel merge lo manda a rifare a
    // mano il tentativo che la macchina ha già fatto — senza dirgli su cosa.
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
    // Il thread dice quali file, e che NON è stato landato niente.
    const thread = after.comments.map((c) => c.content).join("\n");
    expect(thread).toContain("server/db.ts");
    expect(thread).toContain("client/src/App.tsx");
    expect(thread).toContain("Non ho landato niente");
    // La riga di storico distingue le due cause.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.reason).toContain("riportare main nel ramo");
    // E l'istruzione all'agente parla di `git merge main`, non di rebase.
    expect(r).toHaveLength(1);
    expect(r[0][1]).toContain("git merge main");
    expect(r[0][1]).toContain("server/db.ts");
    expect(r[0][1]).not.toContain("git rebase main");
  });
});
