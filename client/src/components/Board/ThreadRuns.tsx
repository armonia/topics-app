/**
 * The task thread with the dispatcher's bookkeeping folded out of the way.
 *
 * A card's thread mixes two things that look identical on screen: the words a
 * human or an agent wrote, and the dispatcher's own accounting (a retry, a
 * server restart, a queue hold). On a busy card the accounting is the majority
 * - one measured card carried 28 comments, 20 of them service notes - so
 * whoever opens the card to DECIDE was digging for the two or three lines where
 * the agent actually speaks.
 *
 * COLLAPSED, NEVER DROPPED, and that is enforced by construction rather than by
 * care: the fold is a native `<details>`, so every row it holds is in the
 * document whether the fold is open or shut. There is no state in which a row
 * has been rendered away - the browser hides and shows it, and the reason a
 * task sat in the queue stays one click from whoever goes looking for it.
 *
 * The fold also stays in its PLACE in the conversation instead of hoisting the
 * notes into one pile at the end: `groupServiceRuns` partitions adjacent rows,
 * so the agent's words keep the context they happened in.
 *
 * Which rows count as service is decided by `shared/task-comment-service.ts`,
 * and it is NOT "the machine wrote it": land outcomes, check results and
 * questions all carry author 'system' and all have to stay on screen.
 *
 * This lives in its own file, apart from `TaskDetail`, because it is the part
 * that can be wrong in SILENCE: a fold that quietly drops its rows renders as a
 * perfectly plausible thread. Here it can be mounted and read by a test.
 */
import { useMemo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { foldsAway, groupServiceRuns, groupStatusRuns, type ThreadComment } from '../../../../shared/task-comment-service';

/** A thread row this component can render: whatever it takes to classify, plus a key. */
export type ThreadRunsRow = ThreadComment & { id: string };

/**
 * One run of bookkeeping behind a single line.
 *
 * `<details>` on purpose, not a `useState` toggle. It keeps the children in the
 * document at all times (so the fold cannot lose them), it opens with the
 * keyboard and reads as a disclosure to a screen reader, and it survives a
 * re-render of the thread without carrying any state of its own.
 */
export function ServiceFold({ count, children }: { count: number; children: ReactNode }) {
  const tr = useT();
  return (
    <details className="group rounded-md border border-app-border-subtle bg-white/[0.02]" data-testid="task-service-fold">
      <summary
        title={tr('board.task.serviceNotesTitle')}
        className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[11px] text-app-text-muted hover:text-app-text-heading"
      >
        <ChevronRight size={10} className="shrink-0 transition-transform group-open:rotate-90" />
        <span data-testid="task-service-fold-count">{count} {tr('board.task.serviceNotes')}</span>
      </summary>
      <div className="space-y-2 border-t border-app-border-subtle px-2 py-2">{children}</div>
    </details>
  );
}

/**
 * The thread, cut into runs of bookkeeping and runs of speech.
 *
 * `renderRow` draws a row exactly the same way folded or not - the fold changes
 * where a row sits, never how it looks - and gets the row's index in the ORIGINAL
 * list, which is what the caller needs to find the session steps belonging in the
 * gap above it.
 *
 * `breaksRun` forces a cut before a row even when both sides are bookkeeping:
 * the caller passes "something of mine is drawn in the gap above this row", and
 * a fold that swallowed that gap would hide it. The drawer no longer needs it
 * (the agent's steps moved into their own pane); it stays because it is the
 * contract of `groupServiceRuns`, which the server shares.
 */
export function ThreadRuns<T extends ThreadRunsRow>({ comments, breaksRun, renderRow, renderStatusRun, isService }: {
  comments: readonly T[];
  breaksRun?: (comment: T, index: number) => boolean;
  /** What folds. Absent = the thread's own rule (`isServiceComment`). */
  isService?: (comment: T) => boolean;
  renderRow: (comment: T, index: number) => ReactNode;
  /**
   * The transitions of a stretch, drawn as ONE thing instead of one paragraph
   * each. Status rows are the other half of the wall — 4406 of 9973 rows on the
   * live database — and every one of them was a full-width line saying a card
   * changed column. Given a renderer they collapse into a chip strip; without
   * one they keep going through `renderRow`, so nothing here depends on a
   * caller opting in.
   */
  renderStatusRun?: (comments: T[], startIndex: number) => ReactNode;
}) {
  const runs = useMemo(() => {
    // `start` = the index of the run's first row in the ORIGINAL list, carried
    // along because the runs partition it in order and nothing is dropped.
    const out: Array<{ service: boolean; comments: T[]; start: number }> = [];
    let start = 0;
    for (const run of groupServiceRuns(comments, breaksRun, isService)) {
      out.push({ ...run, start });
      start += run.comments.length;
    }
    return out;
  }, [comments, breaksRun, isService]);
  /**
   * A run's children. Without `renderStatusRun` this is the row-per-comment it
   * has always been; with it, adjacent transitions hand themselves to the strip
   * renderer as a group. The cut rule is the SAME `breaksRun` the outer split
   * uses, so a gap the caller marked splits the strip too — the alternative is
   * a chip strip that quietly spans over whatever sits in that gap.
   */
  const bodyOf = (run: { comments: T[]; start: number }): ReactNode[] => {
    if (!renderStatusRun) return run.comments.map((c, k) => renderRow(c, run.start + k));
    const out: ReactNode[] = [];
    let at = run.start;
    for (const stretch of groupStatusRuns(run.comments, (c, i) => !!breaksRun?.(c, run.start + i))) {
      if (stretch.status) out.push(
        <div key={`status-${(stretch.comments[0] as ThreadRunsRow).id}`}>{renderStatusRun(stretch.comments, at)}</div>,
      );
      else for (const [k, c] of stretch.comments.entries()) out.push(renderRow(c, at + k));
      at += stretch.comments.length;
    }
    return out;
  };
  return (
    <>
      {runs.map((run) => {
        const body = bodyOf(run);
        // A lone service note is not a wall: folding it would cost a click to
        // read one line that was already one line.
        return foldsAway(run)
          ? <ServiceFold key={run.comments[0]!.id} count={run.comments.length}>{body}</ServiceFold>
          : <div key={run.comments[0]!.id} className="space-y-2">{body}</div>;
      })}
    </>
  );
}
