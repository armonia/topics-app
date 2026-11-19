/**
 * sarim-deadlines: the schedule of «Dati». Every deadline of SARIM, as a list (allow-italian: quotes the Italian interface)
 * or as a month (two addresses: `/scadenzario` and `/scadenzario/mese`): the (allow-italian: address segments)
 * due day of the cards, the end and the last day for notice of the contracts,
 * the obligations written in the clauses. One filter bar (kind, area, state,
 * day, the search), the closed ones on request; a deadline opens its card or
 * its clause. The contract part is read the way «Contratti» reads it, so its
 * numbers are the same. (allow-italian: quotes the Italian interface)
 */
import { useMemo } from 'react';
import { ArrowRight, CalendarClock, CalendarX, CircleDot, Download, Flag, Tag, Users } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Checkbox } from '../../../../ui/primitives/Field';
import { Table } from '../../../../ui/primitives/Table';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { ViewSwitch } from '../../../../ui/kanban/KanbanHeader';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import { MonthCalendar } from '../../../../ui/data/MonthCalendar';
import type { CalendarItemModel } from '../../../../ui/data/model';
import type { SarimDeadlineKind, SarimDeadlineState } from '../../../../ui/copy/sarim-data';
import { agentById } from '../../world';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import { aboutOf, allDeadlines, DEADLINE_KEYS, isDueSoon, relativeDay, STATE_TONE, stateOf, teamOfDeadline, whatOf, type Deadline } from './deadlines';
import { downloadText, personShort, toCsv } from './tables';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';

const KINDS: SarimDeadlineKind[] = ['card', 'end', 'notice', 'obligation'];

/** The one name a person has in the work screens (the short one «Da fare» prints), or the name of the agent. (allow-italian: quotes the Italian interface) */
const ownerName = (id: string) => agentById(id)?.name ?? personShort(id);

