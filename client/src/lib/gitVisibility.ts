import { diffTotals, type DiffFileStat } from './board';

/**
 * WHEN A GIT SURFACE IS WORTH A ROW.
 *
 * Zero changes is not a number to display, it is a surface that does not
 * appear: a section titled "git changes" saying "0 files" spends a row of the
 * sidebar to say nothing happened. `ChangedFilesStrip` had it right from the
 * start (`if (!files.length) return null`); the sidebar section and the card
 * chip did not, and this is where the three now agree.
 *
 * The counts themselves are untouched: when there IS something, it reads
 * exactly as before.
 */

/** What the sidebar knows about the repository, or nothing at all (loading, or
 *  not a repository). */
export type GitCounts = {
  fileCount: number;
  ahead: number;
  behind: number;
  /**
   * The opened folder is itself untracked by the repo that contains it. The
   * server folds the host repo's `?? folder/` record into ZERO files on
   * purpose (a directory is not a file row), so the count alone reads as a
   * clean tree — and hid the one panel that says "not tracked by «repo»" and
   * offers to create a repository here (git-untracked-folder.spec.ts). An
   * untracked folder IS uncommitted work: the section stays.
   */
  folderUntracked?: boolean;
} | null | undefined;

/**
 * The sidebar section shows when git has SOMETHING to say: uncommitted files,
 * a divergence from the upstream, or a folder the host repo does not track
 * yet. Ahead/behind stay in, because commits nobody pushed are work in flight
 * too, and the collapsed rail already spends a dot on them.
 */
export function hasGitStateToShow(status: GitCounts): boolean {
  return !!status && (status.fileCount > 0 || status.ahead > 0 || status.behind > 0 || !!status.folderUntracked);
}

/**
 * The card chip. A MEASURED zero means the turn touched no file, so the chip
 * goes away; a missing measure means nobody has counted yet, which is a
 * different statement and keeps the chip (it says "git changes", no number).
 */
export function showsGitChangesChip(measure: { files: number } | null): boolean {
  return measure === null || measure.files > 0;
}

/**
 * The numbers the chip shows.
 *
 * Once the list is READ it is the truth: the DB counter was measured at
 * delivery and the list is the diff of now, and they drift (task 1c19bf48:
 * 101 on the chip, 34 in the list). Showing both made the chip promise files
 * the list did not have. Before the first read the counter is all there is.
 */
export function deliveryMeasure(
  counter: { files: number | null; insertions: number; deletions: number },
  stat: DiffFileStat[] | null,
): { files: number; insertions: number; deletions: number } | null {
  if (stat) {
    // `diffTotals` skips git's `-1` for a binary: summing it would subtract
    // lines nobody removed.
    const t = diffTotals(stat);
    return { files: t.files, insertions: t.additions, deletions: t.deletions };
  }
  if (counter.files === null) return null;
  return { files: counter.files, insertions: counter.insertions, deletions: counter.deletions };
}
