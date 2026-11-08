import { AlertTriangle, Bot, UserRound } from 'lucide-react';
import type { CreatorChip } from './createdByLabel';
import { openTabInApp } from '../../lib/tabLink';

/**
 * Who opened the card, as a small round avatar (the assignee avatar of other
 * trackers): the person icon for a person, the agent's initial for a named
 * agent, the bot icon when there is no name. The name and the origin chat are
 * the tooltip. Clicking opens the chat through the single in-app door
 * (`openTabInApp`), which checks the chat still exists before it opens a tab
 * (never a bare anchor, never a bare `topics:open-topic`).
 */
export function CreatorChipView({ chip, notify, open = openTabInApp }: {
  chip: CreatorChip;
  /** Told when the chat no longer exists, so the click is never silent. */
  notify?: (message: string) => void;
  /** The in-app door; injectable so a test needs no module mock. */
  open?: typeof openTabInApp;
}) {
  const face = chip.kind === 'human'
    ? <UserRound className="h-3 w-3" />
    : chip.initial ? <span aria-hidden="true">{chip.initial}</span> : <Bot className="h-3 w-3" />;
  const base = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-500/20 text-compact font-semibold leading-none text-slate-700 dark:text-slate-300 md:text-mini';
  const common = { 'data-testid': 'card-created-by', 'data-created-by-kind': chip.kind, title: chip.title, 'aria-label': chip.title } as const;
  if (!chip.openTopicId) return <span {...common} className={base}>{face}</span>;
  return (
    <button
      type="button"
      {...common}
      data-testid="card-created-by"
      className={`${base} hover:bg-slate-500/35`}
      onClick={(e) => { e.stopPropagation(); open({ kind: 'chat', key: chip.openTopicId! }, { notify }); }}
    >{face}</button>
  );
}

/** The line that says an agent's card is missing what it needs to finish by itself. */
export function IncompleteChipView({ chip }: { chip: { label: string; title: string } }) {
  return (
    <span
      data-testid="card-incomplete"
      title={chip.title}
      className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-compact leading-4 text-amber-800 dark:text-amber-300 md:text-mini"
    ><AlertTriangle className="h-3 w-3 shrink-0" /> {chip.label}</span>
  );
}
