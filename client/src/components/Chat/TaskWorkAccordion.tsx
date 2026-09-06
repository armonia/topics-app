/**
 * ONE CLOSED ROW FOR THE WORK OF A TURN, in the chat of a board task.
 *
 * The transcript of a task is read by someone who has to approve it, and what
 * they need is the words: what the agent says, asks and delivers. The proof of
 * the work (tool runs, sub-agents, checks) is what makes that page long. Here
 * the whole stretch collapses into one line that says how much happened, and
 * opens onto exactly the rows that were there before: nothing is dropped, and
 * the click gets everything back.
 *
 * It exists ONLY inside a task session (`TaskWorkFoldContext`, fed by the topic
 * index): a normal conversation renders as it always has.
 *
 * Which messages fold, and which never do, is decided by `taskWorkFold.ts` and
 * proven there.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Users, Workflow, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { ChatMessage } from '../../types';
import { formatDurationMs, formatToolCounts, isWhollyFailed } from './toolGrouping';
import { baseName, summarizeWork } from './taskWorkFold';

/** Up to this many file names spell themselves out; past it, a count. */
const FILES_SPELLED = 2;

export function TaskWorkAccordion({ msg, children }: { msg: ChatMessage; children: ReactNode }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeWork([msg]), [msg]);

  const total = summary.total;
  const failed = isWhollyFailed(summary);
  // Reasoning with no action at all still deserves a row: it is a turn that
  // thought and said nothing, and hiding it entirely would lose the turn.
  const title = total > 0
    ? tr(total === 1 ? 'chat.taskWork.action' : 'chat.taskWork.actions', { n: String(total) })
    : tr('chat.taskWork.reasoning');
  const files = summary.files.length <= FILES_SPELLED
    ? summary.files.map(baseName).join(', ')
    : tr('chat.taskWork.files', { n: String(summary.files.length) });

  return (
    <div
      data-testid="task-work-accordion"
      data-open={open ? 'true' : 'false'}
      data-actions={String(total)}
      className="my-0.5 text-[12px]"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={tr('chat.taskWork.summaryTitle')}
        data-testid="task-work-summary"
        className="w-full rounded border border-app-border/60 bg-app-bg-secondary/40 px-2 py-1 text-left text-app-text-secondary transition-colors hover:bg-app-bg-secondary/80 hover:text-app-text"
      >
        <span className="flex items-center gap-2">
          <span className="flex-shrink-0 inline-flex">
            {open
              ? <ChevronDown size={12} className="text-app-text-muted" />
              : <ChevronRight size={12} className="text-app-text-muted" />}
          </span>
          <Workflow size={13} className="flex-shrink-0 text-app-text-muted" />
          <span
            data-testid="task-work-title"
            className={`flex-shrink-0 font-medium ${failed ? 'text-red-500' : 'text-app-text'}`}
          >
            {title}
          </span>
          {summary.errors > 0 && (
            <span
              data-testid="task-work-errors"
              className="flex-shrink-0 inline-flex items-center gap-0.5 tabular-nums text-[11px] text-red-500"
            >
              <X size={11} /> {tr('chat.taskWork.failed', { n: String(summary.errors) })}
            </span>
          )}
          {summary.subAgents > 0 && (
            <span
              data-testid="task-work-subagents"
              className="flex-shrink-0 inline-flex items-center gap-0.5 text-[11px] text-app-text-muted"
            >
              <Users size={11} /> {summary.subAgents}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] text-app-text-muted">
            {formatToolCounts(summary.counts)}
          </span>
          {files && (
            <span
              data-testid="task-work-files"
              className="hidden flex-shrink-0 items-center gap-1 text-[11px] text-app-text-muted sm:inline-flex"
            >
              <FileDiff size={11} /> {files}
            </span>
          )}
          {summary.durationMs !== undefined && (
            <span
              data-testid="task-work-duration"
              className="flex-shrink-0 tabular-nums text-[10px] text-app-text-muted"
            >
              {formatDurationMs(summary.durationMs)}
            </span>
          )}
        </span>
      </button>
      {/* Open: the same rows as always, indented under the line that summed
          them up. Mounted only when open, so a closed transcript does not pay
          for the tool bodies it is not showing. */}
      {open && (
        <div data-testid="task-work-body" className="ml-[9px] mt-0.5 border-l border-app-border/50 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}
