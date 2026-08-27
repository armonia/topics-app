/**
 * @covers KANBAN-23
 */
import { describe, it, expect } from "bun:test";
import { createPreviewManager, isLocalUrl, isEvidencePage, isPlaceholderPage, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree, PREVIEW_NOTE_PREFIX, PREVIEW_NOTE_SLOT } from "./preview-manager";

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeProc(pid = 1234): PreviewProcess & { killed: boolean } {
  return { pid, killed: false, alive() { return !this.killed; }, kill() { this.killed = true; } };
}

const WT: PreviewWorktree = { id: "wt1", absPath: "/tmp/wt1", branchName: "topics/x", projectId: "p1", mode: "branch" };

interface Harness {
  deps: PreviewManagerDeps;
  outputUrl: { v: string | null };
  previewImage: string | null;
  reviewNotes: Parameters<PreviewManagerDeps["addReviewNote"]>[1][];
  registered: any[];
  unregistered: string[];
  spawned: { cmd: string[]; cwd: string; env: Record<string, string> }[];
  procs: (PreviewProcess & { killed: boolean })[];
}

function harness(over: Partial<PreviewManagerDeps> = {}): Harness {
  const outputUrl = { v: null as string | null };
  const h: Harness = {
    outputUrl, previewImage: null, reviewNotes: [], registered: [], unregistered: [],
    spawned: [], procs: [], deps: null as any,
  };
  h.deps = {
    worktreeOf: () => WT,
    resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/" }),
    spawn: (cmd, opts) => { h.spawned.push({ cmd, ...opts }); const p = fakeProc(); h.procs.push(p); return p; },
    probe: async () => true,
    screenshot: async () => true,
    currentOutputUrl: () => outputUrl.v,
    setOutputUrl: (_t, u) => { outputUrl.v = u; },
    setPreviewImage: (_t, p) => { h.previewImage = p; },
    addReviewNote: (_t, a) => { h.reviewNotes.push(a); },
    registerProcess: (e) => { h.registered.push(e); },
    unregisterProcess: (t) => { h.unregistered.push(t); },
    mediaDir: "/tmp/media",
    ensureMediaDir: () => {},
    portFree: async () => true,
    sleep: async () => {},
    now: () => Date.now(),
    ...over,
  };
  return h;
}

// ── isLocalUrl ─────────────────────────────────────────────────────────────

describe("isLocalUrl", () => {
  it("accepts loopback hosts", () => {
    for (const u of ["http://localhost:3400/", "http://127.0.0.1:3400", "http://0.0.0.0:80", "http://foo.localhost/x"]) {
      expect(isLocalUrl(u)).toBe(true);
    }
  });
  it("rejects prod / non-loopback hosts and garbage", () => {
    for (const u of ["https://demoapp.example.com/", "http://example.com", "not a url", ""]) {
      expect(isLocalUrl(u)).toBe(false);
    }
  });
});

// ── ensurePreview ────────────────────────────────────────────────────────────

