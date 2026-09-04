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
export type GitCounts = { fileCount: number; ahead: number; behind: number } | null | undefined;

/**
 * The sidebar section shows when git has SOMETHING to say: uncommitted files,
 * or a divergence from the upstream. Ahead/behind stay in, because commits
 * nobody pushed are work in flight too, and the collapsed rail already spends
 * a dot on them.
 */
export function hasGitStateToShow(status: GitCounts): boolean {
  return !!status && (status.fileCount > 0 || status.ahead > 0 || status.behind > 0);
}

/**
 * The card chip. A MEASURED zero means the turn touched no file, so the chip
 * goes away; a missing measure means nobody has counted yet, which is a
 * different statement and keeps the chip (it says "git changes", no number).
 */
export function showsGitChangesChip(measure: { files: number } | null): boolean {
  return measure === null || measure.files > 0;
}
