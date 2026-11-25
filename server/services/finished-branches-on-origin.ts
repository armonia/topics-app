/**
 * A FINISHED CARD'S BRANCH LEAVES ORIGIN, whatever door the card left by.
 *
 * WHY IT EXISTS. A card's branch reaches origin in two ways: the node lane
 * pushes it before a run elsewhere (`branch-on-origin.ts`) and the CI phase
 * pushes the measured commit for its draft pull request (`ci-evidence.ts`).
 * The land pruned only the LOCAL branch. Its remote half (`closeCiDraft` via
 * `sweepRemoteDelivery`) is one shot at the door, and it misses for good: it
 * keeps the branch while origin/main does not carry it yet (29 of the 38
 * cleanup lines in the prod log), dies on a hook that ran past 60 s, or finds no
 * `origin` in the worktree it was given. Nobody ever came back. Measured on
 * 22/11/2026: 941 branches on the public origin of topics-app, 9 open pull
 * requests, 346 branches already inside main.
 *
 * So this is a CONVERGENT sweep, not one more door: on every landing-audit pass
 * it reads origin, asks the board which cards each branch belongs to, and
 * removes the branches whose cards are ALL finished (done or archived). A
 * failed delete is simply tried again next pass.
 *
 * WHAT IS KEPT FOREVER, before anything is deleted:
 *  - a tip already inside origin's default branch needs nothing: main holds it;
 *  - any other tip is pinned first under the local tag `archive/<branch>`, the
 *    convention of `check-repo-pulito.ts` ("nothing is deleted outright, it is
 *    archived as an `archive/...` tag"). The tag is local on purpose: the repo
 *    is public, and a tag pushed per finished card would rebuild the same pile
 *    under another name. `git branch <name> archive/<name>` brings one back.
 *
 * WHAT IT NEVER TOUCHES: a branch no card of the board knows (it is someone's
 * work, not the board's), a branch shared with a card still open, the default
 * branch. And the delete carries a lease on the tip it inspected: a branch that
 * moved since the read is left for the next pass.
 */
import { SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import type { GitRunner } from "./own-commits";

/** What the board says about a branch: `null` = no card knows it. */
export type BranchLife = "open" | "finished" | null;

export interface FinishedBranchSweep {
  /** Branches removed from origin. */
  deleted: string[];
  /** Tips pinned under a local tag before their branch was removed: branch -> tag. */
  archived: Record<string, string>;
  /** Why some candidate stayed; the next pass retries it. */
  problems: string[];
}

/** Bounded git without prompts; the push gets the write budget, a batch of deletes is one push. */
export const sweepGit: GitRunner = (cwd, args) =>
  runGit(cwd, args, {
    timeoutMs: args[0] === "push" || args[0] === "fetch" ? SPAWN_TIMEOUT.write : SPAWN_TIMEOUT.query,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });

/** Deletes per push: one push per batch keeps the argv short and a refusal local. */
const DELETE_BATCH = 100;

/** The local tag that keeps a remote branch's tip: `topics/foo` -> `archive/topics-foo`. */
export function archiveTagFor(branch: string): string {
  return `archive/${branch.replaceAll("/", "-")}`;
}

/**
 * The heads of origin and its default branch, in one `ls-remote`. `null` when
 * origin cannot be read: then nothing is accountable and nothing is touched.
 */
export async function readOrigin(
  repoPath: string,
  run: GitRunner = sweepGit,
): Promise<{ defaultBranch: string; heads: Map<string, string> } | null> {
  const r = await run(repoPath, ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/*"]);
  if (r.code !== 0) return null;
  let defaultBranch = "";
  const heads = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const headRef = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (headRef) { defaultBranch = headRef[1]; continue; }
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
  }
  if (!defaultBranch || !heads.has(defaultBranch)) return null;
  return { defaultBranch, heads };
}

async function has(repoPath: string, sha: string, run: GitRunner): Promise<boolean> {
  return (await run(repoPath, ["cat-file", "-e", `${sha}^{commit}`])).code === 0;
}

async function resolves(repoPath: string, ref: string, run: GitRunner): Promise<string | null> {
  const r = await run(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Pins `sha` under `archive/<branch>` (or `archive/<branch>-<sha8>` when that
 * name already keeps another commit). Returns the tag only once it reads back
 * as that very commit. A tip this clone never saw is fetched straight into the
 * tag: a branch pushed from a node or a cloud session exists only on origin.
 */
async function archiveTip(repoPath: string, branch: string, sha: string, run: GitRunner): Promise<string | null> {
  const base = archiveTagFor(branch);
  for (const tag of [base, `${base}-${sha.slice(0, 8)}`]) {
    const current = await resolves(repoPath, `refs/tags/${tag}`, run);
    if (current === sha) return tag;
    if (current) continue;
    const made = (await has(repoPath, sha, run))
      ? await run(repoPath, ["update-ref", `refs/tags/${tag}`, sha, ""])
      : await run(repoPath, ["fetch", "--no-tags", "-q", "origin", `refs/heads/${branch}:refs/tags/${tag}`]);
    if (made.code !== 0) return null;
    // A fetch takes origin's tip as it is NOW: if the branch moved since the
    // read, the tag holds the newer commit and the lease below keeps the branch.
    return (await resolves(repoPath, `refs/tags/${tag}`, run)) ? tag : null;
  }
  return null;
}

/**
 * One pass over one repository. `readLives` answers for the cards of the
 * boards that use this repository; it is the only source of «finished», and it
 * is asked AGAIN right before each delete: a card reopened while the pass was
 * archiving and fetching (a pass can walk hundreds of branches) keeps its branch.
 */
export async function sweepFinishedBranchesOnOrigin(
  repoPath: string,
  readLives: () => (branch: string) => BranchLife,
  run: GitRunner = sweepGit,
): Promise<FinishedBranchSweep | null> {
  const lifeOf = readLives();
  const origin = await readOrigin(repoPath, run);
  if (!origin) return null;
  const out: FinishedBranchSweep = { deleted: [], archived: {}, problems: [] };
  const defaultTip = origin.heads.get(origin.defaultBranch)!;
  // Ancestry is asked locally, so origin's default tip must be here: one plain
  // fetch of that branch (never `--depth`, which would make the clone shallow).
  if (!(await has(repoPath, defaultTip, run))) {
    await run(repoPath, ["fetch", "--no-tags", "-q", "origin", `refs/heads/${origin.defaultBranch}`]);
    if (!(await has(repoPath, defaultTip, run))) {
      out.problems.push(`origin/${origin.defaultBranch} (${defaultTip.slice(0, 8)}) is not in this clone: nothing to compare against`);
      return out;
    }
  }
  const leases: Array<[string, string]> = [];
  for (const [branch, sha] of origin.heads) {
    if (branch === origin.defaultBranch || lifeOf(branch) !== "finished") continue;
    const inDefault = (await has(repoPath, sha, run))
      && (await run(repoPath, ["merge-base", "--is-ancestor", sha, defaultTip])).code === 0;
    if (!inDefault) {
      const tag = await archiveTip(repoPath, branch, sha, run);
      if (!tag) { out.problems.push(`${branch}: tip ${sha.slice(0, 8)} could not be archived, branch kept`); continue; }
      out.archived[branch] = tag;
    }
    leases.push([branch, sha]);
  }
  for (let i = 0; i < leases.length; i += DELETE_BATCH) {
    const now = readLives();
    const batch = leases.slice(i, i + DELETE_BATCH).filter(([b]) => {
      if (now(b) === "finished") return true;
      out.problems.push(`${b}: its card reopened during the pass, branch kept`);
      return false;
    });
    if (!batch.length) continue;
    // --no-verify: a deletion publishes no object, and the pre-push hooks only
    // inspect objects. On this Mac they made a delete exit 1 once and run past
    // the 60 s cap twice, and each of those kept a finished branch on origin.
    const push = await run(repoPath, [
      "push", "--porcelain", "--no-verify",
      ...batch.map(([b, sha]) => `--force-with-lease=refs/heads/${b}:${sha}`),
      "origin", ...batch.map(([b]) => `:refs/heads/${b}`),
    ]);
    const gone = new Set<string>();
    for (const line of push.stdout.split("\n")) {
      const m = /^-\t:refs\/heads\/(\S+)\t\[deleted\]/.exec(line);
      if (m) gone.add(m[1]);
    }
    for (const [b] of batch) {
      if (gone.has(b)) out.deleted.push(b);
      else out.problems.push(`${b}: delete refused (${(push.stderr || push.stdout).trim().split("\n").at(-1)?.slice(0, 120) ?? `exit ${push.code}`})`);
    }
  }
  return out;
}

/**
 * The board's answer for every branch a card ever owned in one project:
 * `finished` only when EVERY card that names the branch is done or archived.
 * A branch shared with a card still open stays: the next run of that card may
 * start from it (`ensureBranchOnOrigin` finds it on origin when the local copy
 * was pruned).
 */
export function branchLives(
  rows: Iterable<{ finished: boolean; branches: Array<string | null | undefined> }>,
): (branch: string) => BranchLife {
  const life = new Map<string, "open" | "finished">();
  for (const row of rows) {
    for (const raw of row.branches) {
      for (const b of (raw ?? "").split(/\s+/)) {
        if (!b) continue;
        if (!row.finished) life.set(b, "open");
        else if (!life.has(b)) life.set(b, "finished");
      }
    }
  }
  return (branch) => life.get(branch) ?? null;
}

/**
 * `branchLives` over the board's database: every branch a card delivered on,
 * restarted from, started from, left behind or tried in an attempt. From EVERY
 * board, not one repository's: a card of one board can run in another board's
 * repo.
 *
 * Never finished:
 *  - a land still `unpushed`: deleting its branch before main reaches origin
 *    would make GitHub close its pull request instead of marking it merged;
 *  - a run for ANOTHER machine's card (a node's mirror: `node-run:` key, or a
 *    `base_branch`, which only mirrors carry and which an archived mirror keeps
 *    after giving its key back). Nodes boot this same sweep on their own
 *    database, and there the mirror of round 1 is archived while the card it
 *    mirrors is still open on the machine that owns it, which restarts the next
 *    round from that very branch. The owner's own pass deletes it, when its card
 *    is closed.
 */
export function readBranchLives(db: { prepare(sql: string): { all(): unknown[] } }): (branch: string) => BranchLife {
  const finished = (t: string) =>
    `((${t}archived = 1 OR ${t}status = 'done')
      AND COALESCE(${t}landing_state, '') <> 'unpushed'
      AND COALESCE(${t}claude_task_id, '') NOT LIKE 'node-run:%'
      AND COALESCE(${t}base_branch, '') = '')`;
  const rows = db.prepare(
    `SELECT ${finished("")} AS finished, delivery_branch AS b1, prior_branch AS b2, past_delivery_branches AS b3, base_branch AS b4
       FROM tasks
     UNION ALL
     SELECT ${finished("t.")}, a.branch, NULL, NULL, NULL
       FROM task_attempts a JOIN tasks t ON t.id = a.task_id
      WHERE a.branch IS NOT NULL`,
  ).all() as Array<{ finished: number; b1: string | null; b2: string | null; b3: string | null; b4: string | null }>;
  return branchLives(rows.map((r) => ({ finished: Number(r.finished) === 1, branches: [r.b1, r.b2, r.b3, r.b4] })));
}
