import { Columns3, GanttChart, LayoutList, Table2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { DetailLevel } from './detailLevel';

const ICONS = { summary: Table2, list: LayoutList, grid: Columns3, plan: GanttChart } as const;

/**
 * The board's LAYOUT, picked from a segmented switch: it only decides how the
 * tasks are arranged. How much of each card is drawn is the detail slider's job.
 */
export function LayoutSwitch({ value, onChange, layouts }: { value: DetailLevel; onChange: (next: DetailLevel) => void; layouts: readonly DetailLevel[] }) {
  const tr = useT();
  return (
    <div role="group" data-testid="board-layout-switch" aria-label={tr('board.toolbar.layout.label')} className="mx-1 flex shrink-0 items-center rounded-md border border-app-border p-0.5">
      {layouts.map((layout) => {
        const Icon = ICONS[layout];
        const active = layout === value;
        return (
          <button
            key={layout} type="button" data-layout={layout} aria-pressed={active}
            title={tr(`board.toolbar.layout.${layout}`)} aria-label={tr(`board.toolbar.layout.${layout}`)}
            onClick={() => onChange(layout)}
            className={`flex h-6 w-7 items-center justify-center rounded coarse:h-11 coarse:w-11 ${active ? 'bg-white/15 text-app-text-heading' : 'text-app-text-muted hover:bg-white/5'}`}
          ><Icon className="h-3.5 w-3.5" /></button>
        );
      })}
    </div>
  );
}
