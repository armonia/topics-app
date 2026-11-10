/** The model of «La mia giornata» (x05) for the current person, from the cases and the log. */
import type { TodayModel, TodayTaskModel, DeadlineGroupModel, DeadlineRowModel } from '../../../../ui/work/model';
import { AGENDA, DONE_YESTERDAY, PROCEDURE_REVIEW, recordName } from '../../../../ui/fixtures/work';
import { DEMO_TODAY } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../kit';
import { queueFor, visibleCases, type LiveCase } from '../../store/cases';
import { canDo } from '../../store/permissions';
import { mainDeadline, isOverdue } from './adapters';
import { dateLabel, daysFromToday, distanceLabel, distanceTone, formatShortDay, historyAt, CLOSED } from './format';

const WEEK = 7;
const LATER_SHOWN = 4;

/** The cases this person works on now: confirmed, not closed, theirs or their office's. */
export function mineOf(ctx: ScreenCtx): LiveCase[] {
  return visibleCases(ctx.state, ctx.persona, 'nocera')
    .filter((c) => c.status === 'in-lavorazione' || c.status === 'in-attesa')
    .filter((c) => c.assignee === ctx.persona.id || ctx.persona.offices.length > 0 || ctx.persona.role === 'operatore' || ctx.persona.role === 'direzione')
    .sort((a, b) => (mainDeadline(a)?.date ?? '9999').localeCompare(mainDeadline(b)?.date ?? '9999'));
}

export function todayOf(ctx: ScreenCtx): TodayModel {
  const { copy, persona, state, now } = ctx;
  const w = copy.work.today;
  const open = visibleCases(state, persona, 'nocera').filter((c) => c.status !== CLOSED);
  const queue = queueFor(state, persona);
  const mine = mineOf(ctx);

  /* The cards: the cases to work, what waits in the queue, what waits for an answer, a procedure to review. */
  const tasks: TodayTaskModel[] = [];
  mine.filter((c) => c.status === 'in-lavorazione').slice(0, 2).forEach((c, i) => {
    const main = mainDeadline(c);
    const days = main ? daysFromToday(main.date) : undefined;
    const current = c.steps.find((s) => s.state === 'current');
    const next = c.steps.find((s) => s.state === 'todo');
    tasks.push({
      id: `work:${c.id}`,
      tone: days !== undefined && days <= WEEK ? 'urgent' : 'plain',
      chips: [
        ...(main ? [{ text: w.dueOn(formatShortDay(main.date)), tone: days !== undefined && days <= WEEK ? 'red' as const : 'neutral' as const }] : []),
        { text: recordName(c.id), tone: 'neutral' as const },
      ],
      title: c.title,
      detail: w.workDetail(current?.label ?? '', next?.label),
      action: w.work,
      primary: i === 0,
    });
  });
  if (queue.length > 0) {
    const overdue = queue.filter(isOverdue).length;
    tasks.push({
      id: 'queue',
      tone: overdue > 0 ? 'urgent' : 'todo',
      chips: [{ text: overdue > 0 ? w.queueOverdue(overdue) : w.toDo, tone: overdue > 0 ? 'red' : 'amber' }],
      title: w.queueTitle(queue.length),
      detail: w.queueDetail,
      action: w.open,
    });
  }
  mine.filter((c) => c.status === 'in-attesa').slice(0, 1).forEach((c) => {
    tasks.push({
      id: `wait:${c.id}`,
      tone: 'plain',
      chips: [{ text: recordName(c.id), tone: 'neutral' }],
      title: c.title,
      detail: w.waitingDetail(c.live.receipts?.[c.live.receipts.length - 1]?.title),
      action: w.open,
    });
  });
  if (canDo(state, persona, 'approve') || persona.offices.includes('legale')) {
    tasks.push({
      id: 'procedure',
      tone: 'procedure',
      chips: [{ text: PROCEDURE_REVIEW.tag, tone: 'pink' }],
      title: PROCEDURE_REVIEW.title,
      detail: PROCEDURE_REVIEW.detail,
      action: w.review,
    });
  }
  const urgent = tasks.filter((t) => t.tone === 'urgent').length;

  /* The deadlines of the cases the person can see, grouped by how close they are. */
  const rows: Array<DeadlineRowModel & { days: number }> = open.flatMap((c) => c.deadlines.map((d) => {
    const days = daysFromToday(d.date);
    return {
      id: `${c.id}|${d.id}`,
      label: `${formatShortDay(d.date)} · ${d.label}`,
      distance: distanceLabel(days, copy),
      tone: distanceTone(days),
      detail: `${recordName(c.id)} · ${c.title}`,
      days,
    };
  })).sort((a, b) => a.days - b.days);
  const group = (id: string, label: string, list: typeof rows): DeadlineGroupModel | undefined => (list.length ? { id, label, items: list.map((r) => ({ id: r.id, label: r.label, distance: r.distance, tone: r.tone, detail: r.detail })) } : undefined);
  const deadlineGroups = [
    group('overdue', w.groupOverdue, rows.filter((r) => r.days < 0)),
    group('today', w.groupToday, rows.filter((r) => r.days === 0)),
    group('week', w.groupWeek, rows.filter((r) => r.days > 0 && r.days <= WEEK)),
    group('later', w.groupLater, rows.filter((r) => r.days > WEEK).slice(0, LATER_SHOWN)),
  ].filter((g): g is DeadlineGroupModel => Boolean(g));

  const recent = state.audit.filter((e) => e.who === persona.id).slice(0, 5).map((e) => ({
    id: e.id,
    text: e.what,
    when: historyAt(e.at.replace('T', ' ').slice(0, 16)),
    linked: Boolean(e.path),
  }));

  const hour = Number(now.slice(11, 13));
  const part = hour < 12 ? w.morning : hour < 18 ? w.afternoon : w.evening;
  return {
    dateLabel: dateLabel(DEMO_TODAY, copy),
    headline: tasks.length === 0 ? `${part}. ${w.headlineNone}` : `${part}. ${w.headline(tasks.length, urgent)}`,
    tasks,
    deadlineGroups,
    recent,
    agenda: AGENDA
      .filter((a) => !persona.offices.length || !a.office || persona.offices.includes(a.office))
      .map((a) => ({ id: a.id, time: a.time, label: a.label, detail: a.detail })),
    doneYesterday: DONE_YESTERDAY,
  };
}
