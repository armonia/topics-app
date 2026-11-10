import type { ReactNode } from 'react';
import { ChartColumn, Layers, Rows3, SquareKanban, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import type { ChoiceModel } from './model';

const VIEW_ICON: Record<string, LucideIcon> = { kanban: SquareKanban, list: Rows3, stages: Layers, chart: ChartColumn };

/** List, kanban or cards per stage: the same cards three ways, a segmented switch (tabs). `compact` tightens it to sit in a phone's pane header. */
export function ViewSwitch({ views, active, label, compact, onPick }: {
  views: ChoiceModel[];
  active: string;
  label: string;
  compact?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
      {views.map((v) => {
        const on = v.id === active;
        const Icon = VIEW_ICON[v.id];
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={on}
            data-view={v.id}
            onClick={() => onPick(v.id)}
            className={clsx(
              'inline-flex h-6 items-center rounded-md text-compact font-medium transition-colors',
              compact ? 'gap-1 px-2' : 'gap-1.5 px-2.5',
              on ? 'bg-surface text-app-text shadow-sm' : 'text-app-text-secondary hover:text-app-text',
              FOCUS_RING,
            )}
          >
            {Icon && <Icon size={13} aria-hidden="true" />}
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/** The bar under the pane header: rows of controls with the house padding. */
export function HeaderBand({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('flex shrink-0 flex-col gap-2 border-b border-app-border px-4 py-2.5', className)}>{children}</div>;
}
