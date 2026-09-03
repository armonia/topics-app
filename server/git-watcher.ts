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
// Dal modulo della cache, non dalla route che la riempie: importare
// `./routes/files` da qui chiudeva il ciclo
// file-watcher → git-watcher → routes/files → file-watcher.
import { invalidateGitCache, writeGitStatusCache } from "./lib/git-status-cache";
import { computeGitStatus, type GitStatus } from "./lib/git-status";

const DEBOUNCE_MS = 500;
// Keyed by absPath so distinct worktrees of the same project don't collide.
const watchers = new Map<string, { close: () => void }>();
/** L'id del worktree per path, così `refreshGitStatus` può ricostruire la busta. */
const worktreeIds = new Map<string, string>();

/**
 * Resolve the directory we should hand to `watch()` for a given working
 * tree. For plain repos this is `<path>/.git/`. For worktrees the `.git`
 * is a file (`gitdir: ...`) pointing to the parent's
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

// The status itself (shape and the five spawns that produce it) lives in
// `lib/git-status.ts`, shared with `GET /api/git/status`. This file used to
// carry its own copy of the eight-spawn procedure, and the two had already
// drifted once (the symlink prefix). `computeGitStatus` returns `null` for a
// path that is not a repo and throws on a git failure; here both mean "no
// push", as before.
async function computeGitStatusQuietly(resolvedDir: string): Promise<GitStatus | null> {
  try {
    return await computeGitStatus(resolvedDir);
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
  const status = await computeGitStatusQuietly(projectPath);
  if (!status) return;
  // The route's cache is filled here, not only emptied: the client polls
  // `/api/git/status` right after a push, and that poll used to be a miss
  // (eight spawns) for the very state this push already computed.
  writeGitStatusCache(projectPath, status);
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
