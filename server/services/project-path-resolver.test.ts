/**
 * @covers PROJECT-06
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildProjectCandidates, canonicalProjectFor, projectsInsideWorktrees, readGitCheckoutFacts, makeAliasPathFinder, resolveProjectPath, isSelectableProjectDir, newProjectParentDir, type ProjectCandidate } from "./project-path-resolver";
import { projectIdForPath } from "./tasks";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import type { ProjectStore } from "./project-store";

describe("resolveProjectPath", () => {
  const paths = ["/Users/x/Projects/alpha", "/Users/x/Projects/beta", "/Users/x/workspace/gamma"];
  const candidates: ProjectCandidate[] = [
    { path: paths[0], projectStoreId: "uuid-alpha" },
    { path: paths[1], projectStoreId: null },
    { path: paths[2], projectStoreId: "uuid-gamma" },
  ];

  it("inverts the board hash back to the matching candidate", () => {
    for (const c of candidates) {
      const got = resolveProjectPath(projectIdForPath(c.path), candidates);
      expect(got?.path).toBe(c.path);
      expect(got?.projectStoreId).toBe(c.projectStoreId);
    }
  });

  it("returns null when no candidate re-hashes to the id", () => {
    expect(resolveProjectPath("nope-000000", candidates)).toBeNull();
  });

  it("returns null on an empty candidate set", () => {
    expect(resolveProjectPath(projectIdForPath(paths[0]), [])).toBeNull();
  });
});

/** ProjectStore fake: only list() is consulted by buildProjectCandidates. */
function fakeStore(rows: Array<{ id: string; path: string }>): ProjectStore {
  return { list: () => rows.map((r) => ({ id: r.id, path: r.path })) } as unknown as ProjectStore;
}

const NO_WORKSPACE = "/nonexistent/workspace";

describe("buildProjectCandidates", () => {
  it("keeps store rows first (they carry the store id) and dedupes extras against them", () => {
    const out = buildProjectCandidates({
      projectStore: fakeStore([{ id: "u1", path: "/Users/x/Projects/alpha" }]),
      workspaceDir: NO_WORKSPACE,
      extraPaths: () => ["/Users/x/Projects/alpha", "/Users/x/Projects/beta"],
    });
    expect(out).toEqual([
      { path: "/Users/x/Projects/alpha", projectStoreId: "u1" },
      { path: "/Users/x/Projects/beta", projectStoreId: null },
    ]);
  });

  it("includes ad-hoc extra paths (topic projectPaths / terminal cwds) as path-only candidates", () => {
    const out = buildProjectCandidates({
      projectStore: fakeStore([]),
      workspaceDir: NO_WORKSPACE,
      extraPaths: () => ["/Users/x/Projects/demoapp"],
    });
    expect(out).toEqual([{ path: "/Users/x/Projects/demoapp", projectStoreId: null }]);
  });

  it("normalizes trailing slashes and rejects non-absolute extras", () => {
    const out = buildProjectCandidates({
      projectStore: fakeStore([]),
      workspaceDir: NO_WORKSPACE,
      extraPaths: () => ["/Users/x/Projects/gamma/", "relative/path", "", "/Users/x/Projects/gamma"],
    });
    expect(out).toEqual([{ path: "/Users/x/Projects/gamma", projectStoreId: null }]);
  });

  it("survives a throwing extraPaths source (best-effort)", () => {
    const out = buildProjectCandidates({
      projectStore: fakeStore([{ id: "u1", path: "/a/b" }]),
      workspaceDir: NO_WORKSPACE,
      extraPaths: () => { throw new Error("db gone"); },
    });
    expect(out).toEqual([{ path: "/a/b", projectStoreId: "u1" }]);
  });

  it("still scans the workspace dir for marker-bearing projects", () => {
    const ws = mkdtempSync(join(tmpdir(), "resolver-ws-"));
    mkdirSync(join(ws, "proj"));
    writeFileSync(join(ws, "proj", "package.json"), "{}");
    mkdirSync(join(ws, "not-a-project"));
    const out = buildProjectCandidates({
      projectStore: fakeStore([]),
      workspaceDir: ws,
    });
    expect(out).toEqual([{ path: join(ws, "proj"), projectStoreId: null }]);
  });

  it("maps a board id back to an ad-hoc project dir that only extras know about", () => {
    // The exact failure seen live: a board created for ~/Projects/demoapp — a
    // project opened ad-hoc, never registered, outside the workspace dir.
    const path = "/Users/x/Projects/demoapp";
    const candidates = buildProjectCandidates({
      projectStore: fakeStore([]),
      workspaceDir: NO_WORKSPACE,
      extraPaths: () => [path],
    });
    const hit = resolveProjectPath(projectIdForPath(path), candidates);
    expect(hit).toEqual({ path, projectStoreId: null });
  });
});

