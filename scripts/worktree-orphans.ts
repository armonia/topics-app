#!/usr/bin/env bun
/**
 * The worktrees of this repo, who owns each one, and which are ORPHANS.
 *
 * WHY. `git worktree list` showed 25 entries on 22/10/2026, four of them INSIDE the repo under
 * `.claude/worktrees` (1.6 GB that every `find` and `grep` of the checkout walked). Topics' own
 * worktrees are born in `~/.topics/worktrees` and `server/services/worktree-gc.ts` prunes them, but
 * it reads the table of worktrees it created, never `git worktree list`: the ones made by the desktop
 * app, by Claude Code subagents and by hand were nobody's job.
 *
 * An orphan is a worktree where ALL of these hold (each one is a reason to keep it):
 *   - it is not the main checkout, not locked, and not under `~/.topics/worktrees` (worktree-gc's);
 *   - no process has its working directory inside (`lsof`);
 *   - the tree is clean (any change, ignored files aside, keeps it);
 *   - nothing happened there for 7 days (last commit and folder mtime), because a branch that is
 *     "merged" is true of every worktree the moment it is born, at the tip of main;
 *   - its work is safe elsewhere: the branch tip is an ancestor of `origin/main`, or a merged pull
 *     request had exactly that tip as its head (squash merges never make the tip an ancestor).
 *
 *   bun run scripts/worktree-orphans.ts            print the table, remove nothing
 *   bun run scripts/worktree-orphans.ts --apply    move the orphans to the Trash, then `git worktree prune`
 *
 * Only the folder goes (`trash`, never `rm`): the branch stays, and so does every commit on it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_IDLE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface WorktreeFacts {
  path: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  /** Managed by `worktree-gc` (a worktree under `~/.topics/worktrees`). */
  boardManaged: boolean;
  liveProcess: boolean;
  dirty: boolean;
  /** The later of the last commit and the folder's mtime. */
  lastActivityMs: number;
  /** Tip is an ancestor of origin/main, or a merged PR had exactly this tip. */
  landed: boolean;
}

export interface Verdict {
  orphan: boolean;
  reason: string;
}

/** The first reason to KEEP the worktree, or the reason it is an orphan. */
export function verdict(w: WorktreeFacts, now: number): Verdict {
  const keep = (reason: string): Verdict => ({ orphan: false, reason });
  if (w.isMain) return keep("main checkout");
  if (w.boardManaged) return keep("managed by worktree-gc");
  if (w.locked) return keep("locked");
  if (w.liveProcess) return keep("a process is inside");
  if (w.dirty) return keep("uncommitted work");
  const idleDays = (now - w.lastActivityMs) / DAY_MS;
  if (idleDays < MIN_IDLE_DAYS) return keep(`active ${Math.floor(idleDays)} days ago`);
  if (!w.branch) return keep("detached HEAD");
  if (!w.landed) return keep("branch not in origin/main and no merged PR with this tip");
  return { orphan: true, reason: `idle ${Math.floor(idleDays)} days, clean, work landed` };
}

/** Who made it, read off the path: the only trace there is. */
export function ownerOf(path: string, repo: string): string {
  if (path.startsWith(join(repo, ".claude", "worktrees", "agent-"))) return "Claude Code subagent";
  if (path.startsWith(join(repo, ".claude", "worktrees"))) return "desktop app session";
  if (path.startsWith(join(homedir(), ".topics", "worktrees"))) return "Topics board card";
  if (path.includes("/scratchpad/")) return "agent session scratch";
  return "by hand, next to the repo";
}

const git = (args: string[], cwd: string): string => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function mainCheckout(): string {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], process.cwd());
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : process.cwd();
}

/**
 * Working directories of every process, once: the same probe `scripts/disk-report.ts` uses.
 * `null` means lsof could not answer (not installed, killed): nothing can then be called idle.
 * lsof exits 1 when it could not look into some process, with a good answer on stdout.
 */
function liveCwds(): string[] | null {
  const r = spawnSync("lsof", ["-d", "cwd", "-Fn"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error || r.signal || !r.stdout) return null;
  return r.stdout.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
}

function mergedPrHeads(branch: string, repo: string): string[] {
  try {
    const out = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--jq", ".[].headRefOid"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Dirty unless git says clean: a failed `git status` (corrupt index, ownership) is not "clean". */
function isDirty(path: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
  return r.status !== 0 || r.stdout.trim() !== "";
}

function collect(repo: string, now: number): WorktreeFacts[] {
  const cwds = liveCwds();
  const boardRoot = join(homedir(), ".topics", "worktrees");
  const entries = git(["worktree", "list", "--porcelain"], repo).split("\n\n").filter(Boolean);
  return entries.map((block, i) => {
    const field = (key: string): string | undefined => block.split("\n").find((l) => l === key || l.startsWith(`${key} `))?.slice(key.length + 1);
    const path = field("worktree")!;
    const branch = field("branch")?.replace("refs/heads/", "") ?? null;
    const exists = existsSync(path);
    const tip = branch ? git(["rev-parse", branch], repo) : "";
    const ancestor = branch ? spawnSync("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: repo }).status === 0 : false;
    const lastCommit = exists ? Number(git(["log", "-1", "--format=%ct"], path)) * 1000 : 0;
    return {
      path,
      branch,
      isMain: i === 0,
      locked: block.split("\n").some((l) => l === "locked" || l.startsWith("locked ")),
      boardManaged: path.startsWith(boardRoot),
      liveProcess: cwds === null || cwds.some((c) => c === path || c.startsWith(`${path}/`)),
      dirty: !exists || isDirty(path),
      lastActivityMs: exists && lastCommit > 0 ? Math.max(lastCommit, statSync(path).mtimeMs) : now,
      landed: ancestor || (branch !== null && tip !== "" && mergedPrHeads(branch, repo).includes(tip)),
    };
  });
}

if (import.meta.main) {
  const repo = mainCheckout();
  const now = Date.now();
  const apply = process.argv.includes("--apply");
  const rows = collect(repo, now).map((facts) => ({ facts, v: verdict(facts, now) }));
  const short = (p: string): string => p.replace(homedir(), "~");
  const insideRepo = (p: string): boolean => p.startsWith(`${join(repo, ".claude", "worktrees")}/`);
  for (const { facts, v } of rows) {
    const when = new Date(facts.lastActivityMs).toISOString().slice(0, 10);
    console.log(
      `${v.orphan ? "ORPHAN" : "keep  "}  ${ownerOf(facts.path, repo).padEnd(26)} ${when}  ${(facts.branch ?? "(detached)").padEnd(44)} ${short(facts.path)}  — ${v.reason}`,
    );
  }
  const orphans = rows.filter((r) => r.v.orphan);
  const inside = rows.filter((r) => !r.facts.isMain && insideRepo(r.facts.path));
  console.log(`\n${rows.length} worktrees, ${inside.length} inside the repo, ${orphans.length} orphans${apply ? "" : " (dry run; --apply removes them)"}`);
  if (apply) {
    for (const { facts } of orphans) {
      const r = spawnSync("trash", [facts.path]);
      console.log(r.status === 0 ? `trashed ${short(facts.path)}` : `could not trash ${short(facts.path)} (exit ${r.status})`);
    }
    if (orphans.length) git(["worktree", "prune"], repo);
  }
}
