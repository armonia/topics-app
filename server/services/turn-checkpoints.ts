/**
 * Automatic per-turn checkpoints: a safety net you do not have to remember.
 *
 * THE GAP. Topics already had checkpoints, but MANUAL: somebody has to press
 * "Save" before the turn they will later want to undo, which is exactly the
 * turn nobody sees coming. So in practice the net is not there when it is
 * needed. This module takes the snapshot by itself, once per turn, before the
 * agent is allowed to write anything.
 *
 * THE THREE DECISIONS behind it, because each one is a trade and none is
 * obvious from the code alone:
 *
 * 1. WHERE IT IS WRITTEN - a dedicated ref, `refs/topics/checkpoints/<session>/
 *    <seq>`, never a commit on the working branch. A commit per turn on the
 *    user's branch fills `git log` with noise they have to clean by hand before
 *    every PR and makes `git rebase -i` unreadable. A ref outside `refs/heads/`
 *    is invisible to `log`, `status` and `branch`, is not pushed by default,
 *    and is deleted with one line. The cost, accepted: these checkpoints do not
 *    survive an aggressive `git gc --prune` once the ref is gone - fine for a
 *    short-term safety net, which is all this is.
 *
 * 2. HOW LONG IT IS KEPT - the last `KEEP_PER_SESSION` per session, pruned as
 *    new ones arrive. The net is for "undo the last turn", not for archaeology:
 *    past a few dozen nobody actually goes back, and the cost is git objects
 *    growing forever. The number is deliberately arbitrary and lives here, in a
 *    constant, not in a decision to reopen.
 *
 * 3. WHAT A RESTORE BRINGS BACK - THE FILES, and only the files. Not the
 *    conversation. These are two different promises: "your files are back as
 *    they were" is verifiable and always kept; "the conversation is back as it
 *    was" opens what happens to the later turns already sent, to the tools
 *    already run, to the files the user touched by hand in the meantime.
 *    Claude Code does both because it owns both ends; Topics does not. Making
 *    two promises and keeping one and a half is worse than making one: whoever
 *    trusts a rewind and finds out afterwards that half the state stayed behind
 *    loses trust in the tool, not in the detail. So the caller SAYS SO, in
 *    chat, every time (see `restoreTurnCheckpoint`'s return shape).
 *
 * HOW THE SNAPSHOT IS TAKEN, and why it cannot disturb the user. The worktree
 * is written into a TEMPORARY index file (`GIT_INDEX_FILE`), turned into a tree
 * with `write-tree`, sealed into a commit object with `commit-tree`, and only
 * then pointed at by the ref. The user's real index, their HEAD, their staged
 * changes and their working tree are never touched: taking a checkpoint is a
 * pure read of the worktree plus a write of loose objects.
 */

import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Namespace of every automatic checkpoint. Outside `refs/heads/` on purpose. */
export const CHECKPOINT_REF_ROOT = "refs/topics/checkpoints";

/** Decision 2: how many checkpoints a session keeps. A number in a file. */
export const KEEP_PER_SESSION = 50;

/** The identity stamped on checkpoint commits. Fixed on purpose: these objects
 *  are machine bookkeeping, and they must not carry a real person's name into
 *  a repository that may be public. It also means `commit-tree` works in a repo
 *  where `user.name` was never configured. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "Topics",
  GIT_AUTHOR_EMAIL: "checkpoints@topics.local",
  GIT_COMMITTER_NAME: "Topics",
  GIT_COMMITTER_EMAIL: "checkpoints@topics.local",
};

export interface TurnCheckpoint {
  /** Full ref name, e.g. `refs/topics/checkpoints/abc/0000000007`. */
  ref: string;
  /** The checkpoint commit object. */
  commit: string;
  /** Monotonic sequence inside the session; higher is newer. */
  seq: number;
  /** Human label, the first line of the commit message minus the prefix. */
  label: string;
  /** ISO timestamp of when the snapshot was taken. */
  createdAt: string;
}

