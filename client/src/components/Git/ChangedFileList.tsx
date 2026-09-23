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
 *    in the panel, an Italian word (`nuovo` / `mod` / `del`) in the diff // allow-italian: the labels that were REPLACED are the subject
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
import { useState, type ReactNode } from 'react';
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
const LEFT_TO_RIGHT_MARK = '\u200E';

/** How wide the mark column is, so every row's name starts on the same pixel. */
const MARK_CELL = 'w-4 shrink-0 text-center font-mono text-micro font-bold leading-none';

/** The word a screen reader gets instead of the letter (see `ChangedFileMark`). */
const STATUS_WORD_KEY: Record<ChangedFileStatus, string> = {
  added: 'git.files.status.added',
  modified: 'git.files.status.modified',
  deleted: 'git.files.status.deleted',
  renamed: 'git.files.status.renamed',
  copied: 'git.files.status.copied',
  untracked: 'git.files.status.untracked',
  conflicted: 'git.files.status.conflicted',
};

/**
 * THE MARK: the letter and its colour, in a fixed-width cell so every row's
 * name starts on the same pixel.
 *
 * Hidden from assistive technology ON PURPOSE. The letter is first on the row,
 * and a row is a button whose accessible name is its content: with the letter
 * spoken, every file was announced as "M something" and the name of the row
 * started with a state instead of the file it is about. The state is not
 * dropped -- `ChangedFilePath` says it as a WORD right after the name, which is
 * also what a letter that means "modified" should sound like.
 */
export function ChangedFileMark({ row }: { row: ChangedFileRow }) {
  const mark = markOf(row);
  return (
    <span aria-hidden="true" className={`${MARK_CELL} ${mark.tone}`} data-changed-file-mark={mark.letter}>{mark.letter}</span>
  );
}

/** THE PATH: the name whole, the folder elided from the left, a rename saying
 *  where it came from. */
export function ChangedFilePath({ row }: { row: ChangedFileRow }) {
  const tr = useT();
  const { dir, name } = splitPath(row.path);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1">
      {/* THE NAME FIRST IN THE DOM, whatever is drawn before it: the row's
          accessible name starts here, and "starts with the file name" is the
          one thing every surface's locator and every screen reader rely on. */}
      <span className="max-w-[70%] flex-shrink-0 truncate text-app-text-body">{name}</span>
      <span className="sr-only">{tr(STATUS_WORD_KEY[row.status])}</span>
      {row.origPath && (
        // The old name, struck through, BEFORE the new one on screen (`order-first`)
        // and after it in the DOM: without it a rename shows up as a file that
        // appeared out of nowhere, and with it first the row would be NAMED
        // after the file that no longer exists.
        <span className="order-first max-w-[40%] flex-shrink-0 truncate text-app-text-muted line-through">
          {splitPath(row.origPath).name}
        </span>
      )}
      {dir && (
        <span className="path-elide-left min-w-0 flex-1 text-mini text-app-text-muted">
          {LEFT_TO_RIGHT_MARK + dir.slice(0, -1)}
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
      <span className="shrink-0 tabular-nums text-micro text-app-text-muted" title={tr('git.files.binaryTitle')}>
        {tr('git.files.binary')}
      </span>
    );
  }
  if (!row.added && !row.removed) return null;
  return (
    <span
      className="shrink-0 tabular-nums text-micro leading-none"
      title={tr('git.files.countsTitle', { add: String(row.added ?? 0), del: String(row.removed ?? 0) })}
    >
      {!!row.added && <span className="text-emerald-600 dark:text-emerald-400">+{row.added}</span>}
      {!!row.added && !!row.removed && ' '}
      {!!row.removed && <span className="text-red-600 dark:text-red-400">-{row.removed}</span>}
    </span>
  );
}

/**
 * How many rows before the list folds into "and N more". Past this a dropdown
 * stops being read at a glance, so the rest waits behind a button and a filter
 * appears. It WAITS, it is not dropped: «and 39 more» used to be plain text,
 * and on a 51-file topic 39 files had no way onto the screen.
 */
const MAX_ROWS = 12;

/**
 * The rows to draw. Pure so it can be asserted without a DOM.
 *
 * The filter runs over EVERY row, not over the visible slice: a file past the
 * cut is exactly the one you type to find. A filtered list is never cut, the
 * point of typing was to get a short one.
 */
export function visibleChangedRows(
  rows: ChangedFileRow[],
  { expanded, query }: { expanded: boolean; query: string },
): { shown: ChangedFileRow[]; rest: number } {
  const q = query.trim().toLowerCase();
  if (q) {
    const hits = rows.filter((r) => r.path.toLowerCase().includes(q) || !!r.origPath?.toLowerCase().includes(q));
    return { shown: hits, rest: 0 };
  }
  if (expanded || rows.length <= MAX_ROWS) return { shown: rows, rest: 0 };
  return { shown: rows.slice(0, MAX_ROWS), rest: rows.length - MAX_ROWS };
}

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
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const all = rows ?? [];
  const { shown, rest } = visibleChangedRows(all, { expanded, query });
  const long = all.length > MAX_ROWS;
  return (
    <div data-testid={testId}>
      {loading && <div className="px-1 py-1 text-micro text-app-text-muted">{tr('git.files.loading')}</div>}
      {error && <div className="px-1 py-1 text-micro text-red-600 dark:text-red-400">{tr('git.files.error')}</div>}
      {!loading && !error && rows?.length === 0 && (
        <div className="px-1 py-1 text-micro text-app-text-muted">{emptyLabel ?? tr('git.files.empty')}</div>
      )}
      {long && (
        <input
          type="search"
          data-testid="changed-file-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // The dropdowns this lives in close or open a card on a click that
          // bubbles: typing in the filter must not be read as one.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={tr('git.files.filter', { n: String(all.length) })}
          aria-label={tr('git.files.filter', { n: String(all.length) })}
          className="mb-1 w-full rounded border border-app-border bg-transparent px-1.5 py-0.5 text-mini text-app-text outline-none placeholder:text-app-placeholder focus:border-app-text-muted"
        />
      )}
      {long && query.trim() && shown.length === 0 && (
        <div className="px-1 py-1 text-micro text-app-text-muted">{tr('git.files.noMatch')}</div>
      )}
      {shown.map((row) => {
        const inner = <ChangedFileEntry row={row} />;
        const className = 'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-mini leading-tight';
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
        // silence makes you believe you saw all of it. And it OPENS: a
        // count with nothing behind it only tells you what you cannot read.
        <button
          type="button"
          data-testid="changed-file-more"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="w-full rounded px-1 pt-1 text-left text-micro text-app-text-muted underline-offset-2 hover:bg-app-hover hover:text-app-text hover:underline"
        >
          {tr('git.files.more', { n: String(rest) })}
        </button>
      )}
    </div>
  );
}
