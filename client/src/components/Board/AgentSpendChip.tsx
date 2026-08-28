/**
 * AGENT SPEND IN DOLLARS, in the board header, always.
 *
 * WHY IT EXISTS. Agent consumption was visible in TOKENS on the card and nowhere
 * in dollars: the cost probe sums the chat ledger, and a dispatched agent writes
 * to the board ledger. Two ledgers that do not add up on their own, and the
 * second one (measured: about 38% of the bill) appeared in no money figure at
 * all. A number that appears nowhere is not a budget, it is a variable.
 *
 * WHAT IT SHOWS, in this order: the last 24 hours, because that is the window in
 * which a night gone wrong can still be seen in time; the total and the unpriced
 * share in the tooltip, which is where detail belongs.
 *
 * WHEN IT TURNS AMBER: only if a cap is set and the window has reached it.
 * Without a cap there is no alarm to raise - you cannot be close to a limit that
 * does not exist, and colouring a spend "high" by a criterion nobody chose is
 * inventing a threshold behind their back.
 *
 * At zero spend there is no chip: a fresh install does not gain a placeholder
 * that says $0.00.
 */
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { formatTokens } from '../../lib/formatTokens';

/** Cents to dollars. Above one hundred dollars the cents are noise. */
export function spendLabel(cents: number): string {
  const v = cents / 100;
  return v >= 100 ? `$${Math.round(v).toLocaleString('it-IT')}` : `$${v.toFixed(2)}`;
}

export function AgentSpendChip() {
  const spend = useGlobalDispatchCap().spend;
  if (!spend) return null;
  if (spend.cents24h <= 0 && spend.centsTotal <= 0) return null;

  const capped = spend.capDayCents > 0;
  const over = capped && spend.cents24h >= spend.capDayCents;
  const cls = over
    ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
    : 'bg-white/5 text-app-text-secondary';

  const parti = [
    `Agenti: ${spendLabel(spend.cents24h)} nelle ultime 24 ore`,
    `${spendLabel(spend.centsTotal)} in tutto`,
  ];
  if (spend.unpriced24h > 0) {
    parti.push(`${formatTokens(spend.unpriced24h)} token non prezzabili non sono in questa cifra`);
  }
  // The cap line ONLY if there is a cap: on an install without caps the tooltip
  // must not name a limit, not even to say there is none.
  if (capped) {
    parti.push(
      over
        ? `tetto giornaliero superato (${spendLabel(spend.capDayCents)}): il turno successivo non parte`
        : `restano ${spendLabel(Math.max(0, spend.capDayCents - spend.cents24h))} sul tetto giornaliero`,
    );
  }

  return (
    <span
      data-testid="agent-spend-chip"
      title={parti.join(' · ')}
      className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium tabular-nums ${cls}`}
    >
      {spendLabel(spend.cents24h)}
      <span className="font-normal text-app-text-muted">24h</span>
    </span>
  );
}
