import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync } from "fs";
import { readdir as readdirAsync, stat as statAsync } from "fs/promises";
import { join, resolve, relative } from "path";
import type { AppContext, RouteHandler } from "../types";
import { watchGitDir } from "../git-watcher";
import { watchProjectFiles } from "../file-watcher";
import { resolveStateDir } from "../lib/data-dir";
import { BRANCH_FORMAT, parseBranchLines } from "../lib/git-branch-refs";
import { STATUS_ARGS, gitRead, parsePorcelainZ, scopeToPrefix, statusOfPrefix, repoPrefixOf } from "../lib/git-porcelain";
import { attachNumstats, readNumstats } from "../lib/git-numstat";
import { moveToTrash } from "../lib/trash";
import { detectScripts, MANIFESTS } from "../lib/project-scripts";
import { NAME_STATUS_ARGS, SHOW_NUMSTAT_ARGS, COMMIT_META_ARGS, mergeCommitFiles, scopeCommitFiles } from "../lib/git-show";
import { parseUnifiedDiff, buildPatch, summarizeHunks } from "../lib/git-hunks";
import { stagedEntries, buildSystemPrompt, buildUserPrompt, rulesFallback, usableMessage } from "../lib/commit-message";
import { getProvider } from "../providers";
import { IgnoreSet } from "../lib/gitignore";
// La cache dello stato git vive in `lib/` e non qui: la riempie questa route,
// ma a invalidarla è `git-watcher`, e finché la funzione stava in questo file
// il watcher doveva importare una ROUTE — chiudendo il ciclo
// file-watcher → git-watcher → routes/files → file-watcher.
import { readGitStatusCache, writeGitStatusCache, invalidateGitCache } from "../lib/git-status-cache";
import { gitEnvFor } from "../lib/git-identity";

// Conservative git ref/remote name validation (mirrors worktrees.ts BASE_REF_REGEX)
const GIT_REF_MAX = 200;
const GIT_REF_REGEX = /^[A-Za-z0-9_./\-]+$/;
function isValidGitRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.length > 0 && ref.length <= GIT_REF_MAX && GIT_REF_REGEX.test(ref);
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

/**
 * Un comando git che PARLA CON LA RETE, con le due protezioni che gli servono.
 *
 * `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND` in modalità batch: senza, una
 * chiave ssh con passphrase o una credenziale scaduta fanno aprire a git un
 * prompt su un terminale che nessuno guarda. Il processo non finisce mai, lo
 * spinner nella UI gira all'infinito e — dato che `setPulling(false)` sta solo
 * nel `finally` — l'unica via d'uscita è ricaricare l'app.
 *
 * Il timeout è la rete: un remote irraggiungibile non risponde e basta.
 * Preferisco un errore leggibile dopo N secondi a un'attesa senza fine.
 */
async function runNetworkGit(
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { ok: !timedOut && proc.exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Le cartelle che nessuna ricerca deve attraversare: artefatti di build e
 * cache, tutte rigenerabili e tutte enormi.
 *
 * Stava dentro il ramo dell'ALBERO dei file, che la lezione l'aveva imparata;
 * il `grep` di `/api/files/search` no, e su questo repo la differenza è
 * misurata: 198,9 s contro 16,6 s, perche' `desktop-tauri/src-tauri/target/`
 * da solo pesa 10 GB (gitignorati) e vale il 91,6% del tempo. Una lista sola,
 * quindi, e non due che divergono.
 */
const HEAVY_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "__pycache__", ".cache", ".turbo",
  ".vercel", ".output", "coverage", ".nyc_output", ".parcel-cache", "target",
]);

/** Tetto di durata per una ricerca nei file. Oltre, si tronca e lo si DICE. */
const SEARCH_TIMEOUT_MS = 15_000;

