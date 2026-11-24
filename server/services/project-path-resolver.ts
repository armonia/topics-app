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
 *  - the app data `workspace/` scan (the same marker-based discovery
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
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { isInsideDir } from "../lib/path-containment";
import { projectIdForPath } from "./tasks";
import type { ProjectStore } from "./project-store";

export interface ProjectCandidate {
  path: string;
  /** ProjectStore UUID when the project is registered (needed for worktrees); null otherwise. */
  projectStoreId: string | null;
}

/**
 * The other addresses under which the SAME project has been known: the symlinks
 * a move leaves at the old place.
 *
 * The board id is the hash of the whole path, so moving a folder changes the id
 * you derive from it: cards written before keep the id of the old address and no
 * candidate inverts it any more (19/11: the reshuffle of the projects folder left
 * the topics-app board without a checkout, and the land sent every card back to
 * review). Whoever moves a folder usually leaves a symlink at the old place, in
 * the same tree: we look for symlinks pointing at the project in the two folders
 * above it, never higher than the home. The result also holds the real path when
 * the candidate is itself a symlink. Folder listings are memoised for the
 * duration of one resolution only.
 */
export function makeAliasPathFinder(home = homedir()): (path: string) => string[] {
  const listings = new Map<string, Array<{ link: string; real: string }>>();
  const linksIn = (dir: string) => {
    let hit = listings.get(dir);
    if (hit) return hit;
    hit = [];
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) continue;
        const link = join(dir, e.name);
        try { hit.push({ link, real: realpathSync(link) }); } catch { /* broken symlink */ }
      }
    } catch { /* unreadable or vanished folder */ }
    listings.set(dir, hit);
    return hit;
  };
  return (path) => {
    let real: string;
    try { real = realpathSync(path); } catch { return []; }
    const out = new Set<string>();
    if (real !== path) out.add(real);
    let dir = dirname(real);
    for (let level = 0; level < 2; level++) {
      // Stop at the home: nobody keeps projects above it.
      if (dir === home || dir === dirname(dir) || !isInsideDir(dir, home)) break;
      for (const l of linksIn(dir)) if (l.real === real) out.add(l.link);
      dir = dirname(dir);
    }
    return [...out];
  };
}

/**
 * Pure (apart from the symlinks, which are injectable): find the candidate whose
 * path re-hashes to `projectId`. When no path matches, retry with the other
 * addresses of the same project (`aliasPathsOf`): a card from before a move must
 * find the checkout where it is now.
 */
export function resolveProjectPath(
  projectId: string,
  candidates: ProjectCandidate[],
  aliasPathsOf: (path: string) => string[] = makeAliasPathFinder(),
): ProjectCandidate | null {
  for (const c of candidates) {
    if (projectIdForPath(c.path) === projectId) return c;
  }
  for (const c of candidates) {
    if (aliasPathsOf(c.path).some((alias) => projectIdForPath(alias) === projectId)) return c;
  }
  return null;
}

// ── Canonical project of a folder ─────────────────────────────────────────────
//
// A linked git worktree is never a project: it is another checkout of the SAME
// repository. Registering one as a project gives the repo a second board and a
// second sidebar entry (five of them exist today). The identity of a checkout
// is its git common dir, so the question "which project is this folder?" is
// answered by looking for the project whose main checkout owns that common dir.

/** What the canonical lookup needs from a project row. */
export interface CanonicalProjectRow {
  id: string;
  path: string;
  slug?: string | null;
}

export interface GitCheckoutFacts {
  /** The shared `.git` directory (absolute, symlinks resolved). */
  commonDir: string;
  /** The top of this checkout (absolute, symlinks resolved). */
  topLevel: string;
}

export interface CanonicalProjectDeps {
  /** Probe a folder with git; `null` when it is not (inside) a git checkout. Injectable for tests. */
  gitFacts?: (dir: string) => GitCheckoutFacts | null;
  /** Project id that owns a registered worktree row at this absolute path (the `worktrees` table). */
  worktreeOwner?: (absPath: string) => string | null;
  /** Topics' worktree root: a vanished `{root}/{slug}/…` folder belongs to the project with that slug. */
  worktreeRoot?: string;
}

