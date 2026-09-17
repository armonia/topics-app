/**
 * IL VERDETTO DI ATTERRAGGIO ACCUSA SOLO QUANDO HA UNA PROVA.  @covers LAND-05
 *
 * LA BARRA DEL 13/08: `landing_state` diceva `landed` su card che su main non
 * c'erano (`2d3d6051`, `8f1f1b95`), e tre card (`92d61427`, `274d5425`,
 * `95a6794f`) erano `done` col ramo mai atterrato e la potatura delle worktree
 * pronta a portarlo via. Il campo non era una misura: copiava il resoconto di
 * `git merge`, che dice che una fusione e' riuscita e NON su quale ramo.
 *
 * Un argomento solo: quale verdetto si registra per ogni esito del merge —
 * `landed` solo con la conferma su main, `unlanded` per il no, `unverifiable`
 * per il non-lo-so, `ask` dove il land non ha visto niente — e cosa NON si pota
 * finche' il verdetto non e' una prova. Spezzato da `tasks.landing.test.ts` il
 * 17/09, quando quel file aveva sfondato `check:bloat` a 1.076 righe.
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { createTaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("il verdetto di atterraggio si registra, non si deduce", () => {
  /** Un merge andato a buon fine, nella forma che `tryMerge` restituisce. */
  const MERGED = {
    status: "merged", commit: "a5f83e0e", branch: "topics/wooly-saunter", repoPath: "/repo",
    touchedClient: false, touchedServer: false, touchedNative: false,
    landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
  };
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
      // A confirmed land sweeps the draft and the origin branch: stubbed, or the
      // run spawns a real `gh` at a path that does not exist here.
      closeDelivery: async () => ({ pr: null, branchDeleted: false, problems: [] }),
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
      closeDelivery: async () => ({ pr: null, branchDeleted: false, problems: [] }),
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
});
