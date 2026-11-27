/**
 * APPROVARE E ATTERRARE SONO DUE COSE.  @covers LAND-05
 * L'approvazione e' una decisione umana sulla card; l'atterraggio e' un merge su
 * main che puo' fallire per ragioni che con la decisione non c'entrano — il ramo
 * indietro, un worktree sporco, un conflitto. Tenerle insieme faceva chiudere
 * card il cui codice non era da nessuna parte, ed e' la perdita del 19/07.
 *
 * QUI STA UNA DOMANDA SOLA: quale gesto atterra. Il trascinamento in Done, il
 * bottone, le due risposte rapide, l'approvazione che NON fonde — e l'interruttore
 * della board che decide se Done fonde o si limita a dirlo.
 *
 * Separato da `tasks.test.ts` il 18/08 (il file aveva sfondato il cancello di
 * dimensione a 3.106 righe) e spezzato di nuovo il 17/09, quando questo stesso
 * file era arrivato a 1.076 righe e faceva rosso `check:bloat`. Gli altri pezzi,
 * un argomento per file, stanno in `tasks.landing-failures.test.ts`,
 * `tasks.landing-success.test.ts`, `tasks.landing-realign.test.ts`,
 * `tasks.landing-verdict.test.ts`, `tasks.landing-superseded.test.ts` e
 * `tasks.delivery-sweep.test.ts`. Il banco di prova sta in
 * `tasks-test-support.ts`, condiviso coi test delle altre rotte.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService, LAND_ACTION_LABEL } from "../services/tasks";
import { PUBLISH_ACTION_LABEL } from "../../shared/board";
import { t as label } from "../../client/src/lib/i18n";
import { freshDb, makeCtx, call, setCiPhaseMode } from "./tasks-test-support";

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

    expect(seen.map(({ branch, commit }) => ({ branch, commit }))).toEqual([{ branch: "topics/consegnato", commit: "bdfcf0cb" }]);
    const said = db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(t.id) as Array<{ content: string }>;
    expect(said.some((c) => c.content.includes("Land ≠ consegna") && c.content.includes("DOPO la consegna"))).toBe(true);
  });

  test("land: a manual land of an unmeasured delivery never reaches the merge, a measured one (repair cards too) does", async () => {
    const merges: Array<{ id: string; noRealign: unknown }> = [];
    const am = {
      tryMerge: async (id: string, _t: string, delivery: any) => {
        merges.push({ id, noRealign: delivery.noRealign });
        return { status: "skipped", code: "auto-land-stopped", reason: "stopped" };
      },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const ctx = makeCtx(db, broadcasts);
    const r2 = createTasksRouter(ctx, undefined, { autoMerge: am });
    db.run("INSERT INTO topics (id) VALUES ('top-4')");
    db.run("INSERT OR REPLACE INTO board_settings (project_id, review_checks) VALUES ('pX', ?)",
      [JSON.stringify([{ name: "gates", cmd: "true" }, { name: "unit", cmd: "github-ci:unit" }])]);
    const rowOf = (cmd: string) => ({ name: cmd, cmd, ok: true, code: 0, ms: 1, timedOut: false });
    const full = [rowOf("true"), rowOf("github-ci:unit")];
    const cases: Array<[string | null, unknown[] | null, string | null]> = [
      [null, null, null], ["pass", [rowOf("true")], null], ["pass", full, null], ["pass", full, "main-ci-red:abc"],
    ];
    const ids: string[] = [];
    for (const [state, rows, key] of cases) {
      const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: `card ${ids.length}` }))!.json();
      db.prepare("UPDATE tasks SET assigned_topic_id='top-4', status='review', delivery_branch='topics/y', delivery_commit='bdfcf0cb', checks_state=?, checks_json=?, claude_task_id=? WHERE id = ?")
        .run(state, rows ? JSON.stringify(rows) : null, key, t.id);
      ids.push(t.id);
      await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
      await new Promise((r) => setTimeout(r, 50));
    }
    // Only the two fully measured cards reach the merge, and none of them through the automatic path.
    expect(merges).toEqual([{ id: ids[2], noRealign: undefined }, { id: ids[3], noRealign: undefined }]);
    const said = (id: string) => (db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(id) as Array<{ content: string }>).map((c) => c.content).join(" ");
    expect(said(ids[0]!)).toContain("checks nullo");
    expect(said(ids[1]!)).toContain("mancano: unit");
  });

  test("land in `after` mode: the github-ci rows are not expected yet, a card with local rows lands, one with no checks does not", async () => {
    const merges: string[] = [];
    const am = {
      tryMerge: async (id: string) => { merges.push(id); return { status: "skipped", code: "auto-land-stopped", reason: "stopped" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    setCiPhaseMode(db, "after");
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am, integrationMeasure: async () => ({ measured: [], conflicts: [], verdict: "pass", commit: "bdfcf0cb" }) } as any);
    db.run("INSERT INTO topics (id) VALUES ('top-5')");
    db.run("INSERT OR REPLACE INTO board_settings (project_id, review_checks, dispatch_auto_merge) VALUES ('pX', ?, 1)",
      [JSON.stringify([{ name: "gates", cmd: "true" }, { name: "unit", cmd: "github-ci:unit" }])]);
    const rowOf = (cmd: string) => ({ name: cmd, cmd, ok: true, code: 0, ms: 1, timedOut: false });
    const ids: string[] = [];
    for (const rows of [null, [rowOf("true")]]) {
      const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: `card ${ids.length}` }))!.json();
      db.prepare("UPDATE tasks SET assigned_topic_id='top-5', status='review', delivery_branch='topics/y', delivery_commit='bdfcf0cb', checks_state=?, checks_json=? WHERE id = ?")
        .run(rows ? "pass" : null, rows ? JSON.stringify(rows) : null, t.id);
      ids.push(t.id);
      await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(merges).toEqual([ids[1]!]);
  });

  /**
   * A human's approve while the bar is still `running` must not merge: the measure has not finished,
   * and the next sweep lands the card by itself once it turns green. @covers f00bc37942, 27/11
   */
  test("land: a human's approve while the bar is `running` (zero rows yet) never reaches the merge", async () => {
    const merges: string[] = [];
    const am = {
      tryMerge: async (id: string) => { merges.push(id); return { status: "skipped", code: "auto-land-stopped", reason: "stopped" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am });
    db.run("INSERT INTO topics (id) VALUES ('top-6')");
    db.run("INSERT OR REPLACE INTO board_settings (project_id, review_checks) VALUES ('pX', ?)",
      [JSON.stringify([{ name: "gates", cmd: "true" }])]);
    const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id='top-6', status='review', delivery_branch='topics/y', delivery_commit='bdfcf0cb', checks_state='running', checks_json=NULL, land_intent='human' WHERE id = ?")
      .run(t.id);

    await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 50));

    expect(merges).toEqual([]);
    const after = createTaskService(db).get(t.id)!;
    expect(after.task.status).toBe("review");
    expect(after.task.landIntent).toBe("human");
    expect(after.comments.some((c) => c.content.includes("Misura in corso: atterra da sola quando finisce verde"))).toBe(true);
  });

  test("land in `after` mode: `running` with every local row done and the `github-ci:*` row still pending never reaches the merge, and lands once `recordChecks` says pass", async () => {
    const merges: string[] = [];
    const am = {
      tryMerge: async (id: string) => { merges.push(id); return { status: "skipped", code: "auto-land-stopped", reason: "stopped" }; },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    setCiPhaseMode(db, "after");
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am, integrationMeasure: async () => ({ measured: [], conflicts: [], verdict: "pass", commit: "bdfcf0cb" }) } as any);
    db.run("INSERT INTO topics (id) VALUES ('top-7')");
    db.run("INSERT OR REPLACE INTO board_settings (project_id, review_checks, dispatch_auto_merge) VALUES ('pX', ?, 1)",
      [JSON.stringify([{ name: "gates", cmd: "true" }, { name: "unit", cmd: "github-ci:unit" }])]);
    const rowOf = (cmd: string) => ({ name: cmd, cmd, ok: true, code: 0, ms: 1, timedOut: false, tail: "" });
    const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id='top-7', status='review', delivery_branch='topics/y', delivery_commit='bdfcf0cb', checks_state='running', checks_json=? WHERE id = ?")
      .run(JSON.stringify([rowOf("true")]), t.id);

    await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(merges).toEqual([]);

    createTaskService(db).recordChecks({
      taskId: t.id, state: "pass", commit: "bdfcf0cb", runs: [rowOf("true"), rowOf("github-ci:unit")],
    });
    await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(merges).toEqual([t.id]);
  });

  test("land: with main red the merge hook refuses, but the repair card (main-ci-red:) goes through", async () => {
    const hooks: Array<(sha: string) => Promise<string | null>> = [];
    const am = {
      tryMerge: async (_id: string, _t: string, delivery: any) => {
        hooks.push(delivery.beforeMerge);
        return { status: "skipped", code: "auto-land-stopped", reason: "stopped" };
      },
      buildClient: async () => ({ code: 0, stderr: "" }),
    } as any;
    const redPort = {
      recent: async () => [{ sha: "0123456789abcdef0123456789abcdef01234567", subject: "x", at: Math.floor(Date.now() / 1000) - 3600 }],
      verdict: async () => ({ state: "fail" as const, failed: ["unit"], url: null }),
      entersAt: async () => false,
    };
    const r2 = createTasksRouter(makeCtx(db, broadcasts), undefined, { autoMerge: am, mainCiPort: async () => redPort } as any);
    db.run("INSERT INTO topics (id) VALUES ('top-3')");
    const ids: string[] = [];
    for (const key of [null, "main-ci-red:abc"]) {
      const t = await (await call(r2, "POST", "/api/boards/pX/tasks", { text: "card " + String(key) }))!.json();
      db.prepare("UPDATE tasks SET assigned_topic_id='top-3', status='review', delivery_branch='topics/x', delivery_commit='bdfcf0cb', claude_task_id=? WHERE id = ?").run(key, t.id);
      ids.push(t.id);
      await call(r2, "POST", `/api/boards/pX/tasks/${t.id}/land`, {});
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(hooks).toHaveLength(2);
    expect(await hooks[0]!("bdfcf0cb")).toContain("main");
    expect(await hooks[1]!("bdfcf0cb")).toBeNull();
  });
});
