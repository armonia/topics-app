/**
 * The deadlines of every contract (orbit-contract-deadlines and
 * orbit-contract-deadlines-month), as a list or as a month, each at its own
 * address: the ends, the last day to give notice (tacit renewals and options),
 * the reminders before it the reader chooses (180, 90, 30 days), and the next
 * day of every obligation. Each item opens the clause it is read from. Past
 * notices drop out (the renewal already happened); an obligation past its day
 * stays, late, until it is closed. The filter bar carries the filters of both.
 */
import { useMemo } from 'react';
import { CalendarClock, CalendarX, CircleDot, FileText, Tag } from 'lucide-react';
import clsx from 'clsx';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Checkbox } from '../../../../ui/primitives/Field';
import { Table } from '../../../../ui/primitives/Table';
import { MonthCalendar } from '../../../../ui/data/MonthCalendar';
import type { CalendarItemModel } from '../../../../ui/data/model';
import { ViewSwitch } from '../../../../ui/kanban/KanbanHeader';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { world } from '../../world';
import { liveContracts } from '../../model/live';
import { currentVersion, daysTo } from '../../model/contracts';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import { relDay } from './actions';
import { today } from './view';
import { actorOf, contractEvents, longDay, type ContractEvent } from './model';
import { personShort } from '../data/tables';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';

/** The short name of whoever owns the event, as the Scadenzario writes it: the full names stay in the team and on a person's page. */
const ownerName = (e: ContractEvent) => {
  const id = e.obligation?.owner ?? e.contract.owner;
  const actor = actorOf(id);
  return actor.agent ? actor.name : personShort(id);
};

type EventState = 'late' | 'soon' | 'open' | 'done';

const LEADS = [180, 90, 30] as const;
const STATE_TONE: Record<EventState, Tone> = { late: 'red', soon: 'amber', open: 'blue', done: 'green' };

function stateOf(e: ContractEvent, day: string): EventState {
  if (e.done) return 'done';
  const n = daysTo(e.day, day);
  return n < 0 ? 'late' : n <= 30 ? 'soon' : 'open';
}

function whatOf(ctx: Pick<ScreenCtx, 'copy'>, e: ContractEvent): string {
  const t = ctx.copy.contracts.deadlines.events;
  const tacit = e.contract.renewal.kind === 'tacito'; // allow-italian: data code compared by value
  if (e.kind === 'end') return t.end;
  if (e.kind === 'notice') return tacit ? t.notice.tacit : t.notice.option;
  if (e.kind === 'reminder') return t.reminder(e.lead ?? 0, tacit);
  return e.obligation?.what ?? '';
}

function clauseOf(ctx: Pick<ScreenCtx, 'copy'>, e: ContractEvent): string | undefined {
  if (!e.clause) return undefined;
  const n = currentVersion(e.contract).clauses.find((x) => x.id === e.clause)?.n;
  return n ? ctx.copy.contracts.common.clause(n) : undefined;
}

const pathOf = (e: ContractEvent) => (e.clause ? SP.clause(e.contract.id, e.clause) : SP.contract(e.contract.id));

