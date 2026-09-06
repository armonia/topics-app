/**
 * Automatic per-turn checkpoints: a safety net you do not have to remember.
 *
 * THE GAP. Topics already had checkpoints, but MANUAL: somebody has to press
 * "Save" before the turn they will later want to undo, which is exactly the
 * turn nobody sees coming. So in practice the net is not there when it is
 * needed. This module takes the snapshot by itself, once per turn, before the
 * agent is allowed to write anything.
 *
 * THE FOUR DECISIONS behind it, because each one is a trade and none is
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
 *    chat, every time (see `RestoreOutcome`).
 *
 * 4. WHAT A RESTORE MAY TOUCH - only the paths THIS SESSION'S TURN changed.
 *    The first restore rewrote every path the checkpoint knew and deleted
 *    every path it did not: correct on a folder nobody else is in, and a
 *    disaster on the folder it is actually used in, where a person keeps an
 *    editor open and a second chat may be writing too. A file the turn never
 *    touched was rewritten to its checkpoint bytes, wiping the person's edit;
 *    a file the person created was deleted because the checkpoint had never
 *    seen it. So every turn now closes with an `after` snapshot, and a restore
 *    is the diff between the target and the session's newest snapshot, path
 *    by path, with a second check per path that the worktree still holds what
 *    that newest snapshot recorded. Anything else is somebody else's work and
 *    is left alone, and said so. That logic lives in
 *    `checkpoint-restore-plan.ts`; this module only records the kinds.
 *
 * HOW THE SNAPSHOT IS TAKEN, and why it cannot disturb the user. The worktree
 * is written into a TEMPORARY index file (`GIT_INDEX_FILE`), turned into a tree
 * with `write-tree`, sealed into a commit object with `commit-tree`, and only
 * then pointed at by the ref. The user's real index, their HEAD, their staged
 * changes and their working tree are never touched: taking a checkpoint is a
 * pure read of the worktree plus a write of loose objects.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestorePlanEntry } from "../../shared/checkpoint-plan";

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

/**
 * When in a turn the snapshot was taken. `before` is the restore point offered
 * to the user; `after` is the end-of-turn mark that exists so a restore can
 * tell the turn's own writes from everybody else's (decision 4) and is never
 * offered as a restore point; `manual` is the user pressing "Save", a restore
 * point like `before`.
 */
export type CheckpointKind = "before" | "after" | "manual";

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
  /** Read back from the `Topics-Kind` trailer. A ref written before kinds
   *  existed has no trailer and reads as `before`: that is what every
   *  checkpoint was until then. */
  kind: CheckpointKind;
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
  /** Paths the plan left alone because somebody else changed them after this
   *  session's last snapshot (decision 4). Reported, never silently dropped. */
  skipped: RestorePlanEntry[];
}

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * HOW LONG A SINGLE `git` MAY TAKE, and why waiting forever was not an option.
 *
 * Every checkpoint runs on the user's turn, BEFORE the agent is allowed to
 * write: the turn waits for this. And git is not a pure computation, it takes
 * `index.lock`. Another process holding that lock (an editor auto-fetching, a
 * second agent on the same repository, a crashed git that left the file
 * behind) makes the command sit there, and without a ceiling the user's turn
 * sits with it, forever, without one line in the log to explain the silence.
 *
 * Past this the child is killed and the failure is REPORTED: a checkpoint that
 * did not happen is a small loss, a turn that never starts is the whole app.
 * The window is wide enough for a big repository (`write-tree` over a large
 * worktree) and short enough that nobody thinks the app crashed.
 */
export const GIT_TIMEOUT_MS = 30_000;

/**
 * One `git`, with a ceiling. Exported, and with the ceiling as a parameter,
 * only so the ceiling can be PROVEN in milliseconds instead of thirty seconds:
 * a test that has to wait half a minute to watch a timeout is a test nobody
 * runs. Callers inside this module pass no ceiling and get `GIT_TIMEOUT_MS`.
 */
