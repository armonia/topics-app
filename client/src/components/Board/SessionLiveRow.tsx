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
import { SparkLoader } from '../Layout/StreamingIndicator';
import { TurnLoader } from '../Chat/TurnLoader';
import { useT } from '../../hooks/useT';
import { fmtLive } from './format';
import { startVisibleInterval } from '../../state/documentVisibility';

/** Live "how long has this been running" ticker (anchored server-side). */
export function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    return startVisibleInterval(() => force((n) => n + 1), 1000);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live ticker: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtLive(ms) : '0s'}</>;
}

export function SessionLiveRow({ phase, since, tool }: {
  /** Already-translated dispatch phase ("queued...", "starting agent...", ...). */
  phase: string;
  /** Start of the current run, when it is actually running: drives the ticker. */
  since?: string | null;
  /** Short label of the tool running now, when known. */
  tool?: string | null;
}) {
  const tr = useT();
  return (
    <TurnLoader
      testId="task-session-live"
      icon={<SparkLoader className="shrink-0" state="working" />}
      phrase={phase}
      phraseClassName="turn-activity-phrase font-medium"
      tool={tool}
      runningLabel={tr('turn.running')}
    >
      {since && <span className="tabular-nums text-app-text-muted whitespace-nowrap"><Ticker since={since} /></span>}
    </TurnLoader>
  );
}