export interface RestoreOutcome {
  /** Paths written back from the checkpoint tree. */
  restored: number;
  /** Paths that did not exist at checkpoint time and were removed. */
  removed: number;
  /** The branch HEAD is on AFTER the restore. `null` means the repository was
   *  already detached before we touched it: we never detach it ourselves. */
  branch: string | null;
  /** Always false. Decision 3, made explicit on the wire so no caller has to
   *  guess and no UI can imply otherwise. */
  conversationRewound: false;
}

type GitResult = { code: number; stdout: string; stderr: string };

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitOrThrow(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await git(args, cwd, env);
  if (r.code !== 0) throw new Error(r.stderr || `git ${args[0]} exited ${r.code}`);
  return r.stdout;
}

/**
 * A session key is free-form; a git ref name is not. Anything outside
 * `[A-Za-z0-9._-]` becomes `-`, runs of dots collapse (git forbids `..`), and
 * a leading dot or trailing `.lock` are stripped. Empty input gets a constant
 * so we never build a ref ending in a bare slash.
 */
export function sessionRefSlug(sessionKey: string): string {
  const cleaned = sessionKey
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/\.lock$/i, "");
  return cleaned.length > 0 ? cleaned : "session";
}

function sessionRefPrefix(sessionKey: string): string {
  return `${CHECKPOINT_REF_ROOT}/${sessionRefSlug(sessionKey)}`;
}

/** Zero padded so `for-each-ref`'s lexicographic sort is chronological. */
function seqToRefLeaf(seq: number): string {
  return String(seq).padStart(10, "0");
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  if (!projectPath || !existsSync(projectPath)) return false;
  const r = await git(["rev-parse", "--is-inside-work-tree"], projectPath);
  return r.code === 0 && r.stdout === "true";
}

/**
 * The checkpoints of one session, NEWEST FIRST.
 *
 * Read straight from the refs: there is no side index to keep in sync, so a
 * checkpoint deleted with `git update-ref -d` (or a whole namespace wiped by
 * hand) simply stops being listed. The refs ARE the state.
 */
