import { canonicalProjectPath } from "../lib/canonical-project-path";
import { isInsideDir } from "../lib/path-containment";
import { worktreeRootDir } from "../services/worktree-manager";
import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { detectProjectPath } from "../lib/detect-project-path";
import { homedir } from "os";
import { scaffoldNewProject } from "../services/project-path-resolver";
import type { AppContext, Topic } from "../types";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import { matchProjectRefAll, type ProjectRefCandidate } from "../lib/project-ref";
import { projectIdForPath } from "../../shared/board";
import { moveTerminalPaneToProject as relocateTerminalPaneToProject, moveTopicToProject } from "../lib/relocate-pane";

/** What the router (and the route groups split out of it) share about binding a chat to a project folder. */
export type ProjectBinding = ReturnType<typeof createProjectBinding>;

/** Project resolution, scaffolding and binding: everything ctx alone is enough for. */
export function createProjectBinding(ctx: AppContext) {
  const { APP_DATA_DIR, broadcastToAll, loadTopics, saveSingleTopic, getTopicById, loadLocalMessages, projectStore, worktreeStore, db } = ctx;

  function isExistingDir(p: string): boolean {
    try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
  }

  /**
   * The worktree row an adopted session works in, made when the folder is a
   * linked worktree nobody in Topics registered (Claude Desktop's
   * `.claude/worktrees/`, a `git worktree add` by hand). A row is what
   * `resolveTopicCwd` and the provider read to spawn the CLI THERE, and what
   * the worktree sweep sees. `mode: "reuse"` because the branch is not
   * Topics': the sweep never lands it or deletes it (`decideWorktreeReap`),
   * and it keeps the folder of a chat that is still open (`liveInside`).
   *
   * Idempotent on the path (`abs_path` is UNIQUE): the second adoption from
   * the same folder reuses the row. A row from another project at that path
   * is a conflict the caller reports, never an overwrite.
   */
  function registerAdoptedWorktree(projectDir: string, absPath: string, adminName: string | null, branch: string | null): { id: string } | { error: string } {
    const project = projectStore.getByPath(projectDir)
      ?? projectStore.list().find((p) => canonicalProjectPath(p.path) === projectDir)
      ?? null;
    if (!project) return { error: `no Topics project at ${projectDir}` };
    // Under Topics' own root (a Claude worktree nested inside a Topics one) the
    // path would read as Topics' and the sweep and delete would treat it so:
    // the guard that keeps an adopted folder safe decides on the path alone.
    if (isInsideDir(absPath, worktreeRootDir())) return { error: `worktree ${absPath} is inside Topics' worktree root` };
    const existing = worktreeStore.getByAbsPath(absPath);
    if (existing) {
      if (existing.projectId !== project.id) return { error: `worktree ${absPath} already belongs to another project` };
      if (existing.status !== "ready") worktreeStore.update(existing.id, { status: "ready" });
      return { id: existing.id };
    }
    const taken = worktreeStore.listNamesForProject(project.id);
    const stem = (adminName || basename(absPath)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 56) || "adopted";
    let name = stem;
    for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`;
    const row = worktreeStore.create({ projectId: project.id, name, branchName: branch, baseRef: branch, mode: "reuse", absPath });
    worktreeStore.update(row.id, { status: "ready" });
    return { id: row.id };
  }

  /** The model of the last real assistant turn, as the CLI stamped it. */
  function lastTranscriptModel(text: string): string | null {
    let end = text.length;
    for (let scanned = 0; end > 0 && scanned < 400; scanned++) {
      const start = text.lastIndexOf("\n", end - 1) + 1;
      const line = text.slice(start, end);
      end = start - 1;
      if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
      try {
        const m = JSON.parse(line)?.message?.model;
        if (typeof m === "string" && m && !m.startsWith("<")) return m;
      } catch { /* a cut line */ }
    }
    return null;
  }

  /**
   * Resolve a project reference (a Topics project name/slug, a `~/` or absolute
   * path, or a workspace folder name) to an absolute directory on disk.
   *
   * Crucially this prefers the user's REAL Topics projects (projectStore) and
   * folders already bound to a topic — not just `<app data>/workspace`. That is
   * what makes a cloud session's "open project Pix" land on the actual Pix
   * project the user has in Topics. Returns null when nothing resolves to an
   * existing directory.
   */
  function resolveProjectRef(ref: string, opts?: { trustRawPaths?: boolean }): string | null {
    const raw = (ref || "").trim();
    if (!raw) return null;

    // Absolute / home-relative paths. Honoured verbatim ONLY for explicit local
    // user actions (the /project command, an adopt body). On the AI-marker path
    // (trustRawPaths falsy) a raw path must already be a project Topics knows
    // about — otherwise a model, or prompt injection reaching a cloud session,
    // could emit {{PROJECT_OPEN:~/.ssh}} / {{PROJECT_OPEN:/etc}} and make every
    // connected client open a pane rooted at an arbitrary directory.
    if (raw.startsWith("/") || raw.startsWith("~/")) {
      // Il link si scioglie qui, prima del cancello: `isKnownProject` confronta
      // stringhe, e un progetto gia' noto raggiunto dal suo link non risultava noto.
      const abs = canonicalProjectPath(raw);
      if (!isExistingDir(abs)) return null;
      return (opts?.trustRawPaths || isKnownProject(abs)) ? abs : null;
    }

    // Bare name/slug: match against known projects (strongest signal first).
    const candidates: ProjectRefCandidate[] = [];
    try {
      for (const p of projectStore.list({ archived: false })) {
        candidates.push({ path: p.path, name: p.name, slug: p.slug });
      }
    } catch { /* projectStore is best-effort here */ }
    // Topic-bound paths ordered by liveness: a NON-archived, recently-updated
    // binding beats a dead one. Without this, "topics-app" once resolved to an
    // empty workspace husk because six archived June chats iterated before the
    // live ones bound to the real repo.
    const topicList = (Object.values(loadTopics().topics) as any[])
      .filter((t) => typeof t?.projectPath === "string" && t.projectPath)
      .sort((a, b) =>
        (Number(!!a.archived) - Number(!!b.archived)) ||
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    for (const t of topicList) candidates.push({ path: t.projectPath });
    for (const p of getWorkspaceProjects()) candidates.push({ path: p });

    // Compare candidate slugs with the SAME slugify that produced them (the
    // store's), so "My App" matches a project stored as slug "my-app". On an
    // ambiguous ref (same basename in several places) prefer the match that
    // LOOKS like a project (git repo, CLAUDE.md, manifest…) over a bare husk.
    const matches = matchProjectRefAll(raw, candidates, (s) => projectStore.slugify(s)).filter(isExistingDir);
    if (matches.length) return matches.find(looksLikeProject) ?? matches[0];

    // Last resort: a same-named folder directly under the workspace.
    //
    // Lo slug si controlla PRIMA del join, e non è pignoleria. Un `raw` fatto
    // solo di caratteri non ammessi — «../..» è il caso da manuale — dà slug
    // VUOTO, e `join(WORKSPACE_DIR, "")` è WORKSPACE_DIR: `isExistingDir`
    // rispondeva sì e questa funzione restituiva la RADICE del workspace,
    // legandoci la topic. È esattamente la classe che il docstring qui sopra
    // dice di parare («un modello, o una prompt injection… potrebbe emettere
    // {{PROJECT_OPEN:~/.ssh}}»), e il ramo è raggiungibile proprio con
    // `trustRawPaths` falso, perché una stringa così non inizia né con «/» né
    // con «~/» e non viene intercettata dal controllo là sopra.
    const slug = raw.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!slug) return null;
    const wsDir = join(WORKSPACE_DIR, slug);
    return isExistingDir(wsDir) ? wsDir : null;
  }

  /** Every project folder the server already knows (store, topics, workspace):
   *  from these `scaffoldNewProject` infers WHERE the user keeps their projects. */
  function knownProjectPaths(): string[] {
    const out: string[] = [];
    try { for (const p of projectStore.list()) out.push(p.path); } catch { /* store best-effort */ }
    for (const t of Object.values(loadTopics().topics)) {
      if (typeof t?.projectPath === "string" && t.projectPath) out.push(t.projectPath);
    }
    return out.concat(getWorkspaceProjects());
  }

  function scaffoldProject(safeName: string): { dir: string; exists: boolean } {
    return scaffoldNewProject(safeName, {
      workspaceDir: WORKSPACE_DIR, homeDir: homedir(), knownDirs: knownProjectPaths(), projectStore,
    });
  }

  /** Is this directory already a project Topics knows about? Used to decide
   *  whether a heuristic auto-bind is safe to surface as a project window. */
  function isKnownProject(dir: string): boolean {
    try { if (projectStore.getByPath(dir)) return true; } catch { /* ignore */ }
    if (getWorkspaceProjects().includes(dir)) return true;
    for (const t of Object.values(loadTopics().topics)) {
      if ((t as any).projectPath === dir) return true;
    }
    return false;
  }

  /**
   * Single source of truth for binding a topic (a chat / cloud session) to a
   * project directory. Persists `projectPath`, notifies clients (topic:updated)
   * and — when `focus` — emits `pane:focus-suggest` so every client opens the
   * project window and nests THIS session inside it. The cloud session then
   * shows up as a project on Topics, the way a Warp cloud session is scoped to
   * its repo. `projectPath` rides along on the focus-suggest so the client
   * never has to wait for topic:updated to arrive first (removes a race).
   */
  function bindTopicToProject(topicId: string, targetDir: string, opts?: { focus?: boolean }): boolean {
    const t = getTopicById(topicId);
    if (!t) return false;
    // The singleton is an ordinary Topic, but deliberately has no project
    // authority. Keep this at the one binding gateway so a future caller
    // cannot accidentally couple it to a selected card or board.
    if (isGlobalOrchestratorTopic(db, t.id)) return false;
    // Un progetto e' una CARTELLA. Il cancello sta qui, alla porta, e non sugli
    // otto chiamanti: metterlo li' vorrebbe dire dimenticarne uno, e quello
    // dimenticato sarebbe il buco. Un path che non esiste passa — puo' essere
    // una cartella che sta per nascere, o un progetto su un disco staccato —
    // ma un FILE no: quello e' definitivamente non un progetto, e legarcisi
    // fa comparire nella barra laterale un progetto fantasma col nome del file.
    try {
      if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
        console.warn(`[topics] bind rifiutato: ${targetDir} esiste e non e' una cartella`);
        return false;
      }
    } catch { /* stat fallito: si lascia passare, come per un path assente */ }
    if (t.projectPath !== targetDir) {
      t.projectPath = targetDir;
      t.updatedAt = new Date().toISOString();
      saveSingleTopic(t);
      broadcastToAll({ type: "topic:updated", topic: t });
    }
    if (opts?.focus) {
      // Lo spostamento vero, prima del suggerimento: la chat entra
      // nell'appartenenza del progetto e si porta dietro il suo pannello
      // browser, che restava fuori come tab orfano. Solo sul ramo `focus`,
      // cioe' quando lo spostamento e' stato CHIESTO (open_project /
      // create_project / bind esplicito): l'aggancio euristico di
      // `autoBindProject` non deve aprire tab in una finestra di progetto per
      // conto suo.
      moveTopicToProject(
        db,
        broadcastToAll,
        { id: t.id, browserContextIds: [t.browserState?.contextId ?? t.id] },
        targetDir,
      );
      broadcastToAll({ type: "pane:focus-suggest", topicId: t.id, projectPath: targetDir });
    }
    return true;
  }

  /**
   * Indovina la cartella di progetto dai messaggi. La regola sta in
   * `lib/detect-project-path.ts`, fuori da questa closure perche' dentro non
   * la poteva provare nessuno — ed e' proprio il suo ripiego ad aver legato una
   * chat a un eseguibile.
   */
  const detectProjectPathFromMessages = (messages: { role: string; content: string }[]) =>
    detectProjectPath(messages);

  /**
   * After first AI response: auto-detect projectPath and auto-name the topic (simple heuristic).
   * Runs server-side without needing a second LLM call.
   */
  function autoBindProject(topic: Topic): void {
    // The coordinator is an intentionally unbound ordinary Topic. Its registry
    // grants narrow global board tools; heuristic message text must never turn
    // that into a selected-project/session authority.
    if (isGlobalOrchestratorTopic(db, topic.id)) return;
    if (topic.projectPath) return; // already bound
    const localMsgs = loadLocalMessages(topic.sessionKey);
    if (localMsgs.length < 2) return; // need at least 1 user + 1 assistant
    const detected = detectProjectPathFromMessages(localMsgs);
    if (detected) {
      const t = getTopicById(topic.id);
      if (t && !t.projectPath) {
        // Heuristic detection: only force the project window open when the
        // folder is one Topics already knows about. A brand-new path mentioned
        // in passing still binds, but doesn't surprise the user with a window.
        bindTopicToProject(t.id, detected, { focus: isKnownProject(detected) });
        console.log(`[AutoBind] Detected projectPath for "${t.name}": ${detected}`);
      }
    }
  }

  /**
   * Il `projectId` della board a cui un topic appartiene, o `null` se il topic
   * non è legato a un progetto.
   *
   * L'hash NON è più riscritto qui: questa closure era la copia che nessun test
   * di parità copriva, quindi l'unica delle tre che poteva derivare in silenzio.
   */
  function getProjectIdForTopic(topicId: string): string | null {
    const topic = getTopicById(topicId);
    if (!topic?.projectPath) return null;
    return projectIdForPath(topic.projectPath);
  }

  // Scan workspace directory for project directories
  const WORKSPACE_DIR = join(APP_DATA_DIR, "workspace");
  const SKIP_DIRS = new Set(["node_modules", "memory", "backups", "test-results"]);
  const PROJECT_MARKERS = [
    ".git", "package.json", "CLAUDE.md", "Cargo.toml", "go.mod", "pyproject.toml",
    "Makefile", "README.md", "tsconfig.json", "requirements.txt", "Dockerfile",
    "index.html", "server.ts", "server.py", "server.js",
  ];
  function getWorkspaceProjects(): string[] {
    try {
      if (!existsSync(WORKSPACE_DIR)) return [];
      return readdirSync(WORKSPACE_DIR, { withFileTypes: true })
        .filter(e => {
          if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) return false;
          return looksLikeProject(join(WORKSPACE_DIR, e.name));
        })
        .map(e => join(WORKSPACE_DIR, e.name));
    } catch { return []; }
  }

  /** Does this dir carry at least one project marker? Used both by the
   *  workspace scan and by resolveProjectRef's ambiguity tiebreak (a real
   *  repo beats a marker-less husk with the same basename). */
  function looksLikeProject(dir: string): boolean {
    try { return PROJECT_MARKERS.some(m => existsSync(join(dir, m))); } catch { return false; }
  }

  /**
   * Relocate a Claude Code TERMINAL tab into a project window — extracted to
   * server/lib/relocate-pane.ts (unit-testable; the closure needed only db +
   * broadcastToAll). The extraction rode along with the duplicate-tab fix:
   * the splice now writes a durable TOMBSTONE, without which live clients'
   * union-hydrate re-persisted the standalone tab right back (moved tab
   * duplicated inside+outside the project, closes coupled). See the module
   * header for the full story.
   */
  const moveTerminalPaneToProject = (
    term: { id: string; name?: string },
    projectDir: string,
  ): { paneId: string; membershipKey: string } =>
    relocateTerminalPaneToProject(db, broadcastToAll, term, projectDir);

  return {
    isExistingDir,
    registerAdoptedWorktree,
    lastTranscriptModel,
    resolveProjectRef,
    knownProjectPaths,
    scaffoldProject,
    isKnownProject,
    bindTopicToProject,
    detectProjectPathFromMessages,
    autoBindProject,
    getProjectIdForTopic,
    WORKSPACE_DIR,
    getWorkspaceProjects,
    looksLikeProject,
    moveTerminalPaneToProject,
  };
}
