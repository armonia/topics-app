/**
 * THE «FRENATO» TAG ON THE SIDEBAR'S BOARD ROW (HUBBR-20): the board's chip
 * seen from outside the board, so a held queue shows without opening it.
 * Present only while a provider's wall holds at least one Todo card.
 */
import { CirclePause } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { useDispatchBrakes } from '../../state/dispatchBrakes';
import { providerHoldLabel } from '../../../../shared/provider-hold';
import { holdingBrakes } from '../Board/brakeText';

export function BoardBrakeTag() {
  const tr = useT();
  const state = useDispatchBrakes();
  const holding = holdingBrakes(state);
  if (holding.length === 0) return null;
  const who = holding.map((b) => providerHoldLabel(b.provider)).join(' + ');
  return (
    <span
      data-testid="sidebar-board-brake"
      title={tr('sidebar.board.brakeTitle', { n: state.held.size, who })}
      className={`inline-flex h-4 flex-shrink-0 items-center gap-0.5 rounded-sm bg-amber-500/[0.14] px-1 text-mini font-semibold leading-none dark:bg-amber-400/[0.12] ${WARNING_TEXT}`}
    >
      <CirclePause className="h-[11px] w-[11px]" aria-hidden="true" />
      {tr('sidebar.board.brake')}
    </span>
  );
}
