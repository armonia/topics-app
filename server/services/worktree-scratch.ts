/**
 * THE THROWAWAY CHECKOUTS, in the worktree root (change worktree-standard, T2).
 *
 * Landing, realigning a branch, measuring an integration batch and measuring a
 * node delivery each need a checkout that nobody keeps. They used to live in
 * `$TMPDIR`, which meant two places to look for disk (the root and the temp
 * area), a sweep per kind, and the OS temp cleaner deleting a checkout from
 * under git. Now they all live at
 *
 *   {worktree root}/_scratch/{land|realign|integrazione|node-checks}/{id}
 *
 * so the root is the one place to measure and one boot sweep covers all of them.
 * `_` is not a valid project slug, so `_scratch` can never collide with a project.
 */
import { readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ASIDE_MARK, discardWorktree, worktreeRepoOf, type DiscardDeps, type DiscardGit } from "../lib/worktree-discard";
import { worktreeRootDir } from "./worktree-manager";
import { topicsHome } from "./daemon-state";

/** Folder under the worktree root that holds every throwaway checkout. */
export const SCRATCH_FOLDER = "_scratch";

export const SCRATCH_KINDS = ["land", "realign", "integrazione", "node-checks"] as const;
export type ScratchKind = (typeof SCRATCH_KINDS)[number];

/** The folder one kind of throwaway checkout is made in. `root` defaults to the live worktree root. */
export function scratchDir(kind: ScratchKind, root: string = worktreeRootDir()): string {
  return join(root, SCRATCH_FOLDER, kind);
}

/** Make the folder of a kind (and its parents) and hand it back, for callers that create a checkout inside it. */
export function ensureScratchDir(kind: ScratchKind, root?: string): string {
  const dir = scratchDir(kind, root);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A stable short name for a checkout that is reused by what it is for (a repo, a repo and a branch). */
export function scratchId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Discard every checkout a previous process left under the kinds that have no
 * lease of their own (land, realign, integrazione). Called once at boot, when
 * nothing of THIS process is in flight: what is there was cut by a restart or a
 * kill, and nothing else would ever remove it. `node-checks` is swept by its own
 * pool (`createNodeCheckWorktrees`), which knows its leases.
 */
export async function sweepScratch(
  git: DiscardGit,
  root: string = worktreeRootDir(),
  kinds: readonly ScratchKind[] = ["land", "realign", "integrazione"],
  deps?: DiscardDeps,
): Promise<string[]> {
  const gone: string[] = [];
  for (const kind of kinds) {
    const dir = scratchDir(kind, root);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    // A copy a cut discard moved aside belongs to its checkout's folder: discarding that folder deletes it too.
    for (const entry of new Set(names.map((n) => n.split(ASIDE_MARK)[0]!))) {
      const path = join(dir, entry);
      const repo = [entry, ...names.filter((n) => n.startsWith(entry + ASIDE_MARK))]
        .map((n) => worktreeRepoOf(join(dir, n)))
        .find((r): r is string => r !== null) ?? null;
      await discardWorktree(git, repo, path, deps);
      gone.push(path);
    }
  }
  return gone;
}

/**
 * Where node-delivery checkouts lived before T2, in `$TMPDIR`: the production
 * home kept `topics-node-checks`, any other home a suffix of its own. Only so
 * that the first boot after the move can sweep what the old layout left (on
 * 23/11 that was 23 leftovers and 8.67 GiB). Nothing is created here any more.
 */
export function legacyNodeCheckRoot(home: string = topicsHome(), tmp: string = tmpdir(), defaultHome: string = topicsHome({})): string {
  const base = join(tmp, "topics-node-checks");
  if (resolve(home) === resolve(defaultHome)) return base;
  return `${base}-${createHash("sha1").update(resolve(home)).digest("hex").slice(0, 8)}`;
}
