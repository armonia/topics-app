import { useT } from '../../hooks/useT';
import type { LandingBand } from './landingBand';

/**
 * THE LANDING BAND, one for both surfaces.
 *
 * The land is asynchronous and the card does not move until main confirms it:
 * without this line "queued", "refused" and "landed" all look the same, which
 * is to say like nothing. The drawer had its two bands written by hand and the
 * card had none; the sentence lives here now, and each surface only decides
 * where to put it.
 *
 * `compact` is the card's shape: same text, without the full-bleed band border
 * that would cut the column there.
 */
export function LandingNotice({ band, testId, compact }: { band: LandingBand; testId: string; compact?: boolean }) {
  const tr = useT();
  const pending = band.kind === 'queued' || band.kind === 'running';
  const tone = band.kind === 'failed' || band.kind === 'unlanded'
    ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
    : 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  const box = compact
    ? `mt-2 rounded-md border px-2 py-1.5 text-xs leading-snug ${tone}`
    : `shrink-0 border-b px-3 py-1.5 text-[11px] ${tone}`;
  return (
    <div data-testid={testId} className={box}>
      {!pending && '⚠️ '}
      {tr('board.task.land')} <strong>{tr(WORD[band.kind])}</strong>
      {band.kind === 'queued' && band.ahead > 0
        ? tr(band.ahead === 1 ? 'board.task.landQueuedRestOne' : 'board.task.landQueuedRestMany', { n: band.ahead })
        : null}
      {band.kind === 'running' || (band.kind === 'queued' && band.ahead === 0)
        ? tr('board.task.landRunningRest')
        : null}
      {band.kind === 'unlanded' ? tr('board.task.landUnlandedRest') : null}
      {band.kind === 'unverifiable' ? tr('board.task.landUnverifiableRest') : null}
      {/* The reason, when the server has one: it is the only part that says
          what to do now. On a failure there was never an empty space
          ("unknown error" is less than nothing, but it is a sentence). */}
      {band.kind === 'failed' ? `: ${band.detail ?? tr('board.task.landUnknownError')}` : null}
      {band.kind === 'unlanded' && band.detail ? ` ${band.detail}` : null}
    </div>
  );
}

/**
 * One word per phase, and it sits outside the JSX because the queued band and
 * the refused one are read side by side: were they to diverge, the same phase
 * would say two things on two surfaces.
 */
const WORD = {
  queued: 'board.task.landQueued',
  running: 'board.task.landRunning',
  failed: 'board.task.landFailed',
  unlanded: 'board.task.landUnlanded',
  unverifiable: 'board.task.landUnverifiable',
} as const;
