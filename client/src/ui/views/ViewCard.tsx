import { ArrowRight, Copy, Eye, MoreHorizontal, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { MenuButton } from '../primitives/Menu';
import { FOCUS_RING } from '../shell/pressable';
import type { ViewCardModel } from './model';

const STEP_CHIP = clsx(
  'inline-flex h-5 max-w-full items-center gap-1 truncate rounded bg-sky-500/15 px-1.5 text-mini leading-4 text-sky-800 transition-colors hover:bg-sky-500/25 dark:text-sky-300',
  FOCUS_RING,
);

/**
 * One saved view as a card: the blocks it is made of, what it is for, the
 * steps of the flows that open it (each a way into the flow) and how often it
 * is opened. A view of the organization opens and says where it opens; one
 * from the sector or the standard set is added to the organization first.
 */
export function ViewCard({ view, copy, onOpen, onWhere, onAdd, onDuplicate, onRemove, metricLabel, deniedTitle }: {
  view: ViewCardModel;
  copy: UiCopy;
  onOpen?: Action;
  onWhere?: Action;
  onAdd?: Action;
  onDuplicate?: Action;
  onRemove?: Action;
  metricLabel: string;
  deniedTitle?: string;
}) {
  const v = copy.viewsMore.list;
  const menu = view.adopted
    ? [
      { id: 'where', label: v.where, icon: SlidersHorizontal, disabled: onWhere === false },
      { id: 'duplicate', label: v.duplicate, icon: Copy, disabled: onDuplicate === false, title: onDuplicate === false ? deniedTitle : undefined },
      { id: 'sep', label: '', separator: true },
      { id: 'remove', label: v.remove, icon: Trash2, danger: true, disabled: onRemove === false, title: onRemove === false ? deniedTitle : undefined },
    ]
    : [];
  const pick = (id: string) => {
    if (id === 'where' && onWhere) onWhere();
    if (id === 'duplicate' && onDuplicate) onDuplicate();
    if (id === 'remove' && onRemove) onRemove();
  };
  return (
    <Card
      title={view.name}
      icon={Eye}
      actions={view.adopted ? <MenuButton label={v.menuLabel(view.name)} icon={MoreHorizontal} items={menu} onSelect={pick} variant="ghost" size="sm" align="right" iconOnly /> : undefined}
      className="h-full"
    >
      <div className="flex h-full flex-col gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          {view.blocks.map((b) => <Chip key={b.key} tone={b.tone}>{b.label}</Chip>)}
        </div>
        <p className="text-compact leading-5 text-app-text-secondary">{view.description}</p>
        <div className="flex flex-col gap-1.5 text-compact">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-app-text-tertiary">{v.usedInSteps}</span>
            {view.steps.length === 0 && <span className="text-app-text-secondary">{v.notInUse}</span>}
            {view.steps.map((s) => (s.onOpen
              ? <button key={s.id} type="button" onClick={s.onOpen} className={STEP_CHIP}><span className="truncate">{s.label}</span></button>
              : <Chip key={s.id} tone="blue">{s.label}</Chip>))}
          </div>
          {view.metric !== undefined && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-app-text-tertiary">{metricLabel}</span>
              <span className="font-medium tabular-nums text-app-text">{v.times(view.metric)}</span>
            </div>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {view.adopted ? (
            <>
              <Button variant="primary" size="sm" icon={ArrowRight} onClick={onOpen}>{v.open}</Button>
              <Button size="sm" icon={SlidersHorizontal} onClick={onWhere}>{v.where}</Button>
            </>
          ) : (
            <Button variant="primary" size="sm" icon={Plus} onClick={onAdd} title={onAdd === false ? deniedTitle : undefined}>{v.add}</Button>
          )}
        </div>
      </div>
    </Card>
  );
}
