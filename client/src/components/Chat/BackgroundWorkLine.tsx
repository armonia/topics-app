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
      <div className={CHAT_STRIP_ROW}>
        <span className={`flex flex-shrink-0 ${isStale ? 'opacity-70' : ''}`}>
          <OrbitLoader state="background" />
        </span>
        {n === 0 ? (
          <span className="min-w-0 flex-1 truncate text-compact text-app-text-secondary">{tr('chat.background.resuming')}</span>
        ) : (
          <>
            <span className="flex-shrink-0 text-compact text-app-text-secondary">
              {n === 1 ? tr('chat.background.waitingOne') : tr('chat.background.waitingMany', { n })}
            </span>
            <span className="min-w-0 flex-1 truncate text-compact text-app-text">{names}</span>
          </>
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
