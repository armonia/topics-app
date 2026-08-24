/**
 * E2E coverage for the Project + Worktree domain (Phase A).
 *
 * Bundles the six "tasks 10.1–10.6" specs into a single file so the
 * setup / teardown happens once. Each test pins itself to one
 * scenario from the spec deltas. Domain-level invariants are
 * additionally covered by `tests/integration/project-worktree-domain.test.ts`
 * which runs in <1 s without a browser.
 *
 * Conventions enforced (per tests/e2e/CONVENTIONS.md):
 *   · No `waitForTimeout`. Condition-based waits only.
 *   · Test data created via API, never direct DB.
 *   · Unique names: `…-${Date.now()}` so reruns don't collide.
 *
 * @covers PROJECT-02
 *
 * Parziale: la compatibilita' con i vecchi `project_path` come stringa, vista
 * dal dominio worktree. Il lato di lettura pura sta in
 * tests/integration/project-worktree-domain.test.ts.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const API = `${E2E_BASE}/api`;

interface ProjectRow {
  id: string;
  slug: string;
  path: string;
}
interface WorktreeRow {
  id: string;
  name: string;
  status: "pending" | "ready" | "error";
  absPath: string;
  branchName: string | null;
}

/**
 * Spin up an isolated bare-repo on the test host so the manager has
 * something real to `git worktree add` against. Cheap (~30 ms) and
 * leaves no lingering state outside `/tmp`.
 */
function makeRepo(): string {
  const dir = `/tmp/topics-e2e-repo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(`${dir}/README.md`, "# e2e\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

async function pollForReady(
  request: import("@playwright/test").APIRequestContext,
  id: string,
  timeoutMs = 8_000,
): Promise<WorktreeRow> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`${API}/worktrees/${id}`);
    if (res.ok()) {
      const wt = (await res.json()) as WorktreeRow;
      if (wt.status !== "pending") return wt;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Worktree ${id} did not flip out of pending in ${timeoutMs}ms`);
}

