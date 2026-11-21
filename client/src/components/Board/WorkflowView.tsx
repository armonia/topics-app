/**
 * THE WORKFLOW BEHIND THE BOARD, as a view of its own: the columns a card goes
 * through, how many cards sit in each, who moves it from there, and the two
 * rules a board chooses (when the CI measures the work, which paths a person
 * must look at). The columns are `shared/workflow.ts`, the rules the board's
 * `/workflow` answer: the same data the kanban and the settings panel read.
 */
import { CheckCircle2, ChevronDown, ChevronRight, GitMerge, Inbox, ListTodo, Settings2, UserRound, Bot } from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '../../hooks/useT';
import { columnOfTask, type BoardTask } from '../../lib/board';
import type { WorkflowColumn, WorkflowRules } from '../../../../shared/workflow';

const STEP_KEYS = ['backlog', 'todo', 'in_progress', 'review', 'ci', 'done'] as const;
type StepKey = (typeof STEP_KEYS)[number];
const STEP_ICON: Record<StepKey, typeof Bot> = { backlog: Inbox, todo: ListTodo, in_progress: Bot, review: UserRound, ci: GitMerge, done: CheckCircle2 };

const stepOf = (c: WorkflowColumn): StepKey => ((STEP_KEYS as readonly string[]).includes(c.id) ? c.id : c.base) as StepKey;

export function WorkflowView({ columns, tasks, rules, onOpenKanban, onOpenSettings }: {
  columns: readonly WorkflowColumn[];
  /** Every card of the board, before the filters: the view counts the whole flow. */
  tasks: readonly BoardTask[];
  /** The board's rules; null on the global board, where each project has its own. */
  rules: WorkflowRules | null;
  onOpenKanban: () => void;
  onOpenSettings?: () => void;
}) {
  const tr = useT();
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of tasks) {
      const col = columnOfTask(columns, t);
      if (col) out.set(col.id, (out.get(col.id) ?? 0) + 1);
    }
    return out;
  }, [tasks, columns]);
  // The CI column is a step only when the board measures the work BEFORE it lands.
  const ciNote = rules?.ciPhase === 'off' ? tr('board.workflow.ciOff') : rules?.ciPhase === 'after' ? tr('board.workflow.ciAfter') : null;

  return (
    <section data-testid="workflow-view" aria-label={tr('board.view.workflow')} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 @container">
      <div className="mx-auto max-w-2xl @5xl:max-w-none">
        <p className="mb-3 text-compact leading-snug text-app-text-secondary">{tr(rules ? 'board.workflow.intro' : 'board.workflow.introAll')}</p>
        <ol className="flex flex-col items-stretch gap-1 @5xl:flex-row">
          {columns.map((c, i) => {
            const key = stepOf(c);
            const Icon = STEP_ICON[key] ?? Bot;
            const off = key === 'ci' && !!ciNote;
            const n = counts.get(c.id) ?? 0;
            return (
              <li key={c.id} className="flex min-w-0 flex-col items-center gap-1 @5xl:flex-1 @5xl:flex-row">
                <button
                  type="button" data-testid={`workflow-step-${c.id}`} onClick={onOpenKanban}
                  title={tr('board.workflow.openKanban')}
                  className={`flex h-full w-full min-w-0 flex-col gap-1.5 rounded-lg border border-app-border bg-surface p-3 text-left shadow-sm hover:border-app-border-light ${off ? 'opacity-60' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-app-text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-prose font-semibold text-app-text">{c.label}</span>
                    <span data-testid={`workflow-count-${c.id}`} className="shrink-0 rounded-full bg-black/5 px-2 text-compact leading-5 tabular-nums text-app-text-secondary dark:bg-white/10"
                      aria-label={tr('board.workflow.count', { n })}>{n}</span>
                  </span>
                  <span className="text-compact leading-snug text-app-text">{off ? ciNote : tr(`board.workflow.step.${key}`)}</span>
                  <span className="mt-auto flex items-start gap-1 text-mini leading-4 text-app-text-muted">
                    <UserRound className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />{tr(`board.workflow.who.${key}`)}
                  </span>
                </button>
                {i < columns.length - 1 && <>
                  <ChevronDown className="h-4 w-4 shrink-0 text-app-text-muted @5xl:hidden" aria-hidden="true" />
                  <ChevronRight className="hidden h-4 w-4 shrink-0 text-app-text-muted @5xl:block" aria-hidden="true" />
                </>}
              </li>
            );
          })}
        </ol>

        {rules && (
          <div className="mt-5 grid gap-3 md:grid-cols-2" data-testid="workflow-rules">
            <div className="rounded-lg border border-app-border p-3">
              <p className="text-compact font-semibold text-app-text">{tr('board.settings.workflow.ci')}: {tr(`board.settings.workflow.ci.${rules.ciPhase}`)}</p>
              <p className="mt-1 text-compact leading-snug text-app-text-secondary">{tr(`board.settings.workflow.ci.${rules.ciPhase}.hint`)}</p>
            </div>
            <div className="rounded-lg border border-app-border p-3">
              <p className="text-compact font-semibold text-app-text">{tr('board.settings.workflow.paths')}</p>
              {rules.personPaths.length === 0
                ? <p className="mt-1 text-compact leading-snug text-app-text-secondary">{tr('board.workflow.pathsNone')}</p>
                : <ul className="mt-1 space-y-1">{rules.personPaths.map((p) => (
                  <li key={p.pattern} className="text-compact leading-snug text-app-text-secondary">
                    <code className="rounded bg-black/5 px-1 text-app-text dark:bg-white/10">{p.pattern}</code>{p.why ? ` ${p.why}` : ''}
                  </li>
                ))}</ul>}
            </div>
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} data-testid="workflow-open-settings"
                className="flex items-center gap-1.5 justify-self-start rounded px-2 py-1 text-compact text-app-text-secondary hover:bg-black/5 hover:text-app-text dark:hover:bg-white/5 coarse:min-h-11"
              ><Settings2 className="h-3.5 w-3.5" aria-hidden="true" />{tr('board.workflow.settings')}</button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