export async function runGit(
  args: string[], cwd: string, env?: Record<string, string>, timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const work = (async (): Promise<GitResult> => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  })();
  // The pipes are NOT waited on past the ceiling either, and that is not a
  // detail: a killed process can leave a grandchild holding the write end, and
  // reading to EOF would then wait exactly as long as the command we just gave
  // up on. Measured here: the test with a stand-in `git` that sleeps hung for
  // the full sleep even though the child had already been killed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let done: GitResult | null;
  try {
    done = await Promise.race([work, alarm]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (done) return done;
  // 124 is what `timeout(1)` answers, and the reason is written down: whoever
  // reads the log must not have to guess why a checkpoint did not happen.
  void work.catch(() => { /* nobody is listening any more */ });
  console.warn(
    `[turn-checkpoints] git ${args[0]} exceeded ${timeoutMs} ms, killing it (index.lock held by another process?)`,
  );
  try { proc.kill(); } catch { /* already gone */ }
  return { code: 124, stdout: "", stderr: `git ${args[0]} timed out after ${timeoutMs} ms and was killed` };
}

async function gitOrThrow(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await runGit(args, cwd, env);
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
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], projectPath);
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
  const r = await runGit(
    [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(subject)%09%(creatordate:iso-strict)%09%(trailers:key=Topics-Kind,valueonly)",
      prefix,
    ],
    projectPath,
  );
  if (r.code !== 0 || !r.stdout) return [];
  const out: TurnCheckpoint[] = [];
  // The trailer value keeps its own newline, so a record with a kind is
  // followed by an empty line: the `!ref` guard below skips it.
  for (const line of r.stdout.split("\n")) {
    const [ref, commit, subject, createdAt, kindRaw] = line.split("\t");
    if (!ref || !commit) continue;
    const seq = Number.parseInt(ref.slice(prefix.length + 1), 10);
    if (!Number.isFinite(seq)) continue;
    out.push({
      ref,
      commit,
      seq,
      label: (subject ?? "").replace(/^topics-checkpoint:\s*/, ""),
      createdAt: createdAt ?? "",
      kind: parseKind(kindRaw),
    });
  }
  return out.sort((a, b) => b.seq - a.seq);
}

function parseKind(raw: string | undefined): CheckpointKind {
  const v = (raw ?? "").trim();
  return v === "after" || v === "manual" ? v : "before";
}

/** The checkpoints a user may go back to: every kind but `after`, newest
 *  first. An end-of-turn mark is bookkeeping for the restore, not a moment
 *  anybody asked to return to. */
export async function listRestorePoints(projectPath: string, sessionKey: string): Promise<TurnCheckpoint[]> {
  return (await listTurnCheckpoints(projectPath, sessionKey)).filter((c) => c.kind !== "after");
}

/**
 * The worktree as it stands, recorded into a TEMPORARY index, handed to `fn`
 * as the environment that selects it. The user's real index is never read or
 * written: this is what lets a snapshot, or a comparison against one, run
 * while they have work staged.
 *
 * Shared with the restore plan on purpose. "Does the worktree still hold what
 * the last snapshot recorded" has to be answered with the SAME reading of the
 * worktree that took the snapshot (untracked files included, ignored files
 * excluded), or the two disagree on exactly the files a turn creates. A plain
 * `git diff <commit>` reads the user's real index instead and reports every
 * untracked path as missing.
 */
