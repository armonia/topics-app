/**
 * WHO FOLLOWS THE CARD, drawn the same way on the card, in the drawer and in
 * the filter bar: one glyph per owner (`cardOrigin.ts`). The person and the
 * board's agents are the common case, so on a card they are a small round
 * icon with the name in the tooltip; an always-on agent, a chat session and a
 * schedule carry their name, because that is the information.
 */
import { AlarmClock, Bot, MessageSquare, UserRound } from 'lucide-react';
import { MAIN_AGENT, agentName } from '../../../../shared/agent-home';
import { openTabInApp } from '../../lib/tabLink';
import { ownerKindOfKey, type OwnerKey, type OwnerKind } from './cardOrigin';
import { ownerTone, type OwnerChip } from './ownerChip';

/** The owner's mark: an icon, or the agent's initial on a round avatar. */
export function OwnerGlyph({ ownerKey, size = 'sm' }: { ownerKey: OwnerKey; size?: 'sm' | 'md' }) {
  const kind = ownerKindOfKey(ownerKey);
  const icon = size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3';
  if (kind === 'agent') {
    const name = agentName(ownerKey.slice('agent:'.length));
    const main = ownerKey === `agent:${MAIN_AGENT}`;
    return (
      <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-mini font-semibold leading-none text-white ${main ? 'bg-blue-600' : 'bg-violet-600'}`}>
        {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
      </span>
    );
  }
  const Icon = GLYPH[kind];
  return <Icon className={`${icon} shrink-0`} aria-hidden="true" />;
}

const GLYPH: Record<Exclude<OwnerKind, 'agent'>, typeof Bot> = { me: UserRound, board: Bot, session: MessageSquare, scheduled: AlarmClock };

/** The origin chip on a card and in the drawer. A click on a chat-backed owner opens that chat. */
export function OriginChipView({ chip, notify, open = openTabInApp }: {
  chip: OwnerChip;
  notify?: (message: string) => void;
  /** The in-app door; injectable so a test needs no module mock. */
  open?: typeof openTabInApp;
}) {
  const iconOnly = !chip.label;
  const cls = iconOnly
    ? `flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ownerTone(chip.key)}`
    : `flex h-5 min-w-0 max-w-48 shrink items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-compact leading-4 md:text-mini ${ownerTone(chip.key)}`;
  const body = <>
    <span className={iconOnly ? 'contents' : 'flex h-4 w-4 shrink-0 items-center justify-center'}><OwnerGlyph ownerKey={chip.key} /></span>
    {!iconOnly && <span className={`truncate ${chip.kind === 'agent' ? 'font-semibold' : ''}`}>{chip.label}</span>}
  </>;
  const common = { 'data-testid': 'card-origin', 'data-owner': chip.key, title: chip.title, 'aria-label': chip.title } as const;
  if (!chip.openTopicId) return <span {...common} className={cls}>{body}</span>;
  return (
    <button
      type="button" {...common}
      className={`${cls} hover:brightness-95 dark:hover:brightness-125`}
      onClick={(e) => { e.stopPropagation(); open({ kind: 'chat', key: chip.openTopicId! }, { notify }); }}
    >{body}</button>
  );
}
