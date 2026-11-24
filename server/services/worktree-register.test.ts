/**
 * The registration door for worktrees another tool made: idempotent on the path,
 * silent on an unknown repository, a row and a v2 marker inside the root, a
 * `reuse` row and no marker outside it. Inside the root it also writes the root
 * ledger's entry, the GC's proof that the folder came through Topics.
 *
 * @covers WORKTREE-STD-08, WORKTREE-STD-16
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createWorktreeStore } from "./worktree-store";
import { canonicalPath, readOwnerMarker, worktreeAdminDir, writeOwnerMarker } from "./worktree-owner";
import { placementFor, placementForProject, registerWorktree, forgetWorktree, type RegisterDeps } from "./worktree-register";
import { folderOwned, forgetFolderOwned, hasRootSentinel, markFolderOwned, writeRootSentinel } from "./worktree-root-ledger";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function freshStore() {
  const db = new Database(":memory:");
  const dir = join(import.meta.dir, "../db/migrations");
  db.run("CREATE TABLE projects (id TEXT PRIMARY KEY)");
  db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  db.run(readFileSync(join(dir, "017-worktrees.sql"), "utf8"));
  db.run(readFileSync(join(dir, "20261124120000-worktrees-source.sql"), "utf8"));
  db.run("INSERT INTO projects (id) VALUES ('p1')");
  return createWorktreeStore(db);
}

let base: string;
let repo: string;
let root: string;
let inside: string;
let outside: string;
let strangerRepo: string;
let strangerWt: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "wt-register-")));
  repo = join(base, "repo");
  git(base, "init", "-q", "-b", "main", "repo");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  root = join(base, "root");
  inside = join(root, "repo", "bold-oak");
  outside = join(base, "elsewhere", "loose");
  git(repo, "worktree", "add", "-q", "-b", "worktree-bold-oak", inside);
  git(repo, "worktree", "add", "-q", "-b", "loose", outside);
  strangerRepo = join(base, "stranger");
  git(base, "init", "-q", "-b", "main", "stranger");
  git(strangerRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  strangerWt = join(root, "stranger", "x");
  git(strangerRepo, "worktree", "add", "-q", "-b", "x", strangerWt);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function deps(store: RegisterDeps["store"] = freshStore(), over: Partial<RegisterDeps> = {}): RegisterDeps {
  return {
    platform: "darwin",
    roots: () => [root],
    canonical: (p) => canonicalPath(p),
    projectFor: (p) => (p.startsWith(repo) || p.startsWith(join(root, "repo")) || p.startsWith(join(base, "elsewhere"))
      ? { id: "p1", slug: "repo", path: repo } : null),
    isLinkedWorktree: (p) => worktreeAdminDir(p) !== null,
    exists: (p) => existsSync(p),
    headBranch: async (p) => git(p, "rev-parse", "--abbrev-ref", "HEAD"),
    store,
    readMarker: readOwnerMarker,
    writeMarker: writeOwnerMarker,
    markOwned: (r, p, info) => writeRootSentinel(r) && markFolderOwned(r, p, info),
    forgetOwned: forgetFolderOwned,
    machine: () => "test-host",
    now: () => new Date("2026-11-24T10:00:00Z"),
    ...over,
  };
}

describe("POST /api/worktrees/register, the decisions", () => {
  test("inside the root: a ready row with its creator, and the v2 marker", async () => {
    const d = deps();
    const r = await registerWorktree(d, { path: inside, creator: "claude-code", session: { id: "s-1", transcript: "/t/s-1.jsonl" } });
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body).toMatchObject({ class: "tracked", inRoot: true, created: true });
    const row = d.store.getByAbsPath(inside)!;
    expect(row).toMatchObject({ status: "ready", mode: "branch", branchName: "worktree-bold-oak", source: "claude-code", sessionRef: "/t/s-1.jsonl" });
    expect(readOwnerMarker(inside)).toMatchObject({ worktreeId: row.id, projectId: "p1", creator: "claude-code", session: { id: "s-1", transcript: "/t/s-1.jsonl" }, machine: "test-host" });
    // The ledger entry under the root: the proof the GC asks, still there if the `.git` goes.
    expect(folderOwned(root, inside)).toBe(true);
    expect(hasRootSentinel(root)).toBe(true);
  });

  test("idempotent: the second call answers the same row and creates nothing", async () => {
    const d = deps();
    const a = await registerWorktree(d, { path: inside, creator: "claude-code" });
    const b = await registerWorktree(d, { path: inside + "/", creator: "claude-code" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    if (a.status !== 200 || b.status !== 200) return;
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.created).toBe(false);
    expect(d.store.list()).toHaveLength(1);
  });

  test("an unknown repository: 202, an inventory answer, and nothing written anywhere", async () => {
    const d = deps();
    const adminBefore = readdirSync(worktreeAdminDir(strangerWt)!).sort();
    const r = await registerWorktree(d, { path: strangerWt, creator: "codex" });
    expect(r).toEqual({ status: 202, body: { class: "inventory", inRoot: true } });
    expect(d.store.list()).toHaveLength(0);
    expect(readdirSync(worktreeAdminDir(strangerWt)!).sort()).toEqual(adminBefore);
  });

  test("outside the root: a reuse row and no marker (the folder is not Topics' to mark)", async () => {
    const d = deps();
    const r = await registerWorktree(d, { path: outside, creator: "codex" });
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body).toMatchObject({ class: "foreign", inRoot: false });
    expect(d.store.getByAbsPath(outside)).toMatchObject({ mode: "reuse", source: "codex" });
    expect(readOwnerMarker(outside)).toBeNull();
    expect(existsSync(join(base, "elsewhere", ".topics-owned"))).toBe(false);
  });

  test("refusals: relative path, missing or `topics` creator, a main checkout, a bad session", async () => {
    const d = deps();
    expect((await registerWorktree(d, { path: "rel/x", creator: "codex" })).status).toBe(400);
    expect((await registerWorktree(d, { path: inside, creator: "topics" })).status).toBe(400);
    expect((await registerWorktree(d, { path: inside, creator: "nobody" })).status).toBe(400);
    expect((await registerWorktree(d, { path: repo, creator: "codex" })).status).toBe(400);
    expect((await registerWorktree(d, { path: inside, creator: "codex", session: { id: "s", transcript: "rel" } })).status).toBe(400);
    expect(d.store.list()).toHaveLength(0);
  });

  test("a branch the creator did not make stays the user's: `reuse`, never deleted by the cleanup", async () => {
    // A hand-made `git worktree add <root>/repo/feat feature` registered by the
    // post-checkout hook: `mode: branch` would make the removal `git branch -D feature`.
    const feat = join(root, "repo", "feat");
    git(repo, "branch", "feature");
    git(repo, "worktree", "add", "-q", feat, "feature");
    try {
      const d = deps();
      const r = await registerWorktree(d, { path: feat, creator: "adopted" });
      expect(r.status).toBe(200);
      expect(d.store.getByAbsPath(feat)).toMatchObject({ mode: "reuse", branchName: "feature" });
    } finally {
      git(repo, "worktree", "remove", "--force", feat);
    }
  });

  test("the branch is read off the checkout, never taken from the body", async () => {
    // A body naming `main` would put `git branch -D main` in the removal of a `branch` row.
    const d = deps();
    const r = await registerWorktree(d, { path: inside, creator: "claude-code", branch: "main" });
    expect(r.status).toBe(200);
    expect(d.store.getByAbsPath(inside)).toMatchObject({ mode: "branch", branchName: "worktree-bold-oak" });
  });

  test("two registrations of one path at once: one row, both answered 200", async () => {
    // The hook and a cleanup pass (or a retried call) can land together; the second
    // must read the first one's row, not throw on the UNIQUE path.
    const slow = deps(freshStore(), { headBranch: async (p) => { await Bun.sleep(20); return git(p, "rev-parse", "--abbrev-ref", "HEAD"); } });
    const [a, b] = await Promise.all([
      registerWorktree(slow, { path: inside, creator: "claude-code" }),
      registerWorktree(slow, { path: inside, creator: "claude-code" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    if (a.status !== 200 || b.status !== 200) return;
    expect(b.body.id).toBe(a.body.id);
    expect(slow.store.list()).toHaveLength(1);
  });

  test("a Windows path is accepted with platform win32", async () => {
    const store = freshStore();
    const d = deps(store, {
      platform: "win32",
      roots: () => ["E:\\wt"],
      canonical: (p) => p.replace(/\//g, "\\"),
      projectFor: () => ({ id: "p1", slug: "repo", path: "E:\\repo" }),
      isLinkedWorktree: () => true,
      exists: () => true,
      headBranch: async () => "worktree-x",
      readMarker: () => null,
      writeMarker: () => true,
      // A Windows root is not a folder of this machine: the ledger write is recorded, never done.
      markOwned: (r, p) => { owned.push(`${r}|${p}`); return true; },
    });
    const owned: string[] = [];
    const r = await registerWorktree(d, { path: "E:\\wt\\repo\\x", creator: "claude-code" });
    expect(r.status).toBe(200);
    if (r.status === 200) expect(r.body.inRoot).toBe(true);
    expect(owned).toEqual(["E:\\wt|E:\\wt\\repo\\x"]);
  });
});

describe("placement and unregister", () => {
  test("placement: the root and the project's slug, from git's common dir too", () => {
    const d = deps();
    expect(placementFor(d, join(repo, ".git"))).toEqual({ status: 200, body: { root, slug: "repo", projectId: "p1" } });
    expect(placementFor(d, strangerRepo)).toEqual({ status: 200, body: { root, slug: "stranger", projectId: null } });
    expect(placementFor(d, "rel").status).toBe(400);
  });

  test("placement by project (`topics-worktree add <project>`): the root, the slug and the repository", () => {
    const d = deps(undefined, { projectByRef: (ref) => (ref === "repo" || ref === "p1" ? { id: "p1", slug: "repo", path: repo } : null) });
    expect(placementForProject(d, "repo")).toEqual({ status: 200, body: { root, slug: "repo", projectId: "p1", repo } });
    expect(placementForProject(d, "p1").status).toBe(200);
    expect(placementForProject(d, "nope").status).toBe(404);
    expect(placementForProject(d, "").status).toBe(400);
    expect(placementForProject(deps(), "repo").status).toBe(404);
  });

  test("unregister: a folder still there is refused, a gone one loses its row", async () => {
    const d = deps();
    const r = await registerWorktree(d, { path: outside, creator: "codex" });
    expect(r.status).toBe(200);
    expect(forgetWorktree(d, outside).status).toBe(409);
    expect(d.store.list()).toHaveLength(1);
    const gone = deps(d.store, { exists: () => false });
    expect(forgetWorktree(gone, outside)).toMatchObject({ status: 200, body: { removed: true } });
    expect(d.store.list()).toHaveLength(0);
    expect(forgetWorktree(gone, outside)).toEqual({ status: 200, body: { removed: false, id: null } });
  });

  test("unregister of a folder gone from the root drops its ledger entry with the row", async () => {
    const d = deps();
    const gonePath = join(root, "repo", "gone-oak");
    git(repo, "worktree", "add", "-q", "-b", "worktree-gone-oak", gonePath);
    expect((await registerWorktree(d, { path: gonePath, creator: "codex" })).status).toBe(200);
    expect(folderOwned(root, gonePath)).toBe(true);
    // The folder goes; its entry stays until the door is told.
    git(repo, "worktree", "remove", "--force", gonePath);
    expect(folderOwned(root, gonePath)).toBe(true);
    expect(forgetWorktree(deps(d.store), gonePath)).toMatchObject({ status: 200, body: { removed: true } });
    expect(existsSync(join(root, ".topics-owned", "repo", "gone-oak"))).toBe(false);
  });

  test("unregister never drops a row Topics made: its own delete handles branch and card", () => {
    const store = freshStore();
    const own = store.create({ projectId: "p1", name: "card", branchName: "topics/card", baseRef: "main", mode: "branch", absPath: join(root, "repo", "card") });
    const gone = deps(store, { exists: () => false });
    expect(forgetWorktree(gone, own.absPath).status).toBe(409);
    expect(store.get(own.id)).not.toBeNull();
  });
});
