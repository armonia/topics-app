/**
 * "IS IT STILL WORKING", asked where you write.
 *
 * A composer with no sign of life above it reads as an agent that stopped, so
 * the running turn gets a row of its own at the tail of the card's
 * conversation: the dispatch phase and how long it has been at it.
 * The stop action belongs to the composer.
 *
 * It no longer carries a PREVIEW of the stream. It used to: the steps lived in
 * a separate pane, so one italic line of the last tokens was the only thing the
 * thread could show of a turn in flight. Now the streaming row IS in the
 * conversation, right above this one, whole and rendered like every other step.
 * A one-line copy of the same tokens under it would be the same words twice,
 * and the button that jumped to the other pane has nowhere left to jump.
 */
import { useEffect, useState } from 'react';
import { Spinner } from '../Shared/Spinner';
import { fmtLive } from './format';

/** Live "how long has this been running" ticker (anchored server-side). */
export function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live ticker: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtLive(ms) : '0s'}</>;
}

export function SessionLiveRow({ phase, since }: {
  /** Already-translated dispatch phase ("queued...", "starting agent...", ...). */
  phase: string;
  /** Start of the current run, when it is actually running: drives the ticker. */
  since?: string | null;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5 py-1 text-center text-[11px] text-app-text-secondary" data-testid="task-session-live">
      <Spinner size="sm" tone="current" className="shrink-0" />
      <span className="min-w-0">
        {phase}
        {since && <span className="whitespace-nowrap"> <Ticker since={since} /></span>}
      </span>
    </div>
  );
}
