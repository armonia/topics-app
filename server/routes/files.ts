import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync } from "fs";
import { join, resolve, relative } from "path";
import type { AppContext, RouteHandler } from "../types";
import { watchGitDir } from "../git-watcher";
import { resolveStateDir } from "../lib/data-dir";

// ── Git status server-side cache (5s TTL, invalidated by git-watcher) ──
const GIT_STATUS_CACHE_TTL = 5000;
interface GitStatusFile { path: string; status: string; }
interface GitStatusResult {
  branch: string;
  lastCommit: { hash: string; message: string; author: string; ago: string };
  files: GitStatusFile[];
  ahead: number;
  behind: number;
}
const gitStatusCache = new Map<string, { data: GitStatusResult; timestamp: number }>();

// Conservative git ref/remote name validation (mirrors worktrees.ts BASE_REF_REGEX)
const GIT_REF_MAX = 200;
const GIT_REF_REGEX = /^[A-Za-z0-9_./\-]+$/;
function isValidGitRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.length > 0 && ref.length <= GIT_REF_MAX && GIT_REF_REGEX.test(ref);
}

export function invalidateGitCache(projectPath: string) {
  gitStatusCache.delete(projectPath);
}

// Backup store persisted to disk for undo support
interface FileBackup {
  filePath: string;
  content: string;
  timestamp: number;
}

const MAX_BACKUPS_PER_FILE = 5;
const MAX_TOTAL_BACKUP_BYTES = 50 * 1024 * 1024; // 50MB total cap
let BACKUPS_DIR = "";

function getBackupsDir(): string {
  if (!BACKUPS_DIR) {
    BACKUPS_DIR = join(resolveStateDir(process.cwd()), ".backups");
    mkdirSync(BACKUPS_DIR, { recursive: true });
  }
  return BACKUPS_DIR;
}

function backupIndexPath(): string {
  return join(getBackupsDir(), "index.json");
}

