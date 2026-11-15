/**
 * The delivery branch of a card that ran on a NODE, planted in THIS checkout
 * (KANBAN-76).
 *
 * The node hands back a git bundle over the already authenticated channel: no
 * push, no shared remote, nothing on `origin`. Here it becomes an ordinary
 * local branch, and from that moment on the landing is the local one, unchanged.
 *
 * THE BASE COMMIT IS A PRECONDITION, NOT A FALLBACK. The node builds the bundle
 * with `--not <baseSha>`, so it carries only the commits past the fork point:
 * without that commit here, `git fetch` fails on a missing prerequisite. The
 * tempting repair is to ask for a full-history bundle, and it is the wrong one:
 * it downloads a whole repository over a device channel to hide a checkout that
 * is simply behind. So the base is CHECKED first (`git cat-file -e`) and its
 * absence is written on the card as a reason a person can act on, after ONE
 * bounded `git fetch origin` that covers the common case (this clone is behind).
 *
 * Git lives here and not in the dispatcher on purpose: the dispatcher only
 * calls `deps.node.plantBranch`, which keeps every subprocess out of the lane
 * that decides a card's fate.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit, type GitRunner } from "./own-commits";

export interface PlantBranchInput {
  /** The board project the card belongs to: it resolves to the local checkout. */
  projectId: string;
  branch: string;
  /** Where the node forked from. `null` = the node could not say, nothing is planted. */
  baseSha: string | null;
  /** `null` = the node had nothing to send (no commits): the branch is planted on the base. */
  bundle: Uint8Array | null;
}

export interface PlantBranchResult {
  planted: boolean;
  /** The tip the branch points at once planted, when git could name it. */
  commit: string | null;
  /**
   * How many commits the planted branch carries above `baseSha` — the fork
   * point on the default branch, not this run's own commits. A run that adds
   * nothing to a branch already ahead of its base is still a real delivery:
   * `0` here, and only here, is what makes the run an empty one.
   */
  commitCount: number;
  /** Why nothing was planted, in words meant for the card. `null` when it was. */
  reason: string | null;
}

export interface NodeBranchPlantDeps {
  /** The local checkout of a board project, or `null` when it has none. */
  repoPathOf: (projectId: string) => string | null;
  /** Injectable git, so the tests answer without a repository. */
  runGit?: GitRunner;
  /** Where the bundle bytes land before `git fetch` reads them. */
  writeBundle?: (bytes: Uint8Array) => Promise<{ file: string; cleanup: () => Promise<void> }>;
}

/** A ref that starts with "-" would be read by git as an option, on our own subprocess. */
function refIsSafe(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** A sha we are about to hand to `cat-file`: hex only, nothing that can be a flag. */
function shaIsSafe(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(sha);
}

/** `origin/main`, or whatever `origin/HEAD` actually points at — same fallback as `delivery-facts.ts`. */
async function originDefaultBranchRef(repo: string, runGit: GitRunner): Promise<string> {
  const head = await runGit(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const remoteHead = head.stdout.trim();
  if (head.code === 0 && remoteHead) return remoteHead;
  for (const candidate of ["origin/main", "origin/master"]) {
    const r = await runGit(repo, ["rev-parse", "--verify", "-q", `refs/remotes/${candidate}`]);
    if (r.code === 0) return candidate;
  }
  return "origin/main";
}

/**
 * `sha` carries nothing of the card's own: either it is the board's own
 * realign merge (`task-automerge.ts`'s "Riporta <main> nel ramo prima del land" allow-italian: quoting the literal commit message the board writes
 * — a merge whose non-first parents are already on the default branch,
 * so its only content is what the branch already shared with it), or the
 * commit itself already sits on the default branch under another name. A
 * commit that is neither is the card's own work, and the delivery is refused.
 */
async function isBoardRealignOnly(repo: string, runGit: GitRunner, sha: string, mainRef: string): Promise<boolean> {
  const parents = (await runGit(repo, ["rev-list", "--parents", "-n", "1", sha])).stdout.trim().split(/\s+/);
  const mergedParents = parents.slice(2); // [0] is `sha` itself, [1] is the first parent.
  if (mergedParents.length > 0) {
    const checks = await Promise.all(
      mergedParents.map((p) => runGit(repo, ["merge-base", "--is-ancestor", p, mainRef])),
    );
    if (checks.every((r) => r.code === 0)) return true;
  }
  return (await runGit(repo, ["merge-base", "--is-ancestor", sha, mainRef])).code === 0;
}

/**
 * The path of the worktree that has `branch` checked out, when this is a
 * linked worktree checkout (KANBAN-76 follow-up): the checks worktree for
 * this same card (`topics-node-checks/<id>`) keeps the card's own branch
 * checked out, and moving the ref under that checkout's feet would desync it.
 */
async function worktreeCheckingOutBranch(repo: string, runGit: GitRunner, branch: string): Promise<string | null> {
  const list = await runGit(repo, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return null;
  let currentPath: string | null = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      if (line.slice("branch ".length).trim() === `refs/heads/${branch}`) return currentPath;
      currentPath = null;
    }
  }
  return null;
}

async function defaultWriteBundle(bytes: Uint8Array): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "topics-node-bundle-"));
  const file = join(dir, `${randomBytes(6).toString("hex")}.bundle`);
  await writeFile(file, bytes);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface NodeBranchPlanter {
  plantBranch(input: PlantBranchInput): Promise<PlantBranchResult>;
  /** The git remote the node matches its own project by. `null` = no origin here. */
  originUrlOf(projectId: string): Promise<string | null>;
}