export async function withWorktreeIndex<T>(
  projectPath: string,
  fn: (indexEnv: Record<string, string>) => Promise<T>,
): Promise<T> {
  const indexDir = mkdtempSync(join(tmpdir(), "topics-ckpt-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(indexDir, "index") };
    // `add -A` on a fresh index records the worktree as it stands, honouring
    // .gitignore: tracked edits, untracked new files, and (by their absence)
    // deletions.
    await gitOrThrow(["add", "-A", "--", "."], projectPath, env);
    return await fn(env);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
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
 *
 * THE DEDUP RULE DEPENDS ON THE KIND, and the asymmetry is the point:
 *   - an `after` is ALWAYS recorded, identical bytes included. It is not a
 *     snapshot, it is a MARK: "the turn ended here, and what the tree holds
 *     now is what this session left". Skipping the ones that changed nothing
 *     looked free and was not: with the mark missing, the newest snapshot of
 *     the session stays the `before` of a turn that is over, and a restore can
 *     no longer tell "that turn wrote nothing" from "that turn wrote and its
 *     end was never recorded". The first is an empty undo, the second is a
 *     refusal (`no-turn-mark` in `checkpoint-restore-plan.ts`), and guessing
 *     between them either loses somebody's work or refuses for no reason. The
 *     cost of the mark is one commit object pointing at a tree that already
 *     exists, and the pruning counts restore points, not refs, so the depth of
 *     the net does not shrink;
 *   - a `before` or `manual` is skipped only when the newest snapshot has the
 *     same bytes AND is itself a restore point. A restore point must exist for
 *     the turn that is starting; the newest snapshot having the same bytes is
 *     not enough if it is an end-of-turn mark, because the end-of-turn mark is
 *     not offered as a restore point (see `listRestorePoints`).
 *
 * `keep` is the pruning ceiling, and it is a parameter for the same reason
 * `runGit`'s timeout is: so the pruning can be PROVEN cheaply. Every round is a
 * real commit on a real repository, so watching the default of 50 prune costs
 * 55 rounds and half a minute of git under load; with a small ceiling the same
 * behaviour is measured in eight. Production passes nothing and gets
 * `KEEP_PER_SESSION`.
 */
export async function captureTurnCheckpoint(
  projectPath: string,
  sessionKey: string,
  label: string,
  kind: CheckpointKind = "before",
  keep: number = KEEP_PER_SESSION,
): Promise<TurnCheckpoint | null> {
  if (!(await isGitRepo(projectPath))) return null;

  return withWorktreeIndex(projectPath, async (env) => {
    const tree = await gitOrThrow(["write-tree"], projectPath, env);

    const existing = await listTurnCheckpoints(projectPath, sessionKey);
    const latest = existing[0];
    if (latest) {
      const lastTree = await runGit(["rev-parse", `${latest.commit}^{tree}`], projectPath);
      const sameBytes = lastTree.code === 0 && lastTree.stdout === tree;
      if (sameBytes && kind !== "after" && latest.kind !== "after") return null;
    }

    // Parent = HEAD when there is one, so `git diff HEAD <checkpoint>` reads
    // naturally. On an unborn branch there is no parent and that is fine.
    const head = await runGit(["rev-parse", "HEAD"], projectPath);
    const parentArgs = head.code === 0 && head.stdout ? ["-p", head.stdout] : [];

    const createdAt = new Date().toISOString();
    const message =
      `topics-checkpoint: ${label}\n\n` +
      `Topics-Session: ${sessionKey}\n` +
      `Topics-Time: ${createdAt}\n` +
      `Topics-Kind: ${kind}\n`;
    const commit = await gitOrThrow(
      ["commit-tree", tree, ...parentArgs, "-m", message],
      projectPath,
      { ...CHECKPOINT_IDENTITY, GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt },
    );

    const seq = (latest?.seq ?? -1) + 1;
    const ref = `${sessionRefPrefix(sessionKey)}/${seqToRefLeaf(seq)}`;
    await gitOrThrow(["update-ref", ref, commit], projectPath);

    await pruneTurnCheckpoints(projectPath, sessionKey, keep);
    return { ref, commit, seq, label, createdAt, kind };
  });
}

/**
 * Drop everything past the newest `keep` RESTORE POINTS, which is
 * `KEEP_PER_SESSION` unless a caller says otherwise.
 *
 * Restore points, not refs: a turn now writes two refs, and counting refs
 * would have halved how far back the net reaches the day the end-of-turn mark
 * arrived. Everything younger than the oldest kept restore point stays, marks
 * included, because a restore point without the mark that closes its turn is
 * a point nobody can rewind to.
 */
export async function pruneTurnCheckpoints(
  projectPath: string, sessionKey: string, keep: number = KEEP_PER_SESSION,
): Promise<number> {
  const all = await listTurnCheckpoints(projectPath, sessionKey);
  const kept = all.filter((c) => c.kind !== "after").slice(0, keep);
  // No restore point at all means nothing to anchor the window on, so nothing
  // is dropped: deleting the marks would leave a session with no history and
  // no way to have got one.
  const floor = kept.length > 0 ? kept[kept.length - 1].seq : -Infinity;
  const doomed = all.filter((c) => c.seq < floor);
  for (const c of doomed) await runGit(["update-ref", "-d", c.ref, c.commit], projectPath);
  return doomed.length;
}

/** Delete a session's whole namespace. Called when the session is closed: the
 *  net has no reason to outlive the conversation it was protecting. */
export async function dropTurnCheckpoints(projectPath: string, sessionKey: string): Promise<number> {
  const all = await listTurnCheckpoints(projectPath, sessionKey);
  for (const c of all) await runGit(["update-ref", "-d", c.ref, c.commit], projectPath);
  return all.length;
}