describe("isSelectableProjectDir (display filter)", () => {
  const workspaceDir = "/Users/x/.app-data/workspace";
  const homeDir = "/Users/x";
  // Only these paths "exist" — real project dirs, their markers, and the
  // internal/husk dirs. Non-workspace projects need no marker; workspace-nested
  // ones must carry one (dashboard does, the husk does not).
  const real = new Set([
    "/Users/x/Projects/demoapp",
    "/Users/x/.app-data/workspace/generale",
    "/Users/x/.app-data/workspace/tasks/ab12cd34",
    "/Users/x/.app-data/workspace/dashboard",
    "/Users/x/.app-data/workspace/dashboard/package.json", // marker
    "/Users/x/.app-data/workspace/topics-app",             // husk (recreated), no marker
    "/Users/x/.claude",
    "/Users/x/.claude/jarvis",
    "/Users/x",
  ]);
  const opts = { workspaceDir, homeDir, exists: (p: string) => real.has(p) };
  const ok = (p: string) => isSelectableProjectDir(p, opts);

  it("keeps real projects, incl. a marker-bearing workspace/<name> child", () => {
    expect(ok("/Users/x/Projects/demoapp")).toBe(true);
    expect(ok("/Users/x/.app-data/workspace/dashboard")).toBe(true);
  });

  it("drops the catch-all generale dir and per-task cwds", () => {
    expect(ok("/Users/x/.app-data/workspace/generale")).toBe(false);
    expect(ok("/Users/x/.app-data/workspace/tasks/ab12cd34")).toBe(false);
    expect(ok("/Users/x/.app-data/workspace/tasks")).toBe(false);
  });

  it("drops a recreated workspace husk that carries no project marker", () => {
    expect(ok("/Users/x/.app-data/workspace/topics-app")).toBe(false);
  });

  it("drops the home dir itself and config dot-dirs", () => {
    expect(ok("/Users/x")).toBe(false);
    expect(ok("/Users/x/.claude")).toBe(false);
    expect(ok("/Users/x/.claude/jarvis")).toBe(false);
  });

  it("drops paths inside /.topics/ (worktrees and topics data dir)", () => {
    expect(ok("/Users/x/.topics/worktrees/topics-app/my-branch")).toBe(false);
    expect(ok("/Users/x/.topics/worktrees/some-project/feature-x")).toBe(false);
    expect(ok("/Users/x/.topics")).toBe(false);
  });

  it("drops vanished paths (stale topic/terminal rows) and non-absolute input", () => {
    expect(ok("/tmp/board-live-demo")).toBe(false); // not in `real` → doesn't exist
    expect(ok("relative/path")).toBe(false);
    expect(ok("")).toBe(false);
  });

  it("tolerates a trailing slash", () => {
    expect(ok("/Users/x/Projects/demoapp/")).toBe(true);
    expect(ok("/Users/x/.app-data/workspace/generale/")).toBe(false);
  });
});

