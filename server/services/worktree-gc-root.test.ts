/**
 * THE GC LOOKS AT THE DISK: orphans are registered, ghosts Topics made moved to
 * quarantine, rows without a folder closed, foreign folders only listed, and a
 * preview writes nothing. And it never touches what Topics did not make: user
 * data under the root, a checkout at the level of a project folder, a folder
 * without Topics' marker, a root it was not given.
 * Real git and real folders under `mkdtemp`; the store and the manager are fakes
 * that record what they are asked.
 *
 * The root pass hands what it finds to the sweep of WORKTREE-09, and these tests run both on real git:
 * an orphan is registered and then judged like any other row, an unmerged tip is pinned under the
 * archive ref before its checkout is freed, a locked or young folder is kept. That meeting is the one
 * `**Intersects:**` declares, hence the joint group below.
 *
 * @covers WORKTREE-STD-03+WORKTREE-09
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeGcRunner, type WorktreeGcDeps } from "./worktree-gc-runner";
import type { StoredWorktree } from "./worktree-gc-root-pass";
import { lockOwned, writeOwnerMarker } from "./worktree-owner";
import { folderOwned, markFolderOwned, OWNED_DIR, QUARANTINE_DIR, listQuarantine } from "./worktree-root-ledger";
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
    // `create` writes this marker before `git worktree add`: an orphan Topics made carries it.
    markFolderOwned(root, abs);
    age(abs, ageMs);
    return abs;
  }
  function ghost(name: string, ageMs = 3 * DAY, owned = true): string {
    const abs = join(root, "proj", name);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, "leftover.txt"), "x");
    if (owned) markFolderOwned(root, abs);
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
    expect(summary!.root).toMatchObject({ registered: 1, ghostsQuarantined: 0 });
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

  test("a branch tip the hook's archive tag already holds is not pinned again: the checkout is freed, no second ref", async () => {
    const abs = mountAt("tagged-one");
    rows.push({ id: "tagged", projectId: "p1", absPath: abs, branchName: "topics/tagged-one", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    writeFileSync(join(abs, "work.txt"), "the work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "work").code).toBe(0);
    git(repo, "tag", "archive/wt-tagged-one", git(abs, "rev-parse", "HEAD").out);
    age(abs, 3 * DAY);
    await runner().runWorktreeGc();
    expect(deleted).toEqual(["tagged"]);
    expect(git(repo, "rev-parse", "--verify", "--quiet", "refs/topics/archive/wt-tagged").code).not.toBe(0);
  });

  test("an orphan on a detached HEAD with a commit not on main is never reaped: the folder is the only ref", async () => {
    const abs = join(root, "proj", "detached-one");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "--detach", abs, "main").code).toBe(0);
    markFolderOwned(root, abs);
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

  /** A worktree adopted on `feat` (already merged into main), later detached with a commit only it holds. */
  function adoptedThenDetached(abs: string, mode: "reuse" | "branch" = "reuse"): string {
    git(repo, "branch", "-q", "feat", "main");
    expect(git(repo, "worktree", "add", "-q", abs, "feat").code).toBe(0);
    rows.push({ id: "drifted", projectId: "p1", absPath: abs, branchName: "feat", mode, status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    git(abs, "checkout", "-q", "--detach");
    writeFileSync(join(abs, "work.txt"), "the only copy\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "unique work").code).toBe(0);
    age(abs, 3 * DAY);
    return git(abs, "rev-parse", "HEAD").out;
  }

  test("a reuse row whose HEAD left its merged branch for commits of its own is kept by the sweep: HEAD is judged, not the stored branch", async () => {
    const abs = join(root, "proj", "adopted");
    mkdirSync(join(root, "proj"), { recursive: true });
    adoptedThenDetached(abs);
    const summary = await runner().runWorktreeGc();
    expect(summary!.reaped).toBe(0);
    expect(deleted).toEqual([]);
    expect(existsSync(join(abs, "work.txt"))).toBe(true);
  });

  test("a branch row whose HEAD left its merged branch for commits of its own is kept too: Topics' own worktrees are judged by HEAD as well", async () => {
    const abs = join(root, "proj", "own");
    mkdirSync(join(root, "proj"), { recursive: true });
    markFolderOwned(root, abs, { worktreeId: "drifted", projectId: "p1" });
    adoptedThenDetached(abs, "branch");
    const summary = await runner().runWorktreeGc();
    expect(summary!.reaped).toBe(0);
    expect(deleted).toEqual([]);
    expect(existsSync(join(abs, "work.txt"))).toBe(true);
  });

  test("gc_foreign=merged keeps an adopted worktree whose HEAD left its merged branch for commits of its own", async () => {
    const abs = join(base, "elsewhere", "adopted");
    mkdirSync(join(base, "elsewhere"), { recursive: true });
    adoptedThenDetached(abs);
    const summary = await runner({ settings: () => ({ abandonDays: 7, gcForeign: "merged", maxPerProject: 50 }) }).runWorktreeGc();
    expect(summary!.foreignRemoved).toBe(0);
    expect(deleted).toEqual([]);
  });

  test("a worktree a person made by hand in the root, with no Topics marker, is listed only: no row, no removal, its ignored .env intact", async () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    const abs = join(root, "proj", "my-own");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", "mine", abs, "main").code).toBe(0);
    writeFileSync(join(abs, ".env"), "API_KEY=only-copy\n");
    age(abs, 3 * DAY);
    const gc = runner();
    const summary = await gc.runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 0 });
    expect(rows).toEqual([]);
    expect(deleted).toEqual([]);
    expect(existsSync(join(abs, ".env"))).toBe(true);
    // Nothing writes Topics' proof for it after the fact.
    expect(folderOwned(root, abs)).toBe(false);
    const plan = await gc.planWorktreeGc();
    expect(plan!.entries.find((e) => e.absPath.endsWith("/my-own"))).toMatchObject({ cls: "orphan", action: "inventory" });
  });

  test("a row that already sat in the root before the marker existed earns its marker on the first pass", async () => {
    const abs = join(root, "proj", "before-upgrade");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", "topics/before-upgrade", abs, "main").code).toBe(0);
    rows.push({ id: "old-row", projectId: "p1", absPath: abs, branchName: "topics/before-upgrade", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    live.push(abs);
    expect(existsSync(join(root, OWNED_DIR, "proj", "before-upgrade"))).toBe(false);
    await runner().runWorktreeGc();
    expect(existsSync(join(root, OWNED_DIR, "proj", "before-upgrade"))).toBe(true);
  });

  test("a standalone clone (a .git DIRECTORY) under the root is never registered nor removed: it is not a worktree", async () => {
    const abs = join(root, "proj", "hand-clone");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(base, "clone", "-q", repo, abs).code).toBe(0);
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 0, ghostsQuarantined: 0 });
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

  test("a minute-old folder with a v2 marker naming codex is registered at once, with its creator and session, and the sweep keeps it", async () => {
    // What `topics-worktree add` leaves when Topics is down: the ledger entry and a
    // v2 marker, no lock, no row. Registered on this pass, never reaped the same day.
    const abs = mountAt("codex-made", 60_000);
    const transcript = join(base, "codex-session.jsonl");
    writeFileSync(transcript, "{}\n");
    expect(writeOwnerMarker(abs, {
      worktreeId: "codex-made", projectId: "p1", createdAt: new Date().toISOString(),
      creator: "codex", session: { id: "s-codex", transcript },
    })).toBe(true);
    age(abs, 60_000);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "codex", sessionRef: transcript });
    expect(summary!.keptReasons["made by another tool less than N h ago"]).toBe(1);
    expect(deleted).toEqual([]);
    expect(existsSync(abs)).toBe(true);
  });

  test("a ghost Topics made, a day old, goes to quarantine intact; a young one and one with a session inside stay", async () => {
    const old = ghost("old-ghost");
    const young = ghost("young-ghost", 60_000);
    const busy = ghost("busy-ghost");
    live.push(join(busy, "sub"));
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ ghostsQuarantined: 1 });
    expect(existsSync(old)).toBe(false);
    const q = listQuarantine(root);
    expect(q.map((x) => x.from)).toEqual([old]);
    expect(existsSync(join(q[0]!.path, "leftover.txt"))).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(busy)).toBe(true);
  });

  test("a ghost without Topics' marker is only listed, however old", async () => {
    const stranger = ghost("stranger", 400 * DAY, false);
    const gc = runner();
    const summary = await gc.runWorktreeGc();
    expect(summary!.root).toMatchObject({ ghostsQuarantined: 0 });
    expect(existsSync(join(stranger, "leftover.txt"))).toBe(true);
    const plan = await gc.planWorktreeGc();
    expect(plan!.entries.find((e) => e.absPath.endsWith("/stranger"))).toMatchObject({ cls: "ghost", action: "inventory" });
  });

  test("the quarantine is deleted after the days of the setting, and the preview shows it with its origin until then", async () => {
    const old = ghost("purge-me");
    await runner().runWorktreeGc();
    const [q] = listQuarantine(root);
    expect(q!.from).toBe(old);
    const plan = await runner().planWorktreeGc();
    expect(plan!.entries.find((e) => e.cls === "quarantined")).toMatchObject({ action: "wait", from: old });
    // Ten days later (the day folder is renamed back in time): the pass deletes it.
    const dayDir = join(root, QUARANTINE_DIR, readdirSync(join(root, QUARANTINE_DIR))[0]!);
    renameSync(dayDir, join(root, QUARANTINE_DIR, "2020-01-01"));
    const summary = await runner({ settings: () => ({ abandonDays: 7, gcForeign: "off", maxPerProject: 50, quarantineDays: 7 }) }).runWorktreeGc();
    expect(summary!.root).toMatchObject({ purged: 1 });
    expect(listQuarantine(root)).toEqual([]);
  });

  test("a root holding user data older than 24 h stays intact: nothing there carries Topics' marker", async () => {
    // The root a person might type by mistake: their home, a folder of projects, of documents.
    for (const rel of ["Documents/taxes", "Projects/app/src", "Code/site/docs", "Pictures/2026"]) {
      const p = join(root, rel);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "keep.txt"), "mine");
      age(p, 30 * DAY);
    }
    const before = readdirSync(root).sort();
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ ghostsQuarantined: 0, purged: 0 });
    expect(readdirSync(root).sort()).toEqual(before);
    for (const rel of ["Documents/taxes", "Projects/app/src", "Code/site/docs", "Pictures/2026"]) expect(existsSync(join(root, rel, "keep.txt"))).toBe(true);
  });

  test("a checkout at the level of a project folder is untouched, its src/docs/tests never read as ghosts", async () => {
    const checkout = join(root, "whole-checkout");
    expect(git(base, "clone", "-q", repo, checkout).code).toBe(0);
    for (const sub of ["src", "docs", "tests"]) {
      mkdirSync(join(checkout, sub), { recursive: true });
      writeFileSync(join(checkout, sub, "f.txt"), sub);
      // Even a marker planted there does not make them Topics': the parent has a `.git`.
      markFolderOwned(root, join(checkout, sub));
      age(join(checkout, sub), 30 * DAY);
    }
    const gc = runner();
    const summary = await gc.runWorktreeGc();
    expect(summary!.root).toMatchObject({ ghostsQuarantined: 0, registered: 0 });
    for (const sub of ["src", "docs", "tests"]) expect(existsSync(join(checkout, sub, "f.txt"))).toBe(true);
    const plan = await gc.planWorktreeGc();
    expect(plan!.entries.find((e) => e.absPath.endsWith("/whole-checkout"))).toMatchObject({ cls: "foreign", action: "inventory" });
  });

  test("a {slug} folder that is a known project's own path is never descended into", async () => {
    const projectDir = join(root, "proj-as-project");
    mkdirSync(join(projectDir, "lib"), { recursive: true });
    markFolderOwned(root, join(projectDir, "lib"));
    age(join(projectDir, "lib"), 30 * DAY);
    const gc = runner({ projectStore: { get: () => ({ path: repo }), list: () => [{ id: "p1", slug: "proj", path: repo }, { id: "p2", slug: "proj-as-project", path: projectDir }] } });
    await gc.runWorktreeGc();
    expect(existsSync(join(projectDir, "lib"))).toBe(true);
  });

  test("THE INCIDENT: a caller that passes a root scans only that root, never the default one under the home", async () => {
    // A decoy Topics home with a perfect ghost in its default root: marked, a month old, nobody inside.
    const decoyHome = join(base, "decoy-home");
    const decoyGhost = join(decoyHome, "worktrees", "proj", "real-folder");
    mkdirSync(decoyGhost, { recursive: true });
    writeFileSync(join(decoyGhost, "precious.txt"), "x");
    markFolderOwned(join(decoyHome, "worktrees"), decoyGhost);
    age(decoyGhost, 30 * DAY);
    const saved = process.env.TOPICS_HOME;
    process.env.TOPICS_HOME = decoyHome;
    try {
      const gc = runner();
      await gc.runWorktreeGc();
      const plan = await gc.planWorktreeGc();
      expect(plan!.entries.some((e) => e.absPath.includes("decoy-home"))).toBe(false);
    } finally {
      process.env.TOPICS_HOME = saved;
    }
    expect(existsSync(join(decoyGhost, "precious.txt"))).toBe(true);
  });

  test("an orphan whose git registration is lost is listed, never registered nor reaped", async () => {
    const abs = mountAt("lost-registration");
    writeFileSync(join(abs, "uncommitted.txt"), "only here\n");
    rmSync(join(repo, ".git", "worktrees", "lost-registration"), { recursive: true, force: true });
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(summary!.root).toMatchObject({ registered: 0, ghostsQuarantined: 0 });
    expect(rows).toEqual([]);
    expect(deleted).toEqual([]);
    expect(existsSync(join(abs, "uncommitted.txt"))).toBe(true);
  });

  test("gc_foreign=merged keeps an adopted worktree while a chat bound to its row is mid-turn, or a terminal session works in it", async () => {
    const outside = join(base, "adopted-busy");
    expect(git(repo, "worktree", "add", "-q", "-b", "side-busy", outside, "main").code).toBe(0);
    rows.push({ id: "adopted", projectId: "p1", absPath: outside, branchName: "side-busy", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 9 * DAY).toISOString() });
    db.run("INSERT INTO topics (id, session_key, worktree_id) VALUES ('t1', 'k1', 'adopted')");
    const merged = { settings: () => ({ abandonDays: 7, gcForeign: "merged" as const, maxPerProject: 50 }) };
    const chatting = await runner({ ...merged, chatActive: () => true }).runWorktreeGc();
    expect(chatting!.foreignRemoved).toBe(0);
    db.run("DELETE FROM topics");
    const external = await runner({ ...merged, externalActiveAt: (p) => p === outside }).runWorktreeGc();
    expect(external!.foreignRemoved).toBe(0);
    expect(deleted).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });

  test("the by-hand relocation asks the same busy check: a chat mid-turn on the row, or an external session", async () => {
    const outside = join(base, "relocate-busy");
    mkdirSync(outside, { recursive: true });
    rows.push({ id: "rb", projectId: "p1", absPath: outside, branchName: null, mode: "detached", status: "ready", createdAt: new Date().toISOString() });
    db.run("INSERT INTO topics (id, session_key, worktree_id) VALUES ('t2', 'k2', 'rb')");
    expect(runner({ chatActive: () => true }).isBusyInside(outside)).toBe(true);
    expect(runner({ chatActive: () => false }).isBusyInside(outside)).toBe(false);
    expect(runner({ externalActiveAt: () => true }).isBusyInside(outside)).toBe(true);
  });

  test("a folder git lists is not a ghost, even without a .git file", async () => {
    const abs = mountAt("listed-one");
    rmSync(join(abs, ".git"));
    age(abs, 3 * DAY);
    const summary = await runner().runWorktreeGc();
    expect(existsSync(abs)).toBe(true);
    expect(summary!.root!.ghostsQuarantined).toBe(0);
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

  test("the hook's claude-code lock on a folder that went without its remove hook is lifted: the name is free again, the branch keeps its commit", async () => {
    const abs = join(root, "proj", "hook-made");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "-b", "worktree-hook-made", abs, "main").code).toBe(0);
    writeFileSync(join(abs, "work.txt"), "work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "work on the branch").code).toBe(0);
    const tip = git(abs, "rev-parse", "HEAD").out;
    expect(git(repo, "worktree", "lock", "--reason", "claude-code:sess-a", abs).code).toBe(0);
    // Somebody else's lock on a vanished folder is not ours to lift.
    const foreign = join(root, "proj", "other-tool");
    expect(git(repo, "worktree", "add", "-q", "--detach", foreign, "main").code).toBe(0);
    expect(git(repo, "worktree", "lock", "--reason", "codex:x", foreign).code).toBe(0);
    rmSync(abs, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
    const summary = await runner().runWorktreeGc();
    expect(summary!.root!.pruned).toBe(1);
    const listed = git(repo, "worktree", "list", "--porcelain").out;
    expect(listed).not.toContain("hook-made");
    expect(listed).toContain("other-tool");
    expect(git(repo, "rev-parse", "refs/heads/worktree-hook-made").out).toBe(tip);
    // The next `claude -w hook-made` can make it again.
    expect(git(repo, "worktree", "add", "-q", abs, "worktree-hook-made").code).toBe(0);
  });

  test("a vanished claude-code checkout on a detached HEAD has its commit pinned before git forgets it", async () => {
    const abs = join(root, "proj", "hook-detached");
    mkdirSync(join(root, "proj"), { recursive: true });
    expect(git(repo, "worktree", "add", "-q", "--detach", abs, "main").code).toBe(0);
    writeFileSync(join(abs, "only-here.txt"), "work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "only on this HEAD").code).toBe(0);
    const head = git(abs, "rev-parse", "HEAD").out;
    expect(git(repo, "worktree", "lock", "--reason", "claude-code:sess-b", abs).code).toBe(0);
    rmSync(abs, { recursive: true, force: true });
    const summary = await runner().runWorktreeGc();
    expect(summary!.root!.pruned).toBe(1);
    expect(git(repo, "worktree", "list", "--porcelain").out).not.toContain("hook-detached");
    expect(git(repo, "rev-parse", `refs/topics/archive/lost-${head}`).out).toBe(head);
  });

  /** What the Claude Code hook leaves for a session: worktree-<name> branch, lock, v2 marker, ledger entry. */
  function hookMade(name: string, session: string, opts: { detach?: boolean; transcriptAgeMs?: number } = {}): string {
    const abs = join(root, "proj", name);
    mkdirSync(join(root, "proj"), { recursive: true });
    const add = opts.detach ? ["--detach", abs, "main"] : ["-b", `worktree-${name}`, abs, "main"];
    expect(git(repo, "worktree", "add", "-q", ...add).code).toBe(0);
    const transcript = join(base, `${name}.jsonl`);
    writeFileSync(transcript, "{}\n");
    if (opts.transcriptAgeMs) age(transcript, opts.transcriptAgeMs);
    expect(writeOwnerMarker(abs, {
      worktreeId: name, projectId: "p1", createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
      creator: "claude-code", session: { id: session, transcript },
    })).toBe(true);
    expect(git(repo, "worktree", "lock", "--reason", `claude-code:${session}`, abs).code).toBe(0);
    markFolderOwned(root, abs);
    age(abs, 3 * DAY);
    return abs;
  }
  const lockOf = (abs: string) => {
    const block = git(repo, "worktree", "list", "--porcelain").out.split("\n\n").find((b) => b.split("\n")[0] === `worktree ${realpathSync(join(abs, ".."))}/${abs.split("/").pop()}`);
    return block?.split("\n").find((l) => l.startsWith("locked")) ?? null;
  };

  test("a present, row-less checkout under the hook's claude-code lock keeps its lock: only a folder surely gone is lifted", async () => {
    const abs = hookMade("live-hook", "sess-live");
    await runner().runWorktreeGc();
    expect(lockOf(abs)).toBe("locked claude-code:sess-live");
    expect(existsSync(abs)).toBe(true);
    expect(deleted).toEqual([]);
  });

  test("the hook's checkout with a row, whose folder then vanished: the lock is lifted, the row closed, the name free, the branch kept", async () => {
    const abs = hookMade("hook-row", "sess-r", { transcriptAgeMs: 30 * DAY });
    writeFileSync(join(abs, "work.txt"), "work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "work on the branch").code).toBe(0);
    const tip = git(abs, "rev-parse", "HEAD").out;
    // The row the hook's register door (or the first pass) makes for it.
    rows.push({ id: "hook-row", projectId: "p1", absPath: abs, branchName: "worktree-hook-row", mode: "reuse", status: "ready", createdAt: new Date(Date.now() - 30 * DAY).toISOString(), source: "claude-code" });
    rmSync(abs, { recursive: true, force: true });
    const summary = await runner().runWorktreeGc();
    expect(summary!.root!.pruned).toBe(1);
    expect(lockOf(abs)).toBeNull();
    expect(git(repo, "worktree", "list", "--porcelain").out).not.toContain("hook-row");
    expect(summary!.keptReasons["worktree bloccato da un altro (git worktree lock)"]).toBeUndefined();
    expect(deleted).toEqual(["hook-row"]);
    expect(git(repo, "rev-parse", "refs/heads/worktree-hook-row").out).toBe(tip);
    expect(git(repo, "worktree", "add", "-q", abs, "worktree-hook-row").code).toBe(0);
  });

  test("a vanished detached claude-code checkout whose commit cannot be pinned keeps its lock and its entry", async () => {
    const abs = hookMade("hook-nopin", "sess-p", { detach: true });
    writeFileSync(join(abs, "only-here.txt"), "work\n");
    git(abs, "add", "-A");
    expect(git(abs, "commit", "-q", "-m", "only on this HEAD").code).toBe(0);
    rmSync(abs, { recursive: true, force: true });
    const noPin: typeof defaultRunGit = async (cwd, args, opts) =>
      args[0] === "update-ref" && (args[1] ?? "").startsWith("refs/topics/archive/lost-")
        ? { code: 1, stdout: "", stderr: "refused by the test" }
        : defaultRunGit(cwd, args, opts);
    const summary = await runner({ git: noPin }).runWorktreeGc();
    expect(summary!.root!.pruned).toBe(0);
    expect(lockOf(abs)).toBe("locked claude-code:sess-p");
  });

  test("a vanished folder under Topics' own lock that a row claims is left to the sweep's removal, not pruned by the root pass", async () => {
    const abs = mountAt("row-own-lock");
    await lockOwned(defaultRunGit, repo, abs, "row-own-lock");
    rows.push({ id: "own", projectId: "p1", absPath: abs, branchName: "topics/row-own-lock", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
    rmSync(abs, { recursive: true, force: true });
    const summary = await runner().runWorktreeGc();
    expect(summary!.root!.pruned).toBe(0);
    // The fake manager records the removal and leaves git alone: the entry is still there for it.
    expect(lockOf(abs)).toBe("locked topics:row-own-lock");
  });

  test("another tool's clean, merged, task-less row older than 24 h is swept: its birth travels with the row", async () => {
    const abs = mountAt("codex-old");
    rows.push({ id: "codex-old", projectId: "p1", absPath: abs, branchName: "topics/codex-old", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString(), source: "codex" });
    await runner().runWorktreeGc();
    expect(deleted).toEqual(["codex-old"]);
  });

  test("git that cannot list the worktrees (no `-z` before 2.36): a live session's locked row is kept, read off the disk", async () => {
    const abs = hookMade("old-git", "sess-old");
    git(repo, "merge", "-q", "--ff-only", "worktree-old-git");
    rows.push({ id: "old-git", projectId: "p1", absPath: abs, branchName: "worktree-old-git", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 3 * DAY).toISOString(), source: "claude-code" });
    const noListZ: typeof defaultRunGit = async (cwd, args, opts) =>
      args[0] === "worktree" && args[1] === "list" && args.includes("-z")
        ? { code: 129, stdout: "", stderr: "error: unknown switch `z'" }
        : defaultRunGit(cwd, args, opts);
    const summary = await runner({ git: noListZ }).runWorktreeGc();
    expect(deleted).toEqual([]);
    expect(summary!.keptReasons["worktree bloccato da un altro (git worktree lock)"]).toBe(1);
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
    expect(byName["p-ghost"]).toMatchObject({ cls: "ghost", action: "quarantine" });
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

  test("a clean, merged, task-less row another tool registered minutes ago survives the real pass, and the preview says why", async () => {
    // What `topics-worktree add` or the post-checkout hook leaves for codex: a row with
    // its creator and its birth, no lock, no task, level with main.
    const abs = mountAt("codex-fresh");
    rows.push({ id: "codex-row", projectId: "p1", absPath: abs, branchName: "topics/codex-fresh", mode: "branch", status: "ready", createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), source: "codex" });
    const gc = runner();
    const plan = await gc.planWorktreeGc();
    expect(plan!.entries.find((e) => e.rowId === "codex-row")!.planned).toMatchObject({ action: "keep", reason: "made by another tool less than N h ago" });
    const summary = await gc.runWorktreeGc();
    expect(deleted).toEqual([]);
    expect(summary!.keptReasons["made by another tool less than N h ago"]).toBe(1);
    expect(existsSync(abs)).toBe(true);
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
