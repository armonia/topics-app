import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildProjectCandidates, resolveProjectPath, isSelectableProjectDir, newProjectParentDir, type ProjectCandidate } from "./project-path-resolver";
import { projectIdForPath } from "./tasks";
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
  const workspaceDir = "/Users/x/.openclaw/workspace";
  const homeDir = "/Users/x";
  // Only these paths "exist" — real project dirs, their markers, and the
  // internal/husk dirs. Non-workspace projects need no marker; workspace-nested
  // ones must carry one (dashboard does, the husk does not).
  const real = new Set([
    "/Users/x/Projects/demoapp",
    "/Users/x/.openclaw/workspace/generale",
    "/Users/x/.openclaw/workspace/tasks/ab12cd34",
    "/Users/x/.openclaw/workspace/dashboard",
    "/Users/x/.openclaw/workspace/dashboard/package.json", // marker
    "/Users/x/.openclaw/workspace/topics-app",             // husk (recreated), no marker
    "/Users/x/.claude",
    "/Users/x/.claude/jarvis",
    "/Users/x",
  ]);
  const opts = { workspaceDir, homeDir, exists: (p: string) => real.has(p) };
  const ok = (p: string) => isSelectableProjectDir(p, opts);

  it("keeps real projects, incl. a marker-bearing workspace/<name> child", () => {
    expect(ok("/Users/x/Projects/demoapp")).toBe(true);
    expect(ok("/Users/x/.openclaw/workspace/dashboard")).toBe(true);
  });

  it("drops the catch-all generale dir and per-task cwds", () => {
    expect(ok("/Users/x/.openclaw/workspace/generale")).toBe(false);
    expect(ok("/Users/x/.openclaw/workspace/tasks/ab12cd34")).toBe(false);
    expect(ok("/Users/x/.openclaw/workspace/tasks")).toBe(false);
  });

  it("drops a recreated workspace husk that carries no project marker", () => {
    expect(ok("/Users/x/.openclaw/workspace/topics-app")).toBe(false);
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
    expect(ok("/Users/x/.openclaw/workspace/generale/")).toBe(false);
  });
});

describe("newProjectParentDir", () => {
  // `exists` iniettato: questi percorsi non stanno su nessun disco, e senza
  // stub il controllo di esistenza li scarterebbe tutti (che è il suo mestiere,
  // ed è provato dal caso «cartella immaginaria» più sotto).
  const deps = { workspaceDir: "/Users/x/.openclaw/workspace", homeDir: "/Users/x", exists: () => true };

  it("picks the folder where the projects ALREADY live, not the workspace", () => {
    expect(newProjectParentDir(
      ["/Users/x/Projects/alpha", "/Users/x/Projects/beta", "/Users/x/lab/one"],
      deps,
    )).toBe("/Users/x/Projects");
  });

  it("ignores what lives INSIDE the workspace — il plumbing non vota per sé", () => {
    expect(newProjectParentDir(
      [
        "/Users/x/.openclaw/workspace/a",
        "/Users/x/.openclaw/workspace/b",
        "/Users/x/.openclaw/workspace/c",
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
