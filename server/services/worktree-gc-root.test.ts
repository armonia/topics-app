/**
 * THE GC LOOKS AT THE DISK: orphans are registered, ghosts removed, rows without
 * a folder closed, foreign folders only listed, and a preview writes nothing.
 * Real git and real folders under `mkdtemp`; the store and the manager are fakes
 * that record what they are asked.
 *
 * @covers WORKTREE-STD-03
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeGcRunner, type WorktreeGcDeps } from "./worktree-gc-runner";
import type { StoredWorktree } from "./worktree-gc-root-pass";
import { lockOwned } from "./worktree-owner";
import { defaultRunGit } from "./own-commits";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const DAY = 24 * 3600_000;

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

/** A fake row: what the root pass reads of a stored worktree (the real contract), plus what `create` is given. */
type Row = StoredWorktree & { mode: "branch" | "reuse" | "detached"; status: "pending" | "ready" | "error"; createdAt: string; name?: string };

describe("the root pass of the worktree GC, on real git", () => {
  let base: string, repo: string, root: string;
  let rows: Row[];
  let deleted: string[];
  let db: Database;
  let live: string[];
  let nextId: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wt-gc-root-"));
    repo = join(base, "repo");
    root = join(base, "wts");
    mkdirSync(root, { recursive: true });
    rows = [];
    deleted = [];
    live = [];
    nextId = 1;
    git(base, "init", "-q", "-b", "main", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, archived INTEGER, updated_at TEXT, assigned_topic_id TEXT)");
    db.run("CREATE TABLE task_comments (id TEXT PRIMARY KEY, task_id TEXT, kind TEXT, created_at TEXT)");
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT, worktree_id TEXT)");
    db.run("CREATE TABLE messages (session_key TEXT, timestamp TEXT)");
  });
  afterEach(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  const age = (p: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

  function mountAt(name: string, ageMs = 3 * DAY): string {
    const abs = join(root, "proj", name);
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", `topics/${name}`, abs, "main").code).toBe(0);
    age(abs, ageMs);
    return abs;
  }
  function ghost(name: string, ageMs = 3 * DAY): string {
    const abs = join(root, "proj", name);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, "leftover.txt"), "x");
    age(abs, ageMs);
    return abs;
  }

  function runner(over: Partial<WorktreeGcDeps> = {}) {
    const deps: WorktreeGcDeps = {
      db,
      worktreeStore: {
        list: (): StoredWorktree[] => rows,
        update: (id, patch) => { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); return r; },
        create: (i) => { const r: Row = { id: `row-${nextId++}`, ...i, status: "pending", createdAt: new Date().toISOString() }; rows.push(r); return r; },
        listNamesForProject: (pid) => new Set(rows.filter((r) => r.projectId === pid).map((r) => r.name ?? "")),
      },
      worktreeManager: {
        worktreesDir: () => root,
        delete: async (id) => { deleted.push(id); const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); return true; },
      },
      projectStore: { get: () => ({ path: repo }), list: () => [{ id: "p1", slug: "proj", path: repo }] },
      getTopicBySessionKey: () => null,
      resolveTopicCwd: () => null,
      svc: { get: () => null, release: () => undefined, addComment: () => undefined },
      broadcast: () => undefined,
      isInFlight: () => false,
      worktreeOfTask: () => null,
      deliveryIsOnMain: async () => null,
      previewList: () => [],
      previewTeardown: async () => undefined,
      liveCwds: () => live,
      git: defaultRunGit,
      settings: () => ({ abandonDays: 7, gcForeign: "off", maxPerProject: 50 }),
      ...over,
    };
    return createWorktreeGcRunner(deps);
  }

  test("an orphan with a .git is registered, then judged like any other row", async () => {
    const abs = mountAt("lost-one");
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 1, ghostsRemoved: 0 });
    // The row exists with the mode git implies, and the same pass judged it: no task, clean, level with main.
    expect(deleted).toHaveLength(1);
    expect(summary!.reaped).toBe(1);
    expect(abs).toContain("lost-one");
  });

  test("the tip of an unmerged branch is pinned under the archive ref before its checkout is freed", async () => {
    const abs = mountAt("work-one");
    writeFileSync(join(abs, "work.txt"), "the work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "work").code).toBe(0);
    const tip = git(abs, "rev-parse", "HEAD").out;
    // Writing and committing touched the folder: age it again AFTER the work, or on a filesystem
    // with a real birth time (Linux) it reads as born a moment ago and the pass waits.
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    // The orphan is registered, judged unmerged and with no task: the checkout goes, the commits stay reachable.
    expect(summary!.root).toMatchObject({ registered: 1 });
    expect(deleted).toHaveLength(1);
    expect(git(repo, "rev-parse", "--verify", `refs/topics/archive/wt-${deleted[0]}`).out).toBe(tip);
  });

  test("an orphan on a detached HEAD with a commit not on main is never reaped: the folder is the only ref", async () => {
    const abs = join(root, "proj", "detached-one");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "--detach", abs, "main").code).toBe(0);
    writeFileSync(join(abs, "only-here.txt"), "work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "only on this HEAD").code).toBe(0);
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 1 });
    expect(deleted).toEqual([]);
    expect(existsSync(abs)).toBe(true);
  });

  test("a reuse row inside the root whose branch has commits not on main is kept, not reaped as if merged", async () => {
    const abs = join(root, "proj", "moved-in");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", "feature-x", abs, "main").code).toBe(0);
    writeFileSync(join(abs, "feature.txt"), "feature\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "feature").code).toBe(0);
    rows.push({ id: "moved", projectId: "p1", absPath: abs, branchName: "feature-x", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    await runner().runWorktreeGc();
    expect(deleted).toEqual([]);
    expect(existsSync(abs)).toBe(true);
  });

  test("a standalone clone (a .git DIRECTORY) under the root is never registered nor removed: it is not a worktree", async () => {
    const abs = join(root, "proj", "hand-clone");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(base, "clone", "-q", repo, abs).code).toBe(0);
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 0, ghostsRemoved: 0 });
    expect(deleted).toEqual([]);
    expect(rows).toEqual([]);
    expect(existsSync(join(abs, ".git"))).toBe(true);
  });

  test("a worktree locked by another tool is kept, whatever the sweep would say", async () => {
    const abs = mountAt("held-one");
    rows.push({ id: "held", projectId: "p1", absPath: abs, branchName: "topics/held-one", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    expect(git(repo, "worktree", "lock", "--reason", "another tool", abs).code).toBe(0);
    await runner().runWorktreeGc();
    expect(deleted).toEqual([]);
    expect(existsSync(abs)).toBe(true);
  });

  test("a young orphan is left alone: a create may still be in flight", async () => {
    mountAt("fresh-one", 60_000);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 0 });
    expect(rows).toHaveLength(0);
  });

  test("a ghost a day old goes; a young one, one with a session inside and one with a .git stay", async () => {
    const old = ghost("old-ghost");
    const young = ghost("young-ghost", 60_000);
    const busy = ghost("busy-ghost");
    live.push(join(busy, "sub"));
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ ghostsRemoved: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(busy)).toBe(true);
  });

  test("a folder git lists is not a ghost, even without a .git file", async () => {
    const abs = mountAt("listed-one");
    rmSync(join(abs, ".git"));
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(existsSync(abs)).toBe(true);
    expect(summary!.root!.ghostsRemoved).toBe(0);
  });

  test("a row without a folder is closed by the sweep, `error` rows included", async () => {
    rows.push({ id: "err-1", projectId: "p1", absPath: join(root, "proj", "never-made"), branchName: "topics/never-made", mode: "branch", status: "error", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    rows.push({ id: "err-young", projectId: "p1", absPath: join(root, "proj", "just-failed"), branchName: "topics/just-failed", mode: "branch", status: "error", createdAt: new Date().toISOString() });
    await runner().runWorktreeGc();
    expect(deleted).toEqual(["err-1"]);
  });

  test("a row outside the root is inventory: it is never removed, and the pass counts it", async () => {
    const outside = join(base, "elsewhere");
    mkdirSync(outside, { recursive: true });
    rows.push({ id: "adopted", projectId: "p1", absPath: outside, branchName: "topics/x", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    const gc = runner();
    const summary = await gc.runWorktreeGc();
    expect(deleted).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    const plan = await gc.planWorktreeGc();
    expect(plan!.entries.find((e) => e.rowId === "adopted")).toMatchObject({ cls: "foreign", action: "inventory" });
    expect(summary!.foreignRemoved).toBeUndefined();
  });

  test("gc_foreign=merged removes an adopted worktree already on main, clean and idle, keeping its branch", async () => {
    const outside = join(base, "adopted-wt");
    expect(git(repo, "worktree", "add", "-q", "-b", "side", outside, "main").code).toBe(0);
    rows.push({ id: "adopted", projectId: "p1", absPath: outside, branchName: "side", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    const removed: Array<{ id: string; opts: unknown }> = [];
    const gc = runner({
      worktreeManager: { worktreesDir: () => root, delete: async (id, opts) => { removed.push({ id, opts }); return true; } },
      settings: () => ({ abandonDays: 7, gcForeign: "merged", maxPerProject: 50 }),
    });
    const summary = await gc.runWorktreeGc();
    expect(summary!.foreignRemoved).toBe(1);
    expect(removed).toEqual([{ id: "adopted", opts: { deleteBranch: false, includeForeign: true } }]);
  });

  test("gc_foreign=merged keeps one with uncommitted work", async () => {
    const outside = join(base, "dirty-wt");
    expect(git(repo, "worktree", "add", "-q", "-b", "side2", outside, "main").code).toBe(0);
    writeFileSync(join(outside, "work.txt"), "unsaved\n");
    rows.push({ id: "dirty", projectId: "p1", absPath: outside, branchName: "side2", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    const gc = runner({ settings: () => ({ abandonDays: 7, gcForeign: "merged", maxPerProject: 50 }) });
    const summary = await gc.runWorktreeGc();
    expect(summary!.foreignRemoved).toBe(0);
    expect(deleted).toEqual([]);
  });

  test("a lock Topics took on a worktree whose folder is gone is lifted so git can forget it", async () => {
    const abs = mountAt("vanished-one");
    await lockOwned(defaultRunGit, repo, abs, "vanished-one");
    rmSync(abs, { recursive: true, force: true });
    const summary = await runner().runWorktreeGc();
    expect(summary!.root!.pruned).toBe(1);
    expect(git(repo, "worktree", "list", "--porcelain").out).not.toContain("vanished-one");
  });

  test("the preview writes nothing and says what each folder is", async () => {
    mountAt("p-orphan");
    ghost("p-ghost");
    rows.push({ id: "gone-row", projectId: "p1", absPath: join(root, "proj", "p-missing"), branchName: "topics/p-missing", mode: "branch", status: "error", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    const before = readdirSync(join(root, "proj")).sort();
    const plan = await runner().planWorktreeGc({ weigh: true });
    expect(readdirSync(join(root, "proj")).sort()).toEqual(before);
    expect(rows).toHaveLength(1);
    expect(deleted).toEqual([]);
    const byName = Object.fromEntries(plan!.entries.map((e) => [e.absPath.split("/").pop(), e]));
    expect(byName["p-orphan"]).toMatchObject({ cls: "orphan", action: "register" });
    expect(byName["p-ghost"]).toMatchObject({ cls: "ghost", action: "remove-folder" });
    expect(byName["p-missing"]).toMatchObject({ cls: "row-no-folder", action: "close-row" });
    expect(byName["p-ghost"]!.bytes).toBeGreaterThan(0);
    expect(byName["p-missing"]!.bytes).toBeNull();
    expect(plan!.scanMs).toBeGreaterThanOrEqual(0);
  });

  test("the preview runs the real decision on tracked rows: a clean, merged, task-less row would be reaped", async () => {
    const abs = mountAt("tracked-one");
    rows.push({ id: "t1", projectId: "p1", absPath: abs, branchName: "topics/tracked-one", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    const plan = await runner().planWorktreeGc();
    const e = plan!.entries.find((x) => x.rowId === "t1")!;
    expect(e).toMatchObject({ cls: "tracked" });
    expect(e.planned).toMatchObject({ action: "reap" });
    expect(deleted).toEqual([]);
  });

  test("a row that fails three passes in a row is left alone from the fourth", async () => {
    rows.push({ id: "stuck", projectId: "p1", absPath: join(root, "proj", "stuck"), branchName: "topics/stuck", mode: "branch", status: "error", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    let calls = 0;
    const gc = runner({ worktreeManager: { worktreesDir: () => root, delete: async () => { calls++; return false; } } });
    for (let i = 0; i < 5; i++) await gc.runWorktreeGc();
    expect(calls).toBe(3);
  });

  test("a host that cannot name its root runs no root pass at all", async () => {
    ghost("untouchable");
    const gc = runner({ worktreeManager: { delete: async () => true } });
    const summary = await gc.runWorktreeGc();
    expect(summary!.root).toBeUndefined();
    expect(existsSync(join(root, "proj", "untouchable"))).toBe(true);
  });
});