/** `git rev-parse` for a folder: common dir and top level, both with symlinks resolved. */
export function readGitCheckoutFacts(dir: string): GitCheckoutFacts | null {
  const r = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    { cwd: dir, encoding: "utf8", timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  );
  if (r.status !== 0 || !r.stdout) return null;
  const [commonDir, topLevel] = r.stdout.split("\n");
  if (!commonDir || !topLevel) return null;
  try {
    return { commonDir: realpathSync(commonDir), topLevel: realpathSync(topLevel) };
  } catch {
    return null;
  }
}

/** The folder a shared git dir belongs to: the parent of `.git`, or the dir itself for a bare repo. */
function mainCheckoutOf(commonDir: string): string {
  return commonDir.endsWith(`${sep}.git`) ? dirname(commonDir) : commonDir;
}

const realOrSelf = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

/**
 * Where a folder that no longer exists used to be a worktree of: the project it
 * was carved for, read off the path alone. Two conventions, both explicit:
 * `{worktreeRoot}/{slug}/…` (Topics') and `<repo>/.claude/worktrees/…` (Claude
 * Desktop's). Returns null for a path that fits neither.
 */
export function vanishedWorktreeParent<T extends CanonicalProjectRow>(
  path: string,
  projects: readonly T[],
  worktreeRoot?: string,
): T | null {
  if (worktreeRoot && isInsideDir(path, worktreeRoot)) {
    const slug = relative(worktreeRoot, path).split(sep)[0];
    const hit = slug ? projects.find((p) => p.slug === slug) : undefined;
    if (hit) return hit;
  }
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const at = path.indexOf(marker);
  if (at > 0) {
    const repo = path.slice(0, at);
    return projects.find((p) => p.path === repo || realOrSelf(p.path) === realOrSelf(repo)) ?? null;
  }
  return null;
}

/**
 * The project a folder canonically belongs to, or null when none of the known
 * projects is it.
 *
 *  - a linked worktree (any address: symlink alias, `.claude/worktrees`, Topics'
 *    own root) answers with the project of the repository's MAIN checkout;
 *  - the main checkout, reached through an alias, answers with its own project;
 *  - a subfolder of a repository is NOT the repository: a monorepo package
 *    registered as a project stays itself (null);
 *  - a folder that is gone answers from the worktree table or from where it
 *    lived (`vanishedWorktreeParent`), because git can no longer be asked.
 *
 * Existing rows are never rewritten by this: callers use it at the moment a path
 * COMES IN (dispatch, adoption, auto-bind, project creation), so a worktree can
 * no longer open a second board for a repository that already has one.
 */
export function canonicalProjectFor<T extends CanonicalProjectRow>(
  path: string,
  projects: readonly T[],
  deps: CanonicalProjectDeps = {},
): T | null {
  if (!path || !isAbsolute(path)) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    // Gone: git cannot answer, the registry and the path layout can.
    const owner = deps.worktreeOwner?.(path) ?? null;
    const byRow = owner ? projects.find((p) => p.id === owner) : undefined;
    if (byRow) return byRow;
    return vanishedWorktreeParent(path, projects, deps.worktreeRoot);
  }
  const facts = (deps.gitFacts ?? readGitCheckoutFacts)(real);
  if (!facts || facts.topLevel !== real) return null;
  const main = mainCheckoutOf(facts.commonDir);
  return projects.find((p) => realOrSelf(p.path) === main) ?? null;
}

/**
 * Pure check behind `worktree-orphans --check-projects`: the projects whose own
 * `path` is a worktree (linked checkout, or a folder under a worktree location)
 * and that have no `parentId`. They are the boards a worktree opened by itself.
 */
