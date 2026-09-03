/**
 * THE FOLDER BEFORE THE ROW, on real git.
 *
 * Until 2026-09-03 the delete ran `git worktree remove --force` and, when git
 * refused, wrote a `console.warn` and deleted the row anyway. The row is the
 * ONLY handle the sweep has on a folder: once gone, a repo copy of hundreds
 * of MB is invisible to every round, and the human learns of it from a full
 * disk. Measured on `sage-well`: 137 MB for a task closed and already on
 * main, with the git registration lost (`.git` pointing at a missing
 * `.git/worktrees/<name>`) and thus a `worktree remove` exiting 128 forever.
 *
 * Two lines not to get wrong:
 *  - git refuses but the folder can be removed: we remove it, then the row;
 *  - the folder CANNOT be removed: the row stays, we throw, we notify.
 *
 * No real worktree is touched: repo and folders live in a `mkdtemp`.
 *
 * @covers WORKTREE-12
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeManager, WorktreeOperationError, type WorktreeManagerGcDeps } from "./worktree-manager";
import type { WorktreeStore } from "./worktree-store";
import type { ProjectStore } from "./project-store";
import type { AppContext, Worktree } from "../types";
import type { NotificationRecordInput } from "../../shared/notification-log";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).trim() };
}

const fakeCtx = () => ({ broadcastToAll: () => {} }) as unknown as AppContext;
let repoForStore = "";
const fakeProjectStore = () =>
  ({ get: () => ({ path: repoForStore, id: "proj-1", name: "proj", slug: "proj" }) }) as unknown as ProjectStore;

describe("worktree-manager.del(): la cartella prima della riga", () => {
  let root: string, repo: string, wtBase: string;
  let restoreModes: Array<() => void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-mgr-"));
    repo = join(root, "repo");
    repoForStore = repo;
    wtBase = join(root, "worktrees");
    mkdirSync(wtBase, { recursive: true });
    git(root, "init", "--quiet", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    restoreModes = [];
  });
  afterEach(() => {
    for (const r of restoreModes.splice(0)) { try { r(); } catch { /* best-effort */ } }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function mount(name: string): string {
    const absPath = join(wtBase, "proj", name);
    mkdirSync(join(wtBase, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", `topics/${name}`, absPath, "main").code).toBe(0);
    return absPath;
  }

  function manager(wt: { id: string; absPath: string; branchName: string }, over: {
    onDelete?: () => void; notify?: (i: NotificationRecordInput) => void;
  } = {}) {
    const row = {
      id: wt.id, projectId: "proj-1", absPath: wt.absPath, branchName: wt.branchName, mode: "branch" as const,
      name: wt.absPath.split("/").pop()!, status: "ready" as const, baseRef: "main",
      isPushed: false, branchRenamed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), errorMessage: null,
    };
    const deleted: string[] = [];
    const gcDeps: WorktreeManagerGcDeps = { notify: over.notify };
    const m = createWorktreeManager(
      fakeCtx(),
      {
        projectStore: fakeProjectStore(),
        worktreeStore: {
          get: () => row, delete: (id: string) => { deleted.push(id); return true; },
          list: () => [], listNamesForProject: () => new Set(), create: () => row, update: () => row,
        } as unknown as WorktreeStore,
      },
      gcDeps,
    );
    return { m, deleted };
  }

  test("registrazione git persa: `worktree remove` esce 128, la cartella la togliamo noi, POI la riga", async () => {
    const absPath = mount("sage-well");
    // The production fault, reproduced: git loses the registration but the
    // folder stays, its `.git` pointing into the void.
    rmSync(join(repo, ".git", "worktrees", "sage-well"), { recursive: true, force: true });
    expect(git(repo, "worktree", "remove", "--force", absPath).code).not.toBe(0);
    expect(existsSync(absPath)).toBe(true);

    const { m, deleted } = manager({ id: "w1", absPath, branchName: "topics/sage-well" });
    const ok = await m.delete("w1");

    expect(ok).toBe(true);
    // THE LINE THAT COUNTS: before the fix the folder stayed and the row vanished.
    expect(existsSync(absPath)).toBe(false);
    expect(deleted).toEqual(["w1"]);
    // The branch of a `branch`-mode worktree goes as it always did.
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/topics/sage-well").code).not.toBe(0);
  });

  test("cartella che non si puo' togliere: la riga RESTA, il ramo resta, si lancia e si notifica", async () => {
    const absPath = mount("stuck");
    rmSync(join(repo, ".git", "worktrees", "stuck"), { recursive: true, force: true });
    // Read-only parent: the children can be emptied, the folder itself cannot
    // be unlinked. The portable way to make an `rm -rf` fail.
    const parent = join(wtBase, "proj");
    chmodSync(parent, 0o555);
    restoreModes.push(() => chmodSync(parent, 0o755));

    const notified: NotificationRecordInput[] = [];
    const { m, deleted } = manager({ id: "w2", absPath, branchName: "topics/stuck" }, { notify: (i) => notified.push(i) });

    let thrown: unknown = null;
    try { await m.delete("w2"); } catch (err) { thrown = err; }

    expect(thrown).toBeInstanceOf(WorktreeOperationError);
    expect(existsSync(absPath)).toBe(true);
    expect(deleted).toEqual([]);
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/topics/stuck").code).toBe(0);
    expect(notified).toHaveLength(1);
    expect(notified[0].body).toContain(absPath);
    expect(notified[0].dedupeKey).toBe(`worktree-rm-failed:${absPath}`);
  }, 10_000);

  test("isMaterialising: vera finche' la closure di create() non si e' chiusa, poi falsa", async () => {
    let row: Worktree | null = null;
    // The worktree root is read at construction: the variable goes FIRST.
    const orig = process.env.TOPICS_WORKTREES_DIR;
    process.env.TOPICS_WORKTREES_DIR = wtBase;
    try {
      const m = createWorktreeManager(
        fakeCtx(),
        {
          projectStore: fakeProjectStore(),
          worktreeStore: {
            get: () => row, delete: () => true, list: () => [], listNamesForProject: () => new Set(),
            create: (input: Parameters<WorktreeStore["create"]>[0]) => {
              row = { id: "w3", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isPushed: false, branchRenamed: false, ...input };
              return row;
            },
            update: (_id: string, patch: Partial<Worktree>) => { row = { ...row!, ...patch }; return row; },
          } as unknown as WorktreeStore,
        },
      );
      const created = await m.create({ projectId: "proj-1", name: "fresh", mode: "branch", baseRef: "main" });
      expect(m.isMaterialising(created.id)).toBe(true);
      const done = await m.awaitMaterialisation(created.id, 15_000);
      expect(done.status).toBe("ready");
      expect(m.isMaterialising(created.id)).toBe(false);
      expect(m.isMaterialising("mai-visto")).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.TOPICS_WORKTREES_DIR; else process.env.TOPICS_WORKTREES_DIR = orig;
    }
  }, 20_000);
});
