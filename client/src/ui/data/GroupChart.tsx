import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { EmptyState } from '../primitives/EmptyState';
import { FOCUS_RING } from '../shell/pressable';
import type { StageGlyph } from '../kanban/model';
import type { ChartBarModel } from './model';

const FILL: Record<ChartBarModel['tone'], string> = {
  neutral: 'bg-black/25 dark:bg-white/30',
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  violet: 'bg-violet-500',
  pink: 'bg-fuchsia-500',
};

/** The ink of each stage glyph (`ui/kanban/glyphs.ts`) as a fill, so a bar per stage reads from the same table as the icons and chips of «Da fare». (allow-italian: quotes the Italian interface) */
const GLYPH_FILL: Record<StageGlyph, string> = {
  incoming: 'bg-app-text-tertiary',
  working: 'bg-sky-600 dark:bg-sky-400',
  check: 'bg-amber-600 dark:bg-amber-400',
  approve: 'bg-violet-600 dark:bg-violet-400',
  done: 'bg-emerald-600 dark:bg-emerald-400',
};

/** The «chart» view: how many rows per value of a column, as bars. A bar narrows the table to its value. */
export function GroupChart({ bars, copy, onBar }: {
  bars: ChartBarModel[];
  copy: UiCopy;
  onBar: (id: string) => void;
}) {
  const t = copy.dataMore.chart;
  const max = Math.max(1, ...bars.map((b) => b.value));
  if (!bars.length) return <EmptyState title={t.empty} />;
  return (
    <ul className="space-y-2 rounded-lg border border-app-border bg-surface p-4">
      {bars.map((b) => (
        <li key={b.id}>
          <button
            type="button"
            onClick={() => onBar(b.id)}
            data-tip={t.showRows(b.label)}
            className={clsx('flex w-full items-center gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]', FOCUS_RING)}
          >
            <span className="w-[170px] shrink-0 truncate text-prose text-app-text max-sm:w-[110px]">{b.label}</span>
            <span className="h-5 min-w-0 flex-1 rounded bg-black/[0.04] dark:bg-white/[0.06]">
              <span style={{ width: `${(b.value / max) * 100}%` }} className={clsx('block h-full rounded transition-[width] duration-base', b.glyph ? GLYPH_FILL[b.glyph] : FILL[b.tone])} />
            </span>
            <span className="w-8 shrink-0 text-right text-prose tabular-nums text-app-text">{b.value}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