export function DeadlinesScreen({ ctx, view }: { ctx: ScreenCtx; view: 'list' | 'month' }) {
  const s = ctx.copy.sarimData;
  const dl = s.deadlines;
  const today = ctx.now.slice(0, 10);
  const [showDone, setShowDone] = ctx.ui<boolean>(DEADLINE_KEYS.done, false);
  const [month, setMonth] = ctx.ui<string>('sarim.dl.month', today.slice(0, 7));
  const [day, setDay] = ctx.ui<string>('sarim.dl.day', '');

  const every = useMemo(() => allDeadlines(ctx.state, today), [ctx.state, today]);
  const pool = useMemo(() => (showDone ? every : every.filter((d) => !d.done)), [every, showDone]);
  const copyOnly = useMemo(() => ({ copy: ctx.copy }), [ctx.copy]);
  const teamLabels = useMemo(() => new Map(every.map((d) => [teamOfDeadline(d).id, teamOfDeadline(d).label])), [every]);
  const schema = useMemo<FilterSchema<Deadline>>(() => ({
    text: (d) => [whatOf(copyOnly, d), aboutOf(copyOnly, d), ownerName(d.owner), teamOfDeadline(d).label].join(' '),
    fields: [
      { id: 'tipo', label: dl.fields.kind, icon: Tag, kind: 'choice', get: (d) => d.kind, valueLabel: (v) => dl.kinds[v as SarimDeadlineKind], order: KINDS },
      { id: 'area', label: dl.fields.area, icon: Users, kind: 'choice', get: (d) => teamOfDeadline(d).id, valueLabel: (v) => teamLabels.get(v) ?? v },
      { id: 'state', label: dl.fields.state, icon: CircleDot, kind: 'choice', get: (d) => stateOf(d, today), valueLabel: (v) => dl.states[v as SarimDeadlineState], order: ['late', 'soon', 'open', 'done'], values: ['late', 'soon', 'open'] },
      /* what the overview of «Dati» counts as due within the week, late ones included (allow-italian: quotes the Italian interface) */
      { id: 'entro', label: dl.fields.within, icon: Flag, kind: 'choice', ops: ['is'], get: (d) => (!d.done && isDueSoon(d.day, today) ? 'week' : []), valueLabel: () => dl.saved.week, values: ['week'] },
      { id: 'day', label: dl.fields.day, icon: CalendarClock, kind: 'date', get: (d) => d.day },
    ],
  }), [dl, today, copyOnly, teamLabels]);
  const presets = useMemo<SavedFilter[]>(() => [
    { id: 'late', name: dl.saved.late, tokens: [{ id: 'p1', field: 'state', op: 'is', value: 'late' }] },
    { id: 'soon', name: dl.saved.soon, tokens: [{ id: 'p2', field: 'state', op: 'is', value: 'soon' }] },
    { id: 'notices', name: dl.saved.notices, tokens: [{ id: 'p3', field: 'tipo', op: 'is', value: 'notice' }, { id: 'p4', field: 'day', op: 'within', value: '180' }] }, // allow-italian: field id
    { id: 'week', name: dl.saved.week, tokens: [{ id: 'p5', field: 'entro', op: 'is', value: 'week' }] }, // allow-italian: field id
  ], [dl]);
  const list = useListFilters(ctx, { key: DEADLINE_KEYS.filters, items: pool, schema, presets });
  const shown = list.items;
  const stateText = (st: SarimDeadlineState) => dl.states[st];

  const exportList = () => {
    const name = dl.file(today);
    const csv = toCsv(
      [dl.columns.day, dl.columns.what, dl.columns.about, dl.columns.area, dl.columns.owner, dl.columns.status],
      shown.map((d) => [formatDay(d.day), whatOf(ctx, d), aboutOf(ctx, d), teamOfDeadline(d).label, ownerName(d.owner), stateText(stateOf(d, today))]),
    );
    downloadText(name, csv);
    ctx.log(dl.logExported(shown.length), 'share', SP.deadlines());
    ctx.toast({ tone: 'ok', title: dl.exported(shown.length), body: name });
  };

  const items: CalendarItemModel[] = shown.map((d) => {
    const st = stateOf(d, today);
    return { id: d.id, day: d.day, label: d.card ? `${d.card.id} · ${whatOf(ctx, d)}` : whatOf(ctx, d), tone: STATE_TONE[st], opens: true };
  });
  const dayItems = shown.filter((d) => d.day === day);

  const list_ = shown.length === 0 ? (
    <EmptyState icon={CalendarX} title={dl.empty.title} action={list.state.tokens.length || list.state.query ? <Button variant="primary" onClick={list.bar.onClear}>{dl.empty.clear}</Button> : undefined} className="min-h-0 rounded-lg border border-app-border bg-surface py-10">
      {dl.empty.body}
    </EmptyState>
  ) : ctx.phone ? (
    <ul className="space-y-2">
      {shown.map((d) => {
        const st = stateOf(d, today);
        return (
          <li key={d.id}>
            <button type="button" data-deadline={d.id} onClick={() => ctx.go(d.path)} className={clsx('block w-full rounded-lg border border-app-border bg-surface px-3.5 py-2.5 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
              <span className="flex items-center gap-2">
                <span className="text-compact font-semibold tabular-nums text-app-text">{formatDay(d.day)}</span>
                <span className="text-compact text-app-text-tertiary">{relativeDay(ctx, d.day, today)}</span>
                <span className="flex-1" />
                <Chip tone={STATE_TONE[st]}>{stateText(st)}</Chip>
              </span>
              <span className="mt-1 block text-prose leading-5 text-app-text">{whatOf(ctx, d)}</span>
              <span className="block text-compact leading-4 text-app-text-secondary">{aboutOf(ctx, d)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  ) : (
    <Table
      ariaLabel={dl.title}
      /* what is due takes the room: who and their team share one column, the team under the name */
      columns={[
        { id: 'day', label: dl.columns.day, width: 110 },
        { id: 'what', label: dl.columns.what, width: 440 },
        { id: 'owner', label: dl.columns.owner, width: 170 },
        { id: 'status', label: dl.columns.status, width: 100 },
      ]}
      rows={shown.map((d) => {
        const st = stateOf(d, today);
        return {
          id: d.id,
          muted: d.done,
          onOpen: () => ctx.go(d.path),
          cells: {
            day: (
              <span className="block leading-5">
                <span className="block tabular-nums text-app-text">{formatDay(d.day)}</span>
                <span className="block text-mini text-app-text-tertiary">{relativeDay(ctx, d.day, today)}</span>
              </span>
            ),
            what: (
              <span className="block leading-5">
                <span className="block font-medium text-app-text">{whatOf(ctx, d)}</span>
                <span className="mt-0.5 block text-compact text-app-text-secondary"><Chip className="mr-1.5 align-middle">{dl.tag[d.kind]}</Chip>{aboutOf(ctx, d)}</span>
              </span>
            ),
            owner: (
              <span className="block leading-5">
                <span className="block text-app-text">{ownerName(d.owner)}</span>
                <span className="block text-compact text-app-text-tertiary">{teamOfDeadline(d).label}</span>
              </span>
            ),
            status: <Chip tone={STATE_TONE[st]}>{stateText(st)}</Chip>,
          },
        };
      })}
    />
  );

  const calendar = (
    <div className="space-y-3">
      <MonthCalendar
        month={month}
        today={today}
        items={items}
        selectedDay={day || undefined}
        onDay={setDay}
        onItem={(id) => { const d = shown.find((x) => x.id === id); if (d) ctx.go(d.path); }}
        onMonth={(delta) => {
          if (delta === 0) { setMonth(today.slice(0, 7)); setDay(today); return; }
          const [y, m] = month.split('-').map(Number);
          const next = new Date(Date.UTC(y, m - 1 + delta, 1));
          setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`);
        }}
        copy={ctx.copy}
        phone={ctx.phone}
      />
      {day && (
        <div className="rounded-lg border border-app-border bg-surface px-3.5 py-3">
          <p className="mb-1 text-prose font-semibold text-app-text">{formatDay(day)}</p>
          {dayItems.length === 0 ? <p className="text-prose text-app-text-secondary">{dl.nothing}</p> : (
            <ul className="space-y-0.5">
              {dayItems.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => ctx.go(d.path)} className={clsx('flex w-full items-center gap-2 rounded px-1 py-1 text-left text-prose text-app-text hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}>
                    <Chip tone={STATE_TONE[stateOf(d, today)]}>{dl.tag[d.kind]}</Chip>
                    <span className="min-w-0 flex-1 truncate">{whatOf(ctx, d)}</span>
                    <ArrowRight size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const views = [{ id: 'list', label: dl.view.list }, { id: 'month', label: dl.view.calendar }];
  const trailing = <Checkbox checked={showDone} onChange={setShowDone} label={dl.showDone} />;
  const controls = (
    <>
      <ViewSwitch views={views} active={view} label={dl.view.label} compact={ctx.phone} onPick={(id) => ctx.go(id === 'month' ? SP.deadlinesMonth() : SP.deadlines())} />
      <Button icon={Download} onClick={ctx.allow('export', exportList)} title={ctx.deniedTitle('export')}>{dl.exportCsv}</Button>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-deadlines-view={view}>
      <PaneHeader
        /* on the desk the crumb «Dati» already leads back; the arrow is for the phone, which shows only the last crumb */
        leading={ctx.phone ? <BackButton label={s.title} copy={ctx.copy} onClick={() => ctx.go(SP.data())} /> : undefined}
        crumbs={orgCrumbs(ctx, [{ label: s.knowledge.title, to: SP.knowledge() }, { label: s.title, to: SP.data() }, { label: dl.title, detail: s.common.rows(shown.length) }])}
      >
        {!ctx.phone && controls}
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="data" />
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-4 py-2">{controls}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className={`min-w-0 space-y-3 ${PAGE_GUTTER} py-3`}>
          <FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.deadlines} phone={ctx.phone} trailing={trailing} />
          {view === 'list' ? list_ : calendar}
        </section>
      </div>
    </div>
  );
}
