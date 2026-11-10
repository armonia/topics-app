/**
 * The small pieces every view of the kanban shares: the glyph of a stage (the
 * Board's column glyphs), who has a card in hand (a person's monogram in their
 * colour, or an agent's bot glyph with its name), and the coloured word of a
 * card.
 */
import { Bot, CirclePause, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Chip } from '../primitives/Chip';
import { Avatar } from '../shell/SidebarRows';
import { TONE_CHIP } from '../tone';
import type { FlowRefModel, StageGlyph, TagModel, WorkerModel } from './model';
import { STAGE_GLYPH } from './glyphs';

export function StageIcon({ glyph, size = 15, className }: { glyph: StageGlyph; size?: number; className?: string }) {
  const g = STAGE_GLYPH[glyph];
  const Icon = g.icon;
  return <Icon size={size} className={clsx('shrink-0', g.className, className)} aria-hidden="true" />;
}

/**
 * The flow of a card: its icon and its short name in plain text, never a colour.
 * `wrap`: a long name goes to the next line instead of ending in an ellipsis
 * (the kanban card never cuts a word).
 */
export function FlowLabel({ flow, wrap, className }: { flow: FlowRefModel; wrap?: boolean; className?: string }) {
  const Icon = flow.icon;
  return (
    <span data-tip={flow.title} className={clsx('inline-flex min-w-0 gap-1 text-mini leading-4 text-app-text-secondary', wrap ? 'items-start' : 'items-center', className)}>
      <Icon size={12} className={clsx('shrink-0 text-app-text-tertiary', wrap && 'mt-0.5')} aria-hidden="true" />
      <span className={clsx('min-w-0', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{flow.label}</span>
    </span>
  );
}

/**
 * A coloured word. `fit`: it may shrink with its row and end in an ellipsis
 * (the full word stays in the tooltip), for a line that also has to hold a
 * button at its end; the plain chip never shrinks.
 */
export function Tag({ tag, icon, fit, className }: { tag: TagModel; icon?: LucideIcon; fit?: boolean; className?: string }) {
  if (fit) {
    return (
      <span data-tip={tag.title ? `${tag.text}: ${tag.title}` : tag.text} className={clsx('inline-flex h-5 min-w-0 items-center rounded px-1.5 text-mini leading-4', TONE_CHIP[tag.tone], className)}>
        <span className="min-w-0 truncate">{tag.text}</span>
      </span>
    );
  }
  return <Chip tone={tag.tone} icon={icon} title={tag.title} className={className}>{tag.text}</Chip>;
}

/**
 * The one token of «Ferma da…» (allow-italian: quotes the Italian interface): same shape and pause glyph
 * wherever a card is stopped. Its tone says why: red when a reason is written
 * under it (blocked on something outside the card), amber when the card only
 * waited past the limit of its flow.
 */
export function StoppedTag({ tag, className }: { tag: TagModel; className?: string }) {
  return <Tag tag={tag} icon={CirclePause} className={className} />;
}

/**
 * Who has a card: the face (monogram or bot) and the short name, then how long
 * (unless `hideSince`) and, unless `compact`, what they are doing. An agent at work wears a pulsing
 * dot on its glyph.
 */
export function WorkerBadge({ worker, compact, hideSince, sinceBelow, wrap, atWorkLabel, className }: {
  worker: WorkerModel;
  compact?: boolean;
  /** Leave out «da 12 min»: a list that has its own «Nello stato da» column would print two different times for one card. (allow-italian: quotes the Italian interface) */
  hideSince?: boolean;
  /** Narrow place (a card): the time leads the line under the name, so the name keeps the whole row instead of ending in an ellipsis. */
  sinceBelow?: boolean;
  /** The name and what they are doing run on as many lines as they need, never cut (the kanban card). */
  wrap?: boolean;
  /** The accessible name of the pulsing dot. */
  atWorkLabel?: string;
  className?: string;
}) {
  const face = worker.kind === 'agent' ? (
    <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
      <Bot size={12} aria-hidden="true" />
      {worker.active && (
        <span role="img" aria-label={atWorkLabel} className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 ring-1 ring-surface" />
        </span>
      )}
    </span>
  ) : (
    <Avatar text={worker.monogram ?? ''} color={worker.color ?? '#64748b'} size={18} />
  );
  return (
    <div className={clsx('min-w-0', className)} data-tip={worker.doing ? `${worker.fullName}: ${worker.doing}` : worker.fullName}>
      <div className="flex min-w-0 items-center gap-1.5">
        {face}
        <span className={clsx('min-w-0 text-compact font-medium text-app-text', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{worker.name}</span>
        {!hideSince && !sinceBelow && <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{worker.since}</span>}
      </div>
      {!compact && (worker.doing || (sinceBelow && !hideSince)) && (
        <p className={clsx('mt-0.5 pl-[24px] text-mini leading-4 text-app-text-secondary', wrap ? '[overflow-wrap:anywhere]' : 'line-clamp-2')}>
          {sinceBelow && !hideSince && <span className="tabular-nums text-app-text-tertiary">{worker.since}{worker.doing ? ' · ' : ''}</span>}
          {worker.doing}
        </p>
      )}
    </div>
  );
}
