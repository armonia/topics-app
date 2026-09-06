/**
 * A CHANGED FILE, in one shape, for every surface that lists one.
 *
 * The same list -- what git says about a set of files -- reached the screen from
 * three different wire shapes and was drawn four different ways:
 *
 *  · `TopicChangedFile` (`shared/topic-changes.ts`), for the strip above the
 *    composer: a semantic `kind` plus `added`/`removed`.
 *  · `DiffFileStat` (`lib/board.ts`), for a task delivery and for the publish
 *    diff: a raw name-status letter plus `additions`/`deletions`, where a
 *    binary file is `-1` and not a flag.
 *  · `GitStatusFile` (`shared/git-status.ts`), for the project's git panel: the
 *    two-character porcelain code, with the line counts split per side
 *    (what is staged is not what is on disk).
 *
 * None of the three can be dropped: they answer different questions and come
 * from different routes. What CAN stop being three is the shape the renderer
 * reads, and that is what lives here -- plus one adapter per wire shape, so the
 * conversion happens once and is testable without mounting anything.
 *
 * The counts stay OPTIONAL and are never defaulted to zero: "no diff to count"
 * (an untracked file, a pure rename) and "a diff of zero lines" are different
 * statements, and `+0 -0` says the second one when the truth is the first.
 */
import type { GitStatusFile, GitLineCounts } from '../../../../shared/git-status';
import type { TopicChangedFile } from '../../../../shared/topic-changes';
import type { DiffFileStat } from '../../lib/board';

/** What happened to the file. Everything git can say, collapsed to what a list shows. */
export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

export interface ChangedFileRow {
  /** Relative to the repository root when there is one, absolute otherwise. */
  path: string;
  status: ChangedFileStatus;
  /**
   * The raw code, when it says more than the status does: `MM` is staged AND
   * dirty, `UU` is both sides of a conflict. Shown in place of the letter, so
   * a state that asks for an action does not read like a plain modification.
   */
  code?: string;
  /** Absent means NOT COUNTED, which is not the same as counted zero. */
  added?: number;
  removed?: number;
  /** git counts no line of a binary file: it prints `-`, not `0`. */
  binary?: boolean;
  /** Renames and copies only: where the content came from. */
  origPath?: string;
}

/** `src/lib/` and `thing.ts`: the folder stays readable without shouting. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** The strip above the composer: a kind that is already semantic. */
export function rowFromTopicChange(file: TopicChangedFile): ChangedFileRow {
  return {
    path: file.path,
    status: file.kind === 'created' ? 'added' : file.kind === 'deleted' ? 'deleted' : 'modified',
    added: file.added,
    removed: file.removed,
    binary: file.binary,
  };
}

/**
 * A delivery or a publish range: `git diff --name-status` letters, where the
 * status can carry a similarity score (`R100`) and a binary file arrives as the
 * `-1` that `--numstat` prints for `-`.
 */
export function rowFromDiffStat(stat: DiffFileStat): ChangedFileRow {
  const binary = stat.additions < 0 || stat.deletions < 0;
  return {
    path: stat.path,
    status: statusFromLetter(stat.status),
    added: binary ? undefined : stat.additions,
    removed: binary ? undefined : stat.deletions,
    binary: binary || undefined,
  };
}

/**
 * The project panel: the porcelain XY code, and the counts of the SIDE the row
 * belongs to. A half-staged file has different numbers in the index and on
 * disk, and showing the sum on both sides would claim twice the lines.
 */
export function rowFromGitFile(
  file: GitStatusFile,
  group: 'staged' | 'unstaged' | 'conflicted',
): ChangedFileRow {
  const counts: GitLineCounts | undefined = group === 'staged' ? file.staged : file.unstaged;
  return {
    path: file.path,
    status: statusFromPorcelain(file.status),
    code: rawCode(file.status),
    added: counts?.binary ? undefined : counts?.added,
    removed: counts?.binary ? undefined : counts?.removed,
    binary: counts?.binary,
    origPath: file.origPath,
  };
}

/**
 * A merge conflict has a letter other than a space in BOTH positions, which is
 * why it satisfies "staged" and "unstaged" at once. It is its own state: the
 * only one that asks the person to do something before anything else works.
 */
function isConflicted(code: string): boolean {
  return code === 'AA' || code === 'DD' || code[0] === 'U' || code[1] === 'U';
}

/** The porcelain XY pair, collapsed. */
export function statusFromPorcelain(code: string): ChangedFileStatus {
  if (isConflicted(code)) return 'conflicted';
  if (code === '??') return 'untracked';
  return statusFromLetter(code.trim());
}

/** A single name-status letter (`M`, `A`, `R100`, `MM`, ...). */
function statusFromLetter(status: string): ChangedFileStatus {
  switch (status.trim()[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case '?': return 'untracked';
    default: return 'modified';
  }
}

/**
 * The code worth SHOWING instead of the status letter: only when the two
 * characters say two different things, so `MM` and `AM` survive while ` M`
 * does not turn into a badge that says "M" twice. `??` is left out on purpose:
 * it has its own letter (`U`) and two question marks name nothing.
 */
function rawCode(code: string): string | undefined {
  const trimmed = code.trim();
  return trimmed.length > 1 && trimmed !== '??' ? trimmed : undefined;
}
