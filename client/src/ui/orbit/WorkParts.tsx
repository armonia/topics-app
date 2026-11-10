import { ArrowRight, Bot, CheckCircle2, CirclePause, FlaskConical, Link, Sparkles, Split, User, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Chip } from '../primitives/Chip';
import { Avatar } from '../shell/SidebarRows';
import { FOCUS_RING } from '../shell/pressable';
import type { CardLinkModel, FlowRowModel, FlowState, FlowStatusModel, WorkActorModel } from './work-model';

/** The glyphs of the flow states, the same as the flow chips of the other organizations (`flows/FlowList.tsx`). */
const FLOW_STATE_ICON: Record<FlowState, LucideIcon> = { active: CheckCircle2, testing: FlaskConical, draft: Sparkles, paused: CirclePause };

/** The state of a flow as a chip, with its glyph; `version` adds `· v2` as on the flow pages of Topics. */
export function FlowStateChip({ status, version }: { status: FlowStatusModel; version?: number }) {
  return <Chip tone={status.tone} icon={FLOW_STATE_ICON[status.state]} strong>{status.text}{version ? ` · v${version}` : ''}</Chip>;
}

/**
 * Who does a step or holds a card, as one chip: a rule in blue, an agent with
 * the robot glyph and its name, a program in green, a person with the avatar
 * of their monogram. The same chip on «Oggi», the flow and the step page. (allow-italian: quotes the Italian interface)
 */
export function ActorBadge({ actor }: { actor: WorkActorModel }) {
  switch (actor.kind) {
    case 'rule': return <Chip tone="blue" icon={Split} strong>{actor.label}</Chip>;
    case 'agent': return <Chip tone="pink" icon={Bot} strong>{actor.name}</Chip>;
    case 'program': return <Chip tone="green" icon={Link} strong>{actor.name}</Chip>;
    case 'action': return <Chip icon={ArrowRight} strong>{actor.name}</Chip>;
    case 'person':
      /* A person the flow names by role only (no one known): the amber person chip of the flow pages. */
      if (!actor.monogram) return <Chip tone="amber" icon={User} strong>{actor.name}</Chip>;
      return (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-black/[0.05] pl-0.5 pr-1.5 text-mini font-medium leading-4 text-app-text dark:bg-white/10">
          <Avatar text={actor.monogram} color={actor.color ?? '#64748b'} size={16} />
          {actor.name}
        </span>
      );
  }
}

/** A card of the kanban as a small link: id, title, a red dot when it is stopped. */
export function CardLink({ card, className }: { card: CardLinkModel; className?: string }) {
  return (
    <button
      type="button"
      onClick={card.onOpen}
      data-tip={card.hint}
      className={clsx(
        'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-surface px-2 text-mini transition-colors',
        card.stopped ? 'border-rose-500/40' : 'border-app-border',
        'hover:border-primary/50 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]',
        FOCUS_RING,
        className,
      )}
    >
      {card.stopped && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />}
      <span className="shrink-0 font-semibold tabular-nums text-app-text">{card.id}</span>
      <span className="min-w-0 truncate text-app-text-secondary">{card.title}</span>
    </button>
  );
}

/**
 * The live cards of a flow at each of its steps, as a row of small cells in
 * step order: each cell carries the number the flow page gives the step above
 * and the count of cards below (its name is in the tip). The number is 11px and the count 12px, in cells never under 24px wide: when the steps do not fit the column they wrap to a second row instead of shrinking. A filled cell holds
 * cards, a faint one is empty, a grey one is the closing step (cards already done). Read left to right, it shows where the work of
 * the flow stands.
 */
export function StepStrip({ steps, label }: { steps: FlowRowModel['steps']; label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0 flex-wrap items-center gap-1">
      {steps.map((s) => (
        <span
          key={s.id}
          data-tip={s.hint}
          className={clsx(
            'inline-flex min-w-6 flex-col items-center justify-center rounded px-1.5 py-1 font-semibold tabular-nums',
            s.done ? 'bg-black/[0.06] text-app-text-secondary dark:bg-white/[0.08]' : s.count ? 'bg-sky-500/15 text-sky-800 dark:text-sky-300' : 'bg-black/[0.04] text-app-text-faint dark:bg-white/[0.06]',
          )}
        >
          <span className="text-mini font-medium leading-3 opacity-80">{s.n}</span>
          <span className="text-compact leading-4">{s.count || '-'}</span>
        </span>
      ))}
    </span>
  );
}
