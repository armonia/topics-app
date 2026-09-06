import { useState, useCallback, useMemo } from 'react';
import { ChevronDown, FileDiff } from 'lucide-react';
import { boardApi, type DiffFileStat } from '../../lib/board';
import { useT } from '../../hooks/useT';
import { ChangedFileList } from '../Git/ChangedFileList';
import { rowFromDiffStat } from '../Git/changedFiles';
import { showsGitChangesChip } from '../../lib/gitVisibility';

/**
 * THE CARD'S GIT CHANGES, as a chip that opens.
 *
 * WHAT CHANGED. It was a mute chip: "136 files +6017 -868", at the end of the
 * chip row. It said HOW MUCH and never WHAT, and in front of a delivery to
 * review "which files did it touch" is the first question, not the second.
 * Asked for in as many words: put the changed files in a dropdown, at the foot
 * of the card, but before the input.
 *
 * WHERE IT SITS NOW. In the card's foot, next to the model: they are the same
 * turn's measures, and reading them together is why they stand side by side.
 * The panel that opens is a DROPDOWN as wide as it needs to be, not a surface
 * that takes over the card: the diff in full lives in the task, here the list
 * is enough.
 *
 * EVEN WHILE THE AGENT WRITES. The delivery counters are born at the end of
 * the turn, but the diff route reads the LIVE WORKTREE (`task-diff-range.ts`).
 * With `live` the chip promises no number that does not exist yet: it says
 * "git changes", and the numbers appear once the list arrives.
 *
 * THE SUMMARY STAYS CLOSED. Opening every card of a column would turn the
 * review into a wall of paths: the number is what you read in passing, the
 * names are what you ask for when that one card actually matters.
 *
 * IT LOADS ONLY WHEN OPENED. The names are not in the task (the DB keeps the
 * counters only) and come from `/tasks/:id/diff`, which reads git: asking for
 * every card of a board would be one repository read per row. Once loaded they
 * stay, as long as the card is mounted.
 *
 * THE ROWS ARE NOT DRAWN HERE. They are the shared list every git surface of
 * the app mounts (`Git/ChangedFileList`): same letter, same colours, same place
 * where the path is cut. What used to be here showed `+/-` and never said
 * whether the file had been added or deleted.
 */

export function DeliveryFiles({ projectId, taskId, files, insertions, deletions, commit, live }: {
  projectId: string;
  taskId: string;
  /** The COUNT recorded at delivery. `null` = not measured yet (the turn is
   *  still running): the chip says so instead of showing a zero. */
  files: number | null;
  insertions: number;
  deletions: number;
  commit: string | null;
  /** The worktree is still moving: what you read is of this instant. */
  live?: boolean;
}) {
  const tr = useT();
  const [aperto, setAperto] = useState(false);
  const [stat, setStat] = useState<DiffFileStat[] | null>(null);
  /** An error is SAID: an empty list after a click reads as a delivery with
   *  no files, which is a different statement. */
  const [errore, setErrore] = useState<string | null>(null);
  const [caricando, setCaricando] = useState(false);

  const apri = useCallback(async (e: React.MouseEvent) => {
    // A bare click on the card opens the drawer: here we do NOT want both
    // things at once.
    e.stopPropagation();
    const prossimo = !aperto;
    setAperto(prossimo);
    // A live worktree changes under your feet: reopening the chip re-reads
    // it, which is the only way "now" can mean now. On a delivery that has
    // stopped the diff no longer moves, so what was read is kept.
    if (!prossimo || caricando || (stat && !live)) return;
    setCaricando(true);
    setErrore(null);
    try {
      const d = await boardApi.taskDiff(projectId, taskId);
      setStat(Array.isArray(d?.stat) ? (d.stat as DiffFileStat[]) : []);
    } catch (err) {
      setErrore(err instanceof Error ? err.message : String(err));
    } finally {
      setCaricando(false);
    }
  }, [aperto, stat, caricando, live, projectId, taskId]);

  const rows = useMemo(() => stat?.map(rowFromDiffStat) ?? null, [stat]);
  /** On a running turn the numbers do NOT come from the task (they do not
   *  exist yet): they are summed from what was just read. Before the first
   *  open there is no number to show, and that is the honest state. */
  const misura = useMemo(() => {
    if (files !== null) return { files, insertions, deletions };
    if (!stat) return null;
    return {
      files: stat.length,
      // A binary file is -1 in git's numstat: summing it would subtract lines
      // nobody removed.
      insertions: stat.reduce((n, f) => n + Math.max(0, f.additions), 0),
      deletions: stat.reduce((n, f) => n + Math.max(0, f.deletions), 0),
    };
  }, [files, insertions, deletions, stat]);

  // A COUNTED ZERO IS NO CHIP. Once the read comes back empty the turn touched
  // nothing, and "0 files +0 -0" is a control that opens on an empty list.
  // Before any count exists the chip stays: "not measured yet" is a different
  // statement from "nothing changed", and it is the one the live label makes.
  if (!showsGitChangesChip(misura)) return null;

  return (
    <div className="relative" data-testid="card-delivery-files">
      <button
        type="button"
        onClick={apri}
        aria-expanded={aperto}
        data-testid="card-delivery-files-toggle"
        title={misura
          ? tr(live ? 'board.card.gitChangesTitle' : 'board.card.deliveryStatTitle', {
            files: misura.files, add: misura.insertions, del: misura.deletions,
            commit: commit?.slice(0, 8) ?? '?',
          })
          : tr('board.card.gitChangesLiveTitle')}
        className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading hover:bg-white/15"
      >
        <FileDiff className="h-3 w-3 shrink-0" />
        {misura
          ? tr('board.card.deliveryFiles', { n: misura.files })
          : tr('board.card.gitChanges')}
        {/* The two numbers with their colours: green and red here are not a
            state but a DIRECTION, and they are the only thing that tells a
            delivery that adds from one that deletes. */}
        {misura && <span className="text-emerald-400">+{misura.insertions}</span>}
        {misura && <span className="text-rose-400">-{misura.deletions}</span>}
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform ${aperto ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {aperto && (
        <div
          data-testid="card-delivery-files-list"
          onClick={(e) => e.stopPropagation()}
          /* IT DROPS UNDER THE CHIP, it does not stand in for the card:
             `absolute`, a width of its own (never wider than the column,
             `max-w`), above the rest (`z-20`) and with its own scrollbar when
             the list is long. As a full-width block it used to push the card's
             controls down every time someone glanced at the files. */
          className="absolute left-0 top-full z-20 mt-1 max-h-40 w-64 max-w-[calc(100vw-4rem)] overflow-y-auto rounded border border-app-border bg-app-bg px-1.5 py-1 shadow-lg scrollbar-standard"
        >
          {/* The empty state is the one sentence that stays per-surface: on a
              stopped delivery it names the commit, on a live worktree it says
              "not yet". */}
          <ChangedFileList
            rows={rows}
            loading={caricando}
            error={!!errore}
            emptyLabel={tr(live ? 'board.card.gitChangesEmpty' : 'board.card.deliveryFilesEmpty')}
          />
        </div>
      )}
    </div>
  );
}
