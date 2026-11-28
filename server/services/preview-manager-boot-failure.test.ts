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
    // Pinned: a machine can carry TOPICS_PREVIEW_PORTS in its environment
    // (a node sharing itself with CI runners does), and these assertions are
    // about the url, not about which pool the machine happens to declare.
    portRange: [3400, 3450],
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

  // A machine with no browser failed mute: the card reached review with no photo
  // and nothing to act on, and a board that requires one parked it for ever.
  it("writes WHY the screenshot failed when the capture knows", async () => {
    const h = harness({
      screenshot: async () => false,
      screenshotFailure: () => "the capture browser (WebKit) is missing on this machine",
    });
    await createPreviewManager(h.deps).prepareForReview("t1");
    const note = h.reviewNotes.map((n) => n.content).join("\n");
    expect(note).toContain("Motivo: the capture browser (WebKit) is missing");
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

  // A command that declares a deep-link file PROMISES to name the page worth a
  // photo. Falling back to the bare `/` photographed the app with no topic open:
  // the empty-shell gate retired that shot on three cards (27/11), over four
  // attempts each, and nobody could tell the seed had never spoken.
  it("refuses to photograph the bare home when the page is never announced, and says why", async () => {
    let t = 0;
    const procs: ReturnType<typeof fakeProc>[] = [];
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => null,
      spawn: () => { const p = fakeProc(); procs.push(p); return p; },
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
    expect(procs[0].killed).toBe(true); // torn down, so the next attempt seeds again
    await pm.prepareForReview("t1");
    const note = h.reviewNotes.map((n) => n.content).join("\n");
    expect(note).toContain("non ha mai annunciato la pagina da fotografare");
    expect(h.reviewNotes.some((n) => n.kind === "service")).toBe(true);
  });

  it("ignores a file content that is not a path, and refuses the bare home with it", async () => {
    const h = harness({
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => "garbage",
      now: (() => { let t = 0; return () => (t += 20_000); })(),
    });
    const pm = createPreviewManager(h.deps);
    expect(await pm.ensurePreview("t1")).toBeNull();
  });

  it("keeps the fallback when the project declares a page of its own", async () => {
    let t = 0;
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/report", deepLinkFile: "/tmp/dl-{port}" }),
      readDeepLink: () => null,
    });
    expect((await createPreviewManager(h.deps).ensurePreview("t1"))?.url).toBe("http://localhost:3400/report");
  });
});

describe("a saved url that names no page", () => {
  // `output_url` outlives the server: the bare `/` written by an old blind boot
  // came back at every attempt and got the same empty shot retired for ever.
  function withSavedUrl(saved: string, deepLinkFile?: string) {
    let t = 0;
    const h = harness({
      now: () => t, sleep: async (ms) => { t += ms; },
      currentOutputUrl: () => saved,
      resolveCommand: () => ({ cmd: ["x"], deepLinkPath: "/", ...(deepLinkFile ? { deepLinkFile } : {}) }),
      readDeepLink: () => "/?topic=abc",
      emptyAppShell: async (url) => !url.includes("topic="),
      setPreviewImage: () => {},
      // The saved address IS verifiably this task's own preview: without this
      // the reuse would be refused for another reason and the test would prove
      // nothing about the guard.
      listenerPid: async () => 99,
      processCwd: async () => WT.absPath,
    });
    const set: string[] = [];
    h.deps.setOutputUrl = (_t, url) => { if (url) set.push(url); };
    return { h, set };
  }

  it("is not reused: the preview boots again and lands on the announced page", async () => {
    const { h, set } = withSavedUrl("http://localhost:3402/", "/tmp/dl-{port}");
    await createPreviewManager(h.deps).prepareForReview("t1");
    expect(set).toEqual(["http://localhost:3400/?topic=abc"]);
  });

  it("is reused as before when the project announces no page", async () => {
    const { h, set } = withSavedUrl("http://localhost:3402/");
    await createPreviewManager(h.deps).prepareForReview("t1");
    expect(set).toEqual([]); // nothing booted: the saved url answered and was kept
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
