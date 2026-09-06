/**
 * THE LIST OF FILES GIT TOUCHED -- one component, wherever it appears.
 *
 * The same list was drawn four times, and the four disagreed on the two things
 * that decide whether it is readable:
 *
 *  · WHERE THE PATH IS CUT. The chat strip cut on the right (`truncate`), which
 *    eats the END of the path -- that is, the file NAME, the one part you are
 *    looking for: `client/src/components/Board/Ca...`. The delivery chip did
 *    it with `dir="rtl"` and bidi isolates, the project panel with
 *    `.path-elide-left`. Three answers to one question, and one of them wrong.
 *  · WHAT SAYS WHAT HAPPENED. A coloured letter in the chat, a coloured badge
 *    in the panel, an Italian word (`nuovo` / `mod` / `del`) in the diff
 *    header, and NOTHING at all in the delivery chip, which showed `+/-` for a
 *    file it never said was deleted.
 *
 * Here there is one answer: the name never truncates, the folder elides from
 * the left (the root is the same on every row, so it is the part that
 * distinguishes nothing), and a monospaced letter carries the state in the one
 * colour vocabulary the app already uses for a diff -- green added, amber
 * modified, red deleted or in conflict, blue renamed, violet untracked.
 *
 * TWO LAYERS, because the surfaces need different amounts of it:
 *  · `ChangedFileEntry` is a ROW and nothing else: mark, path, counts. The
 *    project panel and the diff header mount this one, because their row
 *    carries its own chrome (staging buttons, a disclosure triangle, a
 *    selection) that has no business in a shared component.
 *  · `ChangedFileList` is the DROPDOWN: rows that open a diff on click, plus
 *    the three states a list has before it has rows (loading, error, empty) and
 *    the tail it declares instead of dropping in silence.
 */
import type { ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { splitPath, type ChangedFileRow, type ChangedFileStatus } from './changedFiles';

/**
 * The letter and its colour. `text-*-600 dark:text-*-400` and not a single
 * tone: on a light theme the 400s measure under 3:1 on the panel background,
 * and this letter is the only thing on the row that is not the path.
 */
const MARK: Record<ChangedFileStatus, { letter: string; tone: string }> = {
  added: { letter: 'A', tone: 'text-emerald-600 dark:text-emerald-400' },
  modified: { letter: 'M', tone: 'text-amber-600 dark:text-amber-400' },
  deleted: { letter: 'D', tone: 'text-red-600 dark:text-red-400' },
  renamed: { letter: 'R', tone: 'text-blue-600 dark:text-blue-400' },
  copied: { letter: 'C', tone: 'text-blue-600 dark:text-blue-400' },
  untracked: { letter: 'U', tone: 'text-violet-600 dark:text-violet-400' },
  conflicted: { letter: 'C', tone: 'text-red-600 dark:text-red-400' },
};

/** A conflict shows its raw code (`UU`), so `C` never stands for two things. */
function markOf(row: ChangedFileRow): { letter: string; tone: string } {
  const base = MARK[row.status];
  return row.code ? { letter: row.code, tone: base.tone } : base;
}

/**
 * LEFT-TO-RIGHT MARK, in front of every text put in `.path-elide-left`.
 *
 * Written as an escape and never as the character itself: in the source it
 * would be invisible, and an invisible character survives copy, search and
 * review badly -- nobody sees it disappear.
 */
const LRM = '\u200E';

/** How wide the mark column is, so every row's name starts on the same pixel. */
const MARK_CELL = 'w-4 shrink-0 text-center font-mono text-[10px] font-bold leading-none';

/** THE MARK: the letter and its colour, in a fixed-width cell so every row's
 *  name starts on the same pixel. */
export function ChangedFileMark({ row }: { row: ChangedFileRow }) {
  const mark = markOf(row);
  return (
    <span className={`${MARK_CELL} ${mark.tone}`} data-changed-file-mark={mark.letter}>{mark.letter}</span>
  );
}

/** THE PATH: the name whole, the folder elided from the left, a rename saying
 *  where it came from. */
export function ChangedFilePath({ row }: { row: ChangedFileRow }) {
  const { dir, name } = splitPath(row.path);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1">
      {row.origPath && (
        // The old name, struck through, BEFORE the new one: without it a
        // rename shows up as a file that appeared out of nowhere.
        <span className="max-w-[40%] flex-shrink-0 truncate text-app-text-muted line-through">
          {splitPath(row.origPath).name}
        </span>
      )}
      <span className="max-w-[70%] flex-shrink-0 truncate text-app-text-body">{name}</span>
      {dir && (
        <span className="path-elide-left min-w-0 flex-1 text-[11px] text-app-text-muted">
          {LRM + dir.slice(0, -1)}
        </span>
      )}
    </span>
  );
}

