/**
 * The birth of a sub-agent's own checkout, with a fake manager and a fake store:
 * base ref from `main`, a wait that must end in `ready`, and the project
 * resolved from a directory that may itself be a worktree.
 * @covers WORKTREE-14, WORKTREE-08
 */
import { describe, expect, test } from "bun:test";
import { createAgentWorktree, resolveAgentProject, type AgentWorktreeDeps } from "./worktree-for-agent";

function fakeDeps(over: Partial<AgentWorktreeDeps> = {}) {
  const calls: { create: unknown[]; awaited: unknown[]; warned: string[] } = { create: [], awaited: [], warned: [] };
  const deps: AgentWorktreeDeps = {
    projectPath: () => null,
    create: async (input) => {
      calls.create.push(input);
      return { id: "wt-new" };
    },
    awaitMaterialisation: async (id, timeoutMs) => {
      calls.awaited.push({ id, timeoutMs });
      return { id, status: "ready" };
    },
    warn: (reason) => calls.warned.push(reason),
    ...over,
  };
  return { deps, calls };
}

describe("createAgentWorktree", () => {
  test("creates a branch worktree and returns its id once ready", async () => {
    const { deps, calls } = fakeDeps({ projectPath: () => null });
    const id = await createAgentWorktree(deps, "proj-1", 12_345);
    expect(id).toBe("wt-new");
    expect(calls.create).toEqual([{ projectId: "proj-1", mode: "branch", baseRef: "HEAD" }]);
    expect(calls.awaited).toEqual([{ id: "wt-new", timeoutMs: 12_345 }]);
  });

  test("a project without a repo path falls back to HEAD and says so", async () => {
    const { deps, calls } = fakeDeps();
    await createAgentWorktree(deps, "proj-1", 1000);
    expect(calls.warned.length).toBe(1);
    expect(calls.warned[0]).toContain("HEAD");
  });

  test("a materialisation that never reaches ready throws with the status", async () => {
    const { deps } = fakeDeps({
      awaitMaterialisation: async (id) => ({ id, status: "error", errorMessage: "git said no" }),
    });
    // A half-born checkout is not a directory to hand a child: the caller has to
    // see the failure, not receive a path that may not exist.
    await expect(createAgentWorktree(deps, "proj-1", 1000)).rejects.toThrow(/error git said no/);
  });
});

describe("resolveAgentProject", () => {
  const lookup = {
    getByPath: (path: string) => (path === "/repo/foo" ? { id: "proj-foo" } : null),
    getByAbsPath: (absPath: string) => (absPath === "/wt/foo/kind-tower" ? { projectId: "proj-foo" } : null),
  };

  test("the requested cwd wins over the parent's", () => {
    const out = resolveAgentProject({ cwd: "/repo/foo", parentCwd: "/wt/foo/kind-tower" }, lookup);
    expect(out).toEqual({ ok: true, projectStoreId: "proj-foo" });
  });

  test("a parent standing inside a worktree resolves through that worktree", () => {
    // This is the common case, not the exotic one: the parent is often a card's
    // agent, whose cwd is a checkout `projects.path` has never heard of.
    const out = resolveAgentProject({ parentCwd: "/wt/foo/kind-tower" }, lookup);
    expect(out).toEqual({ ok: true, projectStoreId: "proj-foo" });
  });

  test("the topic's cwd is the last resort", () => {
    const out = resolveAgentProject({ cwd: "/elsewhere", topicCwd: "/repo/foo" }, lookup);
    expect(out).toEqual({ ok: true, projectStoreId: "proj-foo" });
  });

  test("no candidate places a project, and the refusal names the paths", () => {
    const out = resolveAgentProject({ cwd: "/elsewhere", parentCwd: "/nowhere" }, lookup);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusal).toContain("/elsewhere");
    expect(out.refusal).toContain("/nowhere");
  });

  test("with no directory at all the refusal still reads", () => {
    const out = resolveAgentProject({}, lookup);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusal).toBeTruthy();
  });
});