export function projectsInsideWorktrees<T extends CanonicalProjectRow & { parentId?: string | null }>(
  projects: readonly T[],
  deps: Pick<CanonicalProjectDeps, "gitFacts" | "worktreeRoot"> = {},
): T[] {
  const out: T[] = [];
  for (const p of projects) {
    if (p.parentId) continue;
    let real: string | null = null;
    try { real = realpathSync(p.path); } catch { /* vanished: judged by its address */ }
    if (real === null) {
      const inRoot = !!deps.worktreeRoot && isInsideDir(p.path, deps.worktreeRoot) && p.path !== resolve(deps.worktreeRoot);
      if (inRoot || p.path.includes(`${sep}.claude${sep}worktrees${sep}`)) out.push(p);
      continue;
    }
    const facts = (deps.gitFacts ?? readGitCheckoutFacts)(real);
    if (facts && facts.topLevel === real && mainCheckoutOf(facts.commonDir) !== real) out.push(p);
  }
  return out;
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

// Config/tooling dot-dirs that are never user projects even though a chat or a
// terminal may have been rooted there. NOT the app data root — its `workspace/<name>`
// children are legit catch-all projects (see scanWorkspace); we only strip the
// well-known non-project homes below.
const NON_PROJECT_DOTDIR = /\/\.(claude|config|cache|local|npm|bun|cargo|rustup|ssh|vscode|cursor|git|Trash|topics)(\/|$)/;

/**
 * Pure display filter: which candidate dirs are offered as SELECTABLE boards in
 * the task-detail project picker / sidebar. This trims the union used only for
 * DISPLAY — never the resolver (which must still invert `generale-…`/husk hashes
 * so existing tasks keep dispatching). Excludes:
 *  - the catch-all `workspace/generale` and per-task `workspace/tasks/<id8>`
 *    cwds — internal plumbing, not projects the user picks ("task senza
 *    progetto" live ungrouped at the top level, not under a phantom board);
 *  - the home dir itself and config dot-dirs (`~/.claude`, …);
 *  - a workspace-nested dir with NO project marker — a husk left by a catch-all
 *    run (only agent runtime artifacts like `.browser-cookies`), which keeps
 *    getting recreated on boot; real workspace projects always carry a marker;
 *  - paths that no longer exist on disk (stale topic/terminal rows).
 */
export function isSelectableProjectDir(
  path: string,
  deps: { workspaceDir: string; homeDir: string; exists?: (p: string) => boolean },
): boolean {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const p = resolve(path);
  const generale = join(deps.workspaceDir, "generale");
  const tasksDir = join(deps.workspaceDir, "tasks");
  if (p === resolve(generale)) return false;
  if (isInsideDir(p, tasksDir)) return false;
  if (p === resolve(deps.homeDir)) return false;
  if (NON_PROJECT_DOTDIR.test(p)) return false;
  const exists = deps.exists ?? existsSync;
  if (!exists(p)) return false;
  // Workspace-nested dir → must look like a real project, not a runtime husk.
  // The workspace root itself is not "nested", so it keeps the plain check.
  const ws = resolve(deps.workspaceDir);
  if (p !== ws && isInsideDir(p, ws) && !PROJECT_MARKERS.some((m) => exists(join(p, m)))) return false;
  return true;
}

/**
 * I progetti che il server ENUMERA dentro il workspace della cartella dati: figli
 * diretti con un marcatore di progetto. Esportata perché è una SORGENTE, non un
 * dettaglio del resolver: da qui escono i dir che l'indice della board
 * (`/api/all-boards/projects`) mostra, e quindi anche quelli che l'allowlist di
 * `known-project-dirs.ts` deve conoscere. Finché era privata, l'indice mostrava
 * `workspace/dashboard` e `workspace/dancerooms` e l'icona di quegli stessi due
 * progetti prendeva 403 — visti nella lista, negati sulla favicon.
 */
export function scanWorkspaceProjects(workspaceDir: string): string[] {
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
  for (const path of scanWorkspaceProjects(deps.workspaceDir)) pathOnly(path);
  if (deps.extraPaths) {
    let extras: string[] = [];
    try { extras = deps.extraPaths(); } catch { /* best-effort source */ }
    for (const path of extras) {
      if (typeof path !== "string" || !isAbsolute(path)) continue;
      pathOnly(resolve(path));
    }
  }
  return out;
}

/**
 * DOVE nasce un progetto nuovo creato per nome — la cartella in cui l'utente
 * tiene i suoi progetti, non `<app data>/workspace`.
 *
 * Il workspace è plumbing dell'agente (il catch-all `generale`, le cwd dei
 * task). Scaffoldare lì un progetto che l'utente ha appena battuto a mano lo
 * seppellisce in una dot-dir: esiste, dispaccia, e non lo ritrova più. La
 * cartella giusta non è configurata da nessuna parte, ma è DEDUCIBILE: è il
 * genitore che i progetti già noti hanno in comune.
 *
 * Regole, tutte per non indovinare a caso:
 *  - si contano i genitori dei dir già noti, saltando ciò che sta DENTRO il
 *    workspace (altrimenti il plumbing voterebbe per sé stesso);
 *  - i percorsi si DEDUPLICANO prima di contare: `listProjectDirs` restituisce
 *    lo stesso dir più volte (con e senza barra finale, da sorgenti diverse) e
 *    un progetto solo, contato due volte, fingeva una maggioranza che non c'è;
 *  - serve una maggioranza vera: almeno DUE progetti sotto lo stesso genitore.
 *    Con un progetto solo non c'è un «di solito», e si ricade sul workspace;
 *  - la home nuda e `/` non sono mai un bersaglio: troppo larghi per starci a
 *    creare cartelle;
 *  - nessuna cartella NASCOSTA: `~/.topics/worktrees/<repo>` ospita decine di
 *    worktree, che sono nell'elenco dei dir noti come tutti gli altri, e su una
 *    macchina con pochi progetti veri vincerebbero la conta. Un progetto che
 *    crei a mano non nasce in una dot-dir — e la regola copre da sola anche
 *    `<app data>/workspace`;
 *  - la cartella scelta deve ESISTERE. Dedotta da righe stantie (topic di un
 *    disco che non c'è più) puntava a un percorso immaginario, e la creazione
 *    moriva con un 500 invece di ricadere sul workspace;
 *  - a parità di conteggio vince il percorso più corto, poi l'ordine
 *    alfabetico — deve essere deterministico, non «quello che è arrivato prima».
 *
 * Resta una DEDUZIONE, quindi chi la usa deve MOSTRARE la cartella scelta
 * prima di creare: il client la stampa sulla riga «Crea "x"… in <cartella>».
 */
/** Any segment starting with a dot: a worktree, a cache or a config tree. */
function hasHiddenSegment(p: string): boolean {
  return p.split(sep).some((segment) => segment.length > 1 && segment.startsWith("."));
}

export function newProjectParentDir(
  dirs: readonly string[],
  deps: { workspaceDir: string; homeDir: string; exists?: (p: string) => boolean },
): string {
  const ws = resolve(deps.workspaceDir);
  const home = resolve(deps.homeDir);
  const exists = deps.exists ?? existsSync;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of dirs) {
    if (typeof raw !== "string" || !isAbsolute(raw)) continue;
    const p = resolve(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    if (isInsideDir(p, ws)) continue;
    const parent = dirname(p);
    // `dirname` of a volume root is the root itself: `/` and `C:\\` are both
    // too broad to hold a new project, and so is the bare home dir.
    if (dirname(parent) === parent || parent === home) continue;
    if (hasHiddenSegment(parent)) continue; // dot-dir: worktree, cache, config

    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1; // «almeno due»: uno solo non fa una consuetudine
  for (const [parent, n] of counts) {
    if (n < bestCount || !exists(parent)) continue;
    if (n > bestCount) { best = parent; bestCount = n; continue; }
    if (best !== null && (parent.length < best.length || (parent.length === best.length && parent < best))) best = parent;
  }
  return best ?? ws;
}

/**
 * Creates the folder of a new project: the ONE place a project is born by
 * name. There used to be five copies of `join(workspace, name)` and only one
 * (the board) went through `newProjectParentDir`: the sessions'
 * `create_project` tool, `/project create` and the two topic routes created
 * everything inside `<app data>/workspace`, which is the agent's plumbing
 * (02/10: `pop-demo`).
 *
 * The new folder is also REGISTERED in the store: outside the workspace no
 * scan picks it up, and unregistered it would vanish from the picker on the
 * first reload (see the `/api/all-boards/projects` route).
 *
 * `exists` = a folder with that name is already there: nothing is overwritten,
 * the caller answers 409 or its equivalent. Disk errors propagate.
 */
export function scaffoldNewProject(
  safeName: string,
  deps: {
    workspaceDir: string;
    homeDir: string;
    knownDirs: readonly string[];
    projectStore?: Pick<ProjectStore, "getByPath" | "slugify" | "create"> | null;
  },
): { dir: string; exists: boolean } {
  const dir = join(newProjectParentDir(deps.knownDirs, deps), safeName);
  if (existsSync(dir)) return { dir, exists: true };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), `# ${safeName}\n`);
  const store = deps.projectStore;
  if (store && !store.getByPath(dir)) {
    // Slug already taken by another project: try a derived one instead of
    // leaving the folder orphaned and invisible.
    const base = store.slugify(safeName);
    for (const slug of [base, `${base}-${projectIdForPath(dir).split("-").pop()}`]) {
      try { store.create({ name: safeName, slug, path: dir, color: null, icon: null }); break; }
      catch { /* slug conflict: try the next one */ }
    }
  }
  return { dir, exists: false };
}
