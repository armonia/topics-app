/**
 * «Outside the board»: the hub's waiting items that no card accounts for.
 * An item tied to a card that already waits for the person is that same wait
 * and is merged into the card's row (see `splitHubWaits`), so this section
 * lists only the rest: items without a card, or whose card waits for nothing.
 *
 * Silent without the hub or without such items.
 */
import { useMemo } from 'react';
import { CircleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useHubLive } from '../../state/hubLive';
import { waitingItems } from '../../lib/hubSystem';
import { splitHubWaits } from '../../../../shared/hub-attesa';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import type { PlanTree } from '../../../../shared/plan';

export function PlanHubWaits({ tree, onOpenTask }: { tree: PlanTree | null; onOpenTask: (id: string) => void }) {
  const tr = useT();
  const live = useHubLive();
  const outside = useMemo(() => {
    const waitingCards = new Set((tree?.projects ?? []).flatMap((p) => p.needsYou.map((n) => n.taskId)));
    return splitHubWaits(waitingItems(live.attesa?.data), waitingCards).outside;
  }, [tree, live.attesa?.data]);
  if (outside.length === 0) return null;
  return (
    <section data-testid="plan-hub-waits" className="mt-3 flex flex-col gap-0.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
      <span className={`flex items-center gap-1 text-mini font-medium ${SEGNALE_ATTESA}`}>
        <CircleAlert className="h-3 w-3 shrink-0" aria-hidden />{tr('plan.hubWaits.title', { n: outside.length })}
      </span>
      {outside.map((w) => (
        <div key={w.id} data-testid="plan-hub-wait" title={w.why ? `${w.title}\n${w.why}` : w.title} className="flex min-w-0 items-baseline gap-1.5 px-1 py-0.5">
          <span className="min-w-0 flex-1 truncate text-compact text-app-text">{w.title}</span>
          {w.taskId && <button type="button" onClick={() => onOpenTask(w.taskId!)} className="shrink-0 text-mini text-app-text-muted hover:underline">{w.taskId.slice(0, 8)}</button>}
        </div>
      ))}
    </section>
  );
}
