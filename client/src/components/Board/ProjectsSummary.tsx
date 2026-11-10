import { useT } from '../../hooks/useT';
import type { ProjectCount } from './detailLevel';

/** The least detailed level of the board: one row per project, with the count in each column. */
export function ProjectsSummary({ rows, columnLabels }: { rows: ProjectCount[]; columnLabels: string[] }) {
  const tr = useT();
  if (rows.length === 0) {
    return <div data-testid="board-summary" className="p-6 text-center text-body text-app-text-muted">{tr('board.summary.empty')}</div>;
  }
  return (
    <div data-testid="board-summary" className="min-h-0 flex-1 overflow-y-auto p-3">
      <ul className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {rows.map((row) => (
          <li key={row.projectId} data-testid="board-summary-row" className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-medium text-app-text">{row.label}</span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
              {row.perColumn.map((n, i) => n > 0 && (
                <span key={columnLabels[i]} className="rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary">
                  {columnLabels[i]} <b className="text-app-text">{n}</b>
                </span>
              ))}
            </span>
            <span className="w-8 shrink-0 text-right font-semibold tabular-nums text-app-text">{row.total}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
