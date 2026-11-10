/**
 * Small pieces the SARIM admin places share (programs, team, settings): who
 * did or holds something (a person with their monogram, an agent with the
 * Bot glyph), one line per card that opens it, a link to a public source, a
 * list with its empty line. Pure drawing from the ctx, no state.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Bot, ChevronRight, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import type { SarimCard } from '../../ui/fixtures/sarim-org/types';
import { agentById, personaById } from './world';
import { StatCard } from '../../ui/primitives/Card';
import { Chip } from '../../ui/primitives/Chip';
import { Avatar } from '../../ui/shell/SidebarRows';
import { FOCUS_RING } from '../../ui/shell/pressable';
import type { ScreenCtx } from '../app/kit';
import { stageOf } from './model/live';
import { STAGE_TONE, stageLabel } from './model/words';
import { openExternal } from './external';
import { SP } from './paths';

/** A person (monogram in their colour) or an agent (the Bot glyph), with the short name; a button to their page when `ctx` can go there. */
export function ActorChip({ id, ctx, short = true, className }: { id: string; ctx: ScreenCtx; short?: boolean; className?: string }) {
  const raw = id.startsWith('agent:') ? id.slice(6) : id;
  const person = personaById(raw);
  const agent = person ? undefined : agentById(raw);
  const body = person ? (
    <>
      <Avatar text={person.monogram} color={person.color} size={18} />
      <span className="min-w-0 truncate">{short ? person.short : person.name}</span>
    </>
  ) : (
    <>
      <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
        <Bot size={12} aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate">{agent?.name ?? raw}</span>
    </>
  );
  if (!person && !agent) return <span className={clsx('text-app-text-secondary', className)}>{raw}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.go(SP.person(raw));
      }}
      className={clsx('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-prose text-app-text hover:bg-black/[0.05] dark:hover:bg-white/[0.08]', FOCUS_RING, className)}
    >
      {body}
    </button>
  );
}

/** One card as a line: its id, its title, the column it stands in and who has it; pressing it opens the card. The arrow stays at the far right; on a phone the id and the column sit above the title. */
export function CardLine({ card, ctx, note }: { card: SarimCard; ctx: ScreenCtx; note?: ReactNode }) {
  const stage = stageOf(card);
  const sub = note ?? card.blocked?.reason;
  const id = <span className="shrink-0 font-mono text-mini text-app-text-tertiary">{card.id}</span>;
  const chip = <Chip tone={STAGE_TONE[stage]}>{stageLabel(stage)}</Chip>;
  const text = (
    <>
      {card.title}
      {sub && <span className={clsx('block text-mini leading-4', !note && card.blocked ? 'text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{sub}</span>}
    </>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ctx.go(SP.card(card.id))}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.go(SP.card(card.id));
        }
      }}
      className={clsx('group flex min-w-0 cursor-pointer items-center gap-2.5 border-t border-app-border px-1 py-2 first:border-t-0 hover:bg-app-hover', FOCUS_RING)}
    >
      {ctx.phone ? (
        <span className="min-w-0 flex-1">
          <span className="mb-0.5 flex flex-wrap items-center gap-2">{id}{chip}</span>
          <span className="block text-prose leading-5 text-app-text [overflow-wrap:break-word]">{text}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          {id}
          <span className="min-w-[160px] flex-1 text-prose leading-5 text-app-text [overflow-wrap:break-word]">{text}</span>
          {chip}
        </span>
      )}
      <ChevronRight size={13} className="shrink-0 text-app-text-faint group-hover:text-app-text-secondary" aria-hidden="true" />
    </div>
  );
}

/** A number with its label, as the shared stat card, but the label wraps on a second line instead of ending in dots (a narrow column, a phone). */
export function StatTile({ className, ...props }: ComponentProps<typeof StatCard>) {
  return <StatCard {...props} className={clsx('[&>div]:whitespace-normal', className)} />;
}

/** A link to a public source, opened in a new tab; the exact words of the page in its tooltip. */
export function SourceLink({ ctx, label, url, title, className }: { ctx: Pick<ScreenCtx, 'confirm' | 'copy'>; label: string; url: string; title?: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      /* The same confirm as every public page of the edition: it says where the link goes before leaving. */
      onClick={(e) => { e.preventDefault(); openExternal(ctx, url); }}
      data-tip={title ?? url}
      className={clsx('inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 text-mini font-medium leading-4 text-sky-700 hover:bg-sky-500/20 hover:underline dark:text-sky-300', FOCUS_RING, className)}
    >
      <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </a>
  );
}

/** A list of lines inside a block, with its own empty line. */
export function Lines({ empty, children }: { empty: string; children: ReactNode[] }) {
  if (children.length === 0) return <p className="text-prose text-app-text-tertiary">{empty}</p>;
  return <div className="flex flex-col">{children}</div>;
}
