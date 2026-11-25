import { Timer, TrendingUp } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { taskCountdown, type CountdownInput } from '../../../../shared/task-countdown';
import { countdownText, countdownTitle } from '../../lib/etaText';

/**
 * How long a card in progress still has to go. The figure is checked at half,
 * three quarters and the end of the estimate and raised when the card will not
 * make it: then it turns amber and says it was re-estimated. Draws nothing
 * without an estimate: no figure beats a made-up one.
 */
export function TaskCountdown(props: CountdownInput & { className?: string }) {
  const tr = useT();
  const c = taskCountdown(props);
  if (!c) return null;
  const revised = c.revisedAt !== null;
  const Icon = revised ? TrendingUp : Timer;
  return (
    <span
      data-testid="card-countdown"
      data-state="left"
      data-revised={revised ? 'true' : 'false'}
      title={countdownTitle(tr, c, props.elapsedMs)}
      className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums ${revised ? 'text-amber-600 dark:text-amber-400' : 'text-app-text-secondary'} ${props.className ?? ''}`}
    >
      <Icon size={11} aria-hidden="true" />{countdownText(tr, c)}
    </span>
  );
}
