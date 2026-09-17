/**
 * UN LAND RIUSCITO CHIUDE LA CARD, E FERMA CHI CI STAVA ANCORA LAVORANDO.  @covers LAND-05
 *
 * L'ALTRO verso del difetto dell'11/08 (card `4ec47331`): il land e' RIUSCITO — il
 * thread scrive «Mergiato su main» e il contenuto e' dentro — e la card e' rimasta
 * `in_progress` col chip `working` e un agente sopra, che ha speso un turno intero
 * a rifare lavoro gia' atterrato. Due land di fila hanno pagato $5,64 e $8,24 per
 * quel turno.
 *
 * Qui sta un argomento solo: cosa fa il land QUANDO riesce — chiude, spegne il
 * chip, taglia il turno in volo, e non scrive righe di storico che non servono.
 * Spezzato da `tasks.landing.test.ts` il 17/09, quando quel file aveva sfondato
 * `check:bloat` a 1.076 righe.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("un land riuscito: cosa chiude e chi ferma", () => {
  /** Un merge andato a buon fine, nella forma che `tryMerge` restituisce. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };

  /**
   * L'ALTRO verso, misurato l'11/08 su `4ec47331`: il land è RIUSCITO — il
   * thread scrive «Mergiato su main (commit a5f83e0e)» e il contenuto è dentro
   * — e la card è rimasta `in_progress` con il chip `working` e un agente
   * sopra, che ha speso un turno intero a rifare lavoro già atterrato. Il land
   * promuoveva a `done` solo passando da `review`; da ogni altro stato
   * mergiava e lasciava la card dov'era.
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
    // Lo stato in cui è finita la card vera: in corso, agente al lavoro.
    d.prepare("UPDATE tasks SET assigned_topic_id='top-l', status='in_progress', dispatch_state='working' WHERE id = ?").run(t.id);

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((res) => setTimeout(res, 20));

    const svc = createTaskService(d);
    const after = svc.get(t.id)!;
    expect(after.task.status).toBe("done");
    // «Nessun agente dispacciato»: il chip spento è ciò che toglie la card dalla
    // presa del dispatcher — è il gesto che l'umano ha dovuto fare a mano.
    expect(after.task.dispatchState).toBe(null);
    expect(r).toEqual([]);
    // E la riga di storico dice PERCHÉ si è chiusa, non solo che si è chiusa.
    const ev = after.comments.filter((c) => c.kind === "status").at(-1)!;
    expect(parseStatusEvent(ev.content)?.to).toBe("done");
    expect(parseStatusEvent(ev.content)?.reason).toContain("the code is on main");
  });

  /**
   * Dove vanno i soldi. Chiudere la card la toglie dalla coda, ma NON taglia il
   * turno già partito: l'11/08 due land di fila hanno pagato $5,64 (`4ec47331`)
   * e $8,24 (`56677242`, fermata entro un minuto) a un agente che rifaceva
   * lavoro già su main. Il turno si taglia, e si taglia DOPO aver chiuso la
   * card — `onTurnEnd` su una card ancora `in_progress` riprenderebbe l'agente.
   */
  test("un land riuscito FERMA l'agente che sta ancora lavorando su quella card", async () => {
    const aborted: string[] = [];
    let statusAtStop: string | undefined;
    let taskId = "";
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      // Si registra ANCHE lo stato della card nell'istante dello stop: l'ordine
      // non è un dettaglio di stile. `onTurnEnd` su una card ancora
      // `in_progress` riprende l'agente, quindi tagliare prima di chiuderla lo
      // farebbe ripartire — cioè ripagherebbe il turno che si stava evitando.
      abortTurn: async (key: string) => {
        aborted.push(key);
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

    // La chiave della sessione è `topic:<primi 8>` — la stessa che usa «Ferma».
    expect(aborted).toEqual(["topic:485cb19a"]);
    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("done");
    // E il thread dice che qualcuno è stato fermato, altrimenti l'agente
    // sparisce a metà frase senza spiegazione.
    expect(after.comments.some((c) => c.content.includes("Fermato l'agente"))).toBe(true);
    // L'ordine: quando lo stop parte, la card è GIÀ chiusa.
    expect(statusAtStop).toBe("done");
  });
  test("nessun agente vivo → il land non chiama nessuno stop", async () => {
    // Il controllo del test qui sopra: il percorso normale (card già consegnata
    // e ferma) non deve mandare un abort a una sessione che non lavora.
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
    // Il controllo del test qui sopra: il percorso normale (review → «Landa su
    // main» → done → merge) non deve guadagnare una transizione done→done.
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