/**
 * The whole row, for the surfaces whose row is ONLY a row. The project panel
 * composes the three parts by hand instead: its counts live in a grid cell
 * they share with the staging buttons, which take their place on hover.
 */
export function ChangedFileEntry({ row, trailing }: {
  row: ChangedFileRow;
  /** What the surface puts after the counts (a note badge, a chip). */
  trailing?: ReactNode;
}) {
  return (
    <>
      <ChangedFileMark row={row} />
      <ChangedFilePath row={row} />
      <ChangedFileCounts row={row} />
      {trailing}
    </>
  );
}

/**
 * The two numbers, in the colours that mean a DIRECTION and not a state.
 *
 * Silent when there is nothing to say: an untracked file is in no diff (no
 * number, not a zero) and a pure rename is `0/0` -- `+0 -0` is noise taking up
 * the room of an information.
 */
export function ChangedFileCounts({ row }: { row: ChangedFileRow }) {
  const tr = useT();
  if (row.binary) {
    return (
      <span className="shrink-0 tabular-nums text-[10px] text-app-text-muted" title={tr('git.files.binaryTitle')}>
        {tr('git.files.binary')}
      </span>
    );
  }
  if (!row.added && !row.removed) return null;
  return (
    <span
      className="shrink-0 tabular-nums text-[10px] leading-none"
      title={tr('git.files.countsTitle', { add: String(row.added ?? 0), del: String(row.removed ?? 0) })}
    >
      {!!row.added && <span className="text-emerald-600 dark:text-emerald-400">+{row.added}</span>}
      {!!row.added && !!row.removed && ' '}
      {!!row.removed && <span className="text-red-600 dark:text-red-400">-{row.removed}</span>}
    </span>
  );
}

/**
 * How many rows before the list says "and N more". A longer list than this
 * inside a dropdown does not get read: the whole of it lives in the surface
 * that owns the diff.
 */
const MAX_ROWS = 12;

export function ChangedFileList({ rows, onOpen, loading, error, emptyLabel, testId = 'changed-file-list' }: {
  /** `null` = not read yet; `[]` = read, and nothing changed. Different statements. */
  rows: ChangedFileRow[] | null;
  /** Absent = the list is read-only, and the rows stop being buttons. */
  onOpen?: (row: ChangedFileRow) => void;
  loading?: boolean;
  /** An error is SAID: an empty list after a click reads as "nothing changed". */
  error?: boolean;
  /** What "no rows" means HERE -- it is not the same sentence on every surface. */
  emptyLabel?: string;
  testId?: string;
}) {
  const tr = useT();
  const shown = rows?.slice(0, MAX_ROWS) ?? [];
  const rest = (rows?.length ?? 0) - shown.length;
  return (
    <div data-testid={testId}>
      {loading && <div className="px-1 py-1 text-[10px] text-app-text-muted">{tr('git.files.loading')}</div>}
      {error && <div className="px-1 py-1 text-[10px] text-red-600 dark:text-red-400">{tr('git.files.error')}</div>}
      {!loading && !error && rows?.length === 0 && (
        <div className="px-1 py-1 text-[10px] text-app-text-muted">{emptyLabel ?? tr('git.files.empty')}</div>
      )}
      {shown.map((row) => {
        const inner = <ChangedFileEntry row={row} />;
        const className = 'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-tight';
        return onOpen ? (
          <button
            key={row.path}
            type="button"
            data-testid="changed-file-row"
            data-path={row.path}
            title={row.origPath ? `${row.origPath} -> ${row.path}` : row.path}
            onClick={(e) => { e.stopPropagation(); onOpen(row); }}
            className={`${className} hover:bg-app-hover`}
          >
            {inner}
          </button>
        ) : (
          <div key={row.path} data-testid="changed-file-row" data-path={row.path} title={row.path} className={className}>
            {inner}
          </div>
        );
      })}
      {rest > 0 && (
        // The tail is DECLARED instead of vanishing: a list truncated in
        // silence makes you believe you saw all of it.
        <div className="px-1 pt-1 text-[10px] text-app-text-muted">{tr('git.files.more', { n: String(rest) })}</div>
      )}
    </div>
  );
}
