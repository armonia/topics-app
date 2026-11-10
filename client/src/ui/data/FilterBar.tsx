import { useState } from 'react';
import { Plus, Save, Search, Undo2, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Select, TextField } from '../primitives/Field';
import { MenuButton, type MenuItemModel } from '../primitives/Menu';
import { Popover } from '../primitives/Popover';
import { FOCUS_RING } from '../shell/pressable';
import type { Action } from '../types';
import type { FilterChipModel, FilterColumnModel } from './model';

/**
 * What a person narrows a table with: the filters as chips (each removable),
 * the grouping and the order as two small menus, a search that matches any
 * cell, and the form that adds a filter. `onSave` keeps the whole thing as a
 * named view; `onReset` puts a view back as it was saved.
 */
export function FilterBar({ copy, chips, onRemove, columns, onAdd, group, groupOptions, onGroup, sortText, sortItems, onSort, q, onQuery, onSave, onReset, saveDenied }: {
  copy: UiCopy;
  chips: FilterChipModel[];
  onRemove: (id: string) => void;
  columns: FilterColumnModel[];
  onAdd: (f: { col: string; op: 'is' | 'not' | 'within'; value: string }) => void;
  /** The column the table is grouped by, empty for none. */
  group: string;
  groupOptions: MenuItemModel[];
  onGroup: (id: string) => void;
  sortText: string;
  sortItems: MenuItemModel[];
  onSort: (id: string) => void;
  q: string;
  onQuery: (q: string) => void;
  onSave: Action;
  onReset?: () => void;
  saveDenied?: string;
}) {
  const t = copy.dataMore.toolbar;
  const [adding, setAdding] = useState(false);
  const [col, setCol] = useState(columns[0]?.id ?? '');
  const [op, setOp] = useState<'is' | 'not'>('is');
  const current = columns.find((c) => c.id === col) ?? columns[0];
  const [value, setValue] = useState('');
  const options = current?.options ?? [];
  const chosen = current?.kind === 'within' ? (value || options[0]?.value || '') : (options.some((o) => o.value === value) ? value : options[0]?.value ?? '');
  const groupLabel = groupOptions.find((g) => g.id === group)?.label ?? t.noGroup;
  const mark = (items: MenuItemModel[], on: string) => items.map((i) => (i.id === on ? { ...i, hint: t.current } : i));
  const chip = 'inline-flex h-6 items-center gap-1 rounded-md bg-black/[0.05] px-2 text-compact text-app-text dark:bg-white/10';
  return (
    <div className="mb-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => (
          <span key={c.id} className={clsx(chip, 'pr-1')}>
            {c.text}
            <button
              type="button"
              aria-label={t.removeFilter(c.text)}
              data-tip={t.removeFilter(c.text)}
              onClick={() => onRemove(c.id)}
              className={clsx('inline-flex h-4 w-4 items-center justify-center rounded text-app-text-tertiary hover:bg-black/[0.08] hover:text-app-text dark:hover:bg-white/[0.14]', FOCUS_RING)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        <MenuButton size="sm" label={t.groupBy(groupLabel)} items={mark(groupOptions, group)} onSelect={onGroup} />
        <MenuButton size="sm" label={sortText} items={sortItems} onSelect={onSort} />
        <span className="relative inline-flex">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            className={clsx('inline-flex h-6 items-center gap-1 px-1.5 text-compact font-medium text-primary dark:text-primary-dark', FOCUS_RING)}
          >
            <Plus size={12} aria-hidden="true" />{t.addFilter}
          </button>
          {adding && (
            <Popover ariaLabel={t.addFilterTitle} onClose={() => setAdding(false)} className="w-[280px] p-3">
              <div className="space-y-2.5">
                <Select label={t.filterColumn} value={current?.id ?? ''} options={columns.map((c) => ({ value: c.id, label: c.label }))} onChange={(v) => { setCol(v); setValue(''); }} />
                {current?.kind === 'select' && (
                  <Select label={t.filterOp} value={op} options={[{ value: 'is', label: t.opIs }, { value: 'not', label: t.opNot }]} onChange={(v) => setOp(v === 'not' ? 'not' : 'is')} />
                )}
                <Select label={current?.kind === 'within' ? t.filterWithin : t.filterValue} value={chosen} options={options} onChange={setValue} />
                <div className="flex justify-end gap-2 pt-1">
                  <Button onClick={() => setAdding(false)}>{t.cancel}</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      if (!current) return;
                      onAdd({ col: current.id, op: current.kind === 'within' ? 'within' : op, value: chosen });
                      setAdding(false);
                      setValue('');
                    }}
                  >
                    {t.apply}
                  </Button>
                </div>
              </div>
            </Popover>
          )}
        </span>
        {onReset && <Button size="sm" variant="ghost" icon={Undo2} onClick={onReset}>{t.reset}</Button>}
        <span className="flex-1" />
        <Button size="sm" icon={Save} onClick={onSave} title={onSave === false ? saveDenied : undefined}>{t.saveView}</Button>
      </div>
      <div className="max-w-[460px]">
        <TextField type="search" icon={Search} value={q} onChange={onQuery} placeholder={t.searchPlaceholder} title={t.searchLabel} />
      </div>
    </div>
  );
}
