import { describe, it, expect } from "bun:test";
import { createPreviewManager, isLocalUrl, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree } from "./preview-manager";

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
    for (const u of ["https://[cliente].[cliente].it/", "http://example.com", "not a url", ""]) {
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
    h.outputUrl.v = "https://[cliente].[cliente].it/";
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

  it("reuses a live LOCAL output_url the agent already set (no new server)", async () => {
    const h = harness();
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
