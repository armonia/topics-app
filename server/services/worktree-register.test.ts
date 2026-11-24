/**
 * The registration door for worktrees another tool made: idempotent on the path,
 * silent on an unknown repository, a row and a v2 marker inside the root, a
 * `reuse` row and no marker outside it.
 *
 * @covers WORKTREE-STD-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createWorktreeStore } from "./worktree-store";
import { canonicalPath, readOwnerMarker, worktreeAdminDir, writeOwnerMarker } from "./worktree-owner";
import { placementFor, registerWorktree, unregisterWorktree, type RegisterDeps } from "./worktree-register";
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
    });
    const r = await registerWorktree(d, { path: "E:\\wt\\repo\\x", creator: "claude-code" });
    expect(r.status).toBe(200);
    if (r.status === 200) expect(r.body.inRoot).toBe(true);
  });
});

describe("placement and unregister", () => {
  test("placement: the root and the project's slug, from git's common dir too", () => {
    const d = deps();
    expect(placementFor(d, join(repo, ".git"))).toEqual({ status: 200, body: { root, slug: "repo", projectId: "p1" } });
    expect(placementFor(d, strangerRepo)).toEqual({ status: 200, body: { root, slug: "stranger", projectId: null } });
    expect(placementFor(d, "rel").status).toBe(400);
  });

  test("unregister: a folder still there is refused, a gone one loses its row", async () => {
    const d = deps();
    const r = await registerWorktree(d, { path: outside, creator: "codex" });
    expect(r.status).toBe(200);
    expect(unregisterWorktree(d, outside).status).toBe(409);
    expect(d.store.list()).toHaveLength(1);
    const gone = deps(d.store, { exists: () => false });
    expect(unregisterWorktree(gone, outside)).toMatchObject({ status: 200, body: { removed: true } });
    expect(d.store.list()).toHaveLength(0);
    expect(unregisterWorktree(gone, outside)).toEqual({ status: 200, body: { removed: false, id: null } });
  });
});
