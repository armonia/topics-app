import { CalendarClock, CircleAlert, Clock, FileText, History, Sun } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { FOCUS_RING } from '../shell/pressable';
import { PaneHeader } from '../shell/PaneHeader';
import type { DeadlineRowModel, TodayModel, TodayTaskModel } from './model';

const DISTANCE_TONE: Record<DeadlineRowModel['tone'], string> = {
  urgent: 'font-semibold text-rose-600 dark:text-rose-400',
  soon: 'font-semibold text-amber-700 dark:text-amber-400',
  later: 'font-medium text-app-text',
};

function TaskCard({ task, onOpen }: { task: TodayTaskModel; onOpen?: Action }) {
  return (
    <li
      className={clsx(
        'flex flex-col gap-3 rounded-lg border bg-surface px-4 py-3.5 sm:flex-row sm:items-center',
        task.tone === 'urgent' ? 'border-rose-500/70' : 'border-app-border',
      )}
    >
      <div className="min-w-0 flex-1">
        {task.chips.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {task.chips.map((c) => <Chip key={c.text} tone={c.tone} icon={task.tone === 'urgent' && c.tone === 'red' ? CircleAlert : c.tone === 'amber' ? Clock : undefined}>{c.text}</Chip>)}
          </div>
        )}
        <h3 className="text-body-lg font-semibold leading-6 text-app-text">{task.title}</h3>
        <p className="mt-0.5 text-prose leading-5 text-app-text-secondary">{task.detail}</p>
      </div>
      <Button size="lg" variant={task.primary ? 'primary' : 'secondary'} onClick={onOpen} className="self-start sm:self-center">{task.action}</Button>
    </li>
  );
}

/**
 * «La mia giornata» (x05): what waits for this person today, as cards with
 * their one button; on the side the deadlines of the next days, what they did
 * lately, a short agenda and the figures of yesterday. Every row opens the
 * thing it names. One column under 768px, tasks first.
 */
export function TodayScreen({ today, copy, onOpenTask, onOpenDeadline, onOpenRecent, onOpenAgenda, onOpenDeadlines, canWork = true, notice }: {
  today: TodayModel;
  copy: UiCopy;
  onOpenTask?: (id: string) => void;
  onOpenDeadline?: (id: string) => void;
  onOpenRecent?: (id: string) => void;
  onOpenAgenda?: (id: string) => void;
  onOpenDeadlines?: () => void;
  canWork?: boolean;
  notice?: React.ReactNode;
}) {
  const t = copy.work.today;
  const open = (id: string): Action => (canWork && onOpenTask ? () => onOpenTask(id) : false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: t.title }]} status={<span className="text-app-text-tertiary">{today.dateLabel}</span>}>{notice}</PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 md:px-9">
        <h2 className="mb-5 text-headline font-semibold tracking-[-0.01em] text-app-text">{today.headline}</h2>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-label={t.tasksLabel} className="min-w-0">
            {today.tasks.length === 0 ? (
              <div className="rounded-lg border border-app-border bg-surface"><EmptyState icon={Sun} title={t.nothingToday}>{t.nothingTodayBody}</EmptyState></div>
            ) : (
              <ul className="space-y-3">
                {today.tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={open(task.id)} />)}
              </ul>
            )}
          </section>
          <div className="min-w-0 space-y-4">
            <Card title={t.deadlines} icon={CalendarClock} actions={onOpenDeadlines && <Button size="sm" variant="ghost" onClick={onOpenDeadlines}>{t.allDeadlines}</Button>}>
              {today.deadlineGroups.length === 0 ? (
                <p>{t.noDeadlines}</p>
              ) : (
                <div className="space-y-3">
                  {today.deadlineGroups.map((g) => (
                    <div key={g.id}>
                      <div className="mb-1 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{g.label}</div>
                      <ul>
                        {g.items.map((d) => (
                          <li key={d.id}>
                            <button
                              type="button"
                              onClick={() => onOpenDeadline?.(d.id)}
                              className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-prose text-app-text">{d.label}</span>
                                {d.detail && <span className="block truncate text-mini text-app-text-tertiary">{d.detail}</span>}
                              </span>
                              <span className={clsx('shrink-0 text-prose tabular-nums', DISTANCE_TONE[d.tone])}>{d.distance}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title={t.agenda} icon={Clock}>
              <ul className="space-y-1">
                {today.agenda.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onOpenAgenda?.(a.id)}
                      className={clsx('-mx-2 flex w-[calc(100%+1rem)] gap-3 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                    >
                      <span className="w-11 shrink-0 text-prose tabular-nums text-app-text-tertiary">{a.time}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-prose text-app-text">{a.label}</span>
                        <span className="block text-mini text-app-text-tertiary">{a.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={t.recent} icon={History}>
              {today.recent.length === 0 ? (
                <p>{t.nothingRecent}</p>
              ) : (
                <ul className="space-y-0.5">
                  {today.recent.map((r) => (
                    <li key={r.id}>
                      {r.linked ? (
                        <button
                          type="button"
                          onClick={() => onOpenRecent?.(r.id)}
                          className={clsx('-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                        >
                          <span className="min-w-0 flex-1 truncate text-prose text-app-text">{r.text}</span>
                          <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{r.when}</span>
                        </button>
                      ) : (
                        <div className="flex items-baseline gap-3 py-1.5">
                          <span className="min-w-0 flex-1 truncate text-prose text-app-text">{r.text}</span>
                          <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{r.when}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={t.doneYesterday} icon={FileText}>
              <ul>
                {today.doneYesterday.map((d) => (
                  <li key={d.id} className="flex min-h-7 items-center gap-3 py-0.5 text-prose">
                    <span className="min-w-0 flex-1 truncate text-app-text-secondary">{d.label}</span>
                    <span className="font-semibold tabular-nums text-app-text">{d.value}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
