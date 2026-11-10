/** «La mia giornata» (x05): the model of the day wired to the rest of the preview. */
import type { ScreenCtx } from '../../kit';
import { TodayScreen } from '../../../../ui/work/TodayScreen';
import { AGENDA, PROCEDURE_REVIEW } from '../../../../ui/fixtures/work';
import { P } from '../../paths';
import { mineOf, todayOf } from './today';

export function TodayPlace({ ctx }: { ctx: ScreenCtx }) {
  const today = todayOf(ctx);
  const w = ctx.copy.work.today;
  const firstOf = (office: string) => mineOf(ctx).find((c) => c.office === office) ?? mineOf(ctx)[0];

  const openTask = (id: string) => {
    const [kind, caseId] = id.split(':');
    if (kind === 'work' || kind === 'wait') ctx.go(P.record(caseId));
    else if (kind === 'queue') ctx.go(P.inbox());
    else ctx.go(P.procedure(PROCEDURE_REVIEW.id));
  };
  const openAgenda = (id: string) => {
    const item = AGENDA.find((a) => a.id === id);
    if (item?.office === 'legale' && firstOf('legale')) ctx.go(P.record(firstOf('legale').id));
    else if (item?.office === 'direzione') ctx.go(P.overview());
    else if (item?.office === 'protocollo') ctx.go(P.program('halley'));
    else ctx.toast({ tone: 'info', title: w.agendaOpened });
  };
  return (
    <TodayScreen
      today={today}
      copy={ctx.copy}
      canWork={ctx.can('view:data')}
      onOpenTask={openTask}
      onOpenDeadline={(id) => ctx.go(P.recordSheet(id.split('|')[0]))}
      onOpenRecent={(id) => {
        const entry = ctx.state.audit.find((e) => e.id === id);
        if (entry?.path) ctx.go(entry.path);
      }}
      onOpenAgenda={openAgenda}
      onOpenDeadlines={() => ctx.go(P.deadlines())}
    />
  );
}