describe("newProjectParentDir", () => {
  // `exists` iniettato: questi percorsi non stanno su nessun disco, e senza
  // stub il controllo di esistenza li scarterebbe tutti (che è il suo mestiere,
  // ed è provato dal caso «cartella immaginaria» più sotto).
  const deps = { workspaceDir: "/Users/x/.app-data/workspace", homeDir: "/Users/x", exists: () => true };

  it("picks the folder where the projects ALREADY live, not the workspace", () => {
    expect(newProjectParentDir(
      ["/Users/x/Projects/alpha", "/Users/x/Projects/beta", "/Users/x/lab/one"],
      deps,
    )).toBe("/Users/x/Projects");
  });

  it("ignores what lives INSIDE the workspace — il plumbing non vota per sé", () => {
    expect(newProjectParentDir(
      [
        "/Users/x/.app-data/workspace/a",
        "/Users/x/.app-data/workspace/b",
        "/Users/x/.app-data/workspace/c",
        "/Users/x/Projects/alpha",
        "/Users/x/Projects/beta",
      ],
      deps,
    )).toBe("/Users/x/Projects");
  });

  it("un solo progetto non fa una consuetudine → workspace", () => {
    expect(newProjectParentDir(["/Users/x/Projects/alpha"], deps)).toBe(deps.workspaceDir);
    expect(newProjectParentDir([], deps)).toBe(deps.workspaceDir);
  });

  it("non punta mai alla home nuda né alla radice", () => {
    expect(newProjectParentDir(["/Users/x/alpha", "/Users/x/beta"], deps)).toBe(deps.workspaceDir);
    expect(newProjectParentDir(["/alpha", "/beta"], deps)).toBe(deps.workspaceDir);
  });

  it("a parità di conteggio è deterministico (più corto, poi alfabetico)", () => {
    const got = newProjectParentDir(
      ["/Users/x/zzz/a", "/Users/x/zzz/b", "/Users/x/ab/a", "/Users/x/ab/b"],
      deps,
    );
    expect(got).toBe("/Users/x/ab");
    expect(newProjectParentDir(
      ["/Users/x/bb/a", "/Users/x/bb/b", "/Users/x/aa/a", "/Users/x/aa/b"],
      deps,
    )).toBe("/Users/x/aa");
  });

  it("tollera la barra finale e scarta input non assoluti", () => {
    expect(newProjectParentDir(
      ["/Users/x/Projects/alpha/", "/Users/x/Projects/beta/", "relative/nope", ""],
      deps,
    )).toBe("/Users/x/Projects");
  });

  it("lo STESSO dir ripetuto non vota due volte", () => {
    // `listProjectDirs` restituisce duplicati (con e senza barra, da sorgenti
    // diverse): un progetto solo fingeva una maggioranza che non esiste.
    expect(newProjectParentDir(
      ["/Users/x/Projects/alpha", "/Users/x/Projects/alpha/", "/Users/x/Projects/alpha"],
      deps,
    )).toBe(deps.workspaceDir);
  });

  it("i worktree in una dot-dir non vincono la conta", () => {
    // `~/.topics/worktrees/<repo>` ne ospita decine: senza questa regola, su una
    // macchina con pochi progetti veri i progetti nuovi nascerebbero lì dentro.
    expect(newProjectParentDir(
      [
        "/Users/x/.topics/worktrees/topics-app/a",
        "/Users/x/.topics/worktrees/topics-app/b",
        "/Users/x/.topics/worktrees/topics-app/c",
        "/Users/x/Projects/alpha",
        "/Users/x/Projects/beta",
      ],
      deps,
    )).toBe("/Users/x/Projects");
  });

  it("una cartella IMMAGINARIA non è un bersaglio: si ricade sul workspace", () => {
    const real = new Set(["/Users/x/lab"]);
    const withDisk = { ...deps, exists: (p: string) => real.has(p) };
    // /x/ghost vincerebbe per conteggio, ma non esiste → vince /Users/x/lab.
    expect(newProjectParentDir(
      ["/x/ghost/a", "/x/ghost/b", "/x/ghost/c", "/Users/x/lab/a", "/Users/x/lab/b"],
      withDisk,
    )).toBe("/Users/x/lab");
    expect(newProjectParentDir(["/x/ghost/a", "/x/ghost/b"], withDisk)).toBe(deps.workspaceDir);
  });
});

