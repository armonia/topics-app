/**
 * THE LAST LOOK before the automatic land merges (`task-automerge.ts`).
 *
 * Asked under the repo's queue, after the fetch and every other step, a moment
 * before `git merge`. Two questions, in this order: is the branch still at the
 * commit the bar measured, and does the automatic land still want this? The
 * second is a callback into the card and the open turns, read NOW and not when
 * the land was offered: the step before waits for the queue and the network, and a
 * card archived, asked something or moved on in that time must not be merged on
 * the strength of an older verdict. `null` = go on.
 */

type RunGit = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export interface LastLookStop {
  code: "not-as-measured" | "auto-land-stopped";
  reason: string;
}

export async function lastLook(a: {
  runGit: RunGit;
  cwd: string;
  branch: string;
  /** The full sha the bar measured: what the merge is about to take. */
  pinned: string;
  beforeMerge?: (sha: string) => Promise<string | null>;
}): Promise<LastLookStop | null> {
  const tip = await a.runGit(a.cwd, ["rev-parse", "--verify", "--quiet", `${a.branch}^{commit}`]);
  if (tip.code !== 0 || tip.stdout.trim() !== a.pinned) {
    return {
      code: "not-as-measured",
      reason: `la punta di '${a.branch}' si è mossa mentre il land aspettava il suo turno (non è più ${a.pinned.slice(0, 8)}): l'atterraggio automatico pubblica solo il commit che la barra ha misurato. Guardalo e premi «Landa su main»`,
    };
  }
  if (!a.beforeMerge) return null;
  try {
    const stop = await a.beforeMerge(a.pinned);
    return stop ? { code: "auto-land-stopped", reason: stop } : null;
  } catch (err) {
    return { code: "auto-land-stopped", reason: `the last check failed: ${String(err)}` };
  }
}