export function DeadlinesPlace({ ctx, view }: { ctx: ScreenCtx; view: 'list' | 'month' }) {
  const { copy } = ctx;
  const t = copy.contracts;
  const d = t.deadlines;
  const day = today(ctx);
  const contracts = liveContracts(ctx.state);
  const [showDone, setShowDone] = ctx.ui<boolean>('contracts.dl.done', false);
  const [leads, setLeads] = ctx.ui<number[]>('contracts.dl.leads', [90, 30]);
  const [month, setMonth] = ctx.ui<string>('contracts.dl.month', day.slice(0, 7));
  const [picked, setPicked] = ctx.ui<string>('contracts.dl.day', '');

  // A notice whose day has passed is gone: the contract renewed or the option lapsed.
  const every = contractEvents(contracts, leads, day).filter((e) => !(e.kind === 'notice' && e.day < day));
  const pool = every.filter((e) => showDone || !e.done);
  const toggleLead = (n: number) => setLeads(leads.includes(n) ? leads.filter((x) => x !== n) : [...leads, n].sort((a, b) => b - a));

  const schema = useMemo<FilterSchema<ContractEvent>>(() => ({
    text: (e) => `${whatOf({ copy }, e)} ${e.contract.title} ${e.contract.counterparty} ${ownerName(e)}`,
    fields: [
      { id: 'tipo', label: d.fields.kind, icon: Tag, kind: 'choice', get: (e) => e.kind, valueLabel: (v) => d.kinds[v as ContractEvent['kind']], order: ['end', 'notice', 'reminder', 'obligation'] },
      { id: 'contratto', label: d.fields.contract, icon: FileText, kind: 'choice', get: (e) => e.contract.id, valueLabel: (v) => world().contracts.find((c) => c.id === v)?.title ?? v },
      { id: 'state', label: d.fields.state, icon: CircleDot, kind: 'choice', get: (e) => stateOf(e, day), valueLabel: (v) => d.status[v as EventState], order: ['late', 'soon', 'open', 'done'], values: ['late', 'soon', 'open'] },
      { id: 'day', label: d.fields.day, icon: CalendarClock, kind: 'date', get: (e) => e.day },
    ],
  }), [d, day, copy]);
  const presets = useMemo<SavedFilter[]>(() => [
    { id: 'late', name: d.saved.late, tokens: [{ id: 'p1', field: 'state', op: 'is', value: 'late' }] },
    { id: 'soon', name: d.saved.soon, tokens: [{ id: 'p2', field: 'state', op: 'is', value: 'soon' }] },
    { id: 'notices', name: d.saved.notices, tokens: [{ id: 'p3', field: 'tipo', op: 'is', value: 'notice' }, { id: 'p4', field: 'day', op: 'within', value: '180' }] },
  ], [d]);
  const list = useListFilters(ctx, { key: 'orbit.contracts.deadlines.filters', items: pool, schema, presets });
  const events = list.items;

  const table = (list: ContractEvent[]) => {
    if (!list.length) {
      return <EmptyState icon={CalendarX} title={d.emptyTitle} className="min-h-0 rounded-lg border border-app-border bg-surface py-10">{d.emptyBody}</EmptyState>;
    }
    if (ctx.phone) {
      return (
        <ul className="space-y-2">
          {list.map((e) => {
            const s = stateOf(e, day);
            return (
              <li key={e.id}>
                <button type="button" data-deadline={e.id} onClick={() => ctx.go(pathOf(e))} className={clsx('block w-full rounded-lg border border-app-border bg-surface px-3.5 py-2.5 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
                  <span className="flex items-center gap-2">
                    <span className="text-compact font-semibold tabular-nums text-app-text">{longDay(e.day)}</span>
                    <span className="text-compact text-app-text-tertiary">{relDay(ctx, e.day, day)}</span>
                    <span className="flex-1" />
                    <Chip tone={STATE_TONE[s]}>{d.status[s]}</Chip>
                  </span>
                  <span className="mt-1 block text-prose leading-5 text-app-text">{whatOf(ctx, e)}</span>
                  <span className="block text-compact leading-4 text-app-text-secondary">{e.contract.counterparty}{clauseOf(ctx, e) ? ` · ${clauseOf(ctx, e)}` : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      );
    }
    return (
      <Table
        ariaLabel={d.title}
        columns={[
          { id: 'day', label: d.columns.day, width: 130 },
          { id: 'what', label: d.columns.what },
          { id: 'contract', label: d.columns.contract, width: 260 },
          { id: 'clause', label: d.columns.clause, width: 90 },
          { id: 'owner', label: d.columns.owner, width: 170 },
          { id: 'status', label: d.columns.status, width: 110 },
        ]}
        rows={list.map((e) => {
          const s = stateOf(e, day);
          return {
            id: e.id,
            muted: e.done,
            onOpen: () => ctx.go(pathOf(e)),
            cells: {
              day: (
                <span className="block leading-5">
                  <span className="block tabular-nums text-app-text">{longDay(e.day)}</span>
                  <span className="block text-mini text-app-text-tertiary">{relDay(ctx, e.day, day)}</span>
                </span>
              ),
              what: <span data-deadline={e.id} className="text-app-text">{whatOf(ctx, e)}</span>,
              contract: (
                <span className="block leading-5">
                  <span className="block text-app-text">{e.contract.title}</span>
                  {/* The counterparty only when the title does not already end with it. */}
                  {!e.contract.title.includes(e.contract.counterparty) && <span className="block text-mini text-app-text-tertiary">{e.contract.counterparty}</span>}
                </span>
              ),
              clause: <span className="text-app-text-secondary">{clauseOf(ctx, e) ?? ''}</span>,
              owner: <span className="text-app-text-secondary">{ownerName(e)}</span>,
              status: <Chip tone={STATE_TONE[s]}>{d.status[s]}</Chip>,
            },
          };
        })}
      />
    );
  };

  const items: CalendarItemModel[] = events.map((e) => ({
    id: e.id,
    day: e.day,
    label: `${e.contract.counterparty}: ${whatOf(ctx, e)}`,
    tone: STATE_TONE[stateOf(e, day)],
    opens: true,
  }));
  const inMonth = events.filter((e) => (picked ? e.day === picked : e.day.startsWith(month)));

  const views = [{ id: 'list', label: d.views.list }, { id: 'month', label: d.views.calendar }];
  const trailing = (
    <span className="flex flex-wrap items-center gap-2">
      <span role="group" aria-label={d.leadsLabel} data-tip={d.leadsHint} className="flex items-center gap-1">
        <span className="mr-0.5 text-compact text-app-text-tertiary">{d.leadsLabel}</span>
        {LEADS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={leads.includes(n)}
            onClick={() => toggleLead(n)}
            className={clsx(
              'inline-flex h-6 items-center rounded-full border px-2.5 text-compact font-medium tabular-nums transition-colors',
              leads.includes(n) ? 'border-primary/40 bg-primary/10 text-app-text' : 'border-app-border text-app-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
              FOCUS_RING,
            )}
          >
            {d.lead(n)}
          </button>
        ))}
      </span>
      <Checkbox checked={showDone} onChange={setShowDone} label={d.showDone} />
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        leading={<BackButton label={t.title} onClick={() => ctx.go(SP.contracts())} copy={ctx.copy} />}
        crumbs={orgCrumbs(ctx, [{ label: ctx.copy.orbitData.knowledge.title, to: SP.knowledge() }, { label: t.title, to: SP.contracts() }, { label: d.crumb }])}
      >
        <ViewSwitch views={views} active={view} label={d.viewsLabel} compact={ctx.phone} onPick={(id) => ctx.go(id === 'month' ? SP.contractDeadlinesMonth() : SP.contractDeadlines())} />
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="contracts" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${PAGE_GUTTER} pt-3`}>
          <FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.deadlines} phone={ctx.phone} trailing={trailing} />
        </div>
        <div className="p-4">
          {view === 'list' ? table(events) : (
            <div className="space-y-3">
              <MonthCalendar
                month={month}
                today={day}
                items={items}
                selectedDay={picked || undefined}
                onDay={(x) => setPicked(x === picked ? '' : x)}
                onItem={(id) => {
                  const e = events.find((x) => x.id === id);
                  if (e) ctx.go(pathOf(e));
                }}
                onMonth={(delta) => {
                  if (delta === 0) { setMonth(day.slice(0, 7)); setPicked(day); return; }
                  const [y, m] = month.split('-').map(Number);
                  const next = new Date(Date.UTC(y, m - 1 + delta, 1));
                  setMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`);
                  setPicked('');
                }}
                copy={ctx.copy}
                phone={ctx.phone}
              />
              <div className="flex items-center gap-2">
                <h2 className="min-w-0 flex-1 text-prose font-semibold text-app-text">{picked ? longDay(picked) : ctx.copy.dataMore.calendar.monthTitle(ctx.copy.dataMore.months[Number(month.slice(5, 7)) - 1], Number(month.slice(0, 4)))}</h2>
                {picked && <Button size="sm" variant="ghost" onClick={() => setPicked('')}>{d.clearDay}</Button>}
              </div>
              {picked && !inMonth.length
                ? <p className="rounded-lg border border-app-border bg-surface px-3 py-4 text-prose text-app-text-secondary">{d.nothingThatDay}</p>
                : table(inMonth)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
