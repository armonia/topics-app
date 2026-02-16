import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

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
    BACKUPS_DIR = join(process.cwd(), ".backups");
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
        const statusProc = Bun.spawn(["git", "status", "--porcelain"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statusText = await new Response(statusProc.stdout).text();
        const branchProc = Bun.spawn(["git", "branch", "--show-current"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const branch = (await new Response(branchProc.stdout).text()).trim();
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
        const allFiles = statusText.split("\n").filter(Boolean).map((line) => ({ path: line.substring(3), status: line.substring(0, 2).trim() }));
        const files = relativePrefix ? allFiles.filter((f) => f.path.startsWith(relativePrefix)).map((f) => ({ ...f, path: f.path.slice(relativePrefix.length) })) : allFiles;
        return json({ branch, lastCommit: { hash, message, author, ago }, files, ahead, behind });
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
        const branches: any[] = [];
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
        return json(branches);
      } catch (err: any) { return json({ error: "Git branches error: " + err.message }, 500); }
    }

    // --- Git checkout ---
    if (method === "POST" && pathname === "/api/git/checkout") {
      const body = await readJSON(req);
      if (!body?.path || !body?.branch) return json({ error: "path and branch required" }, 400);
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

    // --- Git stage ---
    if (method === "POST" && pathname === "/api/git/stage") {
      const body = await readJSON(req);
      if (!body?.path || !body?.file) return json({ error: "path and file required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try { const proc = Bun.spawn(["git", "add", body.file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); await proc.exited; return json({ ok: true }); } catch (err: any) { return json({ error: "Stage error: " + err.message }, 500); }
    }

    // --- Git unstage ---
    if (method === "POST" && pathname === "/api/git/unstage") {
      const body = await readJSON(req);
      if (!body?.path || !body?.file) return json({ error: "path and file required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try { const proc = Bun.spawn(["git", "reset", "HEAD", body.file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); await proc.exited; return json({ ok: true }); } catch (err: any) { return json({ error: "Unstage error: " + err.message }, 500); }
    }

    // --- Git commit ---
    if (method === "POST" && pathname === "/api/git/commit") {
      const body = await readJSON(req);
      if (!body?.path || !body?.message) return json({ error: "path and message required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        if (body.files && Array.isArray(body.files)) { for (const file of body.files) { const addProc = Bun.spawn(["git", "add", file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); await addProc.exited; } }
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
        const proc = Bun.spawn(["git", "push"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
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

    return null;
  };
}
