/**
 * Git file watcher — watches .git directories for changes and broadcasts
 * updated status via WebSocket. Debounces to avoid excessive git subprocess spawning.
 *
 * Phase A · WORKTREE-05: when a watched path is a git *worktree* rather
 * than a top-level repo, `.git` is a *file* pointing at the parent's
 * `.git/worktrees/<name>/` directory. We resolve that pointer once at
 * watcher-start so the underlying `index` / `HEAD` / `refs` we watch live
 * in the worktree-specific git dir, not the parent's. Broadcasts include
 * an optional `worktreeId` field — omitted (undefined) for plain repo
 * paths so existing consumers see the exact pre-Phase-A envelope.
 */
import { watch, existsSync, statSync, readFileSync } from "fs";
import { join, isAbsolute, dirname } from "path";
import type { AppContext } from "./types";
import { invalidateGitCache } from "./routes/files";
import { STATUS_ARGS, parsePorcelainZ, scopeToPrefix, repoPrefixOf } from "./lib/git-porcelain";
import { attachNumstats, readNumstats, type Numstat } from "./lib/git-numstat";

const DEBOUNCE_MS = 500;
// Keyed by absPath so distinct worktrees of the same project don't collide.
const watchers = new Map<string, { close: () => void }>();
/** L'id del worktree per path, così `refreshGitStatus` può ricostruire la busta. */
const worktreeIds = new Map<string, string>();

// Shape of the computed git status. Named so the broadcast envelope below
// is typed instead of leaking `any` (matches the typed ws-outbound discipline).
type GitStatus = {
  branch: string;
  lastCommit: { hash: string; message: string; author: string; ago: string };
  /**
   * `origPath` solo per rename/copie: il path di provenienza.
   * `staged`/`unstaged`: quante righe, per lato. Assenti quando non c'è un
   * numero da dare (un non tracciato non sta in nessun diff), che è diverso da
   * zero — vedi `lib/git-numstat.ts`.
   */
  files: { path: string; status: string; origPath?: string; staged?: Numstat; unstaged?: Numstat }[];
  ahead: number;
  behind: number;
};

/**
 * Resolve the directory we should hand to `watch()` for a given working
 * tree. For plain repos this is `<path>/.git/`. For worktrees the `.git`
 * is a file (`gitdir: …`) pointing to the parent's
 * `.git/worktrees/<name>/`. Returns null if neither shape is recognised.
 */
function resolveGitDir(projectPath: string): string | null {
  const dotGit = join(projectPath, ".git");
  if (!existsSync(dotGit)) return null;
  let st;
  try { st = statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    try {
      const raw = readFileSync(dotGit, "utf-8").trim();
      const m = raw.match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      const target = m[1].trim();
      const resolved = isAbsolute(target) ? target : join(dirname(dotGit), target);
      return existsSync(resolved) ? resolved : null;
    } catch { return null; }
  }
  return null;
}

