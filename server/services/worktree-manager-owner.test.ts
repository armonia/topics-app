/**
 * A worktree Topics creates carries its owner marker and a lock; deleting it lifts
 * Topics' own lock and nothing else. Real git, a fake store, a temp root.
 *
 * @covers WORKTREE-STD-03
 * @covers WORKTREE-STD-15
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeManager, WorktreeOperationError } from "./worktree-manager";
import type { WorktreeStore } from "./worktree-store";
import type { ProjectStore } from "./project-store";
import type { AppContext, Worktree } from "../types";
import { canonicalPath, listRepoWorktrees, readOwnerMarker } from "./worktree-owner";
import { defaultRunGit } from "./own-commits";
import { folderOwned, hasRootSentinel, writeRootSentinel } from "./worktree-root-ledger";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

describe("owner marker and lock around create and delete", () => {
  let base: string, repo: string, root: string, savedRoot: string | undefined;
  let rows: Map<string, Worktree>;
  let created: string[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wt-mgr-owner-"));
    repo = join(base, "repo");
    root = join(base, "wts");
    mkdirSync(root, { recursive: true });
    git(base, "init", "-q", "-b", "main", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    savedRoot = process.env.TOPICS_WORKTREES_DIR;
    process.env.TOPICS_WORKTREES_DIR = root;
    rows = new Map();
    created = [];
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.TOPICS_WORKTREES_DIR; else process.env.TOPICS_WORKTREES_DIR = savedRoot;
    rmSync(base, { recursive: true, force: true });
  });

  function manager(gcDeps: { afterCreate?: (projectId: string) => void } = { afterCreate: (id) => created.push(id) }) {
    let n = 0;
    const store = {
      create: (i: Partial<Worktree>) => {
        const row = { id: `w${++n}`, isPushed: false, branchRenamed: false, status: "pending", errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...i } as Worktree;
        rows.set(row.id, row);
        return row;
      },
      get: (id: string) => rows.get(id) ?? null,
      getByName: () => null,
      getByAbsPath: (p: string) => [...rows.values()].find((r) => r.absPath === p) ?? null,
      list: () => [...rows.values()],
      listNamesForProject: () => new Set<string>(),
      update: (id: string, patch: Partial<Worktree>) => { const r = rows.get(id); if (!r) return null; Object.assign(r, patch); return r; },
      delete: (id: string) => rows.delete(id),
    } as unknown as WorktreeStore;
    const project = { path: repo, id: "p1", name: "proj", slug: "proj" };
    const projects = { get: () => project, list: () => [project] } as unknown as ProjectStore;
    return createWorktreeManager({ broadcastToAll: () => {} } as unknown as AppContext, { projectStore: projects, worktreeStore: store }, gcDeps);
  }

  test("create writes the marker, takes the lock and tells the cap check; delete lifts the lock and removes the folder", async () => {
    const m = manager();
    const row = await m.create({ projectId: "p1", mode: "branch", baseRef: "main", name: "fresh-one" });
    expect(created).toEqual(["p1"]);
    const ready = await m.awaitMaterialisation(row.id, 30_000);
    expect(ready.status).toBe("ready");

    const listed = (await listRepoWorktrees(defaultRunGit, repo))!.find((w) => canonicalPath(w.path) === canonicalPath(row.absPath))!;
    expect(listed.locked).toBe(true);
    expect(listed.lockReason).toBe("topics:fresh-one");
    expect(readOwnerMarker(row.absPath)).toMatchObject({ worktreeId: row.id, projectId: "p1" });
    // The proof the GC asks before it may ever move a folder: the root's sentinel and this folder's marker.
    expect(hasRootSentinel(root)).toBe(true);
    expect(folderOwned(root, row.absPath)).toBe(true);

    expect(await m.delete(row.id)).toBe(true);
    expect(existsSync(row.absPath)).toBe(false);
    expect(folderOwned(root, row.absPath)).toBe(false);
    expect((await listRepoWorktrees(defaultRunGit, repo))!.some((w) => canonicalPath(w.path) === canonicalPath(row.absPath))).toBe(false);
  });

  test("a lock somebody else took is respected: the delete refuses and the folder stays", async () => {
    const m = manager();
    const row = await m.create({ projectId: "p1", mode: "branch", baseRef: "main", name: "held-one" });
    await m.awaitMaterialisation(row.id, 30_000);
    git(repo, "worktree", "unlock", row.absPath);
    expect(git(repo, "worktree", "lock", "--reason", "another tool", row.absPath).code).toBe(0);
    await expect(m.delete(row.id)).rejects.toBeInstanceOf(WorktreeOperationError);
    expect(existsSync(row.absPath)).toBe(true);
    expect(rows.has(row.id)).toBe(true);
  });

  test("after the root moved twice, a row of the first root is still Topics' to remove", async () => {
    const m = manager();
    const first = join(base, "first-root");
    process.env.TOPICS_WORKTREES_DIR = first;
    const row = await m.create({ projectId: "p1", mode: "branch", baseRef: "main", name: "from-first" });
    await m.awaitMaterialisation(row.id, 30_000);
    // Two moves of the root later the first one is neither the current nor the default (the env one).
    process.env.TOPICS_WORKTREES_DIR = join(base, "third-root");
    writeRootSentinel(join(base, "third-root"));
    expect(await m.delete(row.id)).toBe(true);
    expect(existsSync(row.absPath)).toBe(false);
    expect((await listRepoWorktrees(defaultRunGit, repo))!.some((w) => canonicalPath(w.path) === canonicalPath(row.absPath))).toBe(false);
  });

  test("a failing cap callback never fails a create", async () => {
    const m = manager({ afterCreate: () => { throw new Error("boom"); } });
    const row = await m.create({ projectId: "p1", mode: "branch", baseRef: "main", name: "still-made" });
    expect((await m.awaitMaterialisation(row.id, 30_000)).status).toBe("ready");
  });
});
