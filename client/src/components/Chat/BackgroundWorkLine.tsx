/**
 * WHAT THE CHAT IS WAITING ON, one line above the composer.
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
 */
import { memo } from 'react';
import { useT } from '../../hooks/useT';
import { useTopicBackgroundWork } from '../../state/signals';
import type { TopicBackgroundWork } from '../../state/backgroundWork';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact } from '../../state/workLongevity';
import { CHAT_STRIP_NEUTRAL, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import { OrbitLoader } from '../Layout/StreamingIndicator';

export const BackgroundWorkLine = memo(function BackgroundWorkLine({ topicId }: { topicId: string }) {
  const work = useTopicBackgroundWork(topicId);
  // Mounted only while there is work, so the shared clock ticks only then.
  return work ? <Line work={work} /> : null;
});

function Line({ work }: { work: TopicBackgroundWork }) {
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
      className={CHAT_STRIP_NEUTRAL}
      title={[names, tr('chat.background.free')].filter(Boolean).join('\n')}
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
          <span data-testid="background-work-names" className="min-w-0 grow basis-24 truncate text-compact text-app-text">{names}</span>
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
