/**
 * THE COUNTS OF THE WORK on the System row: a glyph and a digit each.
 *
 * The names behind those digits used to be listed here too, one line per
 * agent, on top of Performance. They are the level «Agenti e lavori» now
 * (`AgentsJobsLevel`, HUBBR-13), next to the hub's queue and workflows, and
 * they still come from the same derivation as the card's badge
 * (`useActiveAgentRows`, `activeAgentCount`), so a row cannot exist without
 * being counted (BGVIS-03). The open digit is the INSTALLATION's own count,
 * served by `/api/system/presence`.
 */
import { Bot, MessagesSquare } from 'lucide-react';
import { CHIP_INK_DIM } from './identityChip';
import { SEGNALE_OK } from './chromeSignals';
import { SparkLoader } from '../Layout/StreamingIndicator';
import type { SignalKind, WorkSignal } from './workSignals';
import { useT } from '@/hooks/useT';

/**
 * The counts on the row that opens the level: a glyph and a number each.
 *
 * The glyph is the noun ("sessions", "turns") drawn instead of spelled: a word
 * costs six times what the icon costs and says the same thing. The `title`
 * gives the word back to whoever hovers, and to whoever reads with a screen
 * reader.
 */
export function WorkSignals({ signals }: { signals: WorkSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <span data-testid="presence-summary" className="flex flex-shrink-0 items-center gap-1.5 tabular-nums">
      {signals.map((s) => <Signal key={s.kind} kind={s.kind} n={s.n} title={s.title} />)}
    </span>
  );
}

function Signal({ kind, n, title }: { kind: SignalKind; n: number; title?: string }) {
  const tr = useT();
  const { Icon, tint, label, alive } = SIGNALS[kind];
  return (
    <span data-signal={kind} className={`flex items-center gap-0.5 ${tint}`} title={title ?? tr(label, { n })}>
      {alive ? <SparkLoader size={11} /> : <Icon size={11} />}
      <span>{n}</span>
    </span>
  );
}

/** Glyph, tier colour and sentence for each signal. One table, so a new signal
 *  is a line here and not a fourth place to keep in sync. */
const SIGNALS: Record<SignalKind, {
  Icon: typeof Bot;
  tint: string;
  label: string;
  alive?: boolean;
}> = {
  // The only pulsing one: it is the only one where something is happening
  // while you look at it.
  working: { Icon: Bot, tint: SEGNALE_OK, label: 'statusBar.signals.working', alive: true },
  open: { Icon: MessagesSquare, tint: CHIP_INK_DIM, label: 'statusBar.signals.open' },
};
