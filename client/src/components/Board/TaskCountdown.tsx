import { Timer } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { taskCountdown, type CountdownInput } from '../../../../shared/task-countdown';
import { fmtMs } from './format';

/** Whole minutes, at least one: «~12 min», never «~0». */
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * How long a card in progress still has to go, or by how much it overran its
 * estimate. Draws nothing without an estimate: no figure beats a made-up one.
 */
export function TaskCountdown(props: CountdownInput & { className?: string }) {
  const tr = useT();
  const c = taskCountdown(props);
  if (!c) return null;
  const over = c.kind === 'over';
  const text = over
    ? tr('board.countdown.over', { min: minutes(c.overMs) })
    : tr('board.countdown.left', { min: minutes(c.remainingMs) });
  return (
    <span
      data-testid="card-countdown"
      data-state={c.kind}
      title={tr('board.countdown.title', { spent: fmtMs(props.elapsedMs) })}
      className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums ${over ? 'text-amber-600 dark:text-amber-400' : 'text-app-text-secondary'} ${props.className ?? ''}`}
    >
      <Timer size={11} aria-hidden="true" />{text}
    </span>
  );
}
