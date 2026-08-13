import { describe, it, expect } from "bun:test";
import { createPreviewManager, isLocalUrl, isEvidencePage, isPlaceholderPage, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree } from "./preview-manager";

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeProc(pid = 1234): PreviewProcess & { killed: boolean } {
  return { pid, killed: false, alive() { return !this.killed; }, kill() { this.killed = true; } };
}

const WT: PreviewWorktree = { id: "wt1", absPath: "/tmp/wt1", branchName: "topics/x", projectId: "p1", mode: "branch" };

interface Harness {
  deps: PreviewManagerDeps;
  outputUrl: { v: string | null };
  previewImage: string | null;
  reviewNotes: { content: string; media?: string[] }[];
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
    expect(h.reviewNotes[0].content).toContain("Nessuna anteprima allegata");
    expect(h.reviewNotes[0].media).toBeUndefined();
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
