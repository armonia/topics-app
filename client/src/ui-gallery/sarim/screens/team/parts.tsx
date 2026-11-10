/**
 * Pieces the team pages share: a pressable line (icon, two lines of text,
 * chips, an arrow), the line of a person or an agent with what they have in
 * hand, and the numbers of a team.
 */
import type { ReactNode } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Chip } from '../../../../ui/primitives/Chip';
import { Avatar } from '../../../../ui/shell/SidebarRows';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { ScreenCtx } from '../../../app/kit';
import { SP } from '../../paths';
import { teamNumbers, type TeamMember } from '../../model/team';

/** A pressable line inside a block: icon tile, two lines of text, chips on the right (a chip may be a button of its own, so the line is not one). When the chips do not fit they go under the text; the arrow stays at the far right. */
export function LinkLine({ icon, title, sub, chips, onOpen, ...data }: {
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  chips?: ReactNode;
  onOpen: () => void;
  'data-member'?: string;
  'data-flow'?: string;
  /** Set on the line of the person who leads the team (the walk counts them). */
  'data-lead'?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      {...data}
      className={clsx('group flex w-full min-w-0 cursor-pointer items-center gap-2.5 border-t border-app-border px-1 py-2 text-left first:border-t-0 hover:bg-app-hover', FOCUS_RING)}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="min-w-[160px] flex-1 text-prose leading-5 text-app-text [overflow-wrap:break-word]">
          {title}
          {sub && <span className="block text-mini leading-4 text-app-text-tertiary">{sub}</span>}
        </span>
        {chips && <span className="flex flex-wrap items-center gap-1">{chips}</span>}
      </span>
      <ChevronRight size={13} className="shrink-0 text-app-text-faint group-hover:text-app-text-secondary" aria-hidden="true" />
    </div>
  );
}

/** The round mark of an agent. */
export const AgentMark = ({ size = 24 }: { size?: number }) => (
  <span style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
    <Bot size={Math.round(size * 0.55)} aria-hidden="true" />
  </span>
);

/**
 * One person or agent: avatar, name, the «Responsabile» badge, and what they have in hand.
 * The leader of a team is named here and nowhere else on the page, so the header above never repeats them.
 */
export function MemberLine({ ctx, m, hideNumbers }: { ctx: ScreenCtx; m: TeamMember; /** The numbers are already on the page, as the figures of the whole team. */ hideNumbers?: boolean }) {
  const c = ctx.copy.sarimTeam;
  const you = m.id === ctx.persona.id;
  const numbers = (
    <>
      <span className="whitespace-nowrap text-mini text-app-text-secondary">{c.inHand(m.inHand)}</span>
      {m.waiting > 0 && <Chip tone="amber">{c.waiting(m.waiting)}</Chip>}
    </>
  );
  return (
    <LinkLine
      data-member={m.id}
      data-lead={m.lead || undefined}
      icon={m.kind === 'agent' ? <AgentMark /> : <Avatar text={m.monogram} color={m.color} size={24} />}
      title={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{m.name}</span>
          {m.lead && <Chip tone="violet">{c.lead}</Chip>}
          {you && <Chip tone="blue">{ctx.copy.sarimAdmin.common.you}</Chip>}
        </span>
      }
      sub={m.does || undefined}
      chips={hideNumbers ? undefined : numbers}
      onOpen={() => ctx.go(SP.person(m.id))}
    />
  );
}

/** The numbers of a team on one line, as the list and the team page say them. */
export function TeamNumbers({ ctx, members }: { ctx: ScreenCtx; members: TeamMember[] }) {
  const c = ctx.copy.sarimTeam;
  const n = teamNumbers(members);
  const agents = members.length > 0 && members.every((m) => m.kind === 'agent');
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-app-text-secondary">
      <span>{agents ? c.agents(n.count) : c.people(n.count)}</span>
      <span>{c.inHand(n.inHand)}</span>
      <span className={clsx(n.waiting > 0 && 'font-medium text-amber-700 dark:text-amber-400')}>{c.waiting(n.waiting)}</span>
    </span>
  );
}