describe("ensurePreview", () => {
  it("spawns in the worktree with PORT from the pool and returns the deep-link", async () => {
    const h = harness({ portRange: [3400, 3402] });
    const pm = createPreviewManager(h.deps);
    const res = await pm.ensurePreview("t1");
    expect(res).not.toBeNull();
    expect(res!.port).toBe(3400);
    expect(res!.url).toBe("http://localhost:3400/");
    expect(h.spawned[0].cwd).toBe("/tmp/wt1");
    expect(h.spawned[0].env.PORT).toBe("3400");
    expect(h.spawned[0].cmd).toEqual(["bun", "run", "dev"]);
    expect(h.registered[0]).toMatchObject({ taskId: "t1", port: 3400 });
  });

  it("honours a non-root deep-link path", async () => {
    const h = harness({ resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/feature/x" }) });
    const pm = createPreviewManager(h.deps);
    const res = await pm.ensurePreview("t1");
    expect(res!.url).toBe("http://localhost:3400/feature/x");
  });

  it("reuses a live server on a second call (no double spawn)", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    const a = await pm.ensurePreview("t1");
    const b = await pm.ensurePreview("t1");
    expect(a).toEqual(b);
    expect(h.spawned.length).toBe(1);
  });

  it("recreates when the previous server died", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.ensurePreview("t1");
    h.procs[0].kill(); // server crashed
    const res = await pm.ensurePreview("t1");
    expect(res).not.toBeNull();
    expect(h.spawned.length).toBe(2);
  });

  it("returns null for a non-branch worktree", async () => {
    const h = harness({ worktreeOf: () => ({ ...WT, mode: "reuse" }) });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(h.spawned.length).toBe(0);
  });

  it("returns null when no start command resolves", async () => {
    const h = harness({ resolveCommand: () => null });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
  });

  it("returns null (and kills the child) when the server never becomes ready", async () => {
    const h = harness({ probe: async () => false, readyTimeoutMs: 5, readyPollMs: 1 });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(h.procs[0].killed).toBe(true);
  });

  /**
   * L'ALBERO ANCHE SULLE USCITE DI ERRORE, e non e' pignoleria.
   *
   * `deps.spawn` lancia `bun run dev`: il processo che ASCOLTA e' un suo
   * DISCENDENTE. `proc.kill()` chiude il wrapper e lascia il figlio vivo,
   * reparentato a init, con la porta presa e la CPU accesa — e' scritto nel
   * commento di `teardown`, che infatti usa `killTree`. Le due uscite di errore
   * di `bootPreview` no: usavano `proc.kill()` nudo, cioe' proprio dove il dev
   * server e' mezzo avviato e nessuno lo sta piu' guardando. Il pool 3400-3450
   * si consuma cosi', finche' una card in review non ha piu' dove nascere.
   */
  it("un boot fallito chiude l'ALBERO, non solo il wrapper", async () => {
    const killed: number[] = [];
    const h = harness({
      probe: async () => false, readyTimeoutMs: 5, readyPollMs: 1,
      killTree: async (pid) => { killed.push(pid); },
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(killed, "il discendente che ascolta va chiuso, non solo l'handle").toEqual([h.procs[0].pid!]);
  });

  it("una porta di un estraneo chiude l'ALBERO del nostro figlio", async () => {
    const killed: number[] = [];
    const h = harness({
      listenerPid: async () => 999,   // ad ascoltare non e' il nostro
      processCwd: async () => "/altrove",
      killTree: async (pid) => { killed.push(pid); },
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(killed).toEqual([h.procs[0].pid!]);
  });

  it("skips ports already taken by other previews", async () => {
    const h = harness({ portRange: [3400, 3401] });
    const pm = createPreviewManager(h.deps);
    const a = await pm.ensurePreview("t1");
    // second task's worktree differs so it boots its own server
    (h.deps as any).worktreeOf = () => ({ ...WT, id: "wt2", absPath: "/tmp/wt2" });
    const b = await pm.ensurePreview("t2");
    expect(a!.port).toBe(3400);
    expect(b!.port).toBe(3401);
  });

  it("returns null when the pool is exhausted", async () => {
    const h = harness({ portRange: [3400, 3400] });
    const pm = createPreviewManager(h.deps);
    await pm.ensurePreview("t1");
    (h.deps as any).worktreeOf = () => ({ ...WT, id: "wt2", absPath: "/tmp/wt2" });
    expect(await pm.ensurePreview("t2")).toBeNull();
  });
});

// ── prepareForReview ─────────────────────────────────────────────────────────

describe("prepareForReview", () => {
  it("sets output_url to the preview, screenshots → previewImage + review-note", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBe("http://localhost:3400/");
    expect(h.previewImage).toBe("/tmp/media/t1.png");
    expect(h.reviewNotes.length).toBe(1);
    expect(h.reviewNotes[0].media).toEqual(["/tmp/media/t1.png"]);
  });

  it("still leaves a review-note when the screenshot fails", async () => {
    const h = harness({ screenshot: async () => false });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBe("http://localhost:3400/");
    expect(h.previewImage).toBeNull();
    expect(h.reviewNotes[0].media).toBeUndefined();
  });

  it("NEVER keeps a prod output_url when no preview is possible", async () => {
    const h = harness({ resolveCommand: () => null });
    h.outputUrl.v = "https://demoapp.example.com/";
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBeNull();
    expect(h.reviewNotes.length).toBe(1);
    expect(h.reviewNotes[0].content).toContain("output_url rimosso");
  });

  it("leaves an empty output_url untouched when no preview is possible", async () => {
    const h = harness({ resolveCommand: () => null });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBeNull();
    expect(h.reviewNotes.length).toBe(0);
  });

  it("reuses a live LOCAL output_url the agent already set, WHEN it runs in the task's worktree", async () => {
    const h = harness({
      listenerPid: async () => 4242,          // qualcuno ascolta su :9999...
      processCwd: async () => "/tmp/wt1",     // ...ed è nel worktree del task
    });
    h.outputUrl.v = "http://localhost:9999/agents-own";
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.spawned.length).toBe(0);            // did not boot its own
    expect(h.outputUrl.v).toBe("http://localhost:9999/agents-own"); // kept
    expect(h.reviewNotes[0].media).toEqual(["/tmp/media/t1.png"]);   // still screenshots it
  });

  it("boots its own server when the agent's local output_url is dead", async () => {
    let calls = 0;
    const h = harness({
      // first probe (the agent's url) fails; readiness probes succeed
      probe: async (u) => { calls++; return !u.includes("9999"); },
    });
    h.outputUrl.v = "http://localhost:9999/dead";
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.spawned.length).toBe(1);
    expect(h.outputUrl.v).toBe("http://localhost:3400/");
    expect(calls).toBeGreaterThan(0);
  });
});

// ── Cancello d'IDENTITÀ ──────────────────────────────────────────────────────
// «Qualcuno risponde sulla porta» non è «è il mio server». Le prime porte del
// pool erano occupate dai dev server di un ALTRO progetto e 10 card hanno
// fotografato la sua pagina di login come evidenza del proprio lavoro.

describe("identity gate — chi risponde sulla porta dev'essere il nostro", () => {
  it("figlio MORTO + probe che dice sempre true ⇒ nessuno screenshot, nessuna anteprima", async () => {
    const h = harness({
      probe: async () => true,                       // uno sconosciuto risponde
      spawn: (cmd, opts) => {                        // ...e il nostro figlio è già morto
        h.spawned.push({ cmd, ...opts });
        const p = fakeProc(); p.kill();
        h.procs.push(p);
        return p;
      },
      readyTimeoutMs: 5, readyPollMs: 1,
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).toBeNull();
    expect(h.reviewNotes.length).toBe(0);
    expect(h.outputUrl.v).toBeNull();
  });

  it("ensurePreview rifiuta la porta quando ad ascoltare è un processo estraneo", async () => {
    const h = harness({
      listenerPid: async () => 999,               // non è il nostro pid (1234)...
      processCwd: async () => "/Users/x/Projects/gtm-board", // ...né il nostro worktree
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(h.procs[0].killed).toBe(true);
    expect(pm.list().length).toBe(0);
  });

  it("accetta la porta quando ad ascoltare è un discendente (stesso cwd del worktree)", async () => {
    const h = harness({
      listenerPid: async () => 5555,          // nipote, pid diverso dal figlio
      processCwd: async () => "/tmp/wt1/",    // stesso worktree (slash finale incluso)
    });
    const pm = createPreviewManager(h.deps);
    const res = await pm.ensurePreview("t1");
    expect(res!.url).toBe("http://localhost:3400/");
  });

  it("due NOMI della stessa cartella non sono un intruso (/tmp → /private/tmp)", async () => {
    // Il caso vero, misurato su macOS: `lsof` risponde sempre col path REALE,
    // il worktree porta quello con cui è nato. Confrontate come stringhe, la
    // stessa cartella risultava «un altro processo» e l'anteprima appena
    // avviata veniva uccisa. Il cancello confronta path CANONICI.
    const h = harness({
      listenerPid: async () => 5555,
      processCwd: async () => "/private/tmp/wt1",
      realPath: async (p) => (p.startsWith("/tmp/") ? p.replace("/tmp/", "/private/tmp/") : p),
    });
    const pm = createPreviewManager(h.deps);
    const res = await pm.ensurePreview("t1");
    expect(res, "il worktree è lo stesso: l'anteprima va accettata").not.toBeNull();
    expect(h.procs[0].killed).toBe(false);
  });

  it("con i path canonici un ESTRANEO resta estraneo", async () => {
    const h = harness({
      listenerPid: async () => 5555,
      processCwd: async () => "/private/tmp/wt2",
      realPath: async (p) => (p.startsWith("/tmp/") ? p.replace("/tmp/", "/private/tmp/") : p),
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(h.procs[0].killed).toBe(true);
  });

  it("NON riusa un output_url locale che risponde ma non è l'anteprima di questo task", async () => {
    const h = harness();                       // nessun listenerPid ⇒ identità non verificabile
    h.outputUrl.v = "http://localhost:3400/";  // porta del pool, oggi di chissà chi
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.spawned.length).toBe(1);          // ha bootato il PROPRIO server
    expect(h.outputUrl.v).toBe("http://localhost:3400/");
    expect(h.previewImage).toBe("/tmp/media/t1.png");
  });

  it("NON riusa un output_url locale servito da un altro progetto", async () => {
    const h = harness({
      // su :3400 c'è un estraneo, su :3401 il figlio che spawniamo noi
      listenerPid: async (port) => (port === 3400 ? 777 : 1234),
      processCwd: async () => "/Users/x/Projects/gtm-board",
      portRange: [3401, 3402],
    });
    h.outputUrl.v = "http://localhost:3400/";
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBe("http://localhost:3401/"); // il suo, non quello estraneo
  });

  it("azzera l'output_url locale quando su quella porta risponde un estraneo e nessuna anteprima è possibile", async () => {
    const h = harness({ resolveCommand: () => null, listenerPid: async () => 777, processCwd: async () => "/altro/progetto" });
    h.outputUrl.v = "http://localhost:3400/";
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.outputUrl.v).toBeNull();
    expect(h.previewImage).toBeNull();
    expect(h.reviewNotes[0].content).toContain("output_url rimosso");
  });
});

// ── Cancello sul CONTENUTO ───────────────────────────────────────────────────

describe("isPlaceholderPage / isEvidencePage", () => {
  it("riconosce il bundle mai costruito e la pagina vuota", () => {
    expect(isPlaceholderPage("Bundle not built yet — run `cd client && bun run build`.")).toBe(true);
    expect(isPlaceholderPage("   ")).toBe(true);
    expect(isPlaceholderPage("Cannot GET /")).toBe(true);
  });
  it("lascia passare una pagina vera", () => {
    expect(isPlaceholderPage('<!doctype html><div id="root">Topics</div>')).toBe(false);
    expect(isEvidencePage({ status: 200, body: '<div id="root">Topics</div>' })).toBe(true);
  });
  it("uno status di errore non è evidenza, qualunque sia il corpo", () => {
    expect(isEvidencePage({ status: 503, body: "<h1>ci sono quasi</h1>" })).toBe(false);
    expect(isEvidencePage({ status: 404, body: "<h1>ci sono quasi</h1>" })).toBe(false);
  });
});

describe("content gate in prepareForReview", () => {
  it("placeholder ⇒ niente screenshot, anteprima AZZERATA, nota che dice perché", async () => {
    const h = harness({
      fetchPage: async () => ({ status: 503, body: "Bundle not built yet — run `cd client && bun run build`." }),
      screenshot: async () => { throw new Error("non deve nemmeno provarci"); },
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).toBe("");                       // evidenza ritirata
    // The slot comes from the constant, never copied: it is the same list the
    // store uses to empty the slot, and two copies drift apart.
    expect(h.reviewNotes[0].content).toContain(`${PREVIEW_NOTE_PREFIX} non allegata`);
    expect(h.reviewNotes[0]!.replaces).toEqual(PREVIEW_NOTE_SLOT);
    expect(h.reviewNotes[0].media).toBeUndefined();
  });

  /**
   * IL PESO DELLA NOTA SEGUE CHI HA APERTO LA PORTA.
   *
   * Il 19/08 sette card in review su sette avevano come ULTIMA riga del thread
   * lo stesso avviso «nessuna anteprima allegata: localhost:340x ha risposto
   * 503» — sopra il riassunto dell'agente, cioè esattamente dove l'umano cerca
   * «cos'è stato fatto». Non era una scoperta: era un worktree senza bundle
   * costruito, la condizione normale di quasi ogni card, detta con l'enfasi di
   * un guasto.
   */
  it("l'anteprima che abbiamo avviato NOI e non serve: nota di servizio, non in evidenza", async () => {
    const h = harness({
      fetchPage: async () => ({ status: 503, body: "Bundle not built yet." }),
      screenshot: async () => { throw new Error("non deve nemmeno provarci"); },
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.reviewNotes[0].kind).toBe("service");
  });

  it("un output_url messo da una PERSONA che non regge resta in evidenza", async () => {
    // Stessa famiglia del caso sopra, verso opposto: qui l'indirizzo non
    // l'abbiamo scelto noi, quindi il suo fallimento e' una notizia e va detto
    // dove l'umano guarda — non nel raggruppamento delle righe di servizio.
    const h = harness({
      currentOutputUrl: () => "http://localhost:9999",
      probe: async () => true,
      screenshot: async () => { throw new Error("non deve nemmeno provarci"); },
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    const prominenti = h.reviewNotes.filter((n) => (n.kind ?? "review-note") === "review-note");
    expect(prominenti.length, "il fallimento di un url umano non si nasconde").toBeGreaterThan(0);
  });

  it("pagina vera ⇒ si fotografa come prima", async () => {
    const h = harness({ fetchPage: async () => ({ status: 200, body: '<div id="root">Topics</div>' }) });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).toBe("/tmp/media/t1.png");
  });
});

// ── teardown ─────────────────────────────────────────────────────────────────

describe("teardown", () => {
  it("kills the server and unregisters", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.ensurePreview("t1");
    await pm.teardown("t1");
    expect(h.procs[0].killed).toBe(true);
    expect(h.unregistered).toContain("t1");
    expect(pm.list().length).toBe(0);
  });

  it("is a no-op for an unknown task", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.teardown("nope"); // must not throw
    expect(h.procs.length).toBe(0);
  });

  it("teardownAll kills every live preview", async () => {
    const h = harness({ portRange: [3400, 3405] });
    const pm = createPreviewManager(h.deps);
    await pm.ensurePreview("t1");
    (h.deps as any).worktreeOf = () => ({ ...WT, id: "wt2", absPath: "/tmp/wt2" });
    await pm.ensurePreview("t2");
    expect(pm.list().length).toBe(2);
    await pm.teardownAll();
    expect(pm.list().length).toBe(0);
    expect(h.procs.every((p) => p.killed)).toBe(true);
  });
});

// ── sweepOrphans ─────────────────────────────────────────────────────────────
//
// La spazzata chiude per CWD: «ascolta su una porta del pool e sta in un
// worktree conosciuto». Sono i due modi in cui quella descrizione prende un
// processo che nessuno voleva chiudere.
describe("sweepOrphans", () => {
  /** Un ambiente in cui OGNI porta del pool sembra un'anteprima orfana. */
  function sweepHarness(over: Partial<PreviewManagerDeps> = {}) {
    const killed: number[] = [];
    const h = harness({
      portRange: [3400, 3401],
      knownWorktreePaths: () => [WT.absPath],
      listenerPid: async (port) => 9000 + (port - 3400),
      processCwd: async () => WT.absPath,
      killTree: async (pid) => { killed.push(pid); },
      ...over,
    });
    return { h, killed };
  }

  it("chiude una porta del pool tenuta da un worktree conosciuto", async () => {
    const { h, killed } = sweepHarness();
    const pm = createPreviewManager(h.deps);
    expect(await pm.sweepOrphans()).toEqual([3400, 3401]);
    expect(killed).toEqual([9000, 9001]);
  });

  it("non tocca chi sta fuori dai worktree conosciuti", async () => {
    const { h, killed } = sweepHarness({ processCwd: async () => "/Users/qualcuno/altro-progetto" });
    const pm = createPreviewManager(h.deps);
    expect(await pm.sweepOrphans()).toEqual([]);
    expect(killed).toEqual([]);
  });

  /**
   * IL DIFETTO H10, primo verso. `live.set` avviene solo DOPO `waitReady` (fino
   * a 40 s) e la sonda d'identità: fra la scelta della porta e quella riga
   * l'anteprima non risultava «mia» a nessuno. La spazzata d'avvio parte a
   * T+10 s, cioè dentro quella finestra, e cammina 51 porte con un `lsof`
   * ciascuna: un'anteprima che stava nascendo veniva chiusa dalla spazzata del
   * suo stesso processo.
   */
  it("non uccide un'anteprima ancora in AVVIO", async () => {
    let unlockProbe: () => void = () => {};
    const attesa = new Promise<void>((r) => { unlockProbe = r; });
    const { h, killed } = sweepHarness({
      // `waitReady` resta appeso qui: è la finestra di boot, riprodotta.
      probe: async () => { await attesa; return true; },
    });
    const pm = createPreviewManager(h.deps);
    const inAvvio = pm.ensurePreview("t1");
    // Lascia arrivare `pickPort` + `spawn`: adesso siamo dentro `waitReady`.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.spawned.length).toBe(1);
    expect(pm.list()).toEqual([]); // non è ancora in `live`: è la finestra del difetto

    const cleared = await pm.sweepOrphans();
    expect(cleared).not.toContain(3400);
    expect(killed).not.toContain(9000);

    unlockProbe();
    const res = await inAvvio;
    expect(res?.port).toBe(3400);
    // E finito l'avvio la prenotazione è rilasciata: la porta è «mia» perché è
    // viva, non perché una prenotazione è rimasta appesa.
    expect(pm.list()).toEqual([{ taskId: "t1", port: 3400, url: "http://localhost:3400/" }]);
  });

  it("una prenotazione non sopravvive a un avvio FALLITO", async () => {
    const { h, killed } = sweepHarness({ probe: async () => false, readyTimeoutMs: 0 });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    // Senza il rilascio, 3400 resterebbe «mia» per sempre e la spazzata non la
    // libererebbe mai: il pool si prosciuga di una porta per ogni avvio fallito.
    expect(await pm.sweepOrphans()).toContain(3400);
    expect(killed).toContain(9000);
  });

  /**
   * IL DIFETTO H10, secondo verso. Un dev server acceso da un agente con
   * `run_script` NEL SUO worktree ascolta su una porta e sta in una cartella
   * conosciuta: per tutto ciò che la spazzata sa guardare è identico a un
   * residuo. Il pannello Processi lo mostra con un bottone Stop — cioè qualcuno
   * lo sta guardando — e la spazzata non lo consultava.
   */
  it("non tocca un pid che il pannello Processi rivendica", async () => {
    const { h, killed } = sweepHarness({ protectedPids: () => new Set([9000]) });
    const pm = createPreviewManager(h.deps);
    expect(await pm.sweepOrphans()).toEqual([3401]);
    expect(killed).toEqual([9001]);
  });

  it("se il registro dei processi esplode la spazzata non ammazza tutto", async () => {
    // Il verso sbagliato in cui sbagliare sarebbe «non so chi proteggere, quindi
    // procedo»; qui si vuole almeno che non lanci e non cambi il resto.
    const { h } = sweepHarness({ protectedPids: () => { throw new Error("registro giu'"); } });
    const pm = createPreviewManager(h.deps);
    expect(await pm.sweepOrphans()).toEqual([3400, 3401]);
  });
});

describe("uno scatto BIANCO non si allega", () => {
  /**
   * The content gate reads the HTML the server sends; this app is a SPA, so
   * that is the shell, while the camera captures what React drew afterwards.
   * A blank render passes the first and fails only here. It happened: 4257
   * bytes over 1280x720, attached to a card in review as its delivery.
   */
  it("foto riuscita ma vuota ⇒ nessuna anteprima, e la nota dice perché", async () => {
    const h = harness({
      fetchPage: async () => ({ status: 200, body: "<div id=root></div>" }),
      screenshot: async () => true,
      blankShot: () => true,
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).toBe("");
    expect(h.reviewNotes.at(-1)!.content).toContain("pagina bianca");
  });

  // THE BLANK BRANCH MUST RETIRE, not blank out. It said "retired" in the
  // thread and then called `setPreviewImage(taskId, "")`, which by contract
  // turns no state on: the card was left with no reason written and no memory
  // of what it rejected, so the startup sweep took the same shot back.
  it("la pagina bianca RITIRA con un motivo, non azzera in silenzio", async () => {
    const retirements: Array<{ taskId: string; reason: string }> = [];
    const h = harness({
      fetchPage: async () => ({ status: 200, body: "<div id=root></div>" }),
      screenshot: async () => true,
      blankShot: () => true,
      retirePreview: (taskId, reason) => { retirements.push({ taskId, reason }); },
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(retirements).toHaveLength(1);
    expect(retirements[0]!.reason).toContain("pagina bianca");
    // And NOT through the silent blanking, which leaves the card with no reason.
    expect(h.previewImage).toBeNull();
  });

  it("foto riuscita e piena ⇒ si allega, come sempre", async () => {
    const h = harness({
      fetchPage: async () => ({ status: 200, body: "<div id=root></div>" }),
      screenshot: async () => true,
      blankShot: () => false,
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).not.toBe("");
    expect(h.reviewNotes.at(-1)!.media?.length).toBe(1);
  });

  it("senza la dipendenza il comportamento e quello di prima", async () => {
    const h = harness({
      fetchPage: async () => ({ status: 200, body: "<div id=root></div>" }),
      screenshot: async () => true,
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.previewImage).not.toBe("");
  });
});