describe("resolveProjectPath after a move", () => {
  // The 19/11 reshuffle of the projects folder moved directories and left a symlink
  // at the old place: cards written before carry the id of the old address.
  function moved() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "moved-home-")));
    const oldPath = join(home, "Projects", "app");
    const newPath = join(home, "Projects", "Topics", "app");
    mkdirSync(newPath, { recursive: true });
    symlinkSync(newPath, oldPath);
    return { home, oldPath, newPath, candidates: [{ path: newPath, projectStoreId: "uuid-app" }] as ProjectCandidate[] };
  }

  it("the id of the old address finds the checkout where it is now", () => {
    const { home, oldPath, newPath, candidates } = moved();
    const found = resolveProjectPath(projectIdForPath(oldPath), candidates, makeAliasPathFinder(home));
    expect(found?.path).toBe(newPath);
    expect(found?.projectStoreId).toBe("uuid-app");
  });

  it("an id that matches nothing stays without a checkout", () => {
    const { home, candidates } = moved();
    expect(resolveProjectPath(projectIdForPath(join(home, "Projects", "altro")), candidates, makeAliasPathFinder(home))).toBeNull();
  });

  it("a symlink to ANOTHER folder is not an alias", () => {
    const { home, candidates } = moved();
    const elsewhere = join(home, "Projects", "Topics", "altro");
    mkdirSync(elsewhere, { recursive: true });
    const stray = join(home, "Projects", "stray");
    symlinkSync(elsewhere, stray);
    expect(resolveProjectPath(projectIdForPath(stray), candidates, makeAliasPathFinder(home))).toBeNull();
  });

  it("a candidate that is itself a symlink also answers to the id of the real path", () => {
    const { home, oldPath, newPath } = moved();
    const found = resolveProjectPath(projectIdForPath(newPath), [{ path: oldPath, projectStoreId: null }], makeAliasPathFinder(home));
    expect(found?.path).toBe(oldPath);
  });

  it("does not look above the home", () => {
    const { home, newPath, candidates } = moved();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moved-out-")));
    const link = join(outside, "app");
    symlinkSync(newPath, link);
    expect(resolveProjectPath(projectIdForPath(link), candidates, makeAliasPathFinder(home))).toBeNull();
  });
});


