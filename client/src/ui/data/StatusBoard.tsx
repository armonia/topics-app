import clsx from 'clsx';
import { CirclePause } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Chip, Count } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { StageIcon } from '../kanban/parts';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_CHIP, TONE_TEXT } from '../tone';
import type { StatusColumnModel } from './model';

/** The «per stato» view: one column per state, each row of the table a card in it. (allow-italian: quotes the Italian interface) */
export function StatusBoard({ columns, copy, onOpen }: {
  columns: StatusColumnModel[];
  copy: UiCopy;
  onOpen: (id: string) => void;
}) {
  const t = copy.dataMore.board;
  return (
    <div className="scrollbar-none -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {columns.map((col) => (
        <section key={col.id} aria-label={col.label} className="flex w-[240px] shrink-0 flex-col gap-2 rounded-xl bg-black/[0.03] p-2 dark:bg-white/[0.04]">
          <header className="flex items-center gap-2 px-1.5 py-1">
            {col.glyph ? <StageIcon glyph={col.glyph} /> : <span className={clsx('h-2 w-2 rounded-full', TONE_CHIP[col.tone])} aria-hidden="true" />}
            <h3 className="min-w-0 flex-1 truncate text-prose font-semibold text-app-text">{col.label}</h3>
            <Count value={col.cards.length} />
          </header>
          {col.cards.length === 0 && <EmptyState title={t.emptyColumn} className="min-h-0 px-2 py-6 [&>p]:text-prose" />}
          {col.cards.map((c) => {
            const dueTone = c.deadlineTone ?? (c.urgent ? 'red' : 'neutral');
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpen(c.id)}
                className={clsx(
                  'relative flex flex-col gap-1 rounded-lg border bg-surface p-2.5 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.04]',
                  c.stuck?.tone === 'red' ? 'border-rose-500/40' : c.stuck ? 'border-amber-500/45' : 'border-app-border hover:border-app-border-light',
                  FOCUS_RING,
                )}
              >
                {c.stuck && <span aria-hidden="true" className={clsx('absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full', c.stuck.tone === 'red' ? 'bg-rose-500' : 'bg-amber-500')} />}
                <span className="text-prose font-medium leading-5 text-app-text">{c.title}</span>
                <span className="text-compact text-app-text-secondary">{c.detail}</span>
                {c.deadline && <span className={clsx('text-compact tabular-nums', dueTone === 'red' || dueTone === 'amber' ? `font-medium ${TONE_TEXT[dueTone]}` : 'text-app-text-tertiary')}>{t.deadline(c.deadline)}</span>}
                {c.stuck && <span><Chip tone={c.stuck.tone} icon={CirclePause}>{c.stuck.text}</Chip></span>}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
