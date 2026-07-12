/**
 * project-path-resolver.ts — invert the one-way board `projectId` hash.
 *
 * The Kanban board keys everything by `projectId = projectIdForPath(path)` (a
 * djb2-ish hash, see tasks.ts). There is no stored reverse map, so to go from a
 * board id back to a directory on disk (which the dispatcher needs, to create
 * the worktree/topic in the right place) we ENUMERATE every project we know
 * about and re-hash each path until one matches.
 *
 * Sources of candidate paths:
 *  - the ProjectStore (registered projects — these carry the store UUID that
 *    the WorktreeManager requires),
 *  - the OpenClaw `workspace/` scan (the same marker-based discovery
 *    topics.ts:getWorkspaceProjects uses), and
 *  - every OTHER dir the server already references: topic `projectPath`s and
 *    terminal-session cwds (injected as `extraPaths`). In this app most
 *    projects are opened ad-hoc (folder picker, Claude terminals) and never
 *    registered in the ProjectStore — without this union, their boards can
 *    never dispatch (same rationale as the icon-allowlist union in
 *    routes/projects.ts). Path-only candidates carry no store id, so they can
 *    be run in-place but not given a worktree until registered.
 *
 * The pure `resolveProjectPath(id, candidates)` is unit-tested; the impure
 * `buildProjectCandidates` (fs + store reads) is assembled in server.ts.
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { projectIdForPath } from "./tasks";
import type { ProjectStore } from "./project-store";

export interface ProjectCandidate {
  path: string;
  /** ProjectStore UUID when the project is registered (needed for worktrees); null otherwise. */
  projectStoreId: string | null;
}

/** Pure: find the candidate whose path re-hashes to `projectId`. */
export function resolveProjectPath(projectId: string, candidates: ProjectCandidate[]): ProjectCandidate | null {
  for (const c of candidates) {
    if (projectIdForPath(c.path) === projectId) return c;
  }
  return null;
}

// Same discovery rules as topics.ts:getWorkspaceProjects — kept in sync by hand
// (both are cheap, marker-based dir scans). SKIP_DIRS/markers must match so the
// two surfaces agree on what counts as a project.
const SKIP_DIRS = new Set(["node_modules", "memory", "backups", "test-results"]);
const PROJECT_MARKERS = [
  ".git", "package.json", "CLAUDE.md", "Cargo.toml", "go.mod", "pyproject.toml",
  "Makefile", "README.md", "tsconfig.json", "requirements.txt", "Dockerfile",
  "index.html", "server.ts", "server.py", "server.js",
];

function scanWorkspace(workspaceDir: string): string[] {
  try {
    if (!existsSync(workspaceDir)) return [];
    return readdirSync(workspaceDir, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) return false;
        const dir = join(workspaceDir, e.name);
        return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
      })
      .map((e) => join(workspaceDir, e.name));
  } catch {
    return [];
  }
}

/**
 * Impure: collect all candidate projects. Registered store rows first (they
 * carry the store UUID), then the workspace scan, then any ad-hoc dirs the
 * host already knows about (topic projectPaths, terminal cwds) — path-only.
 */
export function buildProjectCandidates(deps: {
  projectStore: ProjectStore;
  workspaceDir: string;
  /** Ad-hoc dirs the server already references (topic paths, terminal cwds). */
  extraPaths?: () => string[];
}): ProjectCandidate[] {
  const seen = new Set<string>();
  const out: ProjectCandidate[] = [];
  for (const p of deps.projectStore.list()) {
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    out.push({ path: p.path, projectStoreId: p.id });
  }
  const pathOnly = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, projectStoreId: null });
  };
  for (const path of scanWorkspace(deps.workspaceDir)) pathOnly(path);
  if (deps.extraPaths) {
    let extras: string[] = [];
    try { extras = deps.extraPaths(); } catch { /* best-effort source */ }
    for (const path of extras) {
      if (typeof path !== "string" || !path.startsWith("/")) continue;
      pathOnly(path.replace(/\/+$/, ""));
    }
  }
  return out;
}
