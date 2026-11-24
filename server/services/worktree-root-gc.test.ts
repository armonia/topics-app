/**
 * The classes of the worktree root: tracked, orphan, ghost, row without folder,
 * foreign. The classification is pure; the scan and the ghost removal are
 * checked on a temp folder that holds real directories, links and a `.git`.
 *
 * @covers WORKTREE-STD-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MIN_REMOVAL_AGE_MS, classifyRootEntry, countRoot, nameForAdopted, planRoot, projectOfFolder, registerOrphan,
  quarantineGhostFolder, scanWorktreeRoot, type RootFacts,
} from "./worktree-root-gc";
import { markFolderOwned, QUARANTINE_DIR } from "./worktree-root-ledger";

const DAY = 24 * 3600_000;
const facts = (over: Partial<RootFacts> = {}): RootFacts => ({
  hasRow: false, folderPresent: true, inRoot: true, hasDotGit: false, inGitList: false, isSymlink: false,
  liveInside: false, ageMs: 3 * DAY, projectKnown: true, owned: true, ...over,
});

describe("classifyRootEntry", () => {
  test("a row with its folder inside the root is judged by the sweep", () => {
    expect(classifyRootEntry(facts({ hasRow: true }))).toMatchObject({ cls: "tracked", action: "judge" });
  });

  test("a row whose folder is gone is closed once a day old, and waits before that", () => {
    expect(classifyRootEntry(facts({ hasRow: true, folderPresent: false, ageMs: 2 * DAY }))).toMatchObject({ cls: "row-no-folder", action: "close-row" });
    expect(classifyRootEntry(facts({ hasRow: true, folderPresent: false, ageMs: 60_000 }))).toMatchObject({ cls: "row-no-folder", action: "wait" });
  });

  test("a row outside the root is foreign: inventory, never removed by the sweep", () => {
    expect(classifyRootEntry(facts({ hasRow: true, inRoot: false }))).toMatchObject({ cls: "foreign", action: "inventory" });
  });

  test("no row, a `.git` and a known project: an orphan to register", () => {
    expect(classifyRootEntry(facts({ hasDotGit: true }))).toMatchObject({ cls: "orphan", action: "register" });
    expect(classifyRootEntry(facts({ inGitList: true }))).toMatchObject({ cls: "orphan", action: "register" });
  });

  test("a young orphan waits (a create may be in flight), an orphan of an unknown repository is only listed", () => {
    expect(classifyRootEntry(facts({ hasDotGit: true, ageMs: 5 * 60_000 }))).toMatchObject({ cls: "orphan", action: "wait" });
    expect(classifyRootEntry(facts({ hasDotGit: true, projectKnown: false }))).toMatchObject({ cls: "orphan", action: "inventory" });
  });

  test("no row, no `.git`, not listed by git, a day old, nobody inside, Topics' marker: a ghost moved to quarantine", () => {
    expect(classifyRootEntry(facts())).toMatchObject({ cls: "ghost", action: "quarantine" });
  });

  test("a ghost without Topics' marker is only listed, however old", () => {
    expect(classifyRootEntry(facts({ owned: false, ageMs: 400 * DAY }))).toMatchObject({ cls: "ghost", action: "inventory" });
  });

  test("a checkout with no Topics marker (a `git worktree add` by hand) is only listed, however old", () => {
    expect(classifyRootEntry(facts({ hasDotGit: true, owned: false, ageMs: 400 * DAY }))).toMatchObject({ cls: "orphan", action: "inventory" });
    expect(classifyRootEntry(facts({ inGitList: true, owned: false, ageMs: 400 * DAY }))).toMatchObject({ cls: "orphan", action: "inventory" });
  });

  test("a worktree whose git registration is lost is only listed, never registered", () => {
    expect(classifyRootEntry(facts({ hasDotGit: true, registrationLost: true }))).toMatchObject({ cls: "orphan", action: "inventory" });
  });

  test("a ghost is not removed while young or while a session is inside it", () => {
    expect(classifyRootEntry(facts({ ageMs: MIN_REMOVAL_AGE_MS - 1 }))).toMatchObject({ cls: "ghost", action: "wait" });
    expect(classifyRootEntry(facts({ liveInside: true }))).toMatchObject({ cls: "ghost", action: "wait" });
  });

  test("a folder git lists is never a ghost, however it looks", () => {
    expect(classifyRootEntry(facts({ inGitList: true })).cls).toBe("orphan");
  });

  test("a symbolic link is inventory only", () => {
    expect(classifyRootEntry(facts({ isSymlink: true }))).toMatchObject({ cls: "foreign", action: "inventory" });
  });
});

describe("planRoot", () => {
  const root = "/wt";
  const base = {
    root, extraRoots: [], listed: new Map(), repoPaths: new Set<string>(), now: 10 * DAY,
    folderPresent: () => true, liveInside: () => false, projectOf: () => "p1",
  };
  const entry = (name: string, over: object = {}) => ({ absPath: `${root}/proj/${name}`, slug: "proj", name, hasDotGit: false, isSymlink: false, ageMs: 5 * DAY, ...over });

  test("every row and every folder lands in exactly one class", () => {
    const plan = planRoot({
      ...base,
      rows: [
        { id: "r1", projectId: "p1", absPath: `${root}/proj/alive`, status: "ready", createdAtMs: 0 },
        { id: "r2", projectId: "p1", absPath: `${root}/proj/gone`, status: "error", createdAtMs: 0 },
        { id: "r3", projectId: "p1", absPath: "/elsewhere/adopted", status: "ready", createdAtMs: 0 },
      ],
      scanned: [entry("alive"), entry("ghost"), entry("orphan", { hasDotGit: true })],
      folderPresent: (p) => !p.endsWith("/gone"),
    });
    const byName = Object.fromEntries(plan.map((p) => [p.absPath.split("/").pop(), p.cls]));
    expect(byName).toEqual({ alive: "tracked", gone: "row-no-folder", adopted: "foreign", ghost: "ghost", orphan: "orphan" });
    expect(countRoot(plan)).toEqual({ ghosts: 1, orphans: 1, rowsWithoutFolder: 1, foreign: 1, quarantined: 0 });
  });

  test("a worktree git lists outside the root with no row is foreign inventory; the main checkout is not", () => {
    const listed = new Map([
      ["/other/wt", { projectId: "p1", entry: { path: "/other/wt" } as never }],
    ]);
    const plan = planRoot({ ...base, rows: [], scanned: [], listed, repoPaths: new Set(["/repo"]) });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ cls: "foreign", action: "inventory", absPath: "/other/wt" });
  });

  test("rows under an extra root (the default one, after the setting moved the root) stay ours", () => {
    const plan = planRoot({
      ...base, extraRoots: ["/old-root"],
      rows: [{ id: "r1", projectId: "p1", absPath: "/old-root/proj/x", status: "ready", createdAtMs: 0 }],
      scanned: [],
    });
    expect(plan[0]!.cls).toBe("tracked");
  });
});

describe("scan, ghost removal and registration on a real folder", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "wt-rootgc-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function mk(rel: string, opts: { git?: boolean; old?: boolean } = {}): string {
    const p = join(root, rel);
    mkdirSync(p, { recursive: true });
    if (opts.git) writeFileSync(join(p, ".git"), "gitdir: /nowhere\n");
    if (opts.old) { const t = new Date(Date.now() - 3 * DAY); utimesSync(p, t, t); }
    return p;
  }

  test("the scan reads {slug}/{name} and skips _scratch, _cache and dot folders", () => {
    mk("alpha/one", { git: true });
    mk("alpha/two");
    mk("_scratch/land/x");
    mk("_cache/cargo/alpha");
    mk(".hidden/zzz");
    const { entries } = scanWorktreeRoot(root);
    const names = entries.map((e) => `${e.slug}/${e.name}`).sort();
    expect(names).toEqual(["alpha/one", "alpha/two"]);
    expect(entries.find((e) => e.name === "one")!.hasDotGit).toBe(true);
    expect(entries.find((e) => e.name === "two")!.hasDotGit).toBe(false);
  });

  test("a missing root is an empty scan", () => {
    expect(scanWorktreeRoot(join(root, "nope")).entries).toEqual([]);
  });

  test("an old folder reads as old even though its birth time is now", () => {
    const p = mk("beta/aged", { old: true });
    const e = scanWorktreeRoot(root).entries.find((x) => x.absPath === p)!;
    expect(e.ageMs).toBeGreaterThan(2 * DAY);
  });

  test("a ghost Topics made is moved to quarantine, intact; a `.git`, a link and a depth-1 folder are refused", () => {
    const ghost = mk("gamma/ghost");
    writeFileSync(join(ghost, "junk.txt"), "x");
    markFolderOwned(root, ghost);
    const to = quarantineGhostFolder(root, ghost);
    expect(to).not.toBeNull();
    expect(to!).toContain(`${QUARANTINE_DIR}/`);
    expect(existsSync(ghost)).toBe(false);
    expect(existsSync(join(to!, "junk.txt"))).toBe(true);

    const withGit = mk("gamma/withgit", { git: true });
    markFolderOwned(root, withGit);
    expect(quarantineGhostFolder(root, withGit)).toBeNull();
    expect(existsSync(withGit)).toBe(true);

    const target = mk("gamma/target");
    const link = join(root, "gamma", "link");
    symlinkSync(target, link);
    markFolderOwned(root, link);
    expect(quarantineGhostFolder(root, link)).toBeNull();
    expect(existsSync(target)).toBe(true);

    expect(quarantineGhostFolder(root, join(root, "gamma"))).toBeNull();
    expect(quarantineGhostFolder(root, join(root, "_scratch", "land"))).toBeNull();
    expect(existsSync(join(root, "gamma"))).toBe(true);
  });

  test("a folder without Topics' marker is never moved, whatever it looks like", () => {
    const stranger = mk("delta/stranger", { old: true });
    writeFileSync(join(stranger, "notes.md"), "mine");
    expect(quarantineGhostFolder(root, stranger)).toBeNull();
    expect(existsSync(join(stranger, "notes.md"))).toBe(true);
  });

  test("a subfolder of a checkout is never moved, even with a marker: the parent has a `.git`", () => {
    const checkout = mk("epsilon", { git: true });
    const src = mk("epsilon/src");
    markFolderOwned(root, src);
    expect(quarantineGhostFolder(root, src)).toBeNull();
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(checkout, ".git"))).toBe(true);
  });

  test("a `.git` that cannot be read (permission denied, not missing) keeps the folder", () => {
    const locked = mk("zeta/locked");
    markFolderOwned(root, locked);
    chmodSync(locked, 0o600); // no search bit: lstat of anything inside fails with EACCES
    try {
      // root reads through any permission: the case only exists for a normal user.
      if (process.getuid?.() !== 0) expect(quarantineGhostFolder(root, locked)).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(existsSync(locked)).toBe(true);
  });

  test("the move never leaves the root: a folder two levels deep elsewhere is refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "wt-outside-"));
    try {
      mkdirSync(join(outside, "a", "b"), { recursive: true });
      markFolderOwned(outside, join(outside, "a", "b"));
      expect(quarantineGhostFolder(root, join(outside, "a", "b"))).toBeNull();
      expect(existsSync(join(outside, "a", "b"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a {slug} folder that is a checkout or a project's path is listed, never descended into", () => {
    const scanRoot = mkdtempSync(join(tmpdir(), "wt-slugscan-"));
    try {
      mkdirSync(join(scanRoot, "checkout", "src"), { recursive: true });
      mkdirSync(join(scanRoot, "checkout", ".git"), { recursive: true });
      mkdirSync(join(scanRoot, "project", "docs"), { recursive: true });
      mkdirSync(join(scanRoot, "plain", "wt"), { recursive: true });
      const scan = scanWorktreeRoot(scanRoot, Date.now(), { projectPaths: new Set([realpathSync(join(scanRoot, "project"))]) });
      expect(scan.entries.map((e) => `${e.slug}/${e.name}`)).toEqual(["plain/wt"]);
      expect(scan.checkouts.map((c) => c.split("/").pop()).sort()).toEqual(["checkout", "project"]);
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  });

  test("an orphan is registered as ready, with the mode git implies and a unique name", () => {
    const rows: Array<{ projectId: string; name: string; mode: string; branchName: string | null; absPath: string }> = [];
    const store = {
      create: (i: { projectId: string; name: string; mode: "branch" | "reuse" | "detached"; branchName: string | null; baseRef: string | null; absPath: string }) => { rows.push(i); return { id: `id-${rows.length}` }; },
      update: () => undefined,
      listNamesForProject: () => new Set(["taken"]),
    };
    const entry = { absPath: resolve("/wt/proj/taken"), slug: "proj", name: "taken", hasDotGit: true, isSymlink: false, ageMs: 5 * DAY };
    registerOrphan(store, entry, "p1", { path: entry.absPath, head: "h", branch: "topics/taken", detached: false, bare: false, locked: false, lockReason: null, prunable: false }, null);
    registerOrphan(store, { ...entry, absPath: "/wt/proj/other" }, "p1", null, "feature/x");
    registerOrphan(store, { ...entry, absPath: "/wt/proj/loose" }, "p1", null, null);
    expect(rows.map((r) => [r.name, r.mode, r.branchName])).toEqual([
      ["taken-2", "branch", "topics/taken"],
      ["other", "reuse", "feature/x"],
      ["loose", "detached", null],
    ]);
  });

  test("names are lowercased, dashed and made unique", () => {
    expect(nameForAdopted("My_Folder.v2", new Set())).toBe("my-folder-v2");
    expect(nameForAdopted("7days", new Set())).toBe("days");
    expect(nameForAdopted("x", new Set(["x", "x-2"]))).toBe("x-3");
  });

  test("the project of a folder: the slug only when it names exactly one project", () => {
    const projects = [{ id: "a", slug: "alpha", path: "/r/a" }, { id: "b", slug: "dup", path: "/r/b" }, { id: "c", slug: "dup", path: "/r/c" }];
    const e = (slug: string) => ({ absPath: `/nowhere/${slug}/x`, slug, name: "x", hasDotGit: false, isSymlink: false, ageMs: 0 });
    expect(projectOfFolder(e("alpha"), projects, new Map())).toBe("a");
    expect(projectOfFolder(e("dup"), projects, new Map())).toBeNull();
    expect(projectOfFolder(e("dup"), projects, new Map([[resolve("/nowhere/dup/x"), { projectId: "c" }]]))).toBe("c");
  });
});