describe("canonicalProjectFor", () => {
  let base: string;
  let repo: string;
  let linked: string;
  let alias: string;
  let linkedAlias: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore", env: gitEnv() });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "canonical-project-")));
    repo = join(base, "repo");
    mkdirSync(join(repo, "pkg"), { recursive: true });
    git(base, "init", "-q", repo);
    writeFileSync(join(repo, "pkg", "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    linked = join(base, "wt", "feature");
    mkdirSync(join(base, "wt"));
    git(repo, "worktree", "add", "-q", "-b", "feature", linked);
    alias = join(base, "repo-alias");
    symlinkSync(repo, alias);
    linkedAlias = join(base, "feature-alias");
    symlinkSync(linked, linkedAlias);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const rows = () => [
    { id: "p-repo", slug: "repo", path: repo },
    { id: "p-other", slug: "other", path: join(base, "other") },
  ];

  it("a linked worktree resolves to the project of its repository", () => {
    expect(canonicalProjectFor(linked, rows())?.id).toBe("p-repo");
  });

  it("a symlink to the worktree and a symlink to the repo resolve to the same project", () => {
    expect(canonicalProjectFor(linkedAlias, rows())?.id).toBe("p-repo");
    expect(canonicalProjectFor(alias, rows())?.id).toBe("p-repo");
  });

  it("the project registered under the alias still resolves from the real path", () => {
    expect(canonicalProjectFor(repo, [{ id: "p-alias", slug: "a", path: alias }])?.id).toBe("p-alias");
  });

  it("a subfolder of the repository stays itself: it is not the repository", () => {
    expect(canonicalProjectFor(join(repo, "pkg"), rows())).toBeNull();
  });

  it("a folder that is not under git, or whose repository is not a project, answers null", () => {
    expect(canonicalProjectFor(base, rows())).toBeNull();
    expect(canonicalProjectFor(linked, [{ id: "p-other", slug: "other", path: join(base, "other") }])).toBeNull();
  });

  it("a worktree folder that is gone answers from the worktree table", () => {
    const gone = join(base, "wt", "removed");
    expect(canonicalProjectFor(gone, rows(), { worktreeOwner: (p) => (p === gone ? "p-repo" : null) })?.id).toBe("p-repo");
  });

  it("a worktree folder that is gone answers from where it lived: {root}/{slug}/… and .claude/worktrees", () => {
    const root = join(base, "root");
    expect(canonicalProjectFor(join(root, "repo", "old"), rows(), { worktreeRoot: root })?.id).toBe("p-repo");
    expect(canonicalProjectFor(join(repo, ".claude", "worktrees", "old"), rows())?.id).toBe("p-repo");
    expect(canonicalProjectFor(join(root, "nobody", "old"), rows(), { worktreeRoot: root })).toBeNull();
  });

  it("rejects relative and empty input", () => {
    expect(canonicalProjectFor("", rows())).toBeNull();
    expect(canonicalProjectFor("repo", rows())).toBeNull();
  });
});

describe("projectsInsideWorktrees", () => {
  let base: string;
  let repo: string;
  let linked: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore", env: gitEnv() });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "projects-in-worktrees-")));
    repo = join(base, "repo");
    git(base, "init", "-q", repo);
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    linked = join(base, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", linked);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("flags a project at a linked worktree with no parent, and not once it has one", () => {
    const row = { id: "w", slug: "w", path: linked, parentId: null as string | null };
    const main = { id: "m", slug: "m", path: repo, parentId: null as string | null };
    expect(projectsInsideWorktrees([main, row]).map((p) => p.id)).toEqual(["w"]);
    expect(projectsInsideWorktrees([main, { ...row, parentId: "m" }])).toEqual([]);
  });

  it("flags a vanished folder under the worktree root or .claude/worktrees", () => {
    const root = join(base, "root");
    const rows = [
      { id: "a", slug: "a", path: join(root, "x", "gone"), parentId: null as string | null },
      { id: "b", slug: "b", path: join(base, "r", ".claude", "worktrees", "gone"), parentId: null as string | null },
      { id: "c", slug: "c", path: join(base, "plain", "gone"), parentId: null as string | null },
    ];
    expect(projectsInsideWorktrees(rows, { worktreeRoot: root }).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("readGitCheckoutFacts", () => {
  let base: string;
  let repo: string;
  let linked: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", env: gitEnv() });
  /** What `git rev-parse` answers for a folder: the question the function answers without running git. */
  const askGit = (dir: string) => {
    const [commonDir, topLevel] = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel").trim().split("\n");
    return { commonDir: realpathSync(commonDir!), topLevel: realpathSync(topLevel!) };
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "git-facts-")));
    repo = join(base, "repo");
    mkdirSync(join(repo, "pkg", "deep"), { recursive: true });
    git(base, "init", "-q", repo);
    writeFileSync(join(repo, "pkg", "a.txt"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    linked = join(base, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", linked);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("reads what git says, with no process: main checkout, linked worktree and a subfolder of each", () => {
    for (const dir of [repo, linked, join(repo, "pkg", "deep"), join(linked, "pkg")]) {
      expect(readGitCheckoutFacts(dir)).toEqual(askGit(dir));
    }
  });

  it("a linked worktree shares the common dir of its repository and has its own top level", () => {
    const main = readGitCheckoutFacts(repo)!;
    const wt = readGitCheckoutFacts(linked)!;
    expect(wt.commonDir).toBe(main.commonDir);
    expect(wt.topLevel).toBe(linked);
  });

  it("answers null outside any repository", () => {
    const loose = join(base, "loose");
    mkdirSync(loose);
    expect(readGitCheckoutFacts(loose)).toBeNull();
  });
});
