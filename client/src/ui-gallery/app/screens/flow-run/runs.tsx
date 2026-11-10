/**
 * The runs of a flow (n10): every item that went through it, filtered by
 * outcome and day, searched, and a row opens the run.
 */
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { FlowHeader } from '../../../../ui/flowrun/common';
import type { RunRowModel } from '../../../../ui/flowrun/model';
import { RunsPanel, type RunFilter } from '../../../../ui/flowrun/RunsPanel';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import {
  dayOf, filterOf, clockTime, liveRunsOf, shortDate, type LiveRun,
} from './data';
import { VIEWS, useFlowSlice, useRunOverrides, viewPath } from './shared';
import { actorOf, runDuration, statusText } from './runs-text';

export function RunsScreen({ ctx, flow }: { ctx: ScreenCtx; flow: FlowSeed }) {
  const copy = ctx.copy;
  const c = copy.flowRun.runs;
  const [st] = useFlowSlice(ctx, flow);
  const [ov] = useRunOverrides(ctx);
  const [filter, setFilter] = ctx.ui<RunFilter>(`flowRun.runs.${flow.id}.filter`, 'all');
  const [query, setQuery] = ctx.ui<string>(`flowRun.runs.${flow.id}.q`, '');
  const [day, setDay] = ctx.ui<string>(`flowRun.runs.${flow.id}.day`, 'today');

  const all = liveRunsOf(flow.id, ov);
  const q = query.trim().toLowerCase();
  const typeQuery = /^tipo:([a-z])$/i.exec(q);
  const inDay = (r: LiveRun) => day === 'all' || r.day === day;
  const matches = (r: LiveRun) => {
    if (!q) return true;
    if (typeQuery) return r.type?.toLowerCase() === typeQuery[1];
    const runCase = caseSeed(r.caseId);
    return [r.title, r.caseId, r.id, runCase?.title, runCase?.subject, runCase?.counterpart].some((x) => x?.toLowerCase().includes(q));
  };
  const base = all.filter((r) => inDay(r) && matches(r));
  const counts: Record<RunFilter, number> = { all: base.length, running: 0, person: 0, error: 0, done: 0 };
  for (const r of base) counts[filterOf(r.status)] += 1;
  const shown = filter === 'all' ? base : base.filter((r) => filterOf(r.status) === filter);

  const rows: RunRowModel[] = shown.map((r) => {
    const runCase = caseSeed(r.caseId);
    const d = runDuration(ctx, r);
    const stepLabel = r.status === 'done' || r.status === 'archived' ? c.noStep : flow.steps.find((s) => s.id === r.stepId)?.label ?? c.noStep;
    const arrivedIso = r.resumedAt && r.status !== 'done' ? r.resumedAt : r.arrived;
    return {
      id: r.id,
      caseNo: r.caseId,
      title: runCase?.title ?? r.title,
      arrived: dayOf(arrivedIso) === dayOf(ctx.now) ? clockTime(arrivedIso) : `${shortDate(arrivedIso)} ${clockTime(arrivedIso)}`,
      step: stepLabel,
      actor: actorOf(flow, r),
      status: r.status,
      statusText: statusText(ctx, flow, r, st.activeOv),
      duration: d.text,
      live: d.live,
      onOpen: () => ctx.go(P.flowRun(flow.id, r.id)),
    };
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FlowHeader
        copy={copy}
        flowName={flow.name}
        here={c.crumb}
        views={VIEWS}
        view="runs"
        onView={(v) => ctx.go(viewPath(flow.id, v))}
        onBack={() => ctx.go(P.flow(flow.id))}
        phone={ctx.phone}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunsPanel
          copy={copy}
          view={{
            filter, counts, query, day,
            days: [{ value: 'today', label: c.days.today }, { value: 'yesterday', label: c.days.yesterday }, { value: 'all', label: c.days.all }],
            rows, neverRan: all.length === 0,
          }}
          onFilter={setFilter}
          onQuery={setQuery}
          onDay={setDay}
          onClear={() => { setFilter('all'); setQuery(''); setDay('today'); }}
        />
      </div>
    </div>
  );
}
