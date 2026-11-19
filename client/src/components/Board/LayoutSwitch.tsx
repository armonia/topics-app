import { LayoutGrid, List, CalendarRange, FolderKanban } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DETAIL_LEVELS, type DetailLevel } from './detailLevel';

const ICONS = { summary: FolderKanban, list: List, grid: LayoutGrid, plan: CalendarRange } as const;

/** The board's layout, picked from four icons: projects, list, kanban, plan. Independent of how detailed the cards are. */
export function LayoutSwitch({ value, onChange, levels = DETAIL_LEVELS }: { value: DetailLevel; onChange: (next: DetailLevel) => void; levels?: readonly DetailLevel[] }) {
  const tr = useT();
  return (
    <div role="radiogroup" aria-label={tr('board.toolbar.layout.label')} data-testid="board-layout-switch" className="mx-1 flex shrink-0 items-center gap-0.5 rounded-md bg-white/5 p-0.5">
      {levels.map((level) => {
        const Icon = ICONS[level];
        const text = tr(`board.toolbar.detail.${level}`);
        const active = level === value;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={text}
            title={text}
            data-testid={`board-layout-${level}`}
            onClick={() => onChange(level)}
            className={`flex h-6 w-6 items-center justify-center rounded coarse:h-11 coarse:w-11 ${active ? 'bg-primary/80 text-white' : 'text-app-text-secondary hover:bg-white/10'}`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