export function createFilesRouter(ctx: AppContext): RouteHandler {
  // `GATEWAY_URL`/`GATEWAY_TOKEN` non si prendono più: l'unico consumatore era
  // il generatore del messaggio di commit, che ora passa dal provider vero
  // (`getProvider("claude-code")`) invece che da un gateway HTTP a parte —
  // gateway che su questa macchina non ascolta, e che quindi rendeva il ✨ un
  // bottone morto.
  const { readJSON, json, errorResponse, resolveProjectPath } = ctx;

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

      // Le esclusioni «di sempre», indipendenti dal .gitignore: cartelle che
      // nessuno vuole vedere nell'albero e che costano care da attraversare.
      const DEFAULT_EXCLUDES = new Set([".git", ".DS_Store"]);
      const HEAVY_EXCLUDES = HEAVY_DIRS;
      // Il .gitignore della radice. Le regole vere — ancoraggio, negazioni,
      // wildcard, match sul path relativo — stanno in `lib/gitignore.ts`.
      function readIgnore(dir: string, base: string, parent?: IgnoreSet): IgnoreSet {
        const set = parent ? parent.clone() : new IgnoreSet();
        try {
          const f = join(dir, ".gitignore");
          if (existsSync(f)) set.addFile(readFileSync(f, "utf-8"), base);
        } catch {}
        return set;
      }
      const rootIgnore = readIgnore(resolvedPath, "");
      // Idempotente, come `watchGitDir` da `/api/git/status`: chiedere l'albero
      // è anche il momento in cui si comincia a osservarlo.
      watchProjectFiles(resolvedPath, ctx);

      interface FileNode { name: string; type: "file" | "dir"; path: string; size?: number; modified?: string; children?: FileNode[]; }
      // Async walk (fs.promises): the old readdirSync + per-entry statSync ran
      // inside the request handler and stalled Bun's single event loop for the
      // whole scan — a large directory (monorepo folder) queued every other
      // client's requests and WS traffic behind it. Sequential awaits keep the
      // ordering identical while yielding the loop between syscalls.
      async function readDirRecursive(dir: string, currentDepth: number, relBase: string, ignore: IgnoreSet): Promise<FileNode[]> {
        const result: FileNode[] = [];
        try {
          const entries = await readdirAsync(dir, { withFileTypes: true });
          entries.sort((a, b) => { if (a.isDirectory() && !b.isDirectory()) return -1; if (!a.isDirectory() && b.isDirectory()) return 1; return a.name.localeCompare(b.name); });
          for (const entry of entries) {
            const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
            if (DEFAULT_EXCLUDES.has(entry.name)) continue;
            if (entry.isDirectory() && HEAVY_EXCLUDES.has(entry.name)) continue;
            if (ignore.ignores(rel, entry.isDirectory())) continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              const node: FileNode = { name: entry.name, type: "dir", path: fullPath };
              if (currentDepth < depth) {
                // Il .gitignore di questa cartella si somma a quelli sopra e
                // vale solo da qui in giù — come in git.
                node.children = await readDirRecursive(fullPath, currentDepth + 1, rel, readIgnore(fullPath, rel, ignore));
              }
              result.push(node);
            } else if (entry.isFile()) {
              try { const stats = await statAsync(fullPath); result.push({ name: entry.name, type: "file", path: fullPath, size: stats.size, modified: stats.mtime.toISOString() }); } catch { result.push({ name: entry.name, type: "file", path: fullPath }); }
            }
          }
        } catch {}
        return result;
      }
      return json(await readDirRecursive(resolvedPath, 1, "", rootIgnore));
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
        // Il perimetro e' la cosa che conta: escludeva quattro cartelle e non
        // `target/`, che su questo repo vale il 92% del tempo. Stessa lista
        // dell'albero dei file (`HEAVY_DIRS`), piu' `.git` e i dati locali.
        for (const ex of [...HEAVY_DIRS, ".git", "data", "test-results", "videos", "uploads"]) {
          args.push(`--exclude-dir=${ex}`);
        }
        args.push("--exclude=*.lock");
        args.push("--", query, ".");

        // Timeout + kill + ENTRAMBI i flussi drenati, come `runNetworkGit` qui
        // sopra. Prima non c'era niente di tutto questo: il processo viveva per
        // conto suo anche quando il client aveva gia' cambiato query (col
        // debounce a 300 ms se ne accodavano a decine), e `stderr` in pipe e mai
        // letto puo' riempire il buffer e appendere la richiesta per sempre —
        // basta una cartella non leggibile che stampi a ogni riga.
        const proc = Bun.spawn(["grep", ...args], { cwd: resolvedPath, stdout: "pipe", stderr: "pipe" });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, SEARCH_TIMEOUT_MS);
        let output: string;
        try {
          const [out] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          output = out;
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }

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
        // `truncated` non e' decorazione: una ricerca interrotta a meta' che si
        // presenta come completa e' peggio di una lenta — dice «non c'e'» di
        // una cosa che magari c'e'.
        return json({ results, truncated: timedOut || undefined });
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
        // Server-side cache check (TTL e sfratto stanno nel modulo della cache)
        const cached = readGitStatusCache(resolvedDir);
        if (cached) return json(cached);
        // Check if path is a git repo
        const checkProc = Bun.spawn(["git", "rev-parse", "--git-dir"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await checkProc.exited;
        if (checkProc.exitCode !== 0) {
          return json({ notGit: true, branch: "", files: [], ahead: 0, behind: 0, lastCommit: null });
        }
        // Start watching .git for changes (idempotent — only sets up once per path)
        watchGitDir(resolvedDir, ctx);
        const statusProc = Bun.spawn(STATUS_ARGS, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
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
        // Il nome del repo che OSPITA la cartella aperta. Serve a dire di chi
        // sono le cose che il pannello mostra: aprendo come progetto una
        // sottocartella, ramo, remote e cronologia sono del repo di sopra, non
        // di quella cartella, e senza dirlo il pannello si contraddice da solo
        // («non tracciata» accanto a una lista di branch).
        let repoName = "";
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          const scope = repoPrefixOf(resolvedDir, gitRoot);
          relativePrefix = scope.prefix;
          repoName = scope.repoName;
        } catch {}
        // Emit the RAW 2-char XY porcelain code (do NOT trim): the client parses
        // it positionally — status[0]=staged (index), status[1]=unstaged (worktree).
        // Trimming "  M" → "M" misclassified unstaged files as staged.
        // Il parse sta in `lib/git-porcelain.ts`: `-z`, path grezzi, e il
        // secondo path dei rename in un campo suo (`origPath`).
        const parsed = parsePorcelainZ(statusText);
        // I conteggi per file (`+N −M`) vengono da due `git diff --numstat`, che
        // sono comandi a parte: `git status` dice quali file, mai quante righe.
        const files = attachNumstats(scopeToPrefix(parsed, relativePrefix), await readNumstats(resolvedDir), relativePrefix);
        // La cartella aperta è a sua volta non tracciata dal repo che la
        // contiene: git la collassa in un record solo e non elenca ciò che c'è
        // dentro. Va DETTO, non elencato — vedi `statusOfPrefix`.
        const folderUntracked = statusOfPrefix(parsed, relativePrefix) === "??";
        const result = { branch, lastCommit: { hash, message, author, ago }, files, ahead, behind, folderUntracked, repoName };
        writeGitStatusCache(resolvedDir, result);
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
        const proc = Bun.spawn(gitRead("diff", "--", filePath), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const diff = await new Response(proc.stdout).text();
        if (!diff.trim()) {
          const cachedProc = Bun.spawn(gitRead("diff", "--cached", "--", filePath), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          return new Response(await new Response(cachedProc.stdout).text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        return new Response(diff, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err: any) { return json({ error: "Git diff error: " + err.message }, 500); }
    }

    // --- Git: i blocchi di un file, e come agirci sopra uno alla volta ---
    //
    // Fino a qui si poteva solo `git add <file>`, tutto o niente: un fix e un
    // rimaneggiamento fatti nella stessa sessione finivano nello stesso commit
    // perché stavano nello stesso file.
    if (method === "GET" && pathname === "/api/git/hunks") {
      const dirPath = url.searchParams.get("path");
      const filePath = url.searchParams.get("file");
      // Quale diff: albero-contro-indice (i blocchi da mettere in stage) o
      // indice-contro-HEAD (quelli da togliere).
      const staged = url.searchParams.get("side") === "staged";
      if (!dirPath || !filePath) return json({ error: "path and file required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        const args = staged
          ? gitRead("diff", "--cached", "--", filePath)
          : gitRead("diff", "--", filePath);
        const proc = Bun.spawn(args, { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
        const diff = await new Response(proc.stdout).text();
        await proc.exited;
        return json({ hunks: summarizeHunks(parseUnifiedDiff(diff)) });
      } catch (err: any) { return json({ error: "Git hunks error: " + err.message }, 500); }
    }

    if (method === "POST" && pathname === "/api/git/apply-hunks") {
      const body = await readJSON(req);
      const filePath: string = body?.file;
      const indici: number[] = Array.isArray(body?.hunks) ? body.hunks : [];
      const azione: string = body?.action;
      if (!body?.path || !filePath || indici.length === 0) return json({ error: "path, file and hunks are required" }, 400);
      if (azione !== "stage" && azione !== "unstage" && azione !== "discard") {
        return json({ error: "invalid action" }, 400);
      }
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Da dove viene il diff, e come si applica la patch:
        //   stage    albero→indice, in avanti sull'indice
        //   unstage  indice→HEAD,   al contrario sull'indice
        //   discard  albero→indice, al contrario sull'ALBERO (tocca il file)
        const fromIndex = azione === "unstage";
        const diffArgs = fromIndex
          ? gitRead("diff", "--cached", "--", filePath)
          : gitRead("diff", "--", filePath);
        const diffProc = Bun.spawn(diffArgs, { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
        const diff = await new Response(diffProc.stdout).text();
        await diffProc.exited;

        const patch = buildPatch(parseUnifiedDiff(diff), indici);
        // Nessun blocco da applicare: quasi sempre vuol dire che il file è
        // cambiato sotto (un salvataggio, un altro client) e gli indici che il
        // browser aveva in mano non descrivono più niente. Dirlo, invece di
        // rispondere ok su un lavoro non fatto.
        if (!patch) return json({ error: "Those hunks are gone: reload the diff" }, 409);

        const applyArgs = azione === "stage" ? ["git", "apply", "--cached", "-"]
          : azione === "unstage" ? ["git", "apply", "--cached", "-R", "-"]
          : ["git", "apply", "-R", "-"];
        const applyProc = Bun.spawn(applyArgs, { cwd: resolvedDir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        applyProc.stdin.write(patch);
        applyProc.stdin.end();
        const stderr = await new Response(applyProc.stderr).text();
        await applyProc.exited;
        if (applyProc.exitCode !== 0) {
          // `git apply` fallisce interamente o non fallisce: non lascia mezze
          // patch applicate, quindi qui non c'è niente da disfare.
          return json({ error: stderr.trim() || "git apply non è riuscito" }, 409);
        }
        invalidateGitCache(resolvedDir);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Apply hunks error: " + err.message }, 500); }
    }

    // --- Git branches ---
    if (method === "GET" && pathname === "/api/git/branches") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // La classificazione delle ref vive in `lib/git-branch-refs.ts`, dove è
        // coperta da test sull'output vero di un clone con due remote: è la
        // parte che nascondeva sia il ramo remoto scambiato per locale sia il
        // checkout che staccava HEAD. Qui resta solo ciò che ha bisogno di git.
        const branchProc = Bun.spawn(["git", "branch", "-a", `--format=${BRANCH_FORMAT}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const branchText = (await new Response(branchProc.stdout).text()).trim();
        interface GitBranch { name: string; current: boolean; isRemote: boolean; ahead: number; behind: number; shortName?: string; remote?: string }
        const branches: GitBranch[] = [];
        for (const ref of parseBranchLines(branchText)) {
          let ahead = 0, behind = 0;
          if (!ref.isRemote && ref.upstream) {
            try { const revProc = Bun.spawn(["git", "rev-list", "--left-right", "--count", `${ref.name}...${ref.upstream}`], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" }); const revText = (await new Response(revProc.stdout).text()).trim(); const parts = revText.split(/\s+/); if (parts.length >= 2) { ahead = parseInt(parts[0]) || 0; behind = parseInt(parts[1]) || 0; } } catch {}
          }
          const entry: GitBranch = { name: ref.name, current: ref.current, isRemote: ref.isRemote, ahead, behind };
          if (ref.isRemote) { entry.remote = ref.remote; entry.shortName = ref.shortName; }
          branches.push(entry);
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
        // `switch`, non `checkout`. La differenza che conta è cosa fanno con un
        // ramo REMOTO: `git checkout origin/foo` stacca HEAD, esce 0 e non dice
        // niente — l'intestazione mostra allora uno short-hash come se fosse un
        // ramo, e ogni commit fatto da lì è orfano. `git switch origin/foo`
        // rifiuta («a branch is expected»), e `git switch foo` fa la cosa che
        // l'utente intende: crea il locale che traccia `origin/foo`. Staccare
        // HEAD resta possibile, ma solo chiedendolo con `--detach`, che questa
        // rotta non offre. Unico chiamante: BranchList, che passa sempre un
        // nome di ramo.
        const proc = Bun.spawn(["git", "switch", "--", body.branch], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Checkout failed" }, 400);
        invalidateGitCache(resolvedDir);
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
          // Stesso confronto su path RISOLTI di `/api/git/status`: con un link
          // simbolico di mezzo il log tornava quello di tutto il repo.
          const { prefix } = repoPrefixOf(resolvedDir, gitRoot);
          if (prefix) logArgs.push("--", prefix.replace(/\/$/, ""));
        } catch {}
        const proc = Bun.spawn(logArgs, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const logText = (await new Response(proc.stdout).text()).trim();
        const commits = logText.split("\n").filter(Boolean).map(line => { const [hash, shortHash, message, author, ago, date] = line.split("|"); return { hash, shortHash, message, author, ago, date }; });
        return json(commits);
      } catch (err: any) { return json({ error: "Git log error: " + err.message }, 500); }
    }

    // --- Git commit: i file di UN commit ---
    //
    // Chiude il buco fra `/api/git/log` (che c'era da sempre e non chiamava
    // nessuno) e il diff: la lista dei commit senza il loro contenuto è un
    // elenco di titoli.
    if (method === "GET" && pathname === "/api/git/commit-files") {
      const dirPath = url.searchParams.get("path");
      const hash = url.searchParams.get("hash") || "";
      if (!dirPath || !hash) return json({ error: "path and hash required" }, 400);
      // Un hash, non una revisione qualunque: qui non serve `HEAD~3` e più
      // stretto è il filtro, meno c'è da ragionare su cosa ci finisce dentro.
      if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return json({ error: "invalid hash" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        let prefix = "";
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          prefix = repoPrefixOf(resolvedDir, gitRoot).prefix;
        } catch {}
        const leggi = async (args: string[]) => {
          const proc = Bun.spawn(args, { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          const text = await new Response(proc.stdout).text();
          await proc.exited;
          return proc.exitCode === 0 ? text : "";
        };
        const [nameStatus, numstat, meta] = await Promise.all([
          leggi(NAME_STATUS_ARGS(hash)),
          leggi(SHOW_NUMSTAT_ARGS(hash)),
          leggi(COMMIT_META_ARGS(hash)),
        ]);
        if (!meta.trim()) return json({ error: "Commit not found" }, 404);
        const [fullHash = "", shortHash = "", message = "", author = "", ago = "", date = ""] = meta.trim().split("|");
        const files = scopeCommitFiles(mergeCommitFiles(nameStatus, numstat), prefix);
        return json({ hash: fullHash, shortHash, message, author, ago, date, files });
      } catch (err: any) { return json({ error: "Git commit-files error: " + err.message }, 500); }
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
        if (batch.exitCode === 0) { invalidateGitCache(resolvedDir); return json({ ok: true }); }
        const failed: string[] = [];
        for (const f of files) {
          const proc = Bun.spawn(["git", "add", "--", f], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          await proc.exited;
          if (proc.exitCode !== 0) failed.push(f);
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to stage some files", failed }, 400);
        invalidateGitCache(resolvedDir);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Stage error: " + err.message }, 500); }
    }

    // --- Git stage all ---
    if (method === "POST" && pathname === "/api/git/stage-all") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      // L'exit code va LETTO. Prima si rispondeva `ok:true` comunque: con un
      // `index.lock` addosso — un agente che committa in parallelo, cosa
      // normale qui — l'utente cliccava, non vedeva errori, e il pannello si
      // ricaricava identico. `stderr` era già in `pipe`: bastava guardarlo.
      try {
        // `-- .` NON è ridondante. Da git 2.0 `git add -A` lavora sull'INTERO
        // albero di lavoro, non sulla cartella corrente: aprendo come progetto
        // una sottocartella di un repo più grande, questo bottone stagiava
        // anche tutto ciò che sta FUORI da essa — misurato su un caso reale:
        // 17.682 file invece dei 11.031 della cartella, cioè 6.651 file che il
        // pannello non mostra nemmeno. Ciò che il bottone fa deve coincidere
        // con ciò che la lista dice.
        const proc = Bun.spawn(["git", "add", "-A", "--", "."], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Stage-all failed" }, 400);
        invalidateGitCache(resolvedDir);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Stage-all error: " + err.message }, 500); }
    }

    // --- Git diff summary (auto commit message) ---
    if (method === "GET" && pathname === "/api/git/diff-summary") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Get diff stat for staged + unstaged
        const statProc = Bun.spawn(gitRead("diff", "--stat", "HEAD"), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statText = (await new Response(statProc.stdout).text()).trim();
        // Get status porcelain for changed files (untracked included as "??")
        const statusProc = Bun.spawn(STATUS_ARGS, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statusText = await new Response(statusProc.stdout).text();
        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];
        const untracked: string[] = [];
        for (const entry of parsePorcelainZ(statusText)) {
          const status = entry.status.trim();
          const basename = entry.path.split("/").pop() || entry.path;
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
        if (batch.exitCode === 0) { invalidateGitCache(resolvedDir); return json({ ok: true }); }
        const failed: string[] = [];
        for (const f of files) {
          const proc = Bun.spawn(["git", "reset", "HEAD", "--", f], { cwd: resolvedDir, stdout: "pipe", stderr: "ignore" });
          await proc.exited;
          if (proc.exitCode !== 0) failed.push(f);
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to unstage some files", failed }, 400);
        invalidateGitCache(resolvedDir);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Unstage error: " + err.message }, 500); }
    }

    // --- Git unstage all ---
    if (method === "POST" && pathname === "/api/git/unstage-all") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // Scopato alla cartella aperta, per lo stesso motivo di `stage-all`:
        // togliere dallo stage roba che qui dentro non si vede sarebbe
        // altrettanto sorprendente.
        const proc = Bun.spawn(["git", "reset", "HEAD", "--", "."], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;
        // `git reset HEAD` esce 1 anche quando ha lavorato, se restano
        // differenze fra indice e albero: è il caso NORMALE dopo un unstage.
        // Si considera fallito solo se ha scritto un errore vero.
        if (proc.exitCode !== 0 && /fatal|error:/i.test(stderr)) {
          return json({ error: stderr.trim() || "Unstage-all failed" }, 400);
        }
        invalidateGitCache(resolvedDir);
        return json({ ok: true });
      } catch (err: any) { return json({ error: "Unstage-all error: " + err.message }, 500); }
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
          const statusProc = Bun.spawn(gitRead("status", "--porcelain", "--", file), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const statusOut = (await new Response(statusProc.stdout).text()).trim();
          if (statusOut.startsWith("??")) {
            // Scartare un file NON TRACCIATO non è come scartare uno tracciato:
            // git non ne ha copia, quindi qui non c'è niente da ripristinare.
            // Ed è lo stesso bottone, sulla riga accanto. Va nel cestino.
            //
            // Il path arriva dal client: si ricompone contro la cartella
            // risolta e si controlla che ci resti dentro. `git status` sopra è
            // già una barriera (fuori dal repo risponde con un errore, non con
            // `??`), ma una cancellazione non deve appoggiarsi a una barriera
            // di rimbalzo.
            const assoluto = resolve(resolvedDir, file);
            if (assoluto !== resolvedDir && !assoluto.startsWith(resolvedDir + "/")) { failed.push(file); continue; }
            const esito = await moveToTrash(assoluto);
            if (!esito.ok) failed.push(file);
          } else {
            const proc = Bun.spawn(["git", "checkout", "--", file], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            if (proc.exitCode !== 0) failed.push(file);
          }
        }
        if (failed.length > 0) return json({ ok: false, error: "Failed to discard some files", failed }, 400);
        invalidateGitCache(resolvedDir);
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
        // `env` con l'identità di ripiego: `git commit` si rifiuta di partire quando la
        // macchina non sa chi firma («empty ident name … not allowed», exit 128), e senza
        // questo il commit dal pannello Git moriva ovunque manchi un `~/.gitconfig` — un
        // runner di CI, un container, un servizio con l'ambiente ripulito. `gitEnvFor` è
        // RIPIEGO, non sostituzione: dove l'identità c'è, il commit resta firmato da chi ha
        // premuto il tasto. Il land (`services/task-automerge.ts`) lo faceva già dal 15/08;
        // questo endpoint no, ed è il motivo per cui FILE-17 era rosso nella nightly.
        const env = await gitEnvFor(resolvedDir);
        const proc = Bun.spawn(["git", "commit", "-m", body.message], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe", env });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) return json({ error: stderr.trim() || "Commit failed" }, 400);
        invalidateGitCache(resolvedDir);
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
        const r = await runNetworkGit(["git", "pull"], resolvedDir, 120_000);
        if (r.timedOut) return json({ error: "Pull: the remote is not answering (timeout)" }, 504);
        if (!r.ok) return json({ error: r.stderr || "Pull failed" }, 400);
        invalidateGitCache(resolvedDir);
        return json({ ok: true, output: r.stdout });
      } catch (err: any) { return json({ error: "Pull error: " + err.message }, 500); }
    }

    // --- Git fetch ---
    //
    // Mancava del tutto, e la sua assenza rendeva DECORATIVI i numeri di
    // sincronia: `ahead`/`behind` escono da `rev-list …@{upstream}`, che legge
    // la ref remote-tracking LOCALE. Senza un fetch quella ref non si muove mai,
    // quindi `behind` resta 0 per sempre — e siccome il bottone Pull è gatato
    // proprio su `behind > 0`, era irraggiungibile: un collega pusha su main e
    // qui non se ne accorge nessuno. È il motivo per cui VS Code fa autofetch.
    if (method === "POST" && pathname === "/api/git/fetch") {
      const body = await readJSON(req);
      if (!body?.path) return json({ error: "path required" }, 400);
      const resolvedDir = resolveProjectPath(body.path);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        // `--prune`: senza, i rami cancellati sul remote restano nella lista per
        // sempre e si può fare checkout di qualcosa che non esiste più.
        const r = await runNetworkGit(["git", "fetch", "--all", "--prune"], resolvedDir, 60_000);
        if (r.timedOut) return json({ error: "Fetch: the remote is not answering (timeout)" }, 504);
        if (!r.ok) return json({ error: r.stderr || "Fetch failed" }, 400);
        // Il fetch muove le ref remote-tracking: lo stato in cache è vecchio di
        // un istante. Senza questa riga i nuovi `behind` si vedrebbero solo al
        // prossimo giro di cache (5s) o al prossimo colpo del watcher.
        invalidateGitCache(resolvedDir);
        return json({ ok: true, output: r.stdout || r.stderr });
      } catch (err: any) { return json({ error: "Fetch error: " + err.message }, 500); }
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
        const configuredRemote = (await new Response(remoteProc.stdout).text()).trim();
        const remote = configuredRemote || "origin";
        // `-u` quando il ramo non ha ancora un upstream. I rami nuovi nascono da
        // `git checkout -b`, che non ne configura uno, e `push.autoSetupRemote`
        // non è impostato: senza questa riga il primo push riesce ma il ramo
        // resta senza tracking, quindi ahead/behind restano 0 per sempre e il
        // Pull successivo muore con «no tracking information».
        const args = configuredRemote
          ? ["git", "push", remote, branch]
          : ["git", "push", "-u", remote, branch];
        const r = await runNetworkGit(args, resolvedDir, 120_000);
        if (r.timedOut) return json({ error: "Push: the remote is not answering (timeout)" }, 504);
        if (!r.ok) return json({ error: r.stderr || "Push failed" }, 400);
        invalidateGitCache(resolvedDir);
        // git scrive l'esito del push su stderr anche quando va bene.
        return json({ ok: true, output: r.stdout || r.stderr });
      } catch (err: any) { return json({ error: "Push error: " + err.message }, 500); }
    }

    // --- Git show ---
    if (method === "GET" && pathname === "/api/git/show") {
      const dirPath = url.searchParams.get("path");
      const filePath = url.searchParams.get("file");
      // La revisione da guardare. Senza, era `HEAD` cablato e il contenuto di
      // un file a un commit qualsiasi non era chiedibile: è il lato sinistro
      // del diff di un commit passato («com'era prima» = `<hash>^`).
      //
      // Il valore va nella stessa stringa di `git show <rev>:<file>`, quindi si
      // accettano solo le forme che una revisione può avere: niente spazi,
      // niente `:` (che spezzerebbe l'argomento in due), niente `..`.
      const rev = url.searchParams.get("rev") || "HEAD";
      if (!/^[A-Za-z0-9_./^~@{}-]{1,200}$/.test(rev) || rev.includes("..")) {
        return json({ error: "invalid rev" }, 400);
      }
      /**
       * `side=index` legge il contenuto DELL'INDICE, cioè `git show :0:<file>`.
       *
       * È un parametro a parte e non un valore di `rev` perché la regex qui
       * sopra vieta i due punti di proposito (spezzerebbero l'argomento di
       * `git show` in due, e `file` arriva dal client). Allargarla per far
       * passare `:0` significherebbe smontare quel cancello per comodità.
       *
       * Serve perché senza, «Staged» e «Changes» mostravano lo STESSO diff:
       * `HEAD` contro il file su disco, cioè la somma dei due. Su un file con
       * entrambe le colonne piene — che è l'uscita garantita dello staging per
       * blocco di questo stesso pannello — chi mette in stage metà file vedeva
       * sotto anche ciò che NON aveva messo in stage, e non poteva rispondere
       * alla domanda che ci si fa prima di ogni commit: «cosa sto per
       * committare?».
       */
      const side = url.searchParams.get("side");
      if (side !== null && side !== "index") {
        return json({ error: "invalid side" }, 400);
      }
      if (!dirPath || !filePath) return json({ error: "path and file required" }, 400);
      const resolvedDir = resolveProjectPath(dirPath);
      if (!resolvedDir) return errorResponse(400, "Invalid path");
      try {
        let gitRelativePath = filePath;
        try {
          const toplevelProc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
          const gitRoot = (await new Response(toplevelProc.stdout).text()).trim();
          const { prefix } = repoPrefixOf(resolvedDir, gitRoot);
          if (prefix) gitRelativePath = prefix + filePath;
        } catch {}
        // `:0:` è lo stage 0 dell'indice — quello normale, non un lato di
        // merge. Il `0` è composto QUI e non arriva mai dal client.
        const spec = side === "index" ? `:0:${gitRelativePath}` : `${rev}:${gitRelativePath}`;
        const proc = Bun.spawn(["git", "show", spec], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
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
        // Nel cestino, non `rm -rf`. Vale per file e cartelle allo stesso modo:
        // era l'unico punto del server che cancellava per davvero su richiesta
        // di un click, senza conferma e senza un modo di tornare indietro.
        //
        // Se il cestino non è raggiungibile la chiamata FALLISCE. Ricadere su
        // `rm` sarebbe peggio che non avere il cestino: si legge «spostato nel
        // cestino», si va a cercarlo lì, e non c'è.
        const esito = await moveToTrash(resolvedFile);
        if (!esito.ok) return json({ error: esito.error || "Non sono riuscito a spostarlo nel cestino" }, 500);
        return json({ ok: true, trashed: true });
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
      // Async walk — same event-loop rationale as readDirRecursive above: this
      // powers file search over a whole project tree, the largest scan in the file.
      async function walkFlat(dir: string): Promise<void> {
        if (files.length >= maxFiles) return;
        try {
          const entries = await readdirAsync(dir, { withFileTypes: true });
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
              await walkFlat(fullPath);
            } else if (entry.isFile()) {
              // resolvedPath is guaranteed non-null (guarded at the top of the
              // handler); TS just loses the narrowing inside this closure.
              files.push(relative(resolvedPath!, fullPath));
            }
          }
        } catch {}
      }
      await walkFlat(resolvedPath);
      return json({ files });
    }

    // --- Package.json scripts ---
    if (method === "GET" && pathname === "/api/files/package-scripts") {
      const dirPath = url.searchParams.get("path");
      if (!dirPath) return json({ error: "path parameter required" }, 400);
      const resolvedPath = resolveProjectPath(dirPath);
      if (!resolvedPath) return errorResponse(400, "Invalid path");
      try {
        // Non piu solo `package.json`: vedi `lib/project-scripts.ts`. Il nome
        // della rotta resta per non rompere i chiamanti, ma quello che
        // restituisce e l'elenco COMPLETO, ognuno col manifest da cui viene.
        //
        // `found` e la meta che mancava: dice quali manifest sono stati
        // guardati e trovati, che e l'unica differenza fra «qui non c'e
        // niente» e «non ho guardato». Senza, la sezione si apriva sul vuoto.
        const { scripts, found } = detectScripts(resolvedPath);
        const pkgPath = join(resolvedPath, "package.json");
        let engines: Record<string, string> = {};
        if (existsSync(pkgPath)) {
          try { engines = JSON.parse(readFileSync(pkgPath, "utf-8")).engines || {}; } catch {}
        }
        return json({ scripts, found, looked: MANIFESTS, engines });
      } catch (err: any) {
        return json({ error: "Failed to read scripts: " + err.message }, 500);
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

        // Cosa c'è DAVVERO in stage. Il parser `-z` e non lo split su `\n`:
        // il vecchio codice faceva `.trim()` sull'output intero, e il trim
        // mangia lo spazio della prima riga — ` M a.txt` diventava `M a.txt`
        // e un file solo modificato sul disco passava per «in stage». Vedi
        // `lib/commit-message.ts`.
        const statusProc = Bun.spawn(STATUS_ARGS, { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const porcelain = await new Response(statusProc.stdout).text();
        await statusProc.exited;
        const staged = stagedEntries(porcelain);

        if (staged.length === 0) {
          return json({ error: "Nothing staged to describe", code: "no_staged_changes" }, 400);
        }

        // La mappa completa (costa poco anche su venti file) più il diff
        // ripartito nel budget. Vedi `lib/commit-message.ts` per il perché
        // «i primi 4000 caratteri» era il criterio peggiore a parità di spesa.
        const statProc = Bun.spawn(gitRead("diff", "--cached", "--stat"), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const statText = await new Response(statProc.stdout).text();
        const diffProc = Bun.spawn(gitRead("diff", "--cached", "--unified=1"), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const diffText = await new Response(diffProc.stdout).text();

        const fallback = rulesFallback(staged);

        // Il provider è quello che questa macchina usa DAVVERO per le chat, non
        // un gateway HTTP a parte: `GATEWAY_URL` (default :18789) qui non
        // risponde, e il ✨ era morto da lì. `claude-code` gira sulla
        // subscription via CLI, quindi una chiamata in più non è una riga di
        // fattura. Non `getDefaultProvider()`: `codex.complete` non accetta
        // nemmeno il parametro `options` e ignorerebbe il modello in silenzio.
        const provider = getProvider("claude-code");
        if (!provider) {
          return json({ message: fallback, source: "rules", reason: "no_provider" });
        }

        // `complete()` non accetta un signal e il suo timeout interno è di
        // MEZZ'ORA: senza questa corsa un modello appeso terrebbe occupato il
        // gestore per tutto quel tempo. Il fetch di prima aveva un
        // AbortController a 30s messo lì apposta, e non si perde.
        const logProc = Bun.spawn(["git", "log", "--pretty=%s", "-10"], { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const esempi = (await new Response(logProc.stdout).text()).split("\n").map(s => s.trim()).filter(Boolean);

        const scaduto = Symbol("timeout");
        const risposta = await Promise.race([
          provider.complete(
            [
              { role: "system", content: buildSystemPrompt(esempi) },
              { role: "user", content: buildUserPrompt(statText, diffText) },
            ],
            { model: "claude-haiku-4-5" },
          ).catch(() => null),
          new Promise<typeof scaduto>(r => setTimeout(() => r(scaduto), 30_000)),
        ]);

        if (risposta === scaduto) {
          return json({ error: "The model did not answer in time", code: "timeout", fallbackMessage: fallback }, 504);
        }
        // `complete()` su exit non-zero NON lancia: risolve con
        // `content: "Error: CLI exited with code N"`. Senza il controllo, quella
        // stringa finirebbe incollata nella casella del commit.
        const message = usableMessage(risposta?.content);
        if (!message) {
          return json({ error: "The model produced no message", code: "provider_failed", fallbackMessage: fallback }, 503);
        }
        return json({ message, source: "ai" });
      } catch (err: any) {
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
        invalidateGitCache(resolvedDir);
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
        invalidateGitCache(resolvedDir);
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
        invalidateGitCache(resolvedDir);
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
        invalidateGitCache(resolvedDir);
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
        invalidateGitCache(resolvedDir);
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
        const proc = Bun.spawn(gitRead("diff", "HEAD", "--", filePath), { cwd: resolvedDir, stdout: "pipe", stderr: "pipe" });
        const diff = await new Response(proc.stdout).text();
        await proc.exited;

        const changes: { from: number; to: number; type: "added" | "modified" | "deleted" }[] = [];
        // Parse unified diff hunks
        const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
        let match;
        while ((match = hunkRegex.exec(diff)) !== null) {
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
