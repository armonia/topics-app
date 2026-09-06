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
 * absence is written on the card as a reason a person can act on.
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
  return /^[A-Za-z0-9._\/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** A sha we are about to hand to `cat-file`: hex only, nothing that can be a flag. */
function shaIsSafe(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(sha);
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
      if (!repo) return { planted: false, commit: null, reason: "questo progetto non ha un checkout su questa macchina" };
      if (!refIsSafe(branch)) return { planted: false, commit: null, reason: `il nome del ramo «${branch}» non è utilizzabile` };
      if (!baseSha || !shaIsSafe(baseSha)) {
        return { planted: false, commit: null, reason: "il nodo non ha dichiarato il commit di base della consegna" };
      }
      // The precondition, checked BEFORE the fetch: see the header. `^{commit}`
      // so a sha that exists as another object type is not read as a commit.
      const known = await runGit(repo, ["cat-file", "-e", `${baseSha}^{commit}`]);
      if (known.code !== 0) {
        return {
          planted: false,
          commit: null,
          reason:
            `il commit di base ${baseSha.slice(0, 8)} non è in questo checkout: il bundle del nodo contiene solo ` +
            "il lavoro dopo quel punto, quindi non si applica. Allinea questo repo (fetch del ramo di base) e riprova.",
        };
      }
      if (!bundle || bundle.length === 0) {
        // Nothing to deliver: the branch exists so the card has an address, and
        // it points at the base. `git branch` refuses to move an existing one,
        // which is the safe answer: we never overwrite somebody's ref.
        const made = await runGit(repo, ["branch", branch, baseSha]);
        if (made.code !== 0) {
          const tip = await runGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
          if (tip.code !== 0) return { planted: false, commit: null, reason: `git branch: ${made.stderr ?? ""}`.trim() };
          return { planted: true, commit: tip.stdout.trim() || null, reason: null };
        }
        return { planted: true, commit: baseSha, reason: null };
      }
      const { file, cleanup } = await writeBundle(bundle);
      try {
        const verified = await runGit(repo, ["bundle", "verify", file]);
        if (verified.code !== 0) {
          return { planted: false, commit: null, reason: `il bundle del nodo non è valido: ${(verified.stderr ?? "").trim()}` };
        }
        // No `+`: a fetch that is not a fast-forward is REFUSED instead of
        // rewriting a branch of the same name that already carries work here.
        const fetched = await runGit(repo, ["fetch", file, `${branch}:refs/heads/${branch}`]);
        if (fetched.code !== 0) {
          return { planted: false, commit: null, reason: `git fetch dal bundle è fallito: ${(fetched.stderr ?? "").trim()}` };
        }
        const tip = await runGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
        return { planted: true, commit: tip.code === 0 ? tip.stdout.trim() || null : null, reason: null };
      } finally {
        await cleanup().catch(() => { /* a temp dir left behind must not fail a delivery */ });
      }
    },
  };
}
