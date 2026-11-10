import type { KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { Popover } from '../primitives/Popover';
import { Chip } from '../primitives/Chip';
import { focusFirstItem, handleMenuKeys } from '../primitives/overlay';
import { Avatar } from './SidebarRows';

export interface PersonaModel {
  id: string;
  name: string;
  /** The role or office, one line. */
  detail: string;
  monogram: string;
  color: string;
  current: boolean;
  /** A person made up for the example, not a real account. */
  example: boolean;
}

/**
 * Whose eyes the preview uses: a menu over the identity row of the sidebar
 * (fixed 8px from the left, 48px from the bottom; full width on a phone). One
 * row per persona, the current one ticked; arrows move, Enter picks, Escape
 * or a click outside closes.
 */
export function PersonaMenu({ title, personas, onSelect, onClose, exampleLabel, currentLabel }: {
  title: string;
  personas: PersonaModel[];
  onSelect: (id: string) => void;
  onClose: () => void;
  exampleLabel: string;
  currentLabel: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    handleMenuKeys(e, onClose);
  };
  return (
    <Popover fixed onClose={onClose} ariaLabel={title} className="bottom-12 left-2 w-[300px] max-sm:inset-x-2 max-sm:w-auto">
      <div className="px-3 pb-1 pt-2.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{title}</div>
      <div role="menu" aria-label={title} ref={focusFirstItem} onKeyDown={onKeyDown} className="max-h-[min(420px,60dvh)] overflow-y-auto pb-1">
        {personas.map((p) => (
          <button
            key={p.id}
            type="button"
            role="menuitemradio"
            aria-checked={p.current}
            tabIndex={-1}
            onClick={() => {
              onSelect(p.id);
              onClose();
            }}
            className={clsx(
              'mx-1 flex min-h-11 w-[calc(100%-8px)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
              'hover:bg-black/[0.05] focus-visible:bg-black/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 dark:hover:bg-white/[0.08] dark:focus-visible:bg-white/[0.08]',
            )}
          >
            <Avatar text={p.monogram} color={p.color} size={26} />
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate text-prose leading-5 text-app-text', p.current && 'font-semibold')}>{p.name}</span>
              <span className="block truncate text-mini leading-4 text-app-text-tertiary">{p.detail}</span>
            </span>
            {p.example && <Chip>{exampleLabel}</Chip>}
            <span className="inline-flex w-4 shrink-0 justify-center text-primary dark:text-primary-dark" data-tip={p.current ? currentLabel : undefined}>
              {p.current && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
            </span>
            {p.current && <span className="sr-only">{currentLabel}</span>}
          </button>
        ))}
      </div>
    </Popover>
  );
}
