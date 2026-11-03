import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { fmtLive, liveToolLabel } from './format';
import type { LiveTool, RetryWait } from './constants';
import { startVisibleInterval } from '../../state/documentVisibility';

// ── The live chips of a working card ──────────────────────────────────────
// What the foot of a card says WHILE the turn runs: the ticking effort chip,
// the wait before a retry, and the tool the session is running right now.
// All three re-render every second from their own interval; none of them
// knows the card, it is `Card.tsx` that decides which one is drawn.

/**
 * "Retry now" is a human comment on the working card: the /comments route
 * hands it to `dispatcher.resume`, which finds no turn in flight, starts one
 * at once and clears the retry timer on its way (`beginRun`). Same door as
 * the deliver-now choice: the words reach the agent, and the thread keeps the
 * trace that a person pressed it. The text is what the agent reads, in the
 * envelope's fallback language, like the deliver-now sentence.
 */
export const RETRY_NOW_MESSAGE = "Riprova adesso: il turno precedente e' finito per un errore, riprendi da dove eri."; // allow-italian: the sentence the agent reads

/**
 * The countdown to the retry, in the live chip's slot, with the reason and
 * the attempt count next to it ("retrying in 42s, provider error, 2/4"). The
 * raw error text is in the tooltip. "Retry now" skips the timer.
 */
export function RetryWaitChip({ retry, disabled, onRetryNow }: { retry: RetryWait; disabled?: boolean; onRetryNow: () => void }) {
  const tr = useT();
  const [, force] = useState(0);
  useEffect(() => {
    return startVisibleInterval(() => force((n) => n + 1), 1000);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- countdown: re-renders every 1s (interval above) and reads the clock each render on purpose
  const left = Math.max(0, retry.at - Date.now());
  return (
    <span
      data-testid="card-retry-wait"
      className="inline-flex min-w-0 items-center gap-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-compact leading-4 md:text-mini text-amber-800 dark:text-amber-300 tabular-nums"
      title={retry.detail ? tr('board.card.retryTitle', { detail: retry.detail }) : retry.reason}
    >
      <span className="truncate">
        {tr('board.card.retryIn', { in: fmtLive(left), reason: retry.reason, attempt: retry.attempt, cap: retry.cap })}
        {retry.free ? tr('board.card.retryFree') : ''}
      </span>
      <button
        type="button"
        data-testid="card-retry-now"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); onRetryNow(); }}
        title={tr('board.card.retryNowTitle')}
        className="shrink-0 rounded bg-amber-500/25 px-1.5 py-px text-mini font-medium text-amber-100 hover:bg-amber-500/40 disabled:opacity-50"
      >{tr('board.card.retryNow')}</button>
    </span>
  );
}

/**
 * "Bash · bun run test:unit · 3m": the running tool and for how long, ticking.
 *
 * WHILE THE COMMAND IS FROZEN THE CLOCK STOPS, and so does the interval. A
 * stopwatch running over a process Topics has SIGSTOPped tells the person the
 * command is making progress, which is the opposite of what happened; and a
 * one-second repaint under a canvas that just painted itself is the kind of
 * cost the freeze exists to avoid. The line says `congelato` instead.
 */
export function LiveToolLine({ tool, frozen = false }: { tool: LiveTool; frozen?: boolean }) {
  const tr = useT();
  const [, force] = useState(0);
  useEffect(() => {
    if (frozen) return;
    return startVisibleInterval(() => force((n) => n + 1), 1000);
  }, [frozen]);
  // eslint-disable-next-line react-hooks/purity -- live tool line: re-renders every 1s (interval above) and reads the clock each render on purpose
  const since = fmtLive(Math.max(0, Date.now() - tool.since));
  const label = liveToolLabel(tool);
  const text = frozen ? `${label} · ${tr('swapFreeze.frozenShort')}` : `${label} · ${since}`;
  return (
    <p
      data-testid="card-live-tool"
      className="mt-1 truncate text-compact leading-4 md:text-mini tabular-nums text-app-text-muted"
      title={frozen ? tr('swapFreeze.frozenShort') : tr('board.card.liveToolTitle', { tool: label, since })}
    >{text}</p>
  );
}