export async function listTurnCheckpoints(projectPath: string, sessionKey: string): Promise<TurnCheckpoint[]> {
  if (!(await isGitRepo(projectPath))) return [];
  const prefix = sessionRefPrefix(sessionKey);
  const r = await git(
    ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(subject)%09%(creatordate:iso-strict)", prefix],
    projectPath,
  );
  if (r.code !== 0 || !r.stdout) return [];
  const out: TurnCheckpoint[] = [];
  for (const line of r.stdout.split("\n")) {
    const [ref, commit, subject, createdAt] = line.split("\t");
    if (!ref || !commit) continue;
    const seq = Number.parseInt(ref.slice(prefix.length + 1), 10);
    if (!Number.isFinite(seq)) continue;
    out.push({
      ref,
      commit,
      seq,
      label: (subject ?? "").replace(/^topics-checkpoint:\s*/, ""),
      createdAt: createdAt ?? "",
    });
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/**
 * Snapshot the worktree as it is RIGHT NOW into a new checkpoint ref.
 *
 * Returns the checkpoint, or `null` when there was nothing to record - either
 * the path is not a git repository, or the tree is byte-identical to the last
 * checkpoint. That second case is not an optimisation detail: most turns in a
 * chat write no files at all, and without it a session would burn its whole
 * budget of 50 on identical snapshots and prune away the one turn that did
 * change something.
 */
export async function captureTurnCheckpoint(
  projectPath: string,
  sessionKey: string,
  label: string,
): Promise<TurnCheckpoint | null> {
  if (!(await isGitRepo(projectPath))) return null;

  // A temporary index, so the user's staged changes are never disturbed.
  const indexDir = mkdtempSync(join(tmpdir(), "topics-ckpt-index-"));
  const indexFile = join(indexDir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    // `add -A` on a fresh index records the worktree as it stands, honouring
    // .gitignore: tracked edits, untracked new files, and (by their absence)
    // deletions.
    await gitOrThrow(["add", "-A", "--", "."], projectPath, env);
    const tree = await gitOrThrow(["write-tree"], projectPath, env);

    const existing = await listTurnCheckpoints(projectPath, sessionKey);
    const latest = existing[0];
    if (latest) {
      const lastTree = await git(["rev-parse", `${latest.commit}^{tree}`], projectPath);
      if (lastTree.code === 0 && lastTree.stdout === tree) return null;
    }

    // Parent = HEAD when there is one, so `git diff HEAD <checkpoint>` reads
    // naturally. On an unborn branch there is no parent and that is fine.
    const head = await git(["rev-parse", "HEAD"], projectPath);
    const parentArgs = head.code === 0 && head.stdout ? ["-p", head.stdout] : [];

    const createdAt = new Date().toISOString();
    const message =
      `topics-checkpoint: ${label}\n\n` +
      `Topics-Session: ${sessionKey}\n` +
      `Topics-Time: ${createdAt}\n`;
    const commit = await gitOrThrow(
      ["commit-tree", tree, ...parentArgs, "-m", message],
      projectPath,
      { ...CHECKPOINT_IDENTITY, GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt },
    );

    const seq = (latest?.seq ?? -1) + 1;
    const ref = `${sessionRefPrefix(sessionKey)}/${seqToRefLeaf(seq)}`;
    await gitOrThrow(["update-ref", ref, commit], projectPath);

    await pruneTurnCheckpoints(projectPath, sessionKey);
    return { ref, commit, seq, label, createdAt };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Drop everything past the newest `KEEP_PER_SESSION`. */
export async function pruneTurnCheckpoints(projectPath: string, sessionKey: string): Promise<number> {
  const all = await listTurnCheckpoints(projectPath, sessionKey);
  const doomed = all.slice(KEEP_PER_SESSION);
  for (const c of doomed) await git(["update-ref", "-d", c.ref, c.commit], projectPath);
  return doomed.length;
}

/** Delete a session's whole namespace. Called when the session is closed: the
 *  net has no reason to outlive the conversation it was protecting. */
export async function dropTurnCheckpoints(projectPath: string, sessionKey: string): Promise<number> {
  const all = await listTurnCheckpoints(projectPath, sessionKey);
  for (const c of all) await git(["update-ref", "-d", c.ref, c.commit], projectPath);
  return all.length;
}

/** Every path the worktree currently holds that git would track, checkpoint
 *  or not: tracked files plus untracked-but-not-ignored ones. */
async function currentWorktreePaths(projectPath: string): Promise<Set<string>> {
  const r = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], projectPath);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}

async function treePaths(projectPath: string, commit: string): Promise<Set<string>> {
  const r = await git(["ls-tree", "-r", "--name-only", "-z", commit], projectPath);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}

/**
 * Put the worktree back the way the checkpoint found it. Two halves, and the
 * second is the one that is easy to forget:
 *
 *   • `git restore --source=<commit> -- .` rewrites every path the checkpoint
 *     knows about. NOT `git checkout <commit>`, which moves HEAD onto the
 *     commit and leaves the repository in DETACHED HEAD - a bad trade for a
 *     gesture as small as "undo the last turn". `restore` leaves HEAD exactly
 *     where it was.
 *
 *   • files the turn CREATED are not in the checkpoint tree, so `restore` says
 *     nothing about them and they would survive the rewind. "The tree as it was
 *     before that turn" has to mean they go, so they are removed explicitly.
 *     Only non-ignored paths git already knows about are ever deleted, which
 *     keeps build outputs and local scratch out of it.
 */
export async function restoreTurnCheckpoint(projectPath: string, commit: string): Promise<RestoreOutcome> {
  const root = resolve(projectPath);
  const before = await currentWorktreePaths(projectPath);
  const inCheckpoint = await treePaths(projectPath, commit);

  await gitOrThrow(["restore", "--source", commit, "--worktree", "--", "."], projectPath);

  let removed = 0;
  for (const path of before) {
    if (inCheckpoint.has(path)) continue;
    const abs = resolve(root, path);
    // Never step outside the project, whatever a crafted path claims to be.
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    try {
      if (existsSync(abs)) {
        unlinkSync(abs);
        removed++;
      }
    } catch {
      // A path we cannot delete is reported by omission, not by an exception:
      // the rest of the rewind is still worth completing.
    }
  }

  const head = await git(["symbolic-ref", "--short", "HEAD"], projectPath);
  return {
    restored: inCheckpoint.size,
    removed,
    branch: head.code === 0 ? head.stdout : null,
    conversationRewound: false,
  };
}
