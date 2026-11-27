/**
 * THE DELIVERY REFERENCE: own commit, own diffstat, measured against the
 * right base.
 *
 * Extracted out of `boot/preview-delivery.ts`'s `taskDeliveryRef` closure so
 * the one thing that matters — resolving `mainRef` BEFORE asking for the own
 * commit and the diffstat, instead of letting them default to the literal
 * ref `"main"` — has a call site a test can reach directly. Without it,
 * removing the `resolveMainRef` wiring at that call site left no test red: a
 * checkout whose local `main` never moves (this board only moves it at land
 * time, never on a fetch) measured a planted branch against its own stale
 * ref and reported zero own commits even with real work on the branch
 * (card 9a850b73, 2026-11-26).
 */

export interface DeliveryBranchRef {
  repoPath: string;
  branch: string;
  worktreePath?: string | null;
}

export interface DeliveryReferenceDeps {
  resolveMainRef(repoPath: string): Promise<string>;
  deliveryPointer(
    repoPath: string, branch: string, opts?: { mainRef?: string; ownRefs?: string[] },
  ): Promise<{ branch: string; commit: string | null } | null>;
  worktreeDiffStat(
    cwd: string, opts: { branch?: string; mainRef?: string },
  ): Promise<{ filesChanged: number; insertions: number; deletions: number } | null>;
  cardOwnBranches(taskId: string): string[];
}

export interface DeliveryReference {
  branch: string;
  commit: string | null;
  repoPath: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

/** The own commit and diffstat of a delivered branch, or `null` when there is nothing own to report. */
export async function resolveDeliveryReference(
  deps: DeliveryReferenceDeps, ref: DeliveryBranchRef, taskId: string,
): Promise<DeliveryReference | null> {
  const mainRef = await deps.resolveMainRef(ref.repoPath).catch(() => "main");
  const pointer = await deps.deliveryPointer(ref.repoPath, ref.branch, { mainRef, ownRefs: deps.cardOwnBranches(taskId) }).catch(() => null);
  if (!pointer) return null;
  const stat = await deps.worktreeDiffStat(ref.worktreePath ?? ref.repoPath, { branch: ref.branch, mainRef }).catch(() => null);
  return stat
    ? { ...pointer, repoPath: ref.repoPath, filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions }
    : { ...pointer, repoPath: ref.repoPath };
}