export function createNodeBranchPlanter(deps: NodeBranchPlantDeps): NodeBranchPlanter {
  const runGit = deps.runGit ?? defaultRunGit;
  const writeBundle = deps.writeBundle ?? defaultWriteBundle;

  return {
    async originUrlOf(projectId) {
      const repo = deps.repoPathOf(projectId);
      if (!repo) return null;
      const r = await runGit(repo, ["remote", "get-url", "origin"]);
      const url = r.stdout.trim();
      return r.code === 0 && url ? url : null;
    },

    async plantBranch({ projectId, branch, baseSha, bundle }) {
      const repo = deps.repoPathOf(projectId);
      if (!repo) return { planted: false, commit: null, commitCount: 0, reason: "questo progetto non ha un checkout su questa macchina" };
      if (!refIsSafe(branch)) return { planted: false, commit: null, commitCount: 0, reason: `il nome del ramo «${branch}» non è utilizzabile` };
      if (!baseSha || !shaIsSafe(baseSha)) {
        return { planted: false, commit: null, commitCount: 0, reason: "il nodo non ha dichiarato il commit di base della consegna" };
      }
      // How much the planted branch carries above `baseSha`, regardless of
      // whether THIS call's bundle added anything: a branch already ahead of
      // its base from an earlier delivery is not an empty one.
      const commitsAboveBase = async (tip: string): Promise<number> => {
        const r = await runGit(repo, ["rev-list", "--count", `${baseSha}..${tip}`]);
        return r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) || 0 : 0;
      };
      // The precondition, checked BEFORE the fetch: see the header. `^{commit}`
      // so a sha that exists as another object type is not read as a commit.
      const hasBase = async () => (await runGit(repo, ["cat-file", "-e", `${baseSha}^{commit}`])).code === 0;
      let known = await hasBase();
      if (!known) {
        // The node forks from the `origin/main` IT fetched, which for a public
        // repo can be newer than this checkout's last fetch: the base is then
        // missing here only because this clone is behind. ONE bounded fetch of
        // origin (never a prompt, never a full-history bundle from the node),
        // then the check is asked again.
        await runGit(repo, ["fetch", "--no-tags", "origin"], { env: { GIT_TERMINAL_PROMPT: "0" } });
        known = await hasBase();
      }
      if (!known) {
        return {
          planted: false,
          commit: null,
          commitCount: 0,
          reason:
            `il commit di base ${baseSha.slice(0, 8)} non è in questo checkout, nemmeno dopo un fetch di origin: ` +
            "il bundle del nodo contiene solo il lavoro dopo quel punto, quindi non si applica. " +
            "Allinea questo repo (fetch del ramo di base) e riprova.",
        };
      }
      if (!bundle || bundle.length === 0) {
        // Nothing to deliver THIS call: the branch exists so the card has an
        // address. When it already exists (a previous delivery planted it),
        // `git branch` refuses to move it, which is the safe answer — and its
        // tip may already carry commits above base from that earlier delivery.
        const made = await runGit(repo, ["branch", branch, baseSha]);
        if (made.code !== 0) {
          const tip = await runGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
          if (tip.code !== 0) return { planted: false, commit: null, commitCount: 0, reason: `git branch: ${made.stderr ?? ""}`.trim() };
          const resolved = tip.stdout.trim() || null;
          return { planted: true, commit: resolved, commitCount: resolved ? await commitsAboveBase(resolved) : 0, reason: null };
        }
        return { planted: true, commit: baseSha, commitCount: 0, reason: null };
      }
      const { file, cleanup } = await writeBundle(bundle);
      try {
        const verified = await runGit(repo, ["bundle", "verify", file]);
        if (verified.code !== 0) {
          return { planted: false, commit: null, commitCount: 0, reason: `il bundle del nodo non è valido: ${(verified.stderr ?? "").trim()}` };
        }
        // No `+`: a fetch that is not a fast-forward is REFUSED instead of
        // rewriting a branch of the same name that already carries work here.
        const fetched = await runGit(repo, ["fetch", file, `${branch}:refs/heads/${branch}`]);
        if (fetched.code !== 0) {
          const baseReason = `git fetch dal bundle è fallito: ${(fetched.stderr ?? "").trim()}`;
          // The branch restarted on the node from its OWN bundle base, without
          // the realign merge the board had put on the local branch before the
          // previous round (KANBAN-76 follow-up). Non-fast-forward is still the
          // right refusal when the local branch carries anything else: only a
          // local branch whose own-extra commits are ALL board realign merges
          // (or already on the default branch) is safe to fast-forward past.
          const localTip = (await runGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).stdout.trim();
          if (!localTip) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
          // The bundle's own tip, read from the bundle header: never FETCH_HEAD,
          // which is one slot per checkout and can be overwritten by a second
          // delivery (another card, another node) landing on this same repo at
          // the same time (review of the first round of this card).
          const headsOut = await runGit(repo, ["bundle", "list-heads", file, `refs/heads/${branch}`]);
          const newTip = (headsOut.stdout.trim().split("\n")[0] ?? "").split(/\s+/)[0] ?? "";
          if (headsOut.code !== 0 || !newTip) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
          // Pull the objects onto a ref of our own, never FETCH_HEAD, for the
          // same reason as above.
          const tempRef = `refs/topics/incoming/${randomBytes(6).toString("hex")}`;
          try {
            const tempFetch = await runGit(repo, ["fetch", file, `${branch}:${tempRef}`]);
            if (tempFetch.code !== 0) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
            const extrasOut = await runGit(repo, ["rev-list", `${newTip}..${localTip}`]);
            const extras = extrasOut.code === 0 ? extrasOut.stdout.trim().split("\n").filter(Boolean) : null;
            if (extras === null) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
            const mainRef = await originDefaultBranchRef(repo, runGit);
            for (const extra of extras) {
              if (await isBoardRealignOnly(repo, runGit, extra, mainRef)) continue;
              const subject = (await runGit(repo, ["log", "-1", "--format=%s", extra])).stdout.trim();
              return {
                planted: false, commit: null, commitCount: 0,
                reason: `${baseReason} (il ramo locale ha un commit che non è una fusione di riallineamento: ${extra.slice(0, 8)} «${subject}»)`,
              };
            }
            // Every local-only commit was only a realign of the board, or already
            // on the default branch: moving the branch onto the bundle's tip loses
            // nothing of the card's own. But the branch may be checked out in a
            // linked worktree (the checks worktree for this same card): moving
            // the ref under that checkout's feet would desync it, so a clean one
            // is detached first and a dirty one is refused instead.
            const worktreePath = await worktreeCheckingOutBranch(repo, runGit, branch);
            if (worktreePath) {
              const dirty = (await runGit(worktreePath, ["status", "--porcelain"])).stdout.trim().length > 0;
              if (dirty) {
                return {
                  planted: false, commit: null, commitCount: 0,
                  reason: `${baseReason} (il ramo è checked out in un worktree sporco: ${worktreePath})`,
                };
              }
              const detached = await runGit(worktreePath, ["switch", "--detach", "-q"]);
              if (detached.code !== 0) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
            }
            const moved = await runGit(repo, ["update-ref", `refs/heads/${branch}`, newTip]);
            if (moved.code !== 0) return { planted: false, commit: null, commitCount: 0, reason: baseReason };
            return { planted: true, commit: newTip, commitCount: await commitsAboveBase(newTip), reason: null };
          } finally {
            await runGit(repo, ["update-ref", "-d", tempRef]);
          }
        }
        const tip = await runGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
        const resolved = tip.code === 0 ? tip.stdout.trim() || null : null;
        return { planted: true, commit: resolved, commitCount: resolved ? await commitsAboveBase(resolved) : 0, reason: null };
      } finally {
        await cleanup().catch(() => { /* a temp dir left behind must not fail a delivery */ });
      }
    },
  };
}
