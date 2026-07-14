import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildProjectCandidates, resolveProjectPath, isSelectableProjectDir, type ProjectCandidate } from "./project-path-resolver";
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
      extraPaths: () => ["/Users/x/Projects/[cliente]"],
    });
    expect(out).toEqual([{ path: "/Users/x/Projects/[cliente]", projectStoreId: null }]);
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
    // The exact failure seen live: a board created for ~/Projects/[cliente] — a
    // project opened ad-hoc, never registered, outside the workspace dir.
    const path = "/Users/x/Projects/[cliente]";
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
    "/Users/x/Projects/[cliente]",
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
    expect(ok("/Users/x/Projects/[cliente]")).toBe(true);
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

  it("drops vanished paths (stale topic/terminal rows) and non-absolute input", () => {
    expect(ok("/tmp/board-live-demo")).toBe(false); // not in `real` → doesn't exist
    expect(ok("relative/path")).toBe(false);
    expect(ok("")).toBe(false);
  });

  it("tolerates a trailing slash", () => {
    expect(ok("/Users/x/Projects/[cliente]/")).toBe(true);
    expect(ok("/Users/x/.openclaw/workspace/generale/")).toBe(false);
  });
});
