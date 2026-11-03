import { AlertTriangle, Bot, UserRound } from 'lucide-react';
import type { CreatorChip } from './createdByLabel';
import { openTabInApp } from '../../lib/tabLink';

/**
 * Who opened the card. The name sits in its own span: a flex chip cannot
 * truncate, so `truncate` + `min-w-0` go on the inner text, which is what puts
 * the «…» when the chat name is long. Opening the chat goes through 
 * single in-app door (`openTabInApp`), which checks the chat still exists before
 * it opens a tab (never a bare anchor, which would hand `/topic/<id>` to the
 * system browser, and never a bare `topics:open-topic`, which opens a ghost tab
 * for a deleted chat).
 */
export function CreatorChipView({ chip, notify, open = openTabInApp }: {
  chip: CreatorChip;
  /** Told when the chat no longer exists, so the click is never silent. */
  notify?: (message: string) => void;
  /** The in-app door; injectable so a test needs no module mock. */
  open?: typeof openTabInApp;
}) {
  return (
    <span
      data-testid="card-created-by"
      data-created-by-kind={chip.kind}
      title={chip.title}
      className="flex min-w-0 max-w-full items-center gap-1 rounded bg-slate-500/15 px-1.5 py-0.5 text-compact leading-4 text-slate-700 dark:text-slate-300 md:text-mini"
    >
      {chip.kind === 'human' ? <UserRound className="h-3 w-3 shrink-0" /> : <Bot className="h-3 w-3 shrink-0" />}
      {chip.openTopicId ? (
        <button
          type="button"
          data-testid="card-created-by-open"
          className="min-w-0 truncate underline-offset-2 hover:underline"
          onClick={(e) => { e.stopPropagation(); open({ kind: 'chat', key: chip.openTopicId! }, { notify }); }}
        >{chip.label}</button>
      ) : (
        <span className="min-w-0 truncate">{chip.label}</span>
      )}
    </span>
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