test.describe("Phase A · Worktree domain (E2E)", () => {

  test("WORKTREE-01: create branch-mode worktree → status flips pending → ready", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "WORKTREE-01" });
    const repo = makeRepo();
    const projectName = `e2e-${Date.now()}`;
    const created = await request.post(`${API}/projects`, {
      data: { name: projectName, path: repo },
    });
    expect(created.ok()).toBe(true);
    const project = (await created.json()) as ProjectRow;

    const wtRes = await request.post(`${API}/worktrees`, {
      data: { project_id: project.id, mode: "branch", base_ref: "main" },
    });
    expect(wtRes.status()).toBe(202);
    const wt = (await wtRes.json()) as WorktreeRow;
    expect(wt.status).toBe("pending");

    const ready = await pollForReady(request, wt.id);
    expect(ready.status).toBe("ready");
    expect(ready.branchName).toMatch(/^topics\//);
    expect(fs.existsSync(ready.absPath)).toBe(true);
  });

  test("WORKTREE-02: naming generator produces filesystem-safe pairs", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "WORKTREE-02" });
    // Drive 30 creates; each must auto-name and pass /^[a-z]+-[a-z]+(-[0-9a-f]{4})?$/.
    const repo = makeRepo();
    const projectName = `e2e-naming-${Date.now()}`;
    const proj = (await (await request.post(`${API}/projects`, {
      data: { name: projectName, path: repo },
    })).json()) as ProjectRow;

    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await request.post(`${API}/worktrees`, {
        data: { project_id: proj.id, mode: "branch", base_ref: "main" },
      });
      expect(r.status()).toBe(202);
      const wt = (await r.json()) as WorktreeRow;
      expect(wt.name).toMatch(/^[a-z]+-[a-z]+(-[0-9a-f]{4})?$/);
      expect(seen.has(wt.name)).toBe(false);
      seen.add(wt.name);
    }
  });

  test("WORKTREE-03 + TOPIC-WT-01: deleting a worktree NULLs topics.worktree_id (graceful degrade)", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "WORKTREE-03" });
    test.info().annotations.push({ type: "spec", description: "TOPIC-WT-01" });
    const repo = makeRepo();
    const proj = (await (await request.post(`${API}/projects`, {
      data: { name: `e2e-cascade-${Date.now()}`, path: repo },
    })).json()) as ProjectRow;
    const wt = (await (await request.post(`${API}/worktrees`, {
      data: { project_id: proj.id, mode: "branch", base_ref: "main" },
    })).json()) as WorktreeRow;
    const ready = await pollForReady(request, wt.id);

    const topic = (await (await request.post(`${API}/topics`, {
      data: { name: `Bound-${Date.now()}`, projectPath: repo, worktreeId: ready.id },
    })).json()) as { id: string; worktreeId?: string | null };
    expect(topic.worktreeId).toBe(ready.id);

    const del = await request.delete(`${API}/worktrees/${ready.id}`);
    expect(del.ok()).toBe(true);

    // After delete, the topic should still exist with worktreeId=null.
    const after = (await (await request.get(`${API}/topics`)).json()) as {
      topics: Record<string, { id: string; worktreeId?: string | null; projectPath?: string }>;
    };
    const reread = after.topics[topic.id];
    expect(reread).toBeDefined();
    expect(reread.worktreeId ?? null).toBeNull();
    expect(reread.projectPath).toBe(repo);
  });

  test("WORKTREE-04: rename mutates display name only", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "WORKTREE-04" });
    const repo = makeRepo();
    const proj = (await (await request.post(`${API}/projects`, {
      data: { name: `e2e-rename-${Date.now()}`, path: repo },
    })).json()) as ProjectRow;
    const wt = (await (await request.post(`${API}/worktrees`, {
      data: { project_id: proj.id, mode: "branch", base_ref: "main" },
    })).json()) as WorktreeRow;
    const ready = await pollForReady(request, wt.id);
    const originalBranch = ready.branchName;
    const originalPath = ready.absPath;

    const renamed = (await (await request.patch(`${API}/worktrees/${ready.id}`, {
      data: { name: "renamed-display" },
    })).json()) as WorktreeRow;
    expect(renamed.name).toBe("renamed-display");
    // Branch name + on-disk path stay unchanged in this phase.
    expect(renamed.branchName).toBe(originalBranch);
    expect(renamed.absPath).toBe(originalPath);
  });

  test("TOPIC-WT-01 (default): topic without worktree binding behaves exactly as before", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-WT-01" });
    // The "Use project path directly" path: create a topic with no worktreeId.
    // The whole stack must still respond exactly as it did pre-Phase-A.
    const created = (await (await request.post(`${API}/topics`, {
      data: { name: `Legacy-${Date.now()}` },
    })).json()) as { id: string; worktreeId?: string | null };
    expect(created.id).toBeDefined();
    expect(created.worktreeId ?? null).toBeNull();
    // The list endpoint returns the topic as before.
    const list = (await (await request.get(`${API}/topics`)).json()) as {
      topics: Record<string, { id: string }>;
    };
    expect(list.topics[created.id]).toBeDefined();
  });

  test("PROJECT-01: archive / restore round-trip + delete refused while worktrees exist", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "PROJECT-01" });
    const repo = makeRepo();
    const proj = (await (await request.post(`${API}/projects`, {
      data: { name: `e2e-archive-${Date.now()}`, path: repo },
    })).json()) as ProjectRow;
    expect((await request.post(`${API}/projects/${proj.id}/archive`)).ok()).toBe(true);
    const listActive = (await (await request.get(`${API}/projects`)).json()) as {
      projects: ProjectRow[];
    };
    expect(listActive.projects.find((p) => p.id === proj.id)).toBeUndefined();
    const listArchived = (await (await request.get(`${API}/projects?archived=true`)).json()) as {
      projects: ProjectRow[];
    };
    expect(listArchived.projects.find((p) => p.id === proj.id)).toBeDefined();
    expect((await request.post(`${API}/projects/${proj.id}/restore`)).ok()).toBe(true);

    // Add a worktree → DELETE /api/projects/:id should return 409.
    const wt = (await (await request.post(`${API}/worktrees`, {
      data: { project_id: proj.id, mode: "branch", base_ref: "main" },
    })).json()) as WorktreeRow;
    await pollForReady(request, wt.id);
    const delResp = await request.delete(`${API}/projects/${proj.id}`);
    expect(delResp.status()).toBe(409);
  });
});
