import { useState } from 'react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Menu, type MenuItemModel } from '../primitives/Menu';
import { FOCUS_RING } from '../shell/pressable';
import type { Action } from '../types';

/**
 * The bar that appears over a table when rows are ticked: how many, and what
 * to do with them. `assign` opens a menu of the people a row can go to; an
 * action that is `false` is drawn off (the person may not do it) and says why
 * in `denied`.
 */
export function SelectionToolbar({ count, copy, assignItems, onAssign, onExport, onMarkRead, onClear, assignDenied, exportDenied, markDenied }: {
  count: number;
  copy: UiCopy;
  /** `false`: the person may not assign; `null`: the rows of this table are not assigned to anyone. */
  assignItems: MenuItemModel[] | false | null;
  onAssign: (personId: string) => void;
  onExport: Action;
  onMarkRead: Action;
  onClear: () => void;
  assignDenied?: string;
  exportDenied?: string;
  markDenied?: string;
}) {
  const t = copy.dataMore.selection;
  const [open, setOpen] = useState(false);
  const item = (off: boolean) => clsx('flex h-full items-center whitespace-nowrap border-l border-white/15 px-4', off ? 'cursor-default opacity-45' : 'hover:bg-white/10', FOCUS_RING, 'focus-visible:ring-inset');
  return (
    <div role="toolbar" aria-label={t.label} className="inline-flex max-w-full flex-wrap items-stretch rounded-xl bg-[#1c1c1f] text-prose text-white shadow-[0_8px_24px_rgba(0,0,0,0.22)]">
      <span className="flex h-10 items-center rounded-l-xl px-4 font-semibold">{copy.data.selected(count)}</span>
      {assignItems !== null && <span className="relative flex">
        <button type="button" disabled={assignItems === false} data-tip={assignItems === false ? assignDenied : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={clsx(item(assignItems === false), 'h-10')}>{t.assign}</button>
        {open && assignItems && <Menu items={assignItems} ariaLabel={t.assign} onSelect={onAssign} onClose={() => setOpen(false)} />}
      </span>}
      <button type="button" disabled={onExport === false} data-tip={onExport === false ? exportDenied : undefined} onClick={onExport || undefined} className={clsx(item(onExport === false), 'h-10')}>{t.exportCsv}</button>
      <button type="button" disabled={onMarkRead === false} data-tip={onMarkRead === false ? markDenied : undefined} onClick={onMarkRead || undefined} className={clsx(item(onMarkRead === false), 'h-10')}>{t.markRead}</button>
      <button type="button" onClick={onClear} className={clsx(item(false), 'h-10 rounded-r-xl text-white/70')}>{t.clear}</button>
    </div>
  );
}
