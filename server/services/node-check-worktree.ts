/**
 * The throwaway checkout a node delivery is measured on (`node-delivery-meter.ts`).
 *
 * Its release runs in the meter's `finally`, which a shutdown reaches right
 * before `process.exit` reaps every git group still alive: the release must
 * survive being cut at any point, which is why it goes through
 * `discardWorktree` and never through a bare `git worktree remove`.
 *
 * NO CHECKOUT OUTLIVES THE SERVER THAT OPENED IT. Surviving the cut is not
 * enough, because the release is the only thing that ever removed a checkout
 * and a dying process does not finish it. A measure lasts as long as the pull
 * request CI (up to an hour), while the production server restarted 49 times
 * from 21/11 22:56 to 23/11 14:34 (median gap 23 minutes): about one node
 * measure in three was cut (19 interruptions against 41 verdicts). On a restart
 * `process.exit` cuts the release (until 23/11 the whole `git worktree remove`,
 * now the prune and the delete of the copy moved aside), and a process that is
 * killed never gets there at all. The next release of the same card would sweep
 * the leftover, but a card that lands is never measured again: on 23/11 the
 * folder held 23 leftovers from 16/11 on, 8.67 GiB, and the Mac's backup
 * stopped for lack of disk. So what a previous process left is discarded when
 * the server starts (`sweep`), which needs nothing from the process that died.
 *
 * ONE ROOT PER TOPICS HOME. The checkouts live in `{worktree root}/_scratch/node-checks`
 * (they lived in $TMPDIR until worktree-standard T2), and the worktree root derives
 * from the server's Topics home: an e2e server (a TOPICS_HOME of its own) never
 * shares it with production, so its boot sweep cannot discard the checkouts
 * production is measuring on. The daemon lock is per home, so a root has one live
 * server, and its sweep only has to spare the leases of its own process.
 */
import { readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ASIDE_MARK, discardWorktree, worktreeRepoOf, type DiscardDeps, type DiscardGit } from "../lib/worktree-discard";
import { installWorktreeDeps } from "../lib/worktree-install-deps";
import { scratchDir } from "./worktree-scratch";
import type { NodeDeliveryCheckout } from "./node-delivery-meter";

export interface NodeCheckWorktreeInput {
  git: DiscardGit;
  repoPath: string;
  /**
   * The delivered commit to measure, NOT the branch tip. A checkout attached
   * to the branch moves with it: if a land or a new delivery advances the
   * branch while the measure is running, HEAD jumps to the new commit but the
   * working tree is still the old one, and the verdict lands on the wrong
   * sha. Detaching HEAD on this commit pins the checkout to exactly what is
   * being measured, however the branch moves meanwhile.
   */
  commit: string;
  /**
   * The planted branch, when the caller knows its name. A fallback only: the
   * detach above always targets `commit` first. It exists for the case the
   * commit itself is not resolvable on this checkout yet (90cd0fcd, 2026-11-25:
   * the branch `topics/splendid-hummingbird` was there, the commit the card
   * carried was not, and the meter gave up for 15 hours instead of using what
   * the branch actually had).
   */
  branch?: string | null;
  /** Folder holding one checkout per run (`nodeCheckRoot()`). */
  root: string;
  taskId: string;
  resolveHead: (cwd: string) => Promise<string | null>;
  discard?: DiscardDeps;
  /** The run's own id (injectable for tests); a fresh one is drawn when omitted. */
  runId?: string;
}

/**
 * The folder this server keeps its checkouts in: `{worktree root}/_scratch/node-checks`.
 * The worktree root derives from the server's own Topics home, so two servers
 * with different homes (production, an e2e server) never share it, and no sweep
 * of one can reach the checkouts of the other.
 */
export function nodeCheckRoot(root?: string): string {
  return scratchDir("node-checks", root);
}

/**
 * One folder per RUN, not per card: the card id is only a human-readable
 * prefix. Two overlapping runs of the same card (a retry, a second check
 * queued behind the first) get different paths, so neither one's pre-add
 * discard can delete the folder the other is still working in.
 */
function checkPath(root: string, taskId: string, runId: string): string {
  return join(root, `${taskId.slice(0, 8)}-${runId}`);
}

