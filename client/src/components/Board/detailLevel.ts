/**
 * The board's DETAIL LEVELS, from the least detailed (projects with counts)
 * to the most detailed (the kanban). Pure helpers, shared by the slider and
 * the pane so the stored preference and the arrow keys agree on the order.
 */
export const DETAIL_LEVELS = ['summary', 'list', 'grid'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Where the preference is kept; the key predates the summary level, so 'list' and 'grid' still read back. */
export const DETAIL_STORAGE_KEY = 'topics.board.layout';

export function parseDetailLevel(raw: string | null): DetailLevel {
  return raw === 'summary' || raw === 'list' ? raw : 'grid';
}

export function readDetailLevel(): DetailLevel {
  try { return parseDetailLevel(localStorage.getItem(DETAIL_STORAGE_KEY)); }
  catch { return 'grid'; }
}

/** A step along the scale, clamped at both ends. */
export function stepDetail(level: DetailLevel, delta: number): DetailLevel {
  const i = DETAIL_LEVELS.indexOf(level) + delta;
  return DETAIL_LEVELS[Math.min(DETAIL_LEVELS.length - 1, Math.max(0, i))];
}

/** The level nearest to a pointer position, as a 0..1 fraction of the track. */
export function detailAtFraction(fraction: number): DetailLevel {
  const i = Math.round(Math.min(1, Math.max(0, fraction)) * (DETAIL_LEVELS.length - 1));
  return DETAIL_LEVELS[i];
}

export interface ProjectCount { projectId: string; label: string; total: number; perColumn: number[] }

/** Tasks grouped by project, one count per column, busiest project first. */
export function countByProject(columns: ReadonlyArray<ReadonlyArray<{ projectId: string }>>): ProjectCount[] {
  const out = new Map<string, ProjectCount>();
  columns.forEach((tasks, col) => {
    for (const t of tasks) {
      let row = out.get(t.projectId);
      if (!row) {
        row = { projectId: t.projectId, label: t.projectId.replace(/-[^-]+$/, ''), total: 0, perColumn: columns.map(() => 0) };
        out.set(t.projectId, row);
      }
      row.total += 1;
      row.perColumn[col] += 1;
    }
  });
  return [...out.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}
