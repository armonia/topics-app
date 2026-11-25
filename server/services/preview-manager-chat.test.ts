/**
 * Chat previews: start, auto gating, reasons, idle shut-off, teardown, listing.
 *
 * @covers KANBAN-23
 */
import { describe, it, expect } from "bun:test";
import { createPreviewManager, chatSourceId, PREVIEW_NOTE_PREFIX, type PreviewManagerDeps, type PreviewProcess, type PreviewWorktree } from "./preview-manager";

const WT: PreviewWorktree = { id: "wt1", absPath: "/tmp/wt1", branchName: "topics/x", projectId: "p1", mode: "branch" };

function fakeProc(pid = 1234): PreviewProcess & { killed: boolean } {
  return { pid, killed: false, alive() { return !this.killed; }, kill() { this.killed = true; } };
}

function harness(over: Partial<PreviewManagerDeps> = {}) {
  const h = {
    posted: [] as { topicId: string; content: string; media?: string[] }[],
    procs: [] as (PreviewProcess & { killed: boolean })[],
    deps: null as unknown as PreviewManagerDeps,
  };
  h.deps = {
    worktreeOf: () => null,
    worktreeOfTopic: () => WT,
    resolveCommand: () => ({ cmd: ["bun", "run", "dev"], deepLinkPath: "/" }),
    spawn: () => { const p = fakeProc(); h.procs.push(p); return p; },
    probe: async () => true,
    screenshot: async () => true,
    currentOutputUrl: () => null,
    setOutputUrl: () => {},
    setPreviewImage: () => {},
    addReviewNote: () => {},
    postChatMessage: (topicId, a) => { h.posted.push({ topicId, ...a }); },
    mediaDir: "/tmp/media",
    ensureMediaDir: () => {},
    portFree: async () => true,
    sleep: async () => {},
    now: () => Date.now(),
    ...over,
  };
  return h;
}

describe("chat preview", () => {
  it("starts and posts a message with the link", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.ensureForChat("c1");
    expect(h.procs.length).toBe(1);
    expect(h.posted.length).toBe(1);
    expect(h.posted[0].topicId).toBe("c1");
    expect(h.posted[0].content).toContain(PREVIEW_NOTE_PREFIX);
    expect(h.posted[0].content).toContain("http://localhost:3400");
  });

  it("auto mode without interface files does not start and stays silent", async () => {
    const h = harness({ touchesInterface: async () => false });
    const pm = createPreviewManager(h.deps);
    await pm.ensureForChat("c1", { auto: true });
    expect(h.procs.length).toBe(0);
    expect(h.posted.length).toBe(0);
  });

  it("auto mode with interface files starts", async () => {
    const h = harness({ touchesInterface: async () => true });
    await createPreviewManager(h.deps).ensureForChat("c1", { auto: true });
    expect(h.procs.length).toBe(1);
  });

  it("without a worktree the button says why", async () => {
    const h = harness({ worktreeOfTopic: () => null });
    await createPreviewManager(h.deps).ensureForChat("c1");
    expect(h.procs.length).toBe(0);
    expect(h.posted.length).toBe(1);
    expect(h.posted[0].content).toContain("non disponibile");
  });

  it("switches off after chatIdleMs", async () => {
    const h = harness({ chatIdleMs: 20 });
    const pm = createPreviewManager(h.deps);
    await pm.ensureForChat("c1");
    expect(pm.listChats().length).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(pm.listChats().length).toBe(0);
    expect(h.procs[0].killed).toBe(true);
  });

  it("teardown frees the port for the next preview", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.ensureForChat("c1");
    expect(pm.listChats()[0].port).toBe(3400);
    await pm.teardown(chatSourceId("c1"));
    expect(h.procs[0].killed).toBe(true);
    await pm.ensureForChat("c2");
    expect(pm.listChats().map((c) => c.port)).toEqual([3400]);
  });

  it("list() leaves chats out and listChats() has them", async () => {
    const h = harness();
    const pm = createPreviewManager(h.deps);
    await pm.ensureForChat("c1");
    expect(pm.list()).toEqual([]);
    expect(pm.listChats().map((c) => c.topicId)).toEqual(["c1"]);
  });
});
