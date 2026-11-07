import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { blockingReason, followParents, type IntakeProject, type IntakeRow } from '../../../../shared/intake-plan';
import { useLocale } from '../../hooks/useT';

// The panel's strings travel with its lazy chunk instead of the eager catalogue:
// most requests are one card and never open it (bundle budget, card a5906c31).
const TEXT = {
  en: {
    heading: 'Proposal: nothing is created until you confirm',
    unknownProject: 'Unknown project',
    pickProject: 'Pick a project',
    subCard: 'sub-card',
    topLevel: 'new card',
    failed: 'failed',
    create: 'Create {n} cards',
    noRelation: 'no existing card',
    under: 'under',
    above: 'above',
    cancel: 'Cancel',
    single: 'Send as one card',
  },
  it: {
    heading: 'Proposta: non viene creato nulla finché non confermi', // allow-italian: UI copy
    unknownProject: 'Progetto sconosciuto', // allow-italian: UI copy
    pickProject: 'Scegli il progetto', // allow-italian: UI copy
    subCard: 'sotto-card', // allow-italian: UI copy
    topLevel: 'nuova card', // allow-italian: UI copy
    failed: 'fallita', // allow-italian: UI copy
    create: 'Crea {n} card', // allow-italian: UI copy
    noRelation: 'nessuna card esistente', // allow-italian: UI copy
    under: 'sotto', // allow-italian: UI copy
    above: 'sopra', // allow-italian: UI copy
    cancel: 'Annulla', // allow-italian: UI copy
    single: 'Manda come una card sola', // allow-italian: UI copy
  },
};

const SELECT = 'max-w-[9rem] shrink-0 rounded border border-app-border bg-transparent px-1 py-0.5';
const SECONDARY = 'rounded-md bg-black/5 px-2 py-1 text-app-text-secondary hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10';

/**
 * The proposal shown BEFORE anything is created: one row per card with its
 * project, sub-cards indented under their parent. The writer ticks, retitles
 * or moves a row to another project; only "Create" touches the boards.
 */
export function IntakePlanPanel({ rows: input, projects, busy, failures, onChange, loadTasks, onConfirm, onSingle, onCancel }: {
  rows: IntakeRow[];
  projects: IntakeProject[];
  busy: boolean;
  /** key -> error, after a partial create; those rows can be retried. */
  failures: Record<string, string>;
  onChange: (rows: IntakeRow[]) => void;
  /** Open cards of a board, for the "under / above an existing card" pick. */
  loadTasks: (projectId: string) => Promise<{ id: string; text: string }[]>;
  onConfirm: () => void;
  /** Send the whole text as ONE card instead of the proposal. */
  onSingle: () => void;
  onCancel: () => void;
}) {
  const tx = useLocale() === 'it' ? TEXT.it : TEXT.en;
  const rows = followParents(input);
  const [existing, setExisting] = useState<Record<string, { id: string; text: string }[]>>({});
  const ensureTasks = (projectId: string | null) => {
    if (!projectId || existing[projectId]) return;
    setExisting((m) => ({ ...m, [projectId]: [] }));
    loadTasks(projectId).then((ts) => setExisting((m) => ({ ...m, [projectId]: ts })), () => {});
  };
  const patch = (key: string, change: Partial<IntakeRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const followsParent = (row: IntakeRow) => !!row.parentKey && !!rows.find((r) => r.key === row.parentKey)?.checked;
  const depthOf = (row: IntakeRow): number => {
    let depth = 0;
    let cursor: IntakeRow | undefined = row;
    while (cursor?.parentKey) { depth++; cursor = rows.find((r) => r.key === cursor!.parentKey); }
    return depth;
  };
  const ticked = rows.filter((r) => r.checked).length;
  const blocked = blockingReason(rows, projects) !== null;

  return (
    <div
      data-testid="intake-plan"
      className="mx-2.5 mb-2 rounded-lg border border-app-border bg-black/5 p-2 text-mini dark:bg-white/5"
    >
      <div className="mb-1.5 text-app-text-muted">{tx.heading}</div>
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
              onChange={(e) => patch(row.key, { projectId: e.target.value || null, unresolvedName: null, existingParentTaskId: null, existingChildTaskId: null })}
              data-testid="intake-plan-project"
              className={SELECT}
              disabled={followsParent(row)}
              title={row.unresolvedName ? `${tx.unknownProject}: ${row.unresolvedName}` : undefined}
            >
              <option value="">{row.unresolvedName ? `? ${row.unresolvedName}` : tx.pickProject}</option>
              {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
            </select>
            <input
              value={row.title}
              onChange={(e) => patch(row.key, { title: e.target.value })}
              data-testid="intake-plan-title"
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-app-text hover:border-app-border"
            />
            <span className="shrink-0 text-app-text-muted">{row.parentKey ? tx.subCard : tx.topLevel}</span>
            {!row.parentKey && row.projectId && (
              <select
                value={row.existingParentTaskId ? `under:${row.existingParentTaskId}` : row.existingChildTaskId ? `above:${row.existingChildTaskId}` : ''}
                onFocus={() => ensureTasks(row.projectId)}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(/:(.*)/s);
                  patch(row.key, {
                    existingParentTaskId: kind === 'under' ? id : null,
                    existingChildTaskId: kind === 'above' ? id : null,
                  });
                }}
                data-testid="intake-plan-relation"
                className={SELECT}
              >
                <option value="">{tx.noRelation}</option>
                {(['under', 'above'] as const).flatMap((kind) => (existing[row.projectId!] ?? []).map((t) => (
                  <option key={kind + t.id} value={`${kind}:${t.id}`}>{`${tx[kind]} ${t.text.slice(0, 40)}`}</option>
                )))}
              </select>
            )}
            {failures[row.key] && (
              <span className="shrink-0 text-red-400" title={failures[row.key]} data-testid="intake-plan-failed">{tx.failed}</span>
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
          {tx.create.replace('{n}', String(ticked))}
        </button>
        <button onClick={onSingle} disabled={busy} data-testid="intake-plan-single" className={SECONDARY}>{tx.single}</button>
        <button onClick={onCancel} disabled={busy} data-testid="intake-plan-cancel" className={SECONDARY}>{tx.cancel}</button>
      </div>
    </div>
  );
}
