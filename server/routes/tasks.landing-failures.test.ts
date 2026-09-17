/**
 * UN LAND CHE NON RIESCE NON CHIUDE LA CARD.  @covers LAND-05
 *
 * Un argomento solo: ogni modo in cui `tryMerge` dice di no — conflitto, commit
 * non isolabili, checkout dell'ospite sporco, repo irrisolvibile, niente da
 * atterrare — e dove finisce la card per ognuno. La differenza che conta e' fra
 * un guasto che l'agente puo' riparare (torna in corso, con l'istruzione) e uno
 * che e' dell'ospite (resta in review, e nessuno rimbalza all'agente un lavoro
 * che non e' suo).
 *
 * Spezzato da `tasks.landing.test.ts` il 17/09, quando quel file aveva sfondato
 * `check:bloat` a 1.076 righe: il banco di prova resta `tasks-test-support.ts`.
 */
import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("un land fallito dice perche', e non lascia la card in done", () => {
  /** Una card in review con una consegna vera: lo stato da cui si clicca «Landa su main». */
  async function reviewTask(db: Database, router: ReturnType<typeof createTasksRouter>): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  test("un land in CONFLITTO ritira la card da done dicendo perché, e firma la macchina", async () => {
    // La riga di storico diceva «user → In corso»: identica a quella che scrive
    // un umano quando ritira una consegna a mano — mentre qui l'umano aveva
    // cliccato «Landa su main» e il ritiro è del merge. Chi rivede leggeva un
    // dietrofront senza causa e senza il suo autore vero.
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
    await new Promise((r) => setTimeout(r, 10)); // il land gira fire-and-forget

    const svc = createTaskService(db);
    const t = svc.get(id)!;
    expect(t.task.status).toBe("in_progress");     // mai chiusa: mandata a riconciliare
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");              // non «user»: non l'ha mossa l'umano
    // `from: "review"` e non più `from: "done"`: il land non approva prima di
    // atterrare, quindi la card il `done` non lo tocca proprio.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "review", to: "in_progress", reason: "il land ha fatto conflitto con main",
    });
    // E l'agent riparte con l'istruzione, come prima.
    expect(resumed.length).toBe(1);
    expect(resumed[0]![1]).toContain("conflitto");
    // L'istruzione dice il gesto GIUSTO: rifare la base del proprio ramo. Diceva
    // «git merge main, oppure rebase», e il merge non toglieva il conflitto —
    // tre card ci sono rimaste incastrate finché non gliel'ho spiegato a mano.
    expect(resumed[0]![1]).toContain("git rebase main");
    expect(resumed[0]![1]).not.toContain("git merge main");
  });

  /**
   * Il guasto dell'11/08 (card `2e6964cb`): il land NON è riuscito, il thread lo
   * scriveva onestamente — «⚠️ Land NON riuscito … Il branch del task NON è su
   * main» — e lo STATO diceva il contrario. Sulla board la card stava in Done
   * come tutte le altre, cioè nell'unica colonna che nessuno riapre, col codice
   * fuori da main e un GC dei worktree che può potare quel ramo.
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
    await new Promise((res) => setTimeout(res, 20)); // il land gira fire-and-forget
    return { id: t.id, db: d, resumed: r };
  }

  test("un land che NON isola i commit ritira la card da done, con la ragione nello STATO", async () => {
    const { id, db: d, resumed: r } = await landSkipping("unisolable");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("in_progress");          // NON resta in Done
    const ev = t.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(ev.author).toBe("system");                   // l'ha ritirata la macchina, non l'umano
    // La ragione sta nella riga di storico, non solo nel thread: il thread lo si
    // legge aprendo la card, lo stato si vede dalla board.
    expect(parseStatusEvent(ev.content)).toEqual({
      from: "review", to: "in_progress", reason: "il land non ha saputo isolare i commit della card",
    });
    // E l'agente riparte con il gesto che ripara il ramo.
    expect(r.length).toBe(1);
    expect(r[0]![1]).toContain("git rebase main");
  });

  test("un land fallito per colpa dell'OSPITE torna in review (l'agente non può ripararlo)", async () => {
    const { id, db: d, resumed: r } = await landSkipping("dirty-checkout");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  /**
   * Il terzo verso dello stesso difetto, misurato il 12/08 su `ee5ebbb4`: la
   * card DICHIARAVA un ramo (`delivery_branch`, esistente) ma il land non
   * riusciva a risolvere dove atterrarlo. Finché quel caso rispondeva
   * `no-branch` la card restava chiusa col codice fuori da main; adesso ha un
   * codice suo, e il codice suo la ritira.
   */
  test("ramo dichiarato ma checkout introvabile: la card NON resta in done", async () => {
    const { id, db: d, resumed: r } = await landSkipping("repo-unresolved");
    expect(createTaskService(d).get(id)!.task.status).toBe("review");
    expect(r).toEqual([]);
  });

  test("«non c'era niente da atterrare» NON chiude la card: lo dice e la lascia in review", async () => {
    // Il controllo dei due test qui sopra: nessun rimbalzo all'agente, perché
    // non c'è niente da riparare. Ma nemmeno una chiusura: un land che non ha
    // portato niente da nessuna parte non è una prova che il lavoro sia su
    // main, e solo un merge confermato toglie una card da review. Se il lavoro è
    // già di là per mano di qualcun altro, a dirlo è l'umano che approva.
    const { id, db: d } = await landSkipping("no-branch");
    const t = createTaskService(d).get(id)!;
    expect(t.task.status).toBe("review");
    expect(t.comments.some((c) => c.content.includes("Niente da atterrare"))).toBe(true);
  });
});
