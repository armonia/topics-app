/**
 * A boot that fails: the REASON must reach the card.
 * @covers KANBAN-23
 */
import { describe, it, expect } from "bun:test";
import { createPreviewManager, PREVIEW_NOTE_PREFIX, PREVIEW_NOTE_SLOT, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree } from "./preview-manager";

const WT: PreviewWorktree = { id: "wt1", absPath: "/tmp/wt1", branchName: "topics/x", projectId: "p1", mode: "branch" };

function fakeProc(pid = 1234): PreviewProcess & { killed: boolean } {
  return { pid, killed: false, alive() { return !this.killed; }, kill() { this.killed = true; } };
}

function harness(over: Partial<PreviewManagerDeps> = {}) {
  const h = {
    reviewNotes: [] as Parameters<PreviewManagerDeps["addReviewNote"]>[1][],
    spawned: [] as { cmd: string[]; cwd: string; env: Record<string, string> }[],
    deps: null as unknown as PreviewManagerDeps,
  };
  h.deps = {
    worktreeOf: () => WT,
    resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/" }),
    spawn: (cmd, opts) => { h.spawned.push({ cmd, ...opts }); return fakeProc(); },
    probe: async () => true,
    screenshot: async () => true,
    currentOutputUrl: () => null,
    setOutputUrl: () => {},
    setPreviewImage: () => {},
    addReviewNote: (_t, a) => { h.reviewNotes.push(a); },
    mediaDir: "/tmp/media",
    ensureMediaDir: () => {},
    portFree: async () => true,
    sleep: async () => {},
    now: () => Date.now(),
    ...over,
  };
  return h;
}

describe("preview boot failures", () => {
  it("runs the prepare steps BEFORE the spawn and substitutes {port}", async () => {
    const order: string[] = [];
    const h = harness({
      portRange: [3400, 3402],
      resolveCommand: () => ({ cmd: ["serve", "--port", "{port}"], deepLinkPath: "/", prepare: [["install"], ["build", "--out", "/o/{port}"]] }),
      runStep: async (cmd) => { order.push(cmd.join(" ")); return { ok: true, tail: "" }; },
      spawn: (cmd, opts) => { order.push("spawn " + cmd.join(" ")); h.spawned.push({ cmd, ...opts }); const p = fakeProc(); return p; },
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).not.toBeNull();
    expect(order).toEqual(["install", "build --out /o/3400", "spawn serve --port 3400"]);
  });

  it("a failed prepare step never spawns the server and puts its output in the reason", async () => {
    const h = harness({
      resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/", prepare: [["bun", "install"]] }),
      runStep: async () => ({ ok: false, tail: "error: lockfile had changes\nerror: frozen" }),
    });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.spawned.length).toBe(0);
    expect(h.reviewNotes.length).toBe(1);
    expect(h.reviewNotes[0].kind).toBe("service");
    expect(h.reviewNotes[0].content).toContain(PREVIEW_NOTE_PREFIX);
    expect(h.reviewNotes[0].content).toContain("bun install");
    expect(h.reviewNotes[0].content).toContain("lockfile had changes");
  });

  it("a child that exited before answering says so, with the tail of its output", async () => {
    const dead: PreviewProcess = { pid: 7, alive: () => false, kill() {}, tail: () => "EADDRINUSE: address already in use\n" };
    const h = harness({ probe: async () => false, spawn: () => dead, readyTimeoutMs: 50, readyPollMs: 1 });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.reviewNotes.length).toBe(1);
    expect(h.reviewNotes[0].content).toContain("è uscito prima di rispondere");
    expect(h.reviewNotes[0].content).toContain("EADDRINUSE");
    expect(h.reviewNotes[0].replaces).toEqual(PREVIEW_NOTE_SLOT);
  });

  it("the command's own wait cap wins over the manager default", async () => {
    let t = 0;
    let polls = 0;
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; }, readyTimeoutMs: 1_000,
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", readyTimeoutMs: 10_000 }),
      probe: async () => { polls++; return t >= 5_000; },
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).not.toBeNull();
    expect(polls).toBeGreaterThan(2);
  });

  it("stays silent when the project has no start command at all", async () => {
    const h = harness({ resolveCommand: () => null });
    const pm = createPreviewManager(h.deps);
    await pm.prepareForReview("t1");
    expect(h.reviewNotes.length).toBe(0);
  });
});

describe("preview deep-link file", () => {
  it("exports the file to the child, waits for the path it writes and uses it", async () => {
    let t = 0;
    let reads = 0;
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => (++reads < 3 ? null : "/?topic=abc"),
    });
    const pm = createPreviewManager(h.deps);
    const res = await pm.ensurePreview("t1");
    expect(h.spawned[0].env.PREVIEW_DEEP_LINK_FILE).toBe("/tmp/dl-3400");
    expect(res?.url).toBe("http://localhost:3400/?topic=abc");
  });

  it("falls back to deepLinkPath when the file never appears", async () => {
    let t = 0;
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/home", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => null,
    });
    const pm = createPreviewManager(h.deps);
    expect((await pm.ensurePreview("t1"))?.url).toBe("http://localhost:3400/home");
  });

  it("ignores a file content that is not a path", async () => {
    const h = harness({
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => "garbage",
      now: (() => { let t = 0; return () => (t += 20_000); })(),
    });
    const pm = createPreviewManager(h.deps);
    expect((await pm.ensurePreview("t1"))?.url).toBe("http://localhost:3400/");
  });
});

describe("recapture on a slow seed", () => {
  // A visible card holds the generated sheet; the recapture must replace it with
  // a real shot of the topic the seeding creates, even when the seeding is slow.
  function slowSeed(seedAtMs: number) {
    let t = 0;
    const set: string[] = [];
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => (t >= seedAtMs ? "/?topic=abc" : null),
      currentPreviewImage: () => "/data/media/task-sheets/t1.svg",
      emptyAppShell: async (url) => !url.includes("topic="),
      setPreviewImage: (_t, p) => { set.push(p); },
    });
    return { h, set };
  }

  it("replaces the sheet with a real shot when the seeding takes 40 s", async () => {
    const { h, set } = slowSeed(40_000);
    await createPreviewManager(h.deps).prepareForReview("t1");
    expect(set.map((p) => p.split("\\").join("/"))).toEqual(["/tmp/media/t1.png"]);
  });
});
