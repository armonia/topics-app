import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnBounded } from "../lib/bounded-spawn";

export interface WorktreeCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface WorktreeProjectConfig {
  setup?: WorktreeCommand;
  run?: WorktreeCommand;
  archive?: WorktreeCommand;
}

export interface WorktreeSetupResult {
  status: "not-configured" | "succeeded" | "failed" | "timed-out";
  exitCode: number | null;
  output: string[];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
// Dependencies plus setup must fit inside the agent's readiness wait (600 s by default).
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const GIT_LIST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LINES = 20;
const PORT_START = 20_000;
const PORT_SPAN = 20_000;

function safeRelativePath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseCommand(value: unknown): WorktreeCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if (typeof command.command !== "string" || !command.command.trim()) return undefined;
  if (!Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")) return undefined;
  const timeoutMs = Number(command.timeoutMs);
  return {
    command: command.command,
    args: command.args as string[],
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS) } : {}),
  };
}

export function readWorktreeProjectConfig(projectPath: string): WorktreeProjectConfig {
  const configPath = join(projectPath, ".topics", "worktree.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return {
      setup: parseCommand(raw.setup),
      run: parseCommand(raw.run),
      archive: parseCommand(raw.archive),
    };
  } catch {
    return {};
  }
}

function hasParentSegment(pattern: string): boolean {
  return pattern.replaceAll("\\", "/").split("/").some((part) => part === "..");
}

// Async on purpose: listing untracked files walks node_modules too, 0.7 s on topics-app,
// and a synchronous spawn would freeze every socket of the server meanwhile.
async function git(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnBounded(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeoutMs: GIT_LIST_TIMEOUT_MS });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Copy only Git's untracked paths selected by gitignore-style patterns. */
export async function copyWorktreeIncludes(projectPath: string, worktreePath: string): Promise<{ copied: string[]; skipped: string[] }> {
  const root = realpathSync(projectPath);
  const targetRoot = resolve(worktreePath);
  const includePath = join(root, ".worktreeinclude");
  if (!existsSync(includePath)) return { copied: [], skipped: [] };
  const patterns = readFileSync(includePath, "utf8").split(/\r?\n/);
  const unsafe = patterns.filter((pattern) => pattern.trim() && !pattern.trimStart().startsWith("#") && hasParentSegment(pattern));
  if (unsafe.length) return { copied: [], skipped: unsafe.map((pattern) => `pattern non sicuro: ${pattern}`) };

  const listed = await git(root, ["ls-files", "--others", "--ignored", "-z", `--exclude-from=${includePath}`, "--"]);
  if (listed.code !== 0) throw new Error(`git ls-files worktreeinclude: ${listed.stderr.trim()}`);
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const relPath of listed.stdout.split("\0").filter(Boolean)) {
    const source = resolve(root, relPath);
    if (!safeRelativePath(root, source)) { skipped.push(`${relPath}: fuori dalla radice`); continue; }
    let stat;
    try {
      stat = lstatSync(source);
      if (!safeRelativePath(root, realpathSync(source))) { skipped.push(`${relPath}: symlink fuori dalla radice`); continue; }
    } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { skipped.push(`${relPath}: symlink o tipo non copiabile`); continue; }
    const destination = resolve(targetRoot, relPath);
    if (!safeRelativePath(targetRoot, destination)) { skipped.push(`${relPath}: destinazione fuori dalla radice`); continue; }
    // A pre-existing symlink in the worktree could redirect this write outside it.
    let cursor = dirname(destination);
    while (cursor !== targetRoot && safeRelativePath(targetRoot, cursor)) {
      try {
        if (lstatSync(cursor).isSymbolicLink()) { skipped.push(`${relPath}: destinazione attraversa un symlink`); cursor = ""; break; }
      } catch { /* directory will be created below */ }
      cursor = dirname(cursor);
    }
    if (!cursor) continue;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied.push(relPath);
  }
  return { copied, skipped };
}

/**
 * Collision-free across the supplied worktrees, which come oldest first: a newcomer whose hash
 * lands on a taken port takes the next free one and never moves a port already handed out.
 */
export function assignWorktreePorts(paths: string[]): Map<string, number> {
  const ordered = [...new Set(paths.map((path) => resolve(path)))];
  const used = new Set<number>();
  const result = new Map<string, number>();
  for (const path of ordered) {
    const digest = createHash("sha256").update(path).digest();
    let port = PORT_START + digest.readUInt32BE(0) % PORT_SPAN;
    for (let attempt = 0; attempt < PORT_SPAN && used.has(port); attempt++) {
      port = PORT_START + ((port - PORT_START + 1) % PORT_SPAN);
    }
    used.add(port);
    result.set(path, port);
  }
  return result;
}

export function worktreePort(path: string, knownPaths: string[] = [path]): number {
  return assignWorktreePorts(knownPaths).get(resolve(path)) ?? PORT_START;
}

export async function runWorktreeCommand(
  cwd: string,
  script: WorktreeCommand | undefined,
  port: number,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<WorktreeSetupResult> {
  if (!script) return { status: "not-configured", exitCode: null, output: [] };
  const limit = Math.min(script.timeoutMs ?? timeoutMs, MAX_COMMAND_TIMEOUT_MS);
  const proc = spawnBounded([script.command, ...script.args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TOPICS_PORT: String(port) },
    timeoutMs: limit,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean).slice(-MAX_OUTPUT_LINES);
  return {
    status: proc.timedOut ? "timed-out" : exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    output,
  };
}
