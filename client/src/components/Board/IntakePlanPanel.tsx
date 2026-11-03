import { Loader2 } from 'lucide-react';
import { blockingReason, type IntakeProject, type IntakeRow } from '../../../../shared/intake-plan';
import { useT } from '../../hooks/useT';

/**
 * The proposal shown BEFORE anything is created: one row per card with its
 * project, sub-cards indented under their parent. The writer ticks, retitles
 * or moves a row to another project; only "Create" touches the boards.
 */
export function IntakePlanPanel({ rows, projects, busy, failures, onChange, onConfirm, onCancel }: {
  rows: IntakeRow[];
  projects: IntakeProject[];
  busy: boolean;
  /** key -> error, after a partial create; those rows can be retried. */
  failures: Record<string, string>;
  onChange: (rows: IntakeRow[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const patch = (key: string, change: Partial<IntakeRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const depthOf = (row: IntakeRow): number => {
    let depth = 0;
    let cursor: IntakeRow | undefined = row;
    while (cursor?.parentKey) { depth++; cursor = rows.find((r) => r.key === cursor!.parentKey); }
    return depth;
  };
  const ticked = rows.filter((r) => r.checked).length;
  const blocked = blockingReason(rows) !== null;

  return (
    <div
      data-testid="intake-plan"
      className="mx-2.5 mb-2 rounded-lg border border-app-border bg-black/5 p-2 text-mini dark:bg-white/5"
    >
      <div className="mb-1.5 text-app-text-muted">{tr('board.intakePlan.heading')}</div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.key}
            data-testid="intake-plan-row"
            style={{ paddingLeft: depthOf(row) * 18 }}
            className="flex items-center gap-2"
          >
            <input
              type="checkbox"
              checked={row.checked}
              onChange={(e) => patch(row.key, { checked: e.target.checked })}
              data-testid="intake-plan-check"
            />
            <select
              value={row.projectId ?? ''}
              onChange={(e) => patch(row.key, { projectId: e.target.value || null, unresolvedName: null })}
              data-testid="intake-plan-project"
              className="max-w-[9rem] shrink-0 rounded border border-app-border bg-transparent px-1 py-0.5"
              disabled={row.parentKey !== null}
              title={row.unresolvedName ? `${tr('board.intakePlan.unknownProject')}: ${row.unresolvedName}` : undefined}
            >
              <option value="">{row.unresolvedName ? `? ${row.unresolvedName}` : tr('board.intakePlan.pickProject')}</option>
              {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
            </select>
            <input
              value={row.title}
              onChange={(e) => patch(row.key, { title: e.target.value })}
              data-testid="intake-plan-title"
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-app-text hover:border-app-border"
            />
            <span className="shrink-0 text-app-text-muted">
              {row.parentKey ? tr('board.intakePlan.subCard') : tr('board.intakePlan.topLevel')}
            </span>
            {failures[row.key] && (
              <span className="shrink-0 text-red-400" title={failures[row.key]} data-testid="intake-plan-failed">
                {tr('board.intakePlan.failed')}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={busy || blocked}
          data-testid="intake-plan-confirm"
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500/25 px-2 py-1 text-emerald-200 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {tr('board.intakePlan.create').replace('{n}', String(ticked))}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          data-testid="intake-plan-cancel"
          className="rounded-md bg-black/5 px-2 py-1 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
        >
          {tr('board.intakePlan.cancel')}
        </button>
      </div>
    </div>
  );
}
