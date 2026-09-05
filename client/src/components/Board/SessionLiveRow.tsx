/**
 * "IS IT STILL WORKING", asked where you write.
 *
 * A composer with no sign of life above it reads as an agent that stopped, so
 * the running turn gets a row of its own at the tail of the card's
 * conversation: the dispatch phase, how long it has been at it, and Stop.
 *
 * It no longer carries a PREVIEW of the stream. It used to: the steps lived in
 * a separate pane, so one italic line of the last tokens was the only thing the
 * thread could show of a turn in flight. Now the streaming row IS in the
 * conversation, right above this one, whole and rendered like every other step.
 * A one-line copy of the same tokens under it would be the same words twice,
 * and the button that jumped to the other pane has nowhere left to jump.
 */
import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import { fmtLive } from './format';
import { taskActionWord } from './taskActionWords';

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

export function SessionLiveRow({ phase, since, stopping, onStop }: {
  /** Already-translated dispatch phase ("queued...", "starting agent...", ...). */
  phase: string;
  /** Start of the current run, when it is actually running: drives the ticker. */
  since?: string | null;
  stopping: boolean;
  onStop: () => void;
}) {
  const tr = useT();
  const stopWord = taskActionWord('stop', tr);
  return (
    <div className="space-y-1.5" data-testid="task-session-live">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-2">
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400/80" style={{ animationDelay: `${d}ms` }} />
          ))}
          <span className="ml-1.5 text-[11px] text-app-text-secondary">
            {phase}
            {since && <span className="text-app-text-muted"> <Ticker since={since} /></span>}
          </span>
        </div>
        <button
          disabled={stopping} onClick={onStop}
          title={stopWord.title}
          className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
        >{stopping ? <Spinner size="sm" tone="current" /> : <Square className="h-3 w-3 fill-current" />} {stopWord.label}</button>
      </div>
    </div>
  );
}
