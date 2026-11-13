import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import { type BoardTask, NOT_MEASURED_EXIT, type CheckRun } from '../../lib/board';
import { taskActionWord } from './taskActionWords';
import { ChevronRight, X, Check, ChevronDown, Hourglass } from 'lucide-react';

/**
 * Outcome of the pre-review checks, next to the decision buttons.
 *
 * Renders nothing when they never ran: "no checks" is NOT a green, and a green
 * light on a board with no declared commands would be a reassuring lie.
 * Green = a single line (it is evidence, not a report); red = command, exit
 * code and output tail, i.e. what you need to understand without opening a
 * terminal.
 */
export function ChecksSection({ task }: { task: BoardTask }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  if (!task.checksState) return null;

  if (task.checksState === 'running') {
    const progress = task.checksProgress;
    const ci = task.checksCi;
    return (
      <div className="rounded bg-white/5 px-2 py-1.5 text-mini text-app-text-heading">
        <div className="flex items-center gap-1.5">
          <Spinner size="sm" tone="current" className="shrink-0 text-app-text-secondary" />
          {progress
            ? tr('board.task.checks.runningProgress', { done: progress.done, total: progress.total })
            : tr('board.task.checks.running')}
        </div>
        {/* The CI links, as soon as they exist. A `github-ci:` line waits on
            GitHub for about fifteen minutes and until now the card had
            nothing to open: the PR and the run only showed up in the verdict
            tail, i.e. when the wait was already over. */}
        {ci && (
          <div className="mt-1 flex flex-wrap items-center gap-2 pl-5 text-app-text-secondary">
            <a href={ci.prUrl} target="_blank" rel="noreferrer" className="underline hover:text-app-text-heading">
              {tr('board.task.checks.ciPr')}
            </a>
            {ci.runUrl && (
              <a href={ci.runUrl} target="_blank" rel="noreferrer" className="underline hover:text-app-text-heading">
                {tr('board.task.checks.ciRun')}
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  const runs = task.checks ?? [];
  const failed = runs.find((r) => !r.ok);
  const failedIndex = failed ? runs.indexOf(failed) : -1;
  const failedLabel = failed
    ? failed.name !== failed.cmd && failed.name.length <= 64
      ? failed.name
      : tr('board.task.checks.numbered', { n: failedIndex + 1 })
    : null;
  // "exit 97" is not an outcome to read: it is the code the gate uses to mean
  // NOT MEASURED, and written that way it sent reviewers hunting for a failure.
  const short = (r: CheckRun) =>
    r.spawnError ? tr('board.task.checks.notStarted')
      : r.timedOut ? tr('board.task.checks.timedOut')
        : r.notMeasured || r.code === NOT_MEASURED_EXIT ? tr('board.task.checks.notMeasured')
          : `exit ${r.code}`;
  // The time stays in the Italian format because `2-digit`/`2-digit` renders it
  // as `14:05` in every language this app speaks: no text, no 12h/24h to
  // decide. The day the drawer gets real dates, the format becomes a locale
  // choice and must be made in a single place (`format.ts`), not here.
  const when = task.checksAt ? new Date(task.checksAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
  const at = when ? ` ${tr('board.task.checks.at', { t: when })}` : '';

  if (task.checksState === 'pass') {
    return (
      <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1.5 text-mini text-emerald-200">
        <Check className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {tr('board.task.checks.pass')}{at}{runs.length ? `: ${runs.map((r) => r.name).join(', ')}` : ''}
        </span>
      </div>
    );
  }

  /* THREE OUTCOMES, NOT TWO: and the third is not a shade of the second.
   *
   * A NOT MEASURED line (exit 97) arrives here as `checksVerdict = 'unknown'`
   * and used to fall into the red block with the wording "Checks RED" (in
   * Italian): red says "the code is broken, do not approve", not measured says
   * "we don't know", and reviewers decide differently in the two cases. The
   * card chip already tells them apart in amber (`Card.tsx`,
   * `board.card.checksUnknown`): two opposite verdicts on the same card are
   * worse than neither. With the CI lines, which read GitHub and measure
   * nothing when the run dies, it is the most likely bucket after green. */
  const unmeasured = task.checksState === 'unknown';
  const box = unmeasured ? 'bg-amber-500/10 text-amber-200' : 'bg-rose-500/10 text-rose-200';
  const headline = unmeasured ? tr('board.task.checks.unknown') : tr('board.task.checks.fail');
  return (
    <div className={`rounded text-mini ${box}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-white/5"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {headline}{at}{failed ? `: ${failedLabel} (${short(failed)})` : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {runs.map((r, i) => (
            <div key={i}>
              <div className={r.ok ? 'text-emerald-300' : r.notMeasured || r.code === NOT_MEASURED_EXIT ? 'text-amber-200' : 'text-rose-200'}>
                {r.ok
                  ? <Check size={14} className="inline-block text-emerald-300" aria-hidden="true" />
                  : r.notMeasured || r.code === NOT_MEASURED_EXIT
                    ? <Hourglass size={14} className="inline-block text-amber-300" aria-hidden="true" />
                    : <X size={14} className="inline-block text-rose-300" aria-hidden="true" />} <code className="font-mono">{r.cmd}</code>{r.ok ? '' : `: ${short(r)}`}
              </div>
              {!r.ok && (r.tail || r.spawnError) && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1.5 font-mono text-mini leading-snug text-app-text-heading">
                  {r.spawnError ?? r.tail}
                </pre>
              )}
            </div>
          ))}
          <p className="text-app-text-secondary">
            {tr('board.task.checks.hintLead')} <b>{taskActionWord('send-back', tr).label}</b>{tr('board.task.checks.hintTail')}
          </p>
        </div>
      )}
    </div>
  );
}