function loadBackupIndex(): Record<string, FileBackup[]> {
  try {
    return JSON.parse(readFileSync(backupIndexPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveBackupIndex(index: Record<string, FileBackup[]>) {
  writeFileSync(backupIndexPath(), JSON.stringify(index, null, 2));
}

function totalBackupSize(index: Record<string, FileBackup[]>): number {
  let total = 0;
  for (const backups of Object.values(index)) {
    for (const b of backups) {
      total += b.content.length;
    }
  }
  return total;
}

function evictOldestBackups(index: Record<string, FileBackup[]>) {
  while (totalBackupSize(index) > MAX_TOTAL_BACKUP_BYTES) {
    // Find oldest backup across all files
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, backups] of Object.entries(index)) {
      if (backups.length > 0 && backups[0].timestamp < oldestTime) {
        oldestTime = backups[0].timestamp;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    index[oldestKey].shift();
    if (index[oldestKey].length === 0) delete index[oldestKey];
  }
}

function saveBackup(resolvedPath: string, content: string) {
  const index = loadBackupIndex();
  const backups = index[resolvedPath] || [];
  backups.push({ filePath: resolvedPath, content, timestamp: Date.now() });
  while (backups.length > MAX_BACKUPS_PER_FILE) backups.shift();
  index[resolvedPath] = backups;
  evictOldestBackups(index);
  saveBackupIndex(index);
}

function popBackup(resolvedPath: string): FileBackup | undefined {
  const index = loadBackupIndex();
  const backups = index[resolvedPath];
  if (!backups || backups.length === 0) return undefined;
  const backup = backups.pop();
  if (backups.length === 0) delete index[resolvedPath];
  else index[resolvedPath] = backups;
  saveBackupIndex(index);
  return backup;
}

// Simple file-based lock for concurrent apply protection
const activeLocks = new Set<string>();

async function acquireLock(filePath: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (activeLocks.has(filePath)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  activeLocks.add(filePath);
  return true;
}

function releaseLock(filePath: string) {
  activeLocks.delete(filePath);
}

export function createFilesRouter(ctx: AppContext): RouteHandler {
  const { GATEWAY_URL, GATEWAY_TOKEN, readJSON, json, errorResponse, resolveProjectPath } = ctx;

  return async function filesRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- File explorer ---
    if (method === "GET" && pathname === "/api/files") {
      const dirPath = url.searchParams.get("path");
      const depth = parseInt(url.searchParams.get("depth") || "3", 10);
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedPath = resolveProjectPath(dirPath);
      if (!resolvedPath) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedPath)) return json({ error: "directory not found" }, 404);
      try { const s = statSync(resolvedPath); if (!s.isDirectory()) return json({ error: "path is not a directory" }, 400); } catch { return json({ error: "cannot stat directory" }, 500); }

      const DEFAULT_EXCLUDES = new Set(["node_modules", ".git", ".next", "dist", "build", ".DS_Store", "__pycache__", ".cache", ".turbo", ".vercel", ".output", "coverage", ".nyc_output", ".parcel-cache", "target"]);
      function parseGitignore(dir: string): Set<string> {
        const patterns = new Set<string>();
        const gitignorePath = join(dir, ".gitignore");
        try {
          if (existsSync(gitignorePath)) {
            const content = readFileSync(gitignorePath, "utf-8");
            for (const line of content.split("\n")) { const trimmed = line.trim(); if (trimmed && !trimmed.startsWith("#")) { const clean = trimmed.replace(/\/$/, "").replace(/^\//, ""); if (clean) patterns.add(clean); } }
          }
        } catch {}
        return patterns;
      }
      const gitignorePatterns = parseGitignore(resolvedPath);
      const allExcludes = new Set([...DEFAULT_EXCLUDES, ...gitignorePatterns]);
      function shouldExclude(name: string): boolean {
        if (allExcludes.has(name)) return true;
        for (const pattern of allExcludes) {
          if (pattern.startsWith("*.") && name.endsWith(pattern.slice(1))) return true;
          if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
        }
        return false;
      }

      interface FileNode { name: string; type: "file" | "dir"; path: string; size?: number; modified?: string; children?: FileNode[]; }
      function readDirRecursive(dir: string, currentDepth: number): FileNode[] {
        const result: FileNode[] = [];
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          entries.sort((a, b) => { if (a.isDirectory() && !b.isDirectory()) return -1; if (!a.isDirectory() && b.isDirectory()) return 1; return a.name.localeCompare(b.name); });
          for (const entry of entries) {
            if (shouldExclude(entry.name)) continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              const node: FileNode = { name: entry.name, type: "dir", path: fullPath };
              if (currentDepth < depth) node.children = readDirRecursive(fullPath, currentDepth + 1);
              result.push(node);
            } else if (entry.isFile()) {
              try { const stats = statSync(fullPath); result.push({ name: entry.name, type: "file", path: fullPath, size: stats.size, modified: stats.mtime.toISOString() }); } catch { result.push({ name: entry.name, type: "file", path: fullPath }); }
            }
          }
        } catch {}
        return result;
      }
      return json(readDirRecursive(resolvedPath, 1));
    }

    // --- File search (grep) ---
    if (method === "GET" && pathname === "/api/files/search") {
      const query = url.searchParams.get("q");
      const dirPath = url.searchParams.get("path");
      const useRegex = url.searchParams.get("regex") === "true";
      const caseSensitive = url.searchParams.get("caseSensitive") === "true";
      if (!query || !dirPath) return json({ error: "q and path parameters required" }, 400);
      const resolvedPath = resolveProjectPath(dirPath);
      if (!resolvedPath) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedPath)) return json({ error: "directory not found" }, 404);

      try {
        const args = ["-rn", "--max-count=100"];
        if (!caseSensitive) args.push("-i");
        if (!useRegex) args.push("-F");
        // Exclude common dirs/files
        for (const ex of ["node_modules", ".git", "dist", "build"]) args.push(`--exclude-dir=${ex}`);
        args.push("--exclude=*.lock");
        args.push("--", query, ".");

        const proc = Bun.spawn(["grep", ...args], { cwd: resolvedPath, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stdout).text();
        await proc.exited;

        const results: { file: string; line: string; lineNumber: number; match: string }[] = [];
        for (const raw of output.split("\n").filter(Boolean)) {
          // Format: ./path/to/file:lineNum:line content
          const firstColon = raw.indexOf(":");
          if (firstColon === -1) continue;
          const secondColon = raw.indexOf(":", firstColon + 1);
          if (secondColon === -1) continue;
          let file = raw.substring(0, firstColon);
          if (file.startsWith("./")) file = file.slice(2);
          const lineNumber = parseInt(raw.substring(firstColon + 1, secondColon), 10);
          const line = raw.substring(secondColon + 1);
          if (isNaN(lineNumber)) continue;
          results.push({ file, line: line.slice(0, 500), lineNumber, match: query });
          if (results.length >= 100) break;
        }
        return json({ results });
      } catch (err: any) {
        return json({ error: "Search error: " + err.message }, 500);
      }
    }

    // --- File content ---
    if (method === "GET" && pathname === "/api/files/content") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "path parameter required" }, 400);
      const resolvedFile = resolveProjectPath(filePath);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      try {
        const file = Bun.file(resolvedFile);
        if (!(await file.exists())) return new Response("File not found", { status: 404 });
        if (file.size > 100 * 1024) return new Response("File too large (max 100KB)", { status: 413 });
        const content = await file.text();
        return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err: any) { return json({ error: "Failed to read file: " + err.message }, 500); }
    }

    // --- File save ---
    if (method === "POST" && pathname === "/api/files/save") {
      const body = await readJSON(req);
      if (!body?.path || body.content === undefined) return json({ error: "path and content required" }, 400);
      const resolvedFile = resolveProjectPath(body.path);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      try { writeFileSync(resolvedFile, body.content, "utf-8"); return json({ ok: true, path: resolvedFile }); } catch (err: any) { return json({ error: "Failed to save file" }, 500); }
    }

    // --- Apply edit (search/replace) ---
    if (method === "POST" && pathname === "/api/files/apply-edit") {
      const body = await readJSON(req);
      if (!body?.filePath || body.searchText === undefined || body.replaceText === undefined) {
        return json({ error: "filePath, searchText, and replaceText required" }, 400);
      }
      const resolvedFile = resolveProjectPath(body.filePath);
      if (!resolvedFile) return errorResponse(400, "Invalid path");

      // Acquire lock to prevent concurrent applies to same file
      const locked = await acquireLock(resolvedFile);
      if (!locked) return json({ error: "File is locked by another edit operation" }, 409);

      try {
        if (!existsSync(resolvedFile)) return json({ error: "File not found" }, 404);
        const content = readFileSync(resolvedFile, "utf-8");

        // Try exact match first
        let idx = content.indexOf(body.searchText);

        if (idx !== -1) {
          // Save backup before writing
          saveBackup(resolvedFile, content);
          // Exact match apply
          const newContent = content.substring(0, idx) + body.replaceText + content.substring(idx + body.searchText.length);
          writeFileSync(resolvedFile, newContent, "utf-8");
          return json({ ok: true, method: "exact" });
        }

        // Fuzzy: normalize line endings and trim
        {
          const normalizedContent = content.replace(/\r\n/g, "\n");
          const normalizedSearch = body.searchText.replace(/\r\n/g, "\n");
          const nIdx = normalizedContent.indexOf(normalizedSearch);
          if (nIdx !== -1) {
            // Save backup before writing
            saveBackup(resolvedFile, content);
            const newContent = normalizedContent.substring(0, nIdx) + body.replaceText.replace(/\r\n/g, "\n") + normalizedContent.substring(nIdx + normalizedSearch.length);
            writeFileSync(resolvedFile, newContent, "utf-8");
            return json({ ok: true, method: "normalized" });
          }
        }

        // Fuzzy: try trimming each line
        {
          const contentLines = content.split("\n").map(l => l.trimEnd());
          const searchLines = body.searchText.split("\n").map((l: string) => l.trimEnd());
          const searchJoined = searchLines.join("\n");
          const contentJoined = contentLines.join("\n");
          const fuzzyIdx = contentJoined.indexOf(searchJoined);
          if (fuzzyIdx !== -1) {
            // Save backup before writing
            saveBackup(resolvedFile, content);
            const newContent = contentJoined.substring(0, fuzzyIdx) + body.replaceText + contentJoined.substring(fuzzyIdx + searchJoined.length);
            writeFileSync(resolvedFile, newContent, "utf-8");
            return json({ ok: true, method: "fuzzy-trim" });
          }
        }

        return json({ error: "Search text not found in file", ok: false }, 400);
      } catch (err: any) {
        return json({ error: "Failed to apply edit" }, 500);
      } finally {
        releaseLock(resolvedFile);
      }
    }

    // --- Undo edit (restore from backup) ---
    if (method === "POST" && pathname === "/api/files/undo-edit") {
      const body = await readJSON(req);
      if (!body?.filePath) return json({ error: "filePath required" }, 400);
      const resolvedFile = resolveProjectPath(body.filePath);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      try {
        const backup = popBackup(resolvedFile);
        if (!backup) return json({ error: "No backup available for this file", ok: false }, 404);
        writeFileSync(resolvedFile, backup.content, "utf-8");
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: "Failed to undo edit: " + err.message }, 500);
      }
    }

    // --- Git status ---
    if (method === "GET" && pathname === "/api/git/status") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Server-side cache check (5s TTL)
        const cached = gitStatusCache.get(resolvedDir);
        if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL) {
          return json(cached.data);
        }
        // Check if path is a git repo
        const checkProc = Bun.spawn(["git", "rev-parse", "--git-dir"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await checkProc.exited;
        if (checkProc.exitCode !== 0) {
          return json({ notGit: true, branch: "", files: [], ahead: 0, behind: 0, lastCommit: null });
        }
        // Start watching .git for changes (idempotent — only sets up once per path)
        watchGitDir(resolvedDir, ctx);
        const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statusText = await new Response(statusProc.stdout).text();
        const branchProc = Bun.spawn(["git", "branch", "--show-current"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        let branch = (await new Response(branchProc.stdout).text()).trim();
        if (!branch) {
          // Detached HEAD — use short commit hash as label
          try {
            const headProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            branch = (await new Response(headProc.stdout).text()).trim() || "HEAD";
          } catch { branch = "HEAD"; }
        }
        const logProc = Bun.spawn(["git", "log", "-1", "--format=%H|%s|%an|%ar"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const logText = (await new Response(logProc.stdout).text()).trim();
        const [hash = "", message = "", author = "", ago = ""] = logText.split("|");
        let ahead = 0, behind = 0;
        try {
          const revProc = Bun.spawn(["git", "rev-list", "--left-right", "--count", `${branch}...@{upstream}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const revText = (await new Response(revProc.stdout).text()).trim();
          const parts = revText.split(/\s+/);
          if (parts.length >= 2) { ahead = parseInt(parts[0]) || 0; behind = parseInt(parts[1]) || 0; }
        } catch {}
        let relativePrefix = "";
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          if (gitRoot && resolvedDir !== gitRoot && resolvedDir.startsWith(gitRoot)) { relativePrefix = resolvedDir.slice(gitRoot.length + 1); if (relativePrefix && !relativePrefix.endsWith("/")) relativePrefix += "/"; }
        } catch {}
        // Emit the RAW 2-char XY porcelain code (do NOT trim): the client parses
        // it positionally — status[0]=staged (index), status[1]=unstaged (worktree).
        // Trimming "  M" → "M" misclassified unstaged files as staged.
        const allFiles = statusText.split("\n").filter(Boolean).map((line) => ({ path: line.substring(3), status: line.substring(0, 2) }));
        const files = relativePrefix ? allFiles.filter((f) => f.path.startsWith(relativePrefix)).map((f) => ({ ...f, path: f.path.slice(relativePrefix.length) })) : allFiles;
        const result = { branch, lastCommit: { hash, message, author, ago }, files, ahead, behind };
        // Bound the cache: the key is the caller-supplied ?path= (resolved, no
        // allowlist), so it grows with every distinct git repo ever queried and
        // is only ever invalidated for paths a watcher fires on. Evict the
        // oldest entry past a cap so this can't grow without limit.
        if (gitStatusCache.size >= 500) {
          let oldestKey: string | undefined; let oldestTs = Infinity;
          for (const [k, v] of gitStatusCache) { if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k; } }
          if (oldestKey !== undefined) gitStatusCache.delete(oldestKey);
        }
        gitStatusCache.set(resolvedDir, { data: result, timestamp: Date.now() });
        return json(result);
      } catch (err: any) { return json({ error: "Git error: " + err.message }, 500); }
    }

    // --- Git diff ---
    if (method === "GET" && pathname === "/api/git/diff") {
      const dirPath = url.searchParams.get("path");
      const filePath = url.searchParams.get("file");
      if (!dirPath || !filePath) return json({ error: "path and file parameters required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "diff", "--", filePath], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const diff = await new Response(proc.stdout).text();
        if (!diff.trim()) {
          const cachedProc = Bun.spawn(["git", "diff", "--cached", "--", filePath], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          return new Response(await new Response(cachedProc.stdout).text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        return new Response(diff, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err: any) { return json({ error: "Git diff error: " + err.message }, 500); }
    }

    // --- Git branches ---
    if (method === "GET" && pathname === "/api/git/branches") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const branchProc = Bun.spawn(["git", "branch", "-a", "--format=%(refname:short)|%(HEAD)|%(upstream:short)"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const branchText = (await new Response(branchProc.stdout).text()).trim();
        interface GitBranch { name: string; current: boolean; isRemote: boolean; ahead: number; behind: number; }
        const branches: GitBranch[] = [];
        for (const line of branchText.split("\n").filter(Boolean)) {
          const [name, head, upstream] = line.split("|");
          const isCurrent = head === "*";
          const isRemote = name.startsWith("origin/");
          if (name === "origin/HEAD") continue;
          let ahead = 0, behind = 0;
          if (!isRemote && upstream) {
            try { const revProc = Bun.spawn(["git", "rev-list", "--left-right", "--count", `${name}...${upstream}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); const revText = (await new Response(revProc.stdout).text()).trim(); const parts = revText.split(/\s+/); if (parts.length >= 2) { ahead = parseInt(parts[0]) || 0; behind = parseInt(parts[1]) || 0; } } catch {}
          }
          branches.push({ name, current: isCurrent, isRemote, ahead, behind });
        }
        // Detached HEAD — no branch is current, add a HEAD entry
        if (branches.length > 0 && !branches.some(b => b.current)) {
          try {
            const headProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            const headRef = (await new Response(headProc.stdout).text()).trim();
            if (headRef) branches.unshift({ name: headRef, current: true, isRemote: false, ahead: 0, behind: 0 });
          } catch {}
        }
        // Fresh repo (git init, no commits) — git branch returns nothing but HEAD exists
        if (branches.length === 0) {
          try {
            const headProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            const headName = (await new Response(headProc.stdout).text()).trim();
            if (headName) branches.push({ name: headName, current: true, isRemote: false, ahead: 0, behind: 0 });
          } catch {}
        }
        return json(branches);
      } catch (err: any) { return json({ error: "Git branches error: " + err.message }, 500); }
    }

    // --- Git checkout ---
    if (method === "POST" && pathname === "/api/git/checkout") {
      const body = await readJSON(req);
      if (!body?.path || !body?.branch) return json({ error: "path and branch required" }, 400);
      if (!isValidGitRef(body.branch)) return json({ error: "Invalid branch name" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "checkout", body.branch], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Checkout failed" }, 400);
        return json({ ok: true, branch: body.branch });
      } catch (err: any) { return json({ error: "Checkout error: " + err.message }, 500); }
    }

    // --- Git log ---
    if (method === "GET" && pathname === "/api/git/log") {
      const dirPath = url.searchParams.get("path");
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const logArgs = ["git", "log", `--max-count=${limit}`, "--format=%H|%h|%s|%an|%ar|%aI"];
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          if (gitRoot && resolvedDir !== gitRoot && resolvedDir.startsWith(gitRoot)) { logArgs.push("--", resolvedDir.slice(gitRoot.length + 1)); }
        } catch {}
        const proc = Bun.spawn(logArgs, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const logText = (await new Response(proc.stdout).text()).trim();
        const commits = logText.split("\n").filter(Boolean).map(line => { const [hash, shortHash, message, author, ago, date] = line.split("|"); return { hash, shortHash, message, author, ago, date }; });
        return json(commits);
      } catch (err: any) { return json({ error: "Git log error: " + err.message }, 500); }
    }

    // --- Git stage (single file or batch) ---
    if (method === "POST" && pathname === "/api/git/stage") {
      const body = await readJSON(req);
      const files: string[] = body?.files ?? (body?.file ? [body.file] : []);
      if (!body?.path || files.length === 0) return json({ error: "path and file(s) required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Batch all pathspecs into one `git add` — git accepts many at once,
        // so a large stage is a single process spawn instead of N serialized
        // ones. Only fall back to per-file spawns (to attribute the failures)
        // when the batch exits non-zero.
        const batch = Bun.spawn(["git", "add", "--", ...files], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
        await batch.exited;
        if (batch.exitCode === 0) return json({ ok: true });
        const failed: string[] = [];
        for (const f of files) {
          const proc = Bun.spawn(["git", "add", "--", f], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          await proc.exited;
          if (proc.exitCode !== 0) failed.push(f);
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to stage some files", failed }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Stage error: " + err.message }, 500); }
    }

    // --- Git stage all ---
    if (method === "POST" && pathname === "/api/git/stage-all") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try { const proc = Bun.spawn(["git", "add", "-A"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); await proc.exited; return json({ ok: true }); } catch (err: any) { return json({ error: "Stage-all error: " + err.message }, 500); }
    }

    // --- Git diff summary (auto commit message) ---
    if (method === "GET" && pathname === "/api/git/diff-summary") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Get diff stat for staged + unstaged
        const statProc = Bun.spawn(["git", "diff", "--stat", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statText = (await new Response(statProc.stdout).text()).trim();
        // Also get untracked files
        const untrackedProc = Bun.spawn(["git", "ls-files", "--others", "--exclude-standard"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const untrackedText = (await new Response(untrackedProc.stdout).text()).trim();
        // Get status porcelain for changed files
        const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statusText = (await new Response(statusProc.stdout).text()).trim();
        const lines = statusText.split("\n").filter(Boolean);
        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];
        const untracked: string[] = [];
        for (const line of lines) {
          const status = line.substring(0, 2).trim();
          const file = line.substring(3);
          const basename = file.split("/").pop() || file;
          if (status === "??") untracked.push(basename);
          else if (status === "A" || status === "AM") added.push(basename);
          else if (status === "D") deleted.push(basename);
          else modified.push(basename);
        }
        // Build a concise message
        const parts: string[] = [];
        if (modified.length > 0) {
          parts.push(modified.length <= 3 ? `update ${modified.join(", ")}` : `update ${modified.length} files`);
        }
        if (added.length > 0) {
          parts.push(added.length <= 3 ? `add ${added.join(", ")}` : `add ${added.length} files`);
        }
        if (deleted.length > 0) {
          parts.push(deleted.length <= 3 ? `remove ${deleted.join(", ")}` : `remove ${deleted.length} files`);
        }
        if (untracked.length > 0) {
          parts.push(untracked.length <= 3 ? `add ${untracked.join(", ")}` : `add ${untracked.length} new files`);
        }
        const message = parts.length > 0 ? parts.join("; ") : "chore: minor changes";
        return json({ message, stat: statText, files: { added, modified, deleted, untracked } });
      } catch (err: any) { return json({ error: "Diff summary error: " + err.message }, 500); }
    }

    // --- Git unstage (single file or batch) ---
    if (method === "POST" && pathname === "/api/git/unstage") {
      const body = await readJSON(req);
      const files: string[] = body?.files ?? (body?.file ? [body.file] : []);
      if (!body?.path || files.length === 0) return json({ error: "path and file(s) required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Batch into one `git reset HEAD --` (see /api/git/stage); fall back to
        // per-file only on a non-zero batch exit to attribute the failures.
        const batch = Bun.spawn(["git", "reset", "HEAD", "--", ...files], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
        await batch.exited;
        if (batch.exitCode === 0) return json({ ok: true });
        const failed: string[] = [];
        for (const f of files) {
          const proc = Bun.spawn(["git", "reset", "HEAD", "--", f], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          await proc.exited;
          if (proc.exitCode !== 0) failed.push(f);
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to unstage some files", failed }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Unstage error: " + err.message }, 500); }
    }

    // --- Git unstage all ---
    if (method === "POST" && pathname === "/api/git/unstage-all") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try { const proc = Bun.spawn(["git", "reset", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); await proc.exited; return json({ ok: true }); } catch (err: any) { return json({ error: "Unstage-all error: " + err.message }, 500); }
    }

    // --- Git discard file changes (single or batch, restore working tree) ---
    if (method === "POST" && pathname === "/api/git/discard") {
      const body = await readJSON(req);
      const files: string[] = body?.files ?? (body?.file ? [body.file] : []);
      if (!body?.path || files.length === 0) return json({ error: "path and file(s) required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const failed: string[] = [];
        for (const file of files) {
          const statusProc = Bun.spawn(["git", "status", "--porcelain", "--", file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const statusOut = (await new Response(statusProc.stdout).text()).trim();
          if (statusOut.startsWith("??")) {
            const rmProc = Bun.spawn(["rm", "-rf", "--", file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            await rmProc.exited;
            if (rmProc.exitCode !== 0) failed.push(file);
          } else {
            const proc = Bun.spawn(["git", "checkout", "--", file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            if (proc.exitCode !== 0) failed.push(file);
          }
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to discard some files", failed }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Discard error: " + err.message }, 500); }
    }

    // --- Git commit ---
    if (method === "POST" && pathname === "/api/git/commit") {
      const body = await readJSON(req);
      if (!body?.path || !body?.message) return json({ error: "path and message required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        if (body.files && Array.isArray(body.files) && body.files.length > 0) {
          // One batched `git add` for the whole commit set; per-file fallback
          // only on a non-zero batch exit.
          const batch = Bun.spawn(["git", "add", "--", ...body.files], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          await batch.exited;
          if (batch.exitCode !== 0) {
            const failed: string[] = [];
            for (const file of body.files) {
              const addProc = Bun.spawn(["git", "add", "--", file], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
              await addProc.exited;
              if (addProc.exitCode !== 0) failed.push(file);
            }
            if (failed.length > 0) return json({ ok: false, error: "Failed to stage some files", failed }, 400);
          }
        }
        const proc = Bun.spawn(["git", "commit", "-m", body.message], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Commit failed" }, 400);
        return json({ ok: true, output: stdout.trim() });
      } catch (err: any) { return json({ error: "Commit error: " + err.message }, 500); }
    }

    // --- Git pull ---
    if (method === "POST" && pathname === "/api/git/pull") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "pull"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Pull failed" }, 400);
        return json({ ok: true, output: stdout.trim() });
      } catch (err: any) { return json({ error: "Pull error: " + err.message }, 500); }
    }

    // --- Git push ---
    if (method === "POST" && pathname === "/api/git/push") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Resolve current branch and remote explicitly to avoid "multiple upstream branches" errors
        const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await branchProc.exited;
        const branch = (await new Response(branchProc.stdout).text()).trim();
        const remoteProc = Bun.spawn(["git", "config", `branch.${branch}.remote`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await remoteProc.exited;
        const remote = (await new Response(remoteProc.stdout).text()).trim() || "origin";
        const proc = Bun.spawn(["git", "push", remote, branch], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Push failed" }, 400);
        return json({ ok: true, output: stdout.trim() });
      } catch (err: any) { return json({ error: "Push error: " + err.message }, 500); }
    }

    // --- Git show ---
    if (method === "GET" && pathname === "/api/git/show") {
      const dirPath = url.searchParams.get("path");
      const filePath = url.searchParams.get("file");
      if (!dirPath || !filePath) return json({ error: "path and file required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        let gitRelativePath = filePath;
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          if (gitRoot && resolvedDir !== gitRoot && resolvedDir.startsWith(gitRoot)) { const relPrefix = resolvedDir.slice(gitRoot.length + 1); gitRelativePath = relPrefix + (relPrefix.endsWith("/") ? "" : "/") + filePath; }
        } catch {}
        const proc = Bun.spawn(["git", "show", `HEAD:${gitRelativePath}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const content = await new Response(proc.stdout).text();
        await proc.exited;
        if (proc.exitCode !== 0) return new Response("", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err: any) { return json({ error: "Git show error: " + err.message }, 500); }
    }

    // --- File create (new file or dir) ---
    if (method === "POST" && pathname === "/api/files/create") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedFile = resolveProjectPath(body.path);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      if (existsSync(resolvedFile)) return json({ error: "Path already exists" }, 409);
      try {
        if (body.type === "dir") {
          mkdirSync(resolvedFile, { recursive: true });
        } else {
          // Ensure parent dir exists
          const parentDir = resolvedFile.substring(0, resolvedFile.lastIndexOf("/"));
          if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
          writeFileSync(resolvedFile, "", "utf-8");
        }
        return json({ ok: true, path: resolvedFile });
      } catch (err: any) {
        return json({ error: "Failed to create: " + err.message }, 500);
      }
    }

    // --- File rename ---
    if (method === "POST" && pathname === "/api/files/rename") {
      const body = await readJSON(req);
      if (!body?.oldPath || !body?.newPath) return json({ error: "oldPath and newPath required" }, 400);
      const resolvedOld = resolveProjectPath(body.oldPath);
      const resolvedNew = resolveProjectPath(body.newPath);
      if (!resolvedOld || !resolvedNew) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedOld)) return json({ error: "Source path not found" }, 404);
      if (existsSync(resolvedNew)) return json({ error: "Destination already exists" }, 409);
      try {
        renameSync(resolvedOld, resolvedNew);
        return json({ ok: true, path: resolvedNew });
      } catch (err: any) {
        return json({ error: "Failed to rename: " + err.message }, 500);
      }
    }

    // --- File delete ---
    if (method === "DELETE" && pathname === "/api/files/delete") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedFile = resolveProjectPath(body.path);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedFile)) return json({ error: "Path not found" }, 404);
      try {
        const stat = statSync(resolvedFile);
        if (stat.isDirectory()) {
          // Recursive delete for directories
          const rmProc = Bun.spawn(["rm", "-rf", resolvedFile], { stdout: "pipe", stderr: "pipe" });
          await rmProc.exited;
        } else {
          unlinkSync(resolvedFile);
        }
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: "Failed to delete: " + err.message }, 500);
      }
    }

    // --- File move ---
    if (method === "POST" && pathname === "/api/files/move") {
      const body = await readJSON(req);
      if (!body?.from || !body?.to) return json({ error: "from and to required" }, 400);
      const resolvedFrom = resolveProjectPath(body.from);
      const resolvedTo = resolveProjectPath(body.to);
      if (!resolvedFrom || !resolvedTo) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedFrom)) return json({ error: "Source path not found" }, 404);
      if (existsSync(resolvedTo)) return json({ error: "Destination already exists" }, 409);
      try {
        renameSync(resolvedFrom, resolvedTo);
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: "Failed to move: " + err.message }, 500);
      }
    }

    // --- File copy ---
    if (method === "POST" && pathname === "/api/files/copy") {
      const body = await readJSON(req);
      if (!body?.from || !body?.to) return json({ error: "from and to required" }, 400);
      const resolvedFrom = resolveProjectPath(body.from);
      const resolvedTo = resolveProjectPath(body.to);
      if (!resolvedFrom || !resolvedTo) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedFrom)) return json({ error: "Source path not found" }, 404);
      if (existsSync(resolvedTo)) return json({ error: "Destination already exists" }, 409);
      try {
        const stat = statSync(resolvedFrom);
        const args = stat.isDirectory() ? ["cp", "-r", resolvedFrom, resolvedTo] : ["cp", resolvedFrom, resolvedTo];
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          return json({ error: "Failed to copy: " + stderr }, 500);
        }
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: "Failed to copy: " + err.message }, 500);
      }
    }

    // --- File duplicate ---
    if (method === "POST" && pathname === "/api/files/duplicate") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedFile = resolveProjectPath(body.path);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedFile)) return json({ error: "Path not found" }, 404);
      try {
        const stat = statSync(resolvedFile);
        const isDir = stat.isDirectory();

        // Generate duplicate name
        const lastSlash = resolvedFile.lastIndexOf("/");
        const parentDir = resolvedFile.substring(0, lastSlash);
        const baseName = resolvedFile.substring(lastSlash + 1);

        let name: string, ext: string;
        if (isDir) {
          name = baseName;
          ext = "";
        } else {
          const dotIdx = baseName.lastIndexOf(".");
          if (dotIdx > 0) {
            name = baseName.substring(0, dotIdx);
            ext = baseName.substring(dotIdx);
          } else {
            name = baseName;
            ext = "";
          }
        }

        // Parse existing "copy" / "copy N" suffix
        const copyMatch = name.match(/^(.*?) copy(?: (\d+))?$/);
        let newPath: string;
        if (copyMatch) {
          const base = copyMatch[1];
          const num = copyMatch[2] ? parseInt(copyMatch[2], 10) + 1 : 2;
          newPath = join(parentDir, `${base} copy ${num}${ext}`);
          // Increment until unique
          let counter = num;
          while (existsSync(newPath)) {
            counter++;
            newPath = join(parentDir, `${base} copy ${counter}${ext}`);
          }
        } else {
          newPath = join(parentDir, `${name} copy${ext}`);
          if (existsSync(newPath)) {
            let counter = 2;
            newPath = join(parentDir, `${name} copy ${counter}${ext}`);
            while (existsSync(newPath)) {
              counter++;
              newPath = join(parentDir, `${name} copy ${counter}${ext}`);
            }
          }
        }

        const args = isDir ? ["cp", "-r", resolvedFile, newPath] : ["cp", resolvedFile, newPath];
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          return json({ error: "Failed to duplicate: " + stderr }, 500);
        }
        return json({ ok: true, newPath });
      } catch (err: any) {
        return json({ error: "Failed to duplicate: " + err.message }, 500);
      }
    }

    // --- Reveal in Finder ---
    if (method === "POST" && pathname === "/api/files/reveal") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedFile = resolveProjectPath(body.path);
      if (!resolvedFile) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedFile)) return json({ error: "Path not found" }, 404);
      try {
        const proc = Bun.spawn(["open", "-R", resolvedFile], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          return json({ error: "Failed to reveal: " + stderr }, 500);
        }
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: "Failed to reveal: " + err.message }, 500);
      }
    }

    // --- Flat file list (for quick open) ---
    if (method === "GET" && pathname === "/api/files/flat") {
      const dirPath = url.searchParams.get("path");
      const maxFiles = parseInt(url.searchParams.get("maxFiles") || "2000", 10);
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedPath = resolveProjectPath(dirPath);
      if (!resolvedPath) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedPath)) return json({ error: "directory not found" }, 404);

      const DEFAULT_EXCLUDES = new Set(["node_modules", ".git", ".next", "dist", "build", ".DS_Store", "__pycache__", ".cache", ".turbo", ".vercel", ".output", "coverage", ".nyc_output", ".parcel-cache", "target", ".backups"]);
      function parseGitignoreFlat(dir: string): Set<string> {
        const patterns = new Set<string>();
        try {
          const gitignorePath = join(dir, ".gitignore");
          if (existsSync(gitignorePath)) {
            const content = readFileSync(gitignorePath, "utf-8");
            for (const line of content.split("\n")) { const trimmed = line.trim(); if (trimmed && !trimmed.startsWith("#")) { const clean = trimmed.replace(/\/$/, "").replace(/^\//, ""); if (clean) patterns.add(clean); } }
          }
        } catch {}
        return patterns;
      }
      const gitignorePatterns = parseGitignoreFlat(resolvedPath);
      const allExcludes = new Set([...DEFAULT_EXCLUDES, ...gitignorePatterns]);

      const files: string[] = [];
      function walkFlat(dir: string) {
        if (files.length >= maxFiles) return;
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (files.length >= maxFiles) return;
            if (allExcludes.has(entry.name)) continue;
            // Check glob-style excludes
            let skip = false;
            for (const pattern of allExcludes) {
              if (pattern.startsWith("*.") && entry.name.endsWith(pattern.slice(1))) { skip = true; break; }
              if (pattern.endsWith("*") && entry.name.startsWith(pattern.slice(0, -1))) { skip = true; break; }
            }
            if (skip) continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              walkFlat(fullPath);
            } else if (entry.isFile()) {
              // resolvedPath is guaranteed non-null (guarded at the top of the
              // handler); TS just loses the narrowing inside this closure.
              files.push(relative(resolvedPath!, fullPath));
            }
          }
        } catch {}
      }
      walkFlat(resolvedPath);
      return json({ files });
    }

    // --- Package.json scripts ---
    if (method === "GET" && pathname === "/api/files/package-scripts") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedPath = resolveProjectPath(dirPath);
      if (!resolvedPath) return errorResponse(400, "Invalid path");
      const pkgPath = join(resolvedPath, "package.json");
      if (!existsSync(pkgPath)) return json({ scripts: {}, engines: {} });
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return json({ scripts: pkg.scripts || {}, engines: pkg.engines || {} });
      } catch (err: any) {
        return json({ error: "Failed to parse package.json: " + err.message }, 500);
      }
    }

    // --- AI commit message (via Gateway LLM) ---
    if (method === "POST" && pathname === "/api/git/ai-commit-message") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Check if path is a git repo
        const checkProc = Bun.spawn(["git", "rev-parse", "--git-dir"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await checkProc.exited;
        if (checkProc.exitCode !== 0) {
          return json({ error: "Not a git repository" }, 400);
        }

        // Get ONLY staged diff and staged files (--cached = index vs HEAD)
        const diffProc = Bun.spawn(["git", "diff", "--cached"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        let diffText = await new Response(diffProc.stdout).text();
        if (diffText.length > 4000) diffText = diffText.slice(0, 4000) + "\n... (truncated)";
        const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const fullStatus = (await new Response(statusProc.stdout).text()).trim();
        // Filter to only staged files (first char is not ' ' and not '?')
        const statusText = fullStatus.split('\n').filter(l => l.length >= 2 && l[0] !== ' ' && l[0] !== '?').join('\n');

        if (!statusText && !diffText.trim()) {
          return json({ error: "No staged changes to describe" }, 400);
        }

        if (!GATEWAY_URL || !GATEWAY_TOKEN) {
          return json({ error: "Gateway not configured" }, 503);
        }

        // Bound the gateway call — a hung upstream model would otherwise wedge
        // this request handler indefinitely (every other provider call here
        // guards with an AbortController+timeout; this one-shot was the gap).
        const aiAbort = new AbortController();
        const aiTimeout = setTimeout(() => aiAbort.abort(), 30_000);
        const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({
            model: "fast",
            stream: false,
            messages: [
              { role: "system", content: "Generate a concise git commit message in conventional commit format based on the STAGED changes only. First line max 72 chars. If multiple changes, use bullet points. Be specific about what changed. Reply with ONLY the commit message, no explanation." },
              { role: "user", content: `Staged files:\n${statusText || '(no staged files)'}\n\nStaged diff:\n${diffText || '(no staged diff)'}` },
            ],
          }),
          signal: aiAbort.signal,
        }).finally(() => clearTimeout(aiTimeout));

        if (!resp.ok) {
          const errText = await resp.text();
          return json({ error: `Gateway error: ${resp.status} ${errText.slice(0, 200)}` }, 502);
        }

        const data = await resp.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        const rawContent = data.choices?.[0]?.message?.content;
        const message = typeof rawContent === "string" && rawContent.trim() ? rawContent.trim() : "chore: update files";
        return json({ message });
      } catch (err: any) {
        if (err?.name === "AbortError") return json({ error: "AI commit message timed out" }, 504);
        return json({ error: "AI commit message error: " + err.message }, 500);
      }
    }

    // --- Git init ---
    if (method === "POST" && pathname === "/api/git/init") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      if (!existsSync(resolvedDir)) return json({ error: "directory not found" }, 404);
      try {
        const proc = Bun.spawn(["git", "init"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "git init failed" }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Git init error: " + err.message }, 500); }
    }

    // --- Git create branch ---
    if (method === "POST" && pathname === "/api/git/create-branch") {
      const body = await readJSON(req);
      if (!body?.path || !body?.name) return json({ error: "path and name required" }, 400);
      if (!isValidGitRef(body.name)) return json({ error: "Invalid branch name" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const checkout = body.checkout !== false; // default true
        const args = checkout ? ["git", "checkout", "-b", body.name] : ["git", "branch", body.name];
        const proc = Bun.spawn(args, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Create branch failed" }, 400);
        return json({ ok: true, branch: body.name });
      } catch (err: any) { return json({ error: "Create branch error: " + err.message }, 500); }
    }

    // --- Git delete branch ---
    if (method === "POST" && pathname === "/api/git/delete-branch") {
      const body = await readJSON(req);
      if (!body?.path || !body?.name) return json({ error: "path and name required" }, 400);
      if (!isValidGitRef(body.name)) return json({ error: "Invalid branch name" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const flag = body.force ? "-D" : "-d";
        const proc = Bun.spawn(["git", "branch", flag, body.name], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Delete branch failed" }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Delete branch error: " + err.message }, 500); }
    }

    // --- Git remotes ---
    if (method === "GET" && pathname === "/api/git/remotes") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "remote", "-v"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        const remotes: { name: string; fetchUrl: string; pushUrl: string }[] = [];
        const seen = new Map<string, { fetchUrl: string; pushUrl: string }>();
        for (const line of output.split("\n").filter(Boolean)) {
          const parts = line.split(/\s+/);
          if (parts.length < 3) continue;
          const name = parts[0];
          const url = parts[1];
          const type = parts[2]; // (fetch) or (push)
          if (!seen.has(name)) seen.set(name, { fetchUrl: "", pushUrl: "" });
          const entry = seen.get(name)!;
          if (type === "(fetch)") entry.fetchUrl = url;
          if (type === "(push)") entry.pushUrl = url;
        }
        for (const [name, urls] of seen) remotes.push({ name, ...urls });
        return json(remotes);
      } catch (err: any) { return json({ error: "Git remotes error: " + err.message }, 500); }
    }

    // --- Git remote add ---
    if (method === "POST" && pathname === "/api/git/remote-add") {
      const body = await readJSON(req);
      if (!body?.path || !body?.name || !body?.url) return json({ error: "path, name, and url required" }, 400);
      if (!isValidGitRef(body.name)) return json({ error: "Invalid remote name" }, 400);
      if (typeof body.url !== "string" || body.url.startsWith("-")) return json({ error: "Invalid remote url" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "remote", "add", body.name, body.url], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Remote add failed" }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Remote add error: " + err.message }, 500); }
    }

    // --- Git remote remove ---
    if (method === "POST" && pathname === "/api/git/remote-remove") {
      const body = await readJSON(req);
      if (!body?.path || !body?.name) return json({ error: "path and name required" }, 400);
      if (!isValidGitRef(body.name)) return json({ error: "Invalid remote name" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "remote", "remove", body.name], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Remote remove failed" }, 400);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Remote remove error: " + err.message }, 500); }
    }

    // --- Git line changes (for gutter decorations) ---
    if (method === "GET" && pathname === "/api/git/line-changes") {
      const dirPath = url.searchParams.get("path");
      const filePath = url.searchParams.get("file");
      if (!dirPath || !filePath) return json({ error: "path and file parameters required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const proc = Bun.spawn(["git", "diff", "HEAD", "--", filePath], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const diff = await new Response(proc.stdout).text();
        await proc.exited;

        const changes: { from: number; to: number; type: "added" | "modified" | "deleted" }[] = [];
        // Parse unified diff hunks
        const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
        let match;
        while ((match = hunkRegex.exec(diff)) !== null) {
          const oldStart = parseInt(match[1], 10);
          const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
          const newStart = parseInt(match[3], 10);
          const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

          if (oldCount === 0 && newCount > 0) {
            // Pure addition
            changes.push({ from: newStart, to: newStart + newCount - 1, type: "added" });
          } else if (newCount === 0 && oldCount > 0) {
            // Pure deletion
            changes.push({ from: newStart, to: newStart, type: "deleted" });
          } else {
            // Modification
            changes.push({ from: newStart, to: newStart + newCount - 1, type: "modified" });
          }
        }
        return json({ changes });
      } catch (err: any) {
        return json({ changes: [] });
      }
    }

    // --- File upload (external drop) ---
    if (method === "POST" && pathname === "/api/files/upload") {
      const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
      try {
        const formData = await req.formData();
        const targetDir = formData.get("targetDir") as string;
        if (!targetDir) return json({ error: "targetDir required" }, 400);
        const resolvedDir = resolveProjectPath(targetDir);
        if (!resolvedDir) return errorResponse(400, "Invalid target directory");
        if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
          return json({ error: "Target directory not found" }, 404);
        }

        // Containment guard: reject any client-supplied path that escapes resolvedDir.
        const containmentRoot = resolve(resolvedDir);
        function isContained(p: string): boolean {
          const r = resolve(p);
          return r === containmentRoot || r.startsWith(containmentRoot + "/");
        }
        function hasDotDotSegment(rel: string): boolean {
          return rel.split(/[\\/]/).some((seg) => seg === "..");
        }

        const relativePathsRaw = formData.get("relativePaths") as string | null;
        const relativePaths: string[] = relativePathsRaw ? JSON.parse(relativePathsRaw) : [];
        // Empty directory paths to create (no files inside)
        const emptyDirsRaw = formData.get("emptyDirs") as string | null;
        const emptyDirs: string[] = emptyDirsRaw ? JSON.parse(emptyDirsRaw) : [];
        const files = formData.getAll("files") as File[];

        if (files.length === 0 && emptyDirs.length === 0) return json({ error: "No files provided" }, 400);

        // Create empty directories first
        for (const dir of emptyDirs) {
          if (hasDotDotSegment(dir)) return json({ error: "Invalid directory path" }, 400);
          const dirPath = join(resolvedDir, dir);
          if (!isContained(dirPath)) return json({ error: "Invalid directory path" }, 400);
          if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
        }

        const uploaded: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.size > MAX_FILE_SIZE) {
            return json({ error: `File "${file.name}" exceeds 5GB limit` }, 413);
          }

          const relPath = relativePaths[i] || file.name;
          if (hasDotDotSegment(relPath)) return json({ error: "Invalid file path" }, 400);
          let targetPath = join(resolvedDir, relPath);
          if (!isContained(targetPath)) return json({ error: "Invalid file path" }, 400);

          // Ensure parent directory exists
          const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
          if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

          // Handle name conflicts
          if (existsSync(targetPath)) {
            const lastSlash = targetPath.lastIndexOf("/");
            const dir = targetPath.substring(0, lastSlash);
            const fullName = targetPath.substring(lastSlash + 1);
            const dotIdx = fullName.lastIndexOf(".");
            const name = dotIdx > 0 ? fullName.substring(0, dotIdx) : fullName;
            const ext = dotIdx > 0 ? fullName.substring(dotIdx) : "";
            let counter = 1;
            while (existsSync(targetPath)) {
              targetPath = join(dir, `${name} (${counter})${ext}`);
              counter++;
            }
          }

          const buffer = await file.arrayBuffer();
          await Bun.write(targetPath, buffer);
          uploaded.push(targetPath);
        }

        return json({ ok: true, uploaded });
      } catch (err: any) {
        return json({ error: "Upload failed: " + err.message }, 500);
      }
    }

    return null;
  };
}
