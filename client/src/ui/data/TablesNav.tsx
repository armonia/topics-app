import type { LucideIcon } from 'lucide-react';
import { Database, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { SectionLabel } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import type { TableNavItem } from './model';

export interface NavLinkModel {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The link of the page that is open. */
  current?: boolean;
}

function Entry({ item, selected, icon: Icon, onSelect, onRemove, removeLabel }: {
  item: TableNavItem;
  selected?: boolean;
  icon?: LucideIcon;
  onSelect: (id: string) => void;
  onRemove?: (id: string) => void;
  removeLabel?: string;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={selected || undefined}
        data-tip={item.hint}
        aria-label={item.hint ? `${item.label}: ${item.hint}` : undefined}
        onClick={() => onSelect(item.id)}
        className={clsx(
          'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-prose leading-5 transition-colors',
          selected ? 'bg-black/[0.07] font-medium text-app-text dark:bg-white/[0.12]' : 'bg-black/[0.03] text-app-text hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]',
          onRemove && 'pr-7',
          FOCUS_RING,
        )}
      >
        {Icon && <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{item.label}</span>
        <span className="shrink-0 text-compact tabular-nums text-app-text-tertiary">{item.count}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          data-tip={removeLabel}
          onClick={() => onRemove(item.id)}
          className={clsx('absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-app-text-tertiary opacity-0 transition-opacity hover:bg-black/[0.07] hover:text-app-text focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100 dark:hover:bg-white/[0.12]', FOCUS_RING)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/**
 * The tables of an organization, the views people saved on them, and the
 * pages that belong to data (types, quality, schedule). A column on the left;
 * on a phone, one scrolling strip above the table. A view the reader saved
 * can be removed; the ones that ship with the preview cannot.
 */
export function TablesNav({ tables, selectedTableId, onSelectTable, views, selectedViewId, onSelectView, onRemoveView, removableViewIds, links, onLink, copy, phone }: {
  tables: TableNavItem[];
  selectedTableId?: string;
  onSelectTable: (id: string) => void;
  views: TableNavItem[];
  selectedViewId?: string;
  onSelectView: (id: string) => void;
  onRemoveView?: (id: string) => void;
  removableViewIds: string[];
  links: NavLinkModel[];
  onLink: (id: string) => void;
  copy: UiCopy;
  phone: boolean;
}) {
  const t = copy.dataMore.nav;
  if (phone) {
    const chip = (on: boolean) => clsx('inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-prose transition-colors', on ? 'bg-black/[0.08] font-medium text-app-text dark:bg-white/[0.14]' : 'bg-black/[0.04] text-app-text-secondary dark:bg-white/[0.06]', FOCUS_RING);
    return (
      <nav aria-label={t.tables} className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto border-b border-app-border px-3 py-2">
        {tables.map((x) => <button key={x.id} type="button" aria-current={x.id === selectedTableId && !selectedViewId ? true : undefined} onClick={() => onSelectTable(x.id)} className={chip(x.id === selectedTableId && !selectedViewId)}>{x.label}</button>)}
        {views.map((x) => <button key={x.id} type="button" aria-current={x.id === selectedViewId ? true : undefined} onClick={() => onSelectView(x.id)} className={chip(x.id === selectedViewId)}>{x.label}</button>)}
        {links.map((l) => <button key={l.id} type="button" aria-current={l.current ? true : undefined} onClick={() => onLink(l.id)} className={chip(Boolean(l.current))}><l.icon size={14} aria-hidden="true" />{l.label}</button>)}
      </nav>
    );
  }
  return (
    <nav aria-label={t.tables} className="h-full w-[200px] shrink-0 overflow-y-auto border-r border-app-border px-2.5 py-3">
      <SectionLabel className="mb-2 px-1">{t.tables}</SectionLabel>
      <ul className="space-y-1">
        {tables.map((x) => <Entry key={x.id} item={x} icon={Database} selected={x.id === selectedTableId && !selectedViewId} onSelect={onSelectTable} />)}
      </ul>
      <SectionLabel className="mb-2 mt-5 px-1">{t.views}</SectionLabel>
      <ul className="space-y-1">
        {views.map((x) => (
          <Entry
            key={x.id}
            item={x}
            selected={x.id === selectedViewId}
            onSelect={onSelectView}
            onRemove={removableViewIds.includes(x.id) ? onRemoveView : undefined}
            removeLabel={t.removeView(x.label)}
          />
        ))}
      </ul>
      <SectionLabel className="mb-2 mt-5 px-1">{t.more}</SectionLabel>
      <ul className="space-y-1">
        {links.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              aria-current={l.current || undefined}
              onClick={() => onLink(l.id)}
              className={clsx('flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-prose leading-5 transition-colors', l.current ? 'bg-black/[0.07] font-medium text-app-text dark:bg-white/[0.12]' : 'text-app-text-secondary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}
            >
              <l.icon size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{l.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
