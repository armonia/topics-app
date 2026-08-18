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

// Config/tooling dot-dirs that are never user projects even though a chat or a
// terminal may have been rooted there. NOT `.openclaw` — its `workspace/<name>`
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
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  const p = path.replace(/\/+$/, "");
  if (!p) return false;
  const generale = join(deps.workspaceDir, "generale");
  const tasksDir = join(deps.workspaceDir, "tasks");
  if (p === generale) return false;
  if (p === tasksDir || p.startsWith(tasksDir + "/")) return false;
  if (p === deps.homeDir.replace(/\/+$/, "")) return false;
  if (NON_PROJECT_DOTDIR.test(p)) return false;
  const exists = deps.exists ?? existsSync;
  if (!exists(p)) return false;
  // Workspace-nested dir → must look like a real project, not a runtime husk.
  const ws = deps.workspaceDir.replace(/\/+$/, "");
  if (p.startsWith(ws + "/") && !PROJECT_MARKERS.some((m) => exists(join(p, m)))) return false;
  return true;
}

/**
 * I progetti che il server ENUMERA dentro il workspace di OpenClaw: figli
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
      if (typeof path !== "string" || !path.startsWith("/")) continue;
      pathOnly(path.replace(/\/+$/, ""));
    }
  }
  return out;
}

/**
 * DOVE nasce un progetto nuovo creato per nome — la cartella in cui l'utente
 * tiene i suoi progetti, non `~/.openclaw/workspace`.
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
 *    `~/.openclaw/workspace`;
 *  - la cartella scelta deve ESISTERE. Dedotta da righe stantie (topic di un
 *    disco che non c'è più) puntava a un percorso immaginario, e la creazione
 *    moriva con un 500 invece di ricadere sul workspace;
 *  - a parità di conteggio vince il percorso più corto, poi l'ordine
 *    alfabetico — deve essere deterministico, non «quello che è arrivato prima».
 *
 * Resta una DEDUZIONE, quindi chi la usa deve MOSTRARE la cartella scelta
 * prima di creare: il client la stampa sulla riga «Crea "x"… in <cartella>».
 */
export function newProjectParentDir(
  dirs: readonly string[],
  deps: { workspaceDir: string; homeDir: string; exists?: (p: string) => boolean },
): string {
  const ws = deps.workspaceDir.replace(/\/+$/, "");
  const home = deps.homeDir.replace(/\/+$/, "");
  const exists = deps.exists ?? existsSync;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of dirs) {
    if (typeof raw !== "string" || !raw.startsWith("/")) continue;
    const p = raw.replace(/\/+$/, "");
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (p === ws || p.startsWith(ws + "/")) continue;
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (parent === "/" || parent === home) continue;
    if (parent.includes("/.")) continue; // dot-dir: worktree, cache, config

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
