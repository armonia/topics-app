import { ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import type { StageGlyph } from './model';
import { StageIcon } from './parts';
import { FOCUS_RING } from '../shell/pressable';

export interface StripGroupModel {
  id: string;
  label: string;
  glyph: StageGlyph;
  cards: Array<{
    id: string;
    title: string;
    /** Who has it, short. */
    who: string;
    /** `red` blocked, `amber` stopped. */
    flag?: 'red' | 'amber';
    current?: boolean;
  }>;
}

/**
 * The kanban kept in view beside an open card, folded into one column: the
 * stages one under the other, each card a row that opens it, the open one
 * marked. Its head goes back to the full kanban.
 */
export function BoardStrip({ title, backLabel, groups, onBack, onOpen, openLabel }: {
  title: string;
  backLabel: string;
  groups: StripGroupModel[];
  onBack: () => void;
  onOpen: (id: string) => void;
  openLabel: (id: string) => string;
}) {
  return (
    <aside aria-label={title} className="hidden w-[288px] shrink-0 flex-col border-r border-app-border bg-app-inset xl:flex">
      <button
        type="button"
        onClick={onBack}
        data-tip={backLabel}
        className={clsx('flex h-11 shrink-0 items-center gap-1.5 border-b border-app-border px-3 text-left text-prose font-semibold text-app-text transition-colors hover:bg-app-hover', FOCUS_RING)}
      >
        <ChevronLeft size={15} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
        <span className="truncate">{title}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label} className="pt-3">
            <h3 className="flex items-center gap-1.5 px-1.5 pb-1 text-mini font-semibold uppercase tracking-wide text-app-text-secondary">
              <StageIcon glyph={g.glyph} size={12} />
              <span className="truncate">{g.label}</span>
              <span className="ml-auto tabular-nums text-app-text-tertiary">{g.cards.length}</span>
            </h3>
            <ul className="flex flex-col gap-0.5">
              {g.cards.map((c) => {
                const body = (
                  <>
                    {c.flag && <span aria-hidden="true" className={clsx('absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full', c.flag === 'red' ? 'bg-rose-500' : 'bg-amber-500')} />}
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="shrink-0 font-mono text-nano font-medium text-app-text-tertiary">{c.id}</span>
                      <span className="min-w-0 truncate text-compact text-app-text-tertiary">{c.who}</span>
                    </span>
                    <span className="line-clamp-2 text-compact font-medium leading-[17px] text-app-text">{c.title}</span>
                  </>
                );
                const row = 'relative flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left';
                return (
                  <li key={c.id}>
                    {c.current ? (
                      /* The card on show is a place, not a way: it is marked and does nothing when pressed. */
                      <div aria-current="page" data-strip-card={c.id} className={clsx(row, 'bg-sky-500/[0.12] ring-1 ring-inset ring-primary/40')}>{body}</div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpen(c.id)}
                        aria-label={openLabel(c.id)}
                        data-strip-card={c.id}
                        className={clsx(row, 'transition-colors hover:bg-app-hover', FOCUS_RING)}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
