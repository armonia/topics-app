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

/** Above this many hunks the per-hunk question is not asked: "cannot tell". */
const MAX_HUNKS = 200;

/** One patch per hunk, each with its file's header, so each can be applied on its own. */
export function splitIntoHunks(diff: string): string[] {
  const out: string[] = [];
  for (const file of diff.split(/^(?=diff --git )/m)) {
    if (!file.startsWith("diff --git ")) continue;
    const at = file.search(/^@@ /m);
    if (at < 0) continue;
    const header = file.slice(0, at);
    for (const hunk of file.slice(at).split(/^(?=@@ )/m)) if (hunk.startsWith("@@ ")) out.push(header + hunk);
  }
  return out;
}

/**
 * WAS ANY PART OF THIS CHANGE UNDONE ON MAIN? The per-hunk twin of `changeUndoneOn`.
 *
 * A squash C that held the branch, then main removing only one of the branch's two edits
 * in the same file (15/11, verifier on #1113): the whole patch no longer applies forward,
 * the file still differs from the fork point, and every file-level check says "still
 * there" while that edit is gone. A single hunk that applies forward on main is that edit.
 *
 * `true` = at least one hunk was undone · `false` = none was · `null` = cannot tell
 * (empty or binary diff, too many hunks, git error): never read as `false`.
 */
export async function someHunkUndoneOn(
  repoPath: string,
  base: string,
  tip: string,
  mainRef: string,
  paths: readonly string[],
  runGit: GitRunner = defaultRunGit,
): Promise<boolean | null> {
  const diff = await runGit(repoPath, ["diff", "--no-color", "--no-renames", base, tip, "--", ...paths]).catch(() => null);
  if (!diff || diff.code !== 0 || !diff.stdout.trim()) return null;
  if (/^Binary files /m.test(diff.stdout)) return null;
  const hunks = splitIntoHunks(diff.stdout);
  if (hunks.length === 0 || hunks.length > MAX_HUNKS) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "hunk-undone-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await runGit(repoPath, ["read-tree", mainRef], { env })).code !== 0) return null;
    for (let i = 0; i < hunks.length; i++) {
      const patch = join(dir, `h${i}.patch`);
      await writeFile(patch, hunks[i]!);
      // `--check` leaves the private index as it is: every hunk is asked of main's own tree.
      if ((await runGit(repoPath, ["apply", "--cached", "--check", patch], { env })).code === 0) return true;
    }
    return false;
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
