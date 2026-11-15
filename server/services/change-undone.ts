/**
 * WAS THIS CHANGE UNDONE ON MAIN?
 *
 * Ancestry says a commit is in main's history; it does not say its content is
 * still there. The incident of card 48588f6e (2026-11-12): the GC merged a card
 * closed without a land (`3be5ccbad merge task 48588f6e`), a person reverted it
 * by hand (`dc45baa74`, not a `git revert`, so no "This reverts commit" line to
 * grep), both reached origin, and every check kept reading `landed`: the merge
 * was an ancestor, and the land merge carried the card's name.
 *
 * The question asked here is the mirror of `contenutoGiaNellAlbero`: does the
 * change's diff apply FORWARD on main's tree? If it does, every line it adds is
 * absent and every line it removes is present, which is what "undone" means.
 * A change that landed and was later edited by other work does not apply
 * forward (its added files exist, its removed lines are gone), so a busy file
 * is not mistaken for a revert. The opposite question, "is it all still there",
 * would accuse every landed card whose files somebody touched afterwards.
 *
 * Only meaningful AFTER something said the change reached main: on a change
 * that never arrived, "applies forward" is just as true and means nothing new.
 *
 * `null` = cannot tell (empty diff, git error, binary patch). Never `false`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit, type GitRunner } from "./own-commits";

export async function changeUndoneOn(
  repoPath: string,
  base: string,
  tip: string,
  mainRef: string,
  runGit: GitRunner = defaultRunGit,
): Promise<boolean | null> {
  const diff = await runGit(repoPath, ["diff", "--no-color", base, tip]).catch(() => null);
  if (!diff || diff.code !== 0 || !diff.stdout.trim()) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "change-undone-"));
    const patch = join(dir, "change.patch");
    await writeFile(patch, diff.stdout);
    // A private index holds main's tree: the answer must not depend on what
    // the checkout has on disk, and nothing in the repo is written.
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await runGit(repoPath, ["read-tree", mainRef], { env })).code !== 0) return null;
    const check = await runGit(repoPath, ["apply", "--cached", "--check", patch], { env });
    if (check.code === 0) return true;
    return /without full index line|binary patch/i.test(check.stderr ?? "") ? null : false;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
