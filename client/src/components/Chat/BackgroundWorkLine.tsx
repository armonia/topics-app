/**
 * WHAT THE CHAT IS WAITING ON, the last row of the transcript.
 *
 * A turn that ends with an Agent, a Bash, a Monitor or a Workflow still running
 * leaves the chat with no turn open and nothing on screen: no phrase, no timer,
 * no spinner, while the CLI waits for its own work and will wake to answer it.
 * This line names that work, from the `background` row of
 * `/api/topics/streaming` (`useTopicBackgroundWork`), and goes away with it.
 *
 * NO STOP HERE. The composer already offers it with an empty field
 * (`composerAction.ts`), and two commands for one thing read as two things; the
 * tooltip says where it is.
 *
 * IT SITS UNDER THE LAST MESSAGE, NOT ABOVE THE COMPOSER. Mounted among the
 * strips of the composer block, every start and end of the work grew or shrank
 * that block: the composer jumped by the line's height and the transcript lost
 * it. As the last row of the list (Virtuoso's `Footer`, in `MessageList`) it
 * scrolls with the conversation, answers the turn it belongs to, and its
 * height reaches the list through `totalListHeightChanged`, the same hook that
 * keeps a chat at the bottom pinned while a reader scrolled up stays put.
 * `chat-measure` and the row padding put it on the message column, as
 * `QueuedTurns` beside it.
 *
 * Past `WORK_STALE_AFTER_MS` without news the line says for how long, with the
 * amber of `LabeledLoader`'s stale readout: the CLI may have stopped reporting.
 *
 * THE NAMES ARE WHAT THE LINE IS FOR, so they are the last thing to give up
 * room. On one row that cannot wrap, the label and the readout held their text
 * and the names took what was left: on a 375px phone, with work gone stale,
 * that was nothing. The row wraps instead. The names keep a 6rem floor on the
 * label's line, and whatever does not fit beside them (the readout first,
 * then the names themselves) goes below at full width. The glyph and the label
 * are one piece, so the ring never sits alone on a line.
 *
 * EACH TASK SAYS WHAT IT IS AND FOR HOW LONG (BGVIS-06), as Claude Code's own
 * list does: a Monitor carries the icon of the Monitor tool row, and every task
 * with a start time its running time. The CLI lists a Monitor as a plain
 * `local_bash`; the server recognises it from the tool call that armed it.
 *
 * A NEW TURN DOES NOT TAKE IT AWAY. The work of an earlier turn keeps running
 * while the next one is open, and the line keeps naming it until it ends
 * (BGVIS-05). Only the tooltip changes: with a turn open the chat is not free,
 * and the composer's Stop is the turn's.
 */
import { memo } from 'react';
import { Activity } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTopicBackgroundWork, useTopicLoading } from '../../state/signals';
import type { TopicBackgroundWork } from '../../state/backgroundWork';
import type { BackgroundTaskSummary } from '../../../../shared/background-work';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact, formatRunningFor } from '../../state/workLongevity';
import { CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import { OrbitLoader } from '../Layout/StreamingIndicator';

export const BackgroundWorkLine = memo(function BackgroundWorkLine({ topicId, isMobile }: { topicId: string; isMobile: boolean }) {
  const work = useTopicBackgroundWork(topicId);
  const turnOpen = useTopicLoading(topicId);
  // Mounted only while there is work, so the shared clock ticks only then.
  return work ? (
    <div className={`chat-measure pb-2 ${isMobile ? 'px-2' : 'px-4'}`}>
      <Line work={work} turnOpen={turnOpen} />
    </div>
  ) : null;
});

function Line({ work, turnOpen }: { work: TopicBackgroundWork; turnOpen: boolean }) {
  const tr = useT();
  const now = useSharedNow();
  const n = work.tasks.length;
  const names = work.tasks.map((t) => t.description).join(', ');
  // With no task listed a report is waking the CLI right now: that is news.
  const { isStale, elapsedMs } = deriveWorkLongevity(n > 0 ? work.lastSignalAt : undefined, now);
  return (
    <div
      data-testid="background-work-line"
      data-stale={isStale ? 'true' : undefined}
      className="rounded-lg border border-app-border/60 bg-app-hover/40 text-app-text"
      title={[names, turnOpen ? '' : tr('chat.background.free')].filter(Boolean).join('\n')}
    >
      <div className={`${CHAT_STRIP_ROW} flex-wrap gap-y-0.5`}>
        <span className="flex min-w-0 items-center gap-2">
          <span className={`flex flex-shrink-0 ${isStale ? 'opacity-70' : ''}`}>
            <OrbitLoader state="background" />
          </span>
          <span className="min-w-0 truncate text-compact text-app-text-secondary">
            {n === 0
              ? tr('chat.background.resuming')
              : n === 1 ? tr('chat.background.waitingOne') : tr('chat.background.waitingMany', { n })}
          </span>
        </span>
        {n > 0 && (
          <span data-testid="background-work-names" className="min-w-0 grow basis-24 truncate text-compact text-app-text">
            {work.tasks.map((t, i) => <Task key={`${i}:${t.description}`} task={t} now={now} last={i === n - 1} />)}
          </span>
        )}
        {isStale && (
          <span className="flex-shrink-0 text-micro tabular-nums text-amber-600 dark:text-amber-400">
            {tr('chat.background.stale', { t: formatElapsedCompact(elapsedMs) })}
          </span>
        )}
      </div>
    </div>
  );
}

function Task({ task, now, last }: { task: BackgroundTaskSummary; now: number; last: boolean }) {
  const tr = useT();
  const monitor = task.type === 'monitor';
  const running = task.startedAt ? formatRunningFor(Math.max(0, now - task.startedAt)) : '';
  return (
    <span data-testid="background-work-task" data-type={task.type}>
      {monitor && (
        <Activity className="mr-0.5 inline h-3 w-3 align-[-1px] text-app-text-secondary" role="img" aria-label={tr('chat.background.monitor')} />
      )}
      {task.description}
      {running && (
        <span data-testid="background-work-running" className="tabular-nums text-app-text-secondary">{` ${running}`}</span>
      )}
      {!last && ', '}
    </span>
  );
}
