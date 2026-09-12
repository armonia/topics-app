/**
 * WHO IS WORKING, one line per agent.
 *
 * These lines used to be a level of their own, opened from an «active agents»
 * row that sat above the commands. There are no two questions there: «what is
 * running» and «what is this machine spending» are the same question asked at
 * two zoom levels, and answering them in two rows meant reading a number in
 * one place and the names that make it up in another. They are one level now
 * (`SidebarSystemMenu`), and this file is the half of it that names the work.
 *
 * TWO SCOPES, AND THEY ARE NOT THE SAME QUESTION. These rows and the badge on
 * the card are what THIS window's signals can see, from one derivation
 * (`useActiveAgentRows`), so a row cannot exist without being counted. The
 * glyphs in the row's tail are the INSTALLATION's own counts, served by
 * `/api/system/presence`: a machine with sessions running behind another
 * window shows a tail digit larger than the badge, and that is the honest
 * reading of both.
 *
 * Read-only rows: there is no shared helper to jump from a row to its session
 * yet, and a row that looks like a button and does nothing is worse than text.
 */
import { Bot, MessagesSquare } from 'lucide-react';
import { CHIP_INK_DIM } from './identityChip';
import { SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';
import type { SignalKind, WorkSignal } from './workSignals';
import { useT } from '@/hooks/useT';
import { useActiveAgentRows, type ActiveAgentRow } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';

export function AgentLines() {
  const tr = useT();
  const { working, awaitingInput, finished } = useActiveAgentRows(useTerminalSessions(), useTopics());
  return (
    <div className="max-h-[240px] overflow-y-auto py-1">
      {working.map((r) => <AgentLine key={`${r.kind}:${r.id}`} row={r} testId="active-agent-row" alive />)}
      {awaitingInput.length > 0 && (
        <>
          <div className={`px-3 pb-0.5 pt-1.5 text-micro uppercase tracking-wide ${SEGNALE_ATTESA}`}>
            {tr('statusBar.agents.awaitingHeading')}
          </div>
          {awaitingInput.map((r) => <AgentLine key={`${r.kind}:${r.id}`} row={r} testId="awaiting-agent-row" />)}
        </>
      )}
      {/* THE FINISHED TURNS, BY NAME. They used to be a bare number, in a row
          of the account panel reading «3 to look at (turn ended or paused)»:
          the one thing in the whole menu that was counted without being
          openable, and it sat in a block about your account rather than about
          the work. Here they stand beside the other two lists under the same
          rule: the number on the card is the length of these rows. */}
      {finished.length > 0 && (
        <>
          <div className={`px-3 pb-0.5 pt-1.5 text-micro uppercase tracking-wide ${CHIP_INK_DIM}`}>
            {tr('statusBar.agents.finishedHeading')}
          </div>
          {finished.map((r) => <AgentLine key={`${r.kind}:${r.id}`} row={r} testId="finished-agent-row" tone={CHIP_INK_DIM} />)}
        </>
      )}
      {working.length === 0 && awaitingInput.length === 0 && finished.length === 0 && (
        <div className="px-3 py-2 text-mini text-app-text-secondary">{tr('statusBar.agents.none')}</div>
      )}
    </div>
  );
}

/** One agent, one line: the glyph says what kind of thing it is, the label
 *  says which. The working glyph pulses, like its digit in the tail.
 *
 *  `tone` overrides the glyph's colour for the third list: a turn that ENDED
 *  is not waiting on you the way an approval prompt is, and painting the two
 *  the same amber is how a colour that means "answer me now" stops meaning
 *  anything. */
function AgentLine({ row, testId, alive = false, tone = SEGNALE_ATTESA }: { row: ActiveAgentRow; testId: string; alive?: boolean; tone?: string }) {
  const Icon = row.kind === 'terminal' ? Bot : MessagesSquare;
  return (
    <div data-testid={testId} data-kind={row.kind} className="flex items-center gap-2 px-3 py-1 text-mini text-app-text" title={row.label}>
      <Icon size={12} className={`flex-shrink-0 ${alive ? `animate-pulse ${SEGNALE_OK}` : tone}`} />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
    </div>
  );
}

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
      {signals.map((s) => <Signal key={s.kind} kind={s.kind} n={s.n} />)}
    </span>
  );
}

function Signal({ kind, n }: { kind: SignalKind; n: number }) {
  const tr = useT();
  const { Icon, tint, label, alive } = SIGNALS[kind];
  return (
    <span className={`flex items-center gap-0.5 ${tint}`} title={tr(label, { n })}>
      <Icon size={11} className={alive ? 'animate-pulse' : undefined} />
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
