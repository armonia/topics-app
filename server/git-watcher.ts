/**
 * Git file watcher — watches .git directories for changes and broadcasts
 * updated status via WebSocket. Debounces to avoid excessive git subprocess spawning.
 */
import { watch, existsSync } from "fs";
import { join } from "path";
import type { AppContext } from "./types";
import { invalidateGitCache } from "./routes/files";

const DEBOUNCE_MS = 500;
const watchers = new Map<string, { close: () => void }>();

async function computeGitStatus(resolvedDir: string) {
  try {
    const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
    const statusText = await new Response(statusProc.stdout).text();
    await statusProc.exited;

    const branchProc = Bun.spawn(["git", "branch", "--show-current"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
    let branch = (await new Response(branchProc.stdout).text()).trim();
    await branchProc.exited;

    if (!branch) {
      try {
        const headProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        branch = (await new Response(headProc.stdout).text()).trim() || "HEAD";
        await headProc.exited;
      } catch { branch = "HEAD"; }
    }

    const logProc = Bun.spawn(["git", "log", "-1", "--format=%H|%s|%an|%ar"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
    const logText = (await new Response(logProc.stdout).text()).trim();
    await logProc.exited;
    const [hash = "", message = "", author = "", ago = ""] = logText.split("|");

    let ahead = 0, behind = 0;
    try {
      const revProc = Bun.spawn(["git", "rev-list", "--left-right", "--count", `${branch}...@{upstream}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
      const revText = (await new Response(revProc.stdout).text()).trim();
      await revProc.exited;
      const parts = revText.split(/\s+/);
      if (parts.length >= 2) { ahead = parseInt(parts[0]) || 0; behind = parseInt(parts[1]) || 0; }
    } catch {}

    let relativePrefix = "";
    try {
      const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
      const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
      await toplevelProc.exited;
      if (gitRoot && resolvedDir !== gitRoot && resolvedDir.startsWith(gitRoot)) {
        relativePrefix = resolvedDir.slice(gitRoot.length + 1);
        if (relativePrefix && !relativePrefix.endsWith("/")) relativePrefix += "/";
      }
    } catch {}

    const allFiles = statusText.split("\n").filter(Boolean).map((line) => ({
      path: line.substring(3),
      status: line.substring(0, 2).trim(),
    }));
    const files = relativePrefix
      ? allFiles.filter((f) => f.path.startsWith(relativePrefix)).map((f) => ({ ...f, path: f.path.slice(relativePrefix.length) }))
      : allFiles;

    return { branch, lastCommit: { hash, message, author, ago }, files, ahead, behind };
  } catch {
    return null;
  }
}

export function watchGitDir(projectPath: string, ctx: AppContext) {
  if (watchers.has(projectPath)) return; // already watching

  const gitDir = join(projectPath, ".git");
  if (!existsSync(gitDir)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Invalidate server-side cache immediately
    invalidateGitCache(projectPath);
    debounceTimer = setTimeout(async () => {
      const status = await computeGitStatus(projectPath);
      if (status) {
        ctx.broadcastToAll({ type: "git:status", projectPath, status });
      }
    }, DEBOUNCE_MS);
  };

  try {
    // Watch .git/index (changes on stage/unstage/commit) and .git/HEAD (branch switch)
    const indexWatcher = existsSync(join(gitDir, "index"))
      ? watch(join(gitDir, "index"), onChange)
      : null;
    const headWatcher = watch(join(gitDir, "HEAD"), onChange);

    // Also watch the refs directory for branch operations
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
        headWatcher.close();
        refsWatcher?.close();
        if (debounceTimer) clearTimeout(debounceTimer);
      },
    });
  } catch (err) {
    console.warn(`[GitWatcher] Could not watch ${gitDir}:`, err);
  }
}

export function unwatchGitDir(projectPath: string) {
  const w = watchers.get(projectPath);
  if (w) {
    w.close();
    watchers.delete(projectPath);
  }
}
