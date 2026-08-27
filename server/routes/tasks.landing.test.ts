/**
 * APPROVARE E ATTERRARE SONO DUE COSE.  @covers LAND-05
 * L'approvazione e' una decisione umana sulla card; l'atterraggio e' un merge su
 * main che puo' fallire per ragioni che con la decisione non c'entrano — il ramo
 * indietro, un worktree sporco, un conflitto. Tenerle insieme faceva chiudere
 * card il cui codice non era da nessuna parte, ed e' la perdita del 19/07.
 *
 * Separato da `tasks.test.ts` il 18/08: il file aveva sfondato il cancello di
 * dimensione (3.106 righe) e questa era la giuntura piu' netta — 707 righe su
 * una domanda sola. Il banco di prova sta in `tasks-test-support.ts`, condiviso
 * coi test delle altre rotte.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL } from "../services/tasks";
import { parseStatusEvent } from "../../shared/board";
import { t as label } from "../../client/src/lib/i18n";
import { freshDb, makeCtx, call, SESSIONS } from "./tasks-test-support";

describe("approve decoupled from landing", () => {
  let db: Database; let broadcasts: any[];
  let merges: string[]; let resumed: Array<[string, string]>; let router: any;
  let stamped: Array<[string, string]>;
  /** Same router over the same db, with a different landing stamp. */
  let withStamp: (fn: (taskId: string, verdict: string) => Promise<void>) => any;

  beforeEach(() => {
    db = freshDb(); broadcasts = []; merges = []; resumed = []; stamped = [];
    const autoMerge = {
      tryMerge: async (taskId: string) => { merges.push(taskId); return { status: "nothing" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    withStamp = (stampLanding) => createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge, stampLanding });
    router = withStamp(async (taskId, verdict) => { stamped.push([taskId, verdict]); });
  });

  async function reviewTask(): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  /** The land (and the landing verdict behind it) is fire-and-forget: let the
   *  microtasks drain before reading what it left behind. */
  const flushLand = () => new Promise((r) => setTimeout(r, 0));
  const systemNote = (id: string) => createTaskService(db).get(id)!.comments
    .filter((c) => c.author === "system").map((c) => c.content).join("\n");

  /** Turns the board switch on: without it, reaching Done does not merge. */
  const autoMergeOn = () => call(router, "PATCH", "/api/boards/pX/settings", { dispatchAutoMerge: true });

  test("trascinare una card in Done LANDA: `done` deve voler dire atterrato", async () => {
    // Il land era un'azione a parte, e il gesto piu' naturale — trascinare la
    // card in Done — chiudeva il lavoro lasciandolo sul suo ramo, in silenzio.
    // Misurato il 10/08: 17 card chiuse in otto ore col contenuto NON su main.
    const id = await reviewTask();
    await autoMergeOn();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0)); // il land e' fire-and-forget
    expect(merges).toContain(id);
  });

  test("una card SENZA ramo di consegna non tenta nessun land", async () => {
    // Il controllo del test qui sopra: una nota chiusa a mano non deve svegliare
    // git, o ogni gesto sulla board diventerebbe un'operazione sul repo.
    const id = await reviewTask();
    await autoMergeOn();
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await new Promise((r) => setTimeout(r, 0));
    expect(merges).not.toContain(id);
  });

  // ── THE BOARD SWITCH, which nobody read on this path ──────────────────────
  //
  // Every entry into Done of a card carrying a branch queued a merge: not just
  // approval, the drag and the "Sposta in" menu too. The comment next to it
  // claimed the board had already decided via `dispatchAutoMerge`, but the
  // field was never read. Measured on 13/08 against the live board db: of the
  // 137 "Mergiato su main" notes, 8 sit on boards whose switch is off today.

  test("auto-merge OFF: Done does not merge, and the card says why", async () => {
    const id = await reviewTask();   // board pX has no settings row: off by default
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();

    expect(merges).toEqual([]);
    // A MUTE closure with the code still on the branch is the 10/08 fault in
    // its silent form: the note has to name the branch and the way out.
    const note = systemNote(id);
    expect(note).toContain("SENZA fondere");
    expect(note).toContain("topics/x");
    // Both quoted controls are pinned against the words actually printed next
    // to them: a note naming a control the reader cannot find gets ignored, and
    // that is the whole reason this note exists. Rename either label in i18n.ts
    // and this test falls.
    expect(note).toContain(label("board.settings.autoMerge", "it"));
    // `board.action.land` and NOT the retired `board.task.landOnMain`: the
    // branch that gave every action one word moved the button's text into the
    // single action table. Reading the dead key made this assertion pass on
    // nothing, which is how a note could start quoting a control that no longer
    // says that.
    expect(note).toContain(label("board.action.land", "it"));
  });

  test("the skipped-merge note reaches the LIVE card without waiting for git", async () => {
    // The PATCH broadcasts `task:updated` with the task as it was BEFORE the
    // note, and `addComment` bumps `updated_at` precisely so a live client
    // refetches the thread (Card.tsx keys its comment effect on
    // `task.updatedAt`). Without a broadcast of its own the note exists only in
    // the db: a closure as mute on screen as the one this code exists to stop.
    //
    // The stamp here NEVER RESOLVES, which is what makes this test able to
    // fail. The landing verdict shells out to git, so the broadcast that
    // carries the note cannot be the one sitting behind it: a slow repo would
    // hold the note back for as long as git takes. Wire the note's broadcast
    // after the await and this goes red.
    const r = withStamp(() => new Promise<void>(() => { /* git, still thinking */ }));
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    const before = broadcasts.length;
    await call(r, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();

    // Exactly two: the PATCH's own (the task as it was BEFORE the note) and
    // this one. Drop the note's broadcast and it is one — the hung stamp means
    // the deferred broadcast behind it never fires, so nothing else can cover.
    const updates = broadcasts.slice(before).filter((b) => b.type === "task:updated" && b.task?.id === id);
    expect(updates.length).toBe(2);
    // And the second is a FRESH read, not a stale copy of the first: its
    // updatedAt is the one `addComment` just wrote, which is the change signal
    // the card refetches its thread on.
    const got = createTaskService(db).get(id)!;
    expect(updates[1].task.updatedAt).toBe(got.task.updatedAt);
    expect(got.comments.filter((c) => c.author === "system").at(-1)!.createdAt).toBe(got.task.updatedAt);
  });

  test("the way out the note names is REACHABLE: the landing verdict is asked for", async () => {
    // "Landa su main" on a `done` card is drawn by exactly one surface, the
    // "chiuso ma non su main" banner, behind `landingState === 'unlanded'` —
    // and `recordDelivery` blanks that column, so it sits at NULL until the
    // periodic audit runs (LANDING_AUDIT_INTERVAL_MS, 30 min). "ask" is the
    // house verb for "compute the verdict from the repo now": asserting
    // `unlanded` outright would be a guess, since the branch may already be in
    // main by somebody else's hand.
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();
    expect(stamped).toEqual([[id, "ask"]]);
  });

  test("with the switch ON nothing is skipped: no note, no verdict to ask for", async () => {
    // The control for the three above: the note and the stamp belong to the
    // SKIPPED path only. On the merging path `landTask` writes its own outcome.
    const id = await reviewTask();
    await autoMergeOn();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "done" });
    await flushLand();
    expect(merges).toContain(id);
    expect(systemNote(id)).not.toContain("SENZA fondere");
  });

  test("the «Landa su main» button merges with the switch off: it is a human's choice", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {});
    await flushLand();
    expect(merges).toEqual([id]);
  });

  test("…and so does the «Landa su main» quick reply, switch on or off", async () => {
    const id = await reviewTask();
    db.prepare("UPDATE tasks SET delivery_branch = 'topics/x' WHERE id = ?").run(id);
    await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL });
    await flushLand();
    expect(merges).toEqual([id]);
  });

  test("approve accepts the task WITHOUT merging (no azioni da sotto)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "approve" }))!.json();
    expect(t.status).toBe("done");
    expect(merges).toEqual([]); // approve no longer merges
  });

  test("picking the 'Landa su main' option lands, non è un reject, e NON chiude la card in anticipo", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: LAND_ACTION_LABEL }))!.json();
    // `review`, non `done`: la scelta è «landa», e la card la chiude il land
    // quando main lo conferma. Non è nemmeno un rifiuto (nessun resume).
    expect(t.status).toBe("review");
    expect(merges).toEqual([id]);  // e il land parte
    expect(resumed).toEqual([]);   // NOT resumed as a rejection
  });

  test("POST /land merges on demand e lascia la card in review finché non è atterrata", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/land`, {}))!.json();
    expect(t.status).toBe("review");
    expect(merges).toEqual([id]);
  });

  test("un land in CONFLITTO ritira la card da done dicendo perché, e firma la macchina", async () => {
    // La riga di storico diceva «user → In corso»: identica a quella che scrive
    // un umano quando ritira una consegna a mano — mentre qui l'umano aveva
    // cliccato «Landa su main» e il ritiro è del merge. Chi rivede leggeva un
    // dietrofront senza causa e senza il suo autore vero.
    db = freshDb(); broadcasts = []; resumed = [];
    const autoMerge = {
      tryMerge: async () => ({ status: "conflict" }),
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const dispatcher = {
      onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
      resume: async (id: string, msg: string) => { resumed.push([id, msg]); },
    } as any;
    router = createTasksRouter(makeCtx(db, broadcasts), dispatcher, { autoMerge });

    const id = await reviewTask();
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
    let statusAlloStop: string | undefined;
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
        statusAlloStop = (d.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as any)?.status;
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
    expect(statusAlloStop).toBe("done");
  });

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
    const riallineato = comments.findIndex((c) => c.includes("Riallineato prima del land"));
    const mergiato = comments.findIndex((c) => c.includes("Mergiato su main"));
    expect(riallineato).toBeGreaterThanOrEqual(0);
    expect(riallineato).toBeLessThan(mergiato);
    expect(comments[riallineato]).toContain("indietro di 2 commit");
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

  /**
   * Il verdetto di atterraggio si REGISTRA quando il land succede, mentre il
   * ramo esiste ancora: dedurlo dopo, dal solo commit di consegna, sbaglia
   * (provato a mano su 108 card: 20 falsi allarmi con la patch inversa, 5 con
   * la riga distintiva). Il land che ha visto il merge non chiede a nessuno.
   */
  async function landStamping(
    merge: any,
    confirm?: (repoPath: string, commit: string) => Promise<boolean | null>,
  ): Promise<Array<[string, string]>> {
    const stamped: Array<[string, string]> = [];
    const d = freshDb(); const b: any[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => merge, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      stampLanding: async (taskId: string, verdict: string) => { stamped.push([taskId, verdict]); },
      ...(confirm ? { confirmLandedOnMain: confirm } : {}),
    });
    d.run("INSERT INTO topics (id) VALUES ('top-a')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-a', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ca', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 20));
    return stamped.map(([, v]) => [t.id, v] as [string, string]);
  }

  test("merge riuscito E CONFERMATO su main → l'esito si REGISTRA come 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => true) as any;
    expect(v).toBe("landed");
  });

  /**
   * LA BARRA DEL 13/08, secondo sintomo: `landing_state` diceva `landed` su
   * card che su main non c'erano (viste quel giorno: `2d3d6051`, `8f1f1b95`).
   * Il campo non era una misura — copiava il resoconto di `git merge`, che dice
   * che una fusione è riuscita e NON su quale ramo.
   *
   * Qui il merge dice di sì e main dice di no: `landed` non si può scrivere.
   * Rimettendo l'ordine vecchio (verdetto dedotto dallo stato di `tryMerge`)
   * questo test è rosso.
   */
  test("il merge dice sì ma main dice di no: non si scrive MAI 'landed'", async () => {
    const [[, v]] = await landStamping(MERGED, async () => false) as any;
    expect(v).toBe("unlanded");
  });

  /**
   * LA BARRA DEL 13/08, primo sintomo, nella sua forma peggiore: il land CREDE
   * di essere riuscito. `git merge` è uscito zero, il thread scrive «Mergiato su
   * main», la card si chiude — e su main non c'è niente (checkout parcheggiato
   * su un altro ramo, worktree usa-e-getta mai ricucito). Il 13/08 sono andate
   * così `92d61427`, `274d5425` e `95a6794f`: `done` coi rami mai atterrati, e
   * la potatura delle worktree pronta a portarli via.
   *
   * Tre cose insieme, e servono tutte e tre: la card non si chiude, il worktree
   * (unica copia del lavoro) non si pota, e il thread dice perché.
   */
  test("merge non confermato da main: la card NON si chiude e il worktree resta", async () => {
    const d = freshDb(); const b: any[] = []; const reaped: string[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      confirmLandedOnMain: async () => false,
      deleteTaskWorktree: async (taskId: string) => { reaped.push(taskId); return true; },
      taskBranchStatus: async () => "unmerged" as const,
      taskWorktreeDirt: async () => [],
    });
    d.run("INSERT INTO topics (id) VALUES ('top-nc')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-nc', status='review' WHERE id = ?").run(t.id);

    const res = await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    expect(res!.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));

    const after = createTaskService(d).get(t.id)!;
    expect(after.task.status).toBe("review");     // NON done: il land non è avvenuto
    expect(reaped).toEqual([]);                   // e il ramo resta: è l'unica copia
    expect(after.comments.some((c) => c.content.includes("Land NON confermato"))).toBe(true);
  });

  /**
   * PORTA DEL CONTRATTO — la sonda restituisce `ok:false` (git non ha risposto).
   *
   * Prima del fix, `reapAfterLand` usava `taskWorktreeDirt` (string[] | null):
   * un `git status` muto collassava a `paths:[]` = «pulito», e il reap partiva
   * su un albero di cui non sapeva niente.
   *
   * QUANDO `git status` TACE DAVVERO, misurato il 2026-08-18 — perché la prima
   * versione di questo commento diceva «index.lock», ed è FALSO: con un
   * `.git/index.lock` presente `git status --porcelain` esce 0 e riporta lo
   * sporco correttamente, sia con modifiche unstaged sia staged. A farlo uscire
   * non-zero sono solo la cartella inesistente e i metadati git rotti (worktree
   * admin dir potata → `fatal: not a git repository`, exit 128). Il canale per
   * perdere lavoro è quindi stretto — dir presente + modifiche non committate +
   * metadati rotti + branch già merged — ma esiste, e soprattutto le due porte
   * sullo stesso contratto puro non devono più divergere.
   *
   * Un «perché» sbagliato dentro un commento è peggio di nessun commento: si
   * eredita, e il prossimo ci costruisce sopra.
   *
   * Con `taskWorktreeDirtProbe`, `ok:false` vale quanto sporco: il reap NON
   * parte, il thread dice perché, il branch resta.
   */
  test("sonda illeggibile (ok:false): il worktree NON viene potato anche dopo un land riuscito", async () => {
    const d = freshDb(); const b: any[] = []; const reaped: string[] = [];
    const rt = createTasksRouter(makeCtx(d, b), undefined, {
      autoMerge: { tryMerge: async () => MERGED, buildClient: async () => ({ code: 0, stderr: "" }) } as any,
      confirmLandedOnMain: async () => true,
      deleteTaskWorktree: async (taskId: string) => { reaped.push(taskId); return true; },
      taskBranchStatus: async () => "merged" as const,
      // Sonda fail-open: ok:false simula git status che non risponde
      // (es. cartella smontata a metà, fs non risponde).
      taskWorktreeDirtProbe: async () => ({ ok: false, paths: [] }),
    });
    d.run("INSERT INTO topics (id) VALUES ('top-probe')");
    const t = await (await call(rt, "POST", "/api/boards/pX/tasks", { text: "probe-feature" }))!.json();
    d.prepare("UPDATE tasks SET assigned_topic_id='top-probe', status='review' WHERE id = ?").run(t.id);
    d.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('cp1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());

    await call(rt, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 30));

    // Il land ha riportato success (MERGED, confermato su main), ma la sonda
    // ha detto «non lo so»: illeggibile != pulito, niente potatura.
    expect(reaped).toEqual([]);
    // Il thread deve dire perché il worktree è rimasto.
    const comments = d.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(t.id) as Array<{ content: string }>;
    const guardComment = comments.find((c) => c.content.includes("NON ripulito") || c.content.includes("illeggibile"));
    expect(guardComment).toBeDefined();
    expect(guardComment!.content).toMatch(/illeggibile|leggibile/);
  });

  test("main non risponde: il verdetto è «non verificabile», mai 'landed'", async () => {
    // Il no e il non-lo-so restano due cose diverse: `null` non accusa nessuno,
    // ma nemmeno assolve — e `landed` è un'assoluzione.
    const [[, v]] = await landStamping(MERGED, async () => null) as any;
    expect(v).toBe("unverifiable");
    // Stesso esito quando la verifica non esiste proprio su questo host: una
    // capacità non cablata è assenza di prova, non prova d'assenza di problemi
    // (il cablaggio mancante è precisamente come nascono questi guasti).
    const [[, v2]] = await landStamping(MERGED) as any;
    expect(v2).toBe("unverifiable");
  });

  test("land fallito → si registra 'unlanded': anche il no è un fatto osservato", async () => {
    const [[, v]] = await landStamping({ status: "skipped", reason: "x", code: "unisolable" }) as any;
    expect(v).toBe("unlanded");
    const [[, v2]] = await landStamping({ status: "conflict" }) as any;
    expect(v2).toBe("unlanded");
  });

  test("dove il land NON sa (niente ramo, niente da portare) si CHIEDE al repo", async () => {
    // Il controllo dei due test qui sopra: se registrasse sempre un fatto,
    // scriverebbe una testimonianza su una cosa che non ha visto.
    const [[, v]] = await landStamping({ status: "nothing" }) as any;
    expect(v).toBe("ask");
    const [[, v2]] = await landStamping({ status: "skipped", reason: "x", code: "no-branch" }) as any;
    expect(v2).toBe("ask");
  });

  test("picking 'Landa e pubblica' lands (routes to land+publish, not a reject)", async () => {
    const id = await reviewTask();
    const t = await (await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, { decision: "reject", comment: PUBLISH_ACTION_LABEL }))!.json();
    // Deterministic routing: the publish label lands, and does NOT resume the
    // agent (the publish PUSH itself runs in the fire-and-forget chain — no git
    // in this harness — but the interception routes correctly).
    // `review`: pubblicare è landare + spingere, e chiudere la card resta
    // compito del land, quando main lo conferma.
    expect(t.status).toBe("review");
    expect(merges).toEqual([id]);  // land ran first (merges.push is synchronous)
    expect(resumed).toEqual([]);   // NOT resumed as a rejection
  });

  /**
   * Il land riceve lo SCATTO della consegna, e ciò che non coincide finisce nel
   * thread. Senza questa riga chi ha aggiunto un commit dopo la consegna — o chi
   * ha consegnato da un ramo che la card non usa più — crede di aver pubblicato
   * quello che ha visto: è così che l'11/08 `lint` è tornato rosso su main senza
   * che nessuno collegasse le due cose.
   */
  test("land: la consegna arriva al merge, e la deriva viene detta nel thread", async () => {
    const seen: any[] = [];
    const am = {
      tryMerge: async (_id: string, _t: string, delivery: any) => {
        seen.push(delivery);
        return { status: "merged", commit: "cafe123", branch: "topics/consegnato", repoPath: "/repo",
          touchedClient: false, touchedServer: false, touchedNative: false,
          landedNotLive: false, checkoutBranch: "main",
          deliveryDrift: "il ramo porta 1 commit aggiunto DOPO la consegna", realigned: null };
      },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am });
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET assigned_topic_id='top-2', status='review', delivery_branch='topics/consegnato', delivery_commit='bdfcf0cb' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c9', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());

    await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    // Il land gira staccato dalla risposta: si aspetta che la catena dreni.
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toEqual([{ branch: "topics/consegnato", commit: "bdfcf0cb" }]);
    const said = db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(t.id) as Array<{ content: string }>;
    expect(said.some((c) => c.content.includes("Land ≠ consegna") && c.content.includes("DOPO la consegna"))).toBe(true);
  });
});

/**
 * CHIUSA APPOSTA SENZA LANDARE — un debito che nessuno intende pagare.
 *
 * Un `approve` che non atterra lascia la card `unlanded` con un commit vero, e
 * da fuori quello e' identico a una dimenticanza: chip «non su main» sulla card
 * e contatore rosso in cima alla board, per sempre. Misurato il 18/08/2026: tre
 * card chiuse deliberatamente — due il cui ramo portava il doppione di un
 * cancello gia' su main, una in cui fra due rimedi allo stesso guasto era stato
 * scelto l'altro — tutte e tre contate come debito. Il rumore su un contatore
 * lo rende inguardabile, e allora smette di servire anche per i debiti veri.
 *
 * `superseded` non si DEDUCE: dal repo, un ramo fuori da main e' fuori da main,
 * scartato o dimenticato che sia. Lo dice chi rivede, una volta.
 */
describe("una card chiusa senza landare puo' dirlo", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    const broadcasts: unknown[] = [];
    router = createTasksRouter(makeCtx(db, broadcasts), undefined, {});
  });

  /** Una card in review con una consegna vera: e' il caso in cui il chip si accende. */
  async function cardConsegnata(): Promise<string> {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET status = 'review', delivery_branch = 'topics/scartato', delivery_commit = 'abc12345' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  const statoLanding = (id: string) =>
    (db.prepare("SELECT landing_state FROM tasks WHERE id = ?").get(id) as { landing_state: string | null }).landing_state;

  test("con `superseded` la card si chiude e lo dichiara", async () => {
    const id = await cardConsegnata();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true, superseded: true,
    });
    expect(r?.status).toBe(200);
    expect(statoLanding(id)).toBe("superseded");
  });

  test("senza il gesto NON si inventa niente: resta un debito da guardare", async () => {
    // Il caso che tiene onesto quello sopra. Se `approve` marcasse da solo, ogni
    // card chiusa senza landare sparirebbe dal contatore — cioe' il difetto
    // opposto, e molto peggiore: il lavoro dimenticato non lo direbbe piu'
    // nessuno.
    const id = await cardConsegnata();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true,
    });
    expect(r?.status).toBe(200);
    expect(statoLanding(id)).not.toBe("superseded");
  });

  test("un rifiuto non lo scrive nemmeno se glielo chiedi", async () => {
    // `superseded` parla di una card CHIUSA. Su un rifiuto la card torna a
    // lavorare, e un timbro «non atterrera' mai» sopra un lavoro che riparte
    // sarebbe una bugia con la forma di una decisione.
    const id = await cardConsegnata();
    await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "reject", comment: "rifai", superseded: true,
    });
    expect(statoLanding(id)).not.toBe("superseded");
  });
});