async function computeGitStatus(resolvedDir: string): Promise<GitStatus | null> {
  try {
    const statusProc = Bun.spawn(STATUS_ARGS, { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
    const statusText = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    const branchProc = Bun.spawn(["git", "branch", "--show-current"], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
    let branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;

    if (!branch) {
      try {
        const headProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
        branch = (await new Response(headProc.stdout).text()).trim() || "HEAD";
        await headProc.exited;
      } catch { branch = "HEAD"; }
    }

    const logProc = Bun.spawn(["git", "log", "-1", "--format=%H|%s|%an|%ar"], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
    const logText = (await new Response(logProc.stdout).text()).trim();
    await logProc.exited;
    const [hash = "", message = "", author = "", ago = ""] = logText.split("|");

    let ahead = 0, behind = 0;
    try {
      const revProc = Bun.spawn(["git", "rev-list", "--left-right", "--count", `${branch}...@{upstream}`], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
      const revText = (await new Response(revProc.stdout).text()).trim();
      await revProc.exited;
      const parts = revText.split(/\s+/);
      if (parts.length >= 2) { ahead = parseInt(parts[0]) || 0; behind = parseInt(parts[1]) || 0; }
    } catch {}

    let relativePrefix = "";
    try {
      const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
      const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
      await toplevelProc.exited;
      // Stessa funzione della rotta, e deve restarlo. Qui c'era un `startsWith`
      // fra path grezzi: `--show-toplevel` risponde col path REALE, quindi una
      // cartella raggiunta via symlink (su macOS `/tmp` → `/private/tmp`) non
      // combaciava e il prefisso restava vuoto. Risultato: il push del watcher
      // elencava i file di TUTTO il repo mentre il poll ne elencava un pezzo,
      // e la lista cambiava a seconda di chi dei due era arrivato per ultimo.
      relativePrefix = repoPrefixOf(resolvedDir, gitRoot).prefix;
    } catch {}

    // Stesso parse della rotta `/api/git/status` (`lib/git-porcelain.ts`), e
    // deve restarlo: questo push e quella risposta descrivono lo stesso stato,
    // e due parse diversi vorrebbero dire due verità diverse a seconda che
    // l'aggiornamento sia arrivato dal watcher o dal poll. Il codice XY resta
    // grezzo a due caratteri — il client lo legge per posizione.
    const files = attachNumstats(
      scopeToPrefix(parsePorcelainZ(statusText), relativePrefix),
      await readNumstats(resolvedDir),
      relativePrefix,
    );

    return { branch, lastCommit: { hash, message, author, ago }, files, ahead, behind };
  } catch {
    return null;
  }
}

/**
 * Ricalcola lo stato git e lo trasmette. Invalida anche la cache della rotta.
 *
 * Esportata perché il watcher di `.git` NON è l'unica cosa che cambia lo stato:
 * guarda `index`, `HEAD` e `refs`, cioè le operazioni GIT. Salvare un file nel
 * worktree non tocca niente di tutto ciò, quindi una modifica fatta da un
 * editor esterno, da un agente o da un terminale non faceva scattare nessun
 * push — e con un canale WS attivo il poll del client è a 60 secondi. Misurato:
 * un file modificato fuori dall'app poteva restare invisibile al pannello per
 * un minuto.
 *
 * Il chiamante è il watcher dei FILE (`file-watcher.ts`), che ha già il suo
 * debounce e il suo filtro sui path rumorosi.
 */
export async function refreshGitStatus(projectPath: string, ctx: AppContext): Promise<void> {
  invalidateGitCache(projectPath);
  const status = await computeGitStatus(projectPath);
  if (!status) return;
  const envelope: { type: "git:status"; projectPath: string; status: GitStatus; worktreeId?: string } = {
    type: "git:status",
    projectPath,
    status,
  };
  const wt = worktreeIds.get(projectPath);
  if (wt !== undefined) envelope.worktreeId = wt;
  ctx.broadcastToAll(envelope);
}

/**
 * Start watching a working-tree directory.
 *
 * @param projectPath  Absolute path to the working tree (project root or
 *                     worktree absPath).
 * @param ctx          AppContext for the broadcast helper.
 * @param worktreeId   Optional worktree id. When provided, broadcasts
 *                     carry `{ worktreeId }` so consumers can scope cache
 *                     invalidation to that worktree. When omitted the
 *                     broadcast envelope is identical to the pre-Phase-A
 *                     shape — existing consumers don't need to change.
 */
export function watchGitDir(
  projectPath: string,
  ctx: AppContext,
  worktreeId?: string,
) {
  // Keying by projectPath is unchanged for top-level repos; worktrees
  // get their own key naturally because their absPath is distinct.
  if (watchers.has(projectPath)) return;

  const gitDir = resolveGitDir(projectPath);
  if (!gitDir) return;
  if (worktreeId !== undefined) worktreeIds.set(projectPath, worktreeId);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Invalidate server-side cache immediately. The cache is keyed by
    // `projectPath`, so each worktree gets its own slot.
    invalidateGitCache(projectPath);
    debounceTimer = setTimeout(() => { void refreshGitStatus(projectPath, ctx); }, DEBOUNCE_MS);
  };

  try {
    const indexWatcher = existsSync(join(gitDir, "index"))
      ? watch(join(gitDir, "index"), onChange)
      : null;
    const headPath = join(gitDir, "HEAD");
    const headWatcher = existsSync(headPath) ? watch(headPath, onChange) : null;

    let refsWatcher: ReturnType<typeof watch> | null = null;
    const refsDir = join(gitDir, "refs");
    if (existsSync(refsDir)) {
      try {
        refsWatcher = watch(refsDir, { recursive: true }, onChange);
      } catch {
        // recursive watch not supported on all platforms
      }
    }

    watchers.set(projectPath, {
      close() {
        indexWatcher?.close();
        headWatcher?.close();
        refsWatcher?.close();
        if (debounceTimer) clearTimeout(debounceTimer);
      },
    });
  } catch (err) {
    console.warn(`[GitWatcher] Could not watch ${gitDir}:`, err);
  }
}

export function unwatchGitDir(projectPath: string) {
  worktreeIds.delete(projectPath);
  const w = watchers.get(projectPath);
  if (w) {
    w.close();
    watchers.delete(projectPath);
  }
}
