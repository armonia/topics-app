/**
 * THE PROJECT'S PAUSE, as a strip: above the composer of every chat of the
 * project and on top of its board. Same text, same two buttons everywhere; the
 * answer goes to the server and the `project:quota` frame that comes back hides
 * the strip in every window at once, this one included.
 */
import { useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { answerProjectPause, useProjectPause } from '../../hooks/useProjectPause';
import { boardIdForPath } from '../../lib/board';
import { CHAT_STRIP } from '../../lib/chatStripStyles';

const BTN = 'rounded px-2 py-1 text-mini font-medium coarse:min-h-11 hover:bg-black/5 dark:hover:bg-white/10';

export function ProjectPauseStrip({ projectPath, surface }: { projectPath?: string | null; surface: 'chat' | 'board' }) {
  const tr = useT();
  const projectId = projectPath ? boardIdForPath(projectPath) : '';
  const pause = useProjectPause(projectId);
  const [busy, setBusy] = useState<'continue' | 'hold' | null>(null);
  const [failed, setFailed] = useState(false);
  if (!projectId || !pause.paused) return null;
  const answer = async (action: 'continue' | 'hold') => {
    setBusy(action);
    setFailed(false);
    const ok = await answerProjectPause(projectId, action);
    setBusy(null);
    if (!ok) setFailed(true);
  };
  const held = pause.reason === 'hold-until-tomorrow';
  return (
    <div
      data-testid={`project-pause-strip-${surface}`}
      data-reason={pause.reason ?? ''}
      role="status"
      className={`${CHAT_STRIP} flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-800/40 dark:bg-rose-900/20`}
    >
      <PauseCircle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-mini font-medium text-rose-700 dark:text-rose-300">
          {tr(held ? 'projectPause.title.hold' : 'projectPause.title.limit')}
        </div>
        <div className="text-mini text-rose-600 dark:text-rose-400">
          {failed ? tr('projectPause.failed') : tr(held ? 'projectPause.detail.hold' : 'projectPause.detail.limit', { points: pause.points24h ?? 0, limit: pause.limit ?? 0 })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" data-testid="project-pause-continue" disabled={busy !== null} onClick={() => { void answer('continue'); }} className={`${BTN} text-rose-800 dark:text-rose-200`}>
          {tr('projectPause.continue')}
        </button>
        {!held && (
          <button type="button" data-testid="project-pause-hold" disabled={busy !== null} onClick={() => { void answer('hold'); }} className={`${BTN} text-rose-700 dark:text-rose-300`}>
            {tr('projectPause.hold')}
          </button>
        )}
      </div>
    </div>
  );
}
