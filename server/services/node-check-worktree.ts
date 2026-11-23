/**
 * The throwaway checkout a node delivery is measured on (`node-delivery-meter.ts`).
 *
 * Its release runs in the meter's `finally`, which a shutdown reaches right
 * before `process.exit` reaps every git group still alive: the release must
 * survive being cut at any point, which is why it goes through
 * `discardWorktree` and never through a bare `git worktree remove`.
 */
import { join } from "node:path";
import { discardWorktree, type DiscardDeps, type DiscardGit } from "../lib/worktree-discard";
import type { NodeDeliveryCheckout } from "./node-delivery-meter";

export interface NodeCheckWorktreeInput {
  git: DiscardGit;
  repoPath: string;
  branch: string;
  /** Folder holding one checkout per card (`<tmp>/topics-node-checks`). */
  root: string;
  taskId: string;
  resolveHead: (cwd: string) => Promise<string | null>;
  discard?: DiscardDeps;
}

export async function openNodeCheckWorktree(input: NodeCheckWorktreeInput): Promise<NodeDeliveryCheckout | null> {
  const { git, repoPath, branch } = input;
  const path = join(input.root, input.taskId.slice(0, 8));
  await discardWorktree(git, repoPath, path, input.discard);
  const added = await git(repoPath, ["worktree", "add", path, branch]);
  if (added.code !== 0) return null;
  return {
    cwd: path,
    head: () => input.resolveHead(path),
    release: () => discardWorktree(git, repoPath, path, input.discard),
  };
}