export async function openNodeCheckWorktree(input: NodeCheckWorktreeInput): Promise<NodeDeliveryCheckout | null> {
  const { git, repoPath, commit } = input;
  const runId = input.runId ?? randomBytes(4).toString("hex");
  const path = checkPath(input.root, input.taskId, runId);
  await discardWorktree(git, repoPath, path, input.discard);
  // `--detach` on the delivered COMMIT, never on the branch: a branch ref can
  // already be checked out elsewhere (the project's own checkout, or a
  // worktree a cut release never got to discard), which git refuses as
  // "already used by worktree at …" (90cd0fcd, 2026-11-25: "no checkout to
  // measure on", repeated for 15 hours while the branch sat there, planted
  // and unread) — detaching on the commit never claims the branch, so it
  // never hits that refusal, and it also pins the checkout to exactly the
  // commit being measured even if the branch moves on meanwhile. A detach
  // never needs `--force` either, for the same reason.
  let added = await git(repoPath, ["worktree", "add", "--detach", path, commit]);
  // The commit itself can be unresolvable here (a stale `deliveryCommit`, or
  // an object store view that has not caught up with the plant yet) while the
  // branch the node planted is right there: retry on the branch tip instead
  // of giving up on a checkout the branch can still provide.
  if (added.code !== 0 && input.branch) {
    await discardWorktree(git, repoPath, path, input.discard);
    added = await git(repoPath, ["worktree", "add", "--detach", path, input.branch]);
  }
  if (added.code !== 0) {
    // An add that fails or hits its deadline half-way leaves its partial tree
    // (and, killed by SIGKILL, a locked registration): it goes now, not at the
    // next restart.
    await discardWorktree(git, repoPath, path, input.discard);
    return null;
  }
  // A LOCAL CHECK (typecheck, lint, unit tests) needs `node_modules`, which
  // `git worktree add` never materialises (shared with the agent worktrees,
  // `worktree-manager.ts`). Best-effort: a failed install must not stop the
  // measure, the gate the install was for goes red on its own instead.
  await installWorktreeDeps(path).catch((err) => console.warn(`[node-check-worktree] deps not installed in ${path}:`, err));
  return {
    cwd: path,
    head: () => input.resolveHead(path),
    // Moves the SAME detached worktree onto another commit of this same repo:
    // no new `worktree add`, no dependency reinstall. Used right after a
    // pre-review realign advances the real branch in a DIFFERENT worktree (see
    // `task-automerge.ts`'s `realign()`), so the check measures what just
    // landed there instead of the commit this checkout was opened on.
    reattach: async (commit) => (await git(path, ["checkout", "--detach", commit])).code === 0,
    release: () => discardWorktree(git, repoPath, path, input.discard),
  };
}

export interface NodeCheckWorktrees {
  open(input: { repoPath: string; commit: string; branch?: string | null; taskId: string }): Promise<NodeDeliveryCheckout | null>;
  /** Discard every checkout of the root this process does not hold. Returns the card folders it discarded. */
  sweep(): Promise<string[]>;
}

/** The checkouts of one server: it opens them and knows which are leased, so its boot sweep spares them. */
export function createNodeCheckWorktrees(deps: Omit<NodeCheckWorktreeInput, "repoPath" | "commit" | "taskId" | "runId">): NodeCheckWorktrees {
  // A path is unique per call (its own run id), so two opens of the same card
  // never share a key here: one's release can never drop the other's entry.
  const leased = new Set<string>();
  let sweeping: Promise<unknown> = Promise.resolve();

  async function open(input: { repoPath: string; commit: string; branch?: string | null; taskId: string }): Promise<NodeDeliveryCheckout | null> {
    // Its own run id, drawn fresh on every call: never `deps.runId` (that one is
    // only for the bare `openNodeCheckWorktree` a test calls directly).
    const runId = randomBytes(4).toString("hex");
    const path = checkPath(deps.root, input.taskId, runId);
    // Marked before the first await: the sweep checks it in the same synchronous step as its rename.
    leased.add(path);
    // A sweep's `worktree prune` running beside this `worktree add` can make the
    // add fail (git drops the empty `.git/worktrees` under it): the add waits.
    await sweeping.catch(() => undefined);
    const lease = await openNodeCheckWorktree({ ...deps, ...input, runId }).catch(() => null);
    if (!lease) { leased.delete(path); return null; }
    return {
      ...lease,
      release: async () => {
        try { await lease.release(); } finally { leased.delete(path); }
      },
    };
  }

  function sweep(): Promise<string[]> {
    const run = sweepOnce();
    sweeping = run;
    return run;
  }

  async function sweepOnce(): Promise<string[]> {
    let names: string[];
    try { names = readdirSync(deps.root); } catch { return []; }
    const gone: string[] = [];
    // A copy a cut release moved aside belongs to its card's folder: the discard of that folder deletes it.
    for (const card of new Set(names.map((name) => name.split(ASIDE_MARK)[0]!))) {
      const path = join(deps.root, card);
      if (leased.has(path)) continue;
      // The registration is read from the folder, or from the copy a cut release moved aside.
      const repo = [card, ...names.filter((n) => n.startsWith(card + ASIDE_MARK))]
        .map((n) => worktreeRepoOf(join(deps.root, n)))
        .find((r): r is string => r !== null) ?? null;
      await discardWorktree(deps.git, repo, path, deps.discard);
      gone.push(path);
    }
    return gone;
  }

  return { open, sweep };
}
