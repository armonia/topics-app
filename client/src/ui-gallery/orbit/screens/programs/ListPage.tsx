/**
 * orbit-programs: the programs of ORBIT grouped by what they are for, with
 * what Topics reads and writes in each, how it connects, how many flows use
 * it, how many open cards go through it and where it stands. The one filter
 * bar of every list narrows it (how it connects, state, the flow that uses
 * it; the ways of connecting are saved filters); a row opens the program. The
 * side panel counts the states and lists the latest connection events.
 */
import { useMemo } from 'react';
import { CheckCircle2, CircleAlert, CircleDot, Clock, Plug, PlugZap, Search, Workflow } from 'lucide-react';
import clsx from 'clsx';
import { world } from '../../world';
import type { ProgramGroup, OrbitProgram } from '../../../../ui/fixtures/orbit-org/programs';
import type { OrbitProgramLinkGroup, OrbitProgramStateWord } from '../../../../ui/copy/orbit-admin';
import type { UiCopy } from '../../../../ui/copy/types';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { PanelSection, SectionLabel, SidePanel } from '../../../../ui/primitives/Panel';
import { Spinner } from '../../../../ui/primitives/Progress';
import { Timeline } from '../../../../ui/primitives/Timeline';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { ConnectionChip, StatePill } from '../../../../ui/programs/Shared';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING, pressable } from '../../../../ui/shell/pressable';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { flowLabel } from '../../model/flows';
import { liveCards } from '../../model/live';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { shortNameOf, when } from '../../model/words';
import { LINK_KIND, STATE_TONE, flowsUsing, historyOf, openCards, programState, programsSlice } from './state';

const GROUPS: ProgramGroup[] = ['territory', 'staff', 'office', 'tenders', 'public'];
/** The ways of connecting, in the order of the list; the filter says them with the words of the rows. */
const LINK_GROUPS: OrbitProgramLinkGroup[] = ['api', 'file', 'browser', 'screen', 'mailbox', 'public'];
const STATES: OrbitProgramStateWord[] = ['connected', 'failed', 'disconnected', 'testing', 'connecting'];

/** A program with where it stands now, which depends on the tests and connections of this visit. */
interface ProgramItem {
  p: OrbitProgram;
  state: OrbitProgramStateWord;
}

function schemaFor(copy: UiCopy): FilterSchema<ProgramItem> {
  const c = copy.orbitAdmin.programs;
  return {
    text: ({ p }) => [p.name, p.sub, p.how, ...p.reads, ...p.writes.map((w) => w.what), ...flowsUsing(p).map((f) => f.name), c.groups[p.group]].join(' '),
    fields: [
      { id: 'link', label: c.fields.link, icon: PlugZap, kind: 'choice', get: ({ p }) => p.link, valueLabel: (v) => c.linkGroups[v as OrbitProgramLinkGroup], order: LINK_GROUPS },
      { id: 'state', label: c.fields.state, icon: CircleDot, kind: 'choice', get: ({ state }) => state, valueLabel: (v) => c.states[v as OrbitProgramStateWord], order: STATES },
      { id: 'flow', label: c.fields.flow, icon: Workflow, kind: 'choice', get: ({ p }) => flowsUsing(p).map((f) => f.id), valueLabel: (v) => flowLabel(v) },
    ],
  };
}

/* One grid for the header and every row (rows are subgrids), as the programs table of the other edition. */
const TABLE_GRID = 'grid w-min min-w-full gap-x-3 grid-cols-[minmax(min-content,130fr)_minmax(min-content,150fr)_minmax(min-content,120fr)_minmax(min-content,70fr)_minmax(min-content,70fr)_minmax(min-content,110fr)]';
const ROW_GRID = 'col-span-full grid grid-cols-subgrid items-center';

export function StateGlyph({ state }: { state: OrbitProgramStateWord }) {
  if (state === 'connected') return <CheckCircle2 size={12} aria-hidden="true" />;
  if (state === 'disconnected') return <Clock size={12} aria-hidden="true" />;
  if (state === 'failed') return <CircleAlert size={12} aria-hidden="true" />;
  return <Spinner size={11} />;
}

export function ProgramsListPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.orbitAdmin.programs;
  const [slice] = programsSlice(ctx);
  const cards = liveCards(ctx.state);

  const items: ProgramItem[] = world().programs.map((p) => ({ p, state: programState(ctx, slice, p) }));
  const schema = useMemo(() => schemaFor(ctx.copy), [ctx.copy]);
  /* The ways of connecting the list used to have as pills, kept as saved filters. */
  const presets = useMemo<SavedFilter[]>(() => LINK_GROUPS.filter((g) => world().programs.some((p) => p.link === g)).map((g, i) => ({
    id: g, name: c.linkGroups[g], tokens: [{ id: `p${i + 1}`, field: 'link', op: 'is', value: g }],
  })), [c]);
  const list = useListFilters(ctx, { key: 'orbit.programs.filters', items, schema, presets });
  const shown = list.items.map((x) => x.p);
  const states = items.map((x) => x.state);

  const rowOf = (p: OrbitProgram) => {
    const state = states[world().programs.indexOf(p)];
    const flows = flowsUsing(p);
    const open = openCards(cards, p);
    const go = () => ctx.go(SP.program(p.id));
    const name = (
      <div className="min-w-0">
        <div className="text-prose font-semibold text-app-text [overflow-wrap:break-word]">{p.name}</div>
        <div className="text-mini text-app-text-tertiary [overflow-wrap:break-word]">{p.sub}</div>
      </div>
    );
    const pill = <StatePill tone={STATE_TONE[state]} icon={<StateGlyph state={state} />}>{c.states[state]}</StatePill>;
    const link = <ConnectionChip kind={LINK_KIND[p.link]} label={c.links[p.link]} />;
    if (ctx.phone) {
      return (
        <div key={p.id} role="row" aria-selected={false} {...pressable(go)} className={clsx('flex cursor-pointer flex-col gap-1.5 border-b border-app-border px-4 py-3 last:border-b-0 hover:bg-app-hover', FOCUS_RING)}>
          <div role="cell" className="flex items-start justify-between gap-3">{name}{pill}</div>
          <div role="cell" className="text-mini text-app-text-secondary">{c.does(p.gist)}</div>
          <div role="cell" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-app-text-secondary">
            {link}
            <span>{ctx.copy.orbitAdmin.common.flows(flows.length)}</span>
            <span>{ctx.copy.orbitAdmin.common.cards(open.length)}</span>
          </div>
        </div>
      );
    }
    return (
      <div
        key={p.id}
        role="row"
        aria-selected={false}
        {...pressable(go)}
        className={clsx(ROW_GRID, 'min-h-[56px] cursor-pointer border-b border-app-border px-4 py-2 transition-colors last:border-b-0 hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60')}
      >
        <div role="cell" className="min-w-0">{name}</div>
        <div role="cell" className="min-w-0 text-prose text-app-text-secondary">
          {c.does(p.gist)}
          <div className="text-mini text-app-text-tertiary">{c.lastRead(when(ctx, p.lastRead))}</div>
        </div>
        <div role="cell" className="min-w-0">{link}</div>
        <div role="cell" className="min-w-0 text-prose tabular-nums text-app-text-secondary">{flows.length ? ctx.copy.orbitAdmin.common.flows(flows.length) : ctx.copy.orbitAdmin.common.blank}</div>
        <div role="cell" className="min-w-0 text-prose tabular-nums text-app-text-secondary">{open.length || ctx.copy.orbitAdmin.common.blank}</div>
        <div role="cell" className="min-w-0">{pill}</div>
      </div>
    );
  };

  const table = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mb-3"><FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.programs} phone={ctx.phone} /></div>
      <div className="min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
        <div role="table" aria-label={c.title} className={ctx.phone ? undefined : TABLE_GRID}>
          {!ctx.phone && (
            <div role="row" className={clsx(ROW_GRID, 'h-9 border-b border-app-border bg-app-inset px-4 text-compact font-medium text-app-text-secondary')}>
              <span role="columnheader">{c.columns.program}</span>
              <span role="columnheader">{c.columns.does}</span>
              <span role="columnheader">{c.columns.link}</span>
              <span role="columnheader">{c.columns.flows}</span>
              <span role="columnheader">{c.columns.open}</span>
              <span role="columnheader">{c.columns.state}</span>
            </div>
          )}
          {GROUPS.map((g) => {
            const rows = shown.filter((p) => p.group === g);
            if (!rows.length) return null;
            return (
              <div key={g} role="rowgroup" className={ctx.phone ? undefined : ROW_GRID}>
                <div className="col-span-full border-b border-app-border bg-app-inset/60 px-4 py-2"><SectionLabel>{c.groups[g]}</SectionLabel></div>
                {rows.map(rowOf)}
              </div>
            );
          })}
        </div>
        {shown.length === 0 && (
          <EmptyState icon={Search} title={c.emptyTitle} className="min-h-[220px]" action={<Button onClick={list.bar.onClear}>{c.emptyReset}</Button>} />
        )}
      </div>
    </div>
  );

  const counted = (s: OrbitProgramStateWord) => states.filter((x) => x === s).length;
  const events = historyOf(ctx, slice, world().programs).slice(0, 6);
  const side = (
    <>
      {/* When every program is connected there is nothing to tell apart: the box would only say «Collegato 11». allow-italian: quotes the words on screen */}
      {counted('connected') < states.length && (
        <PanelSection label={c.side.stateTitle}>
          {STATES.filter((s) => s === 'connected' || counted(s) > 0).map((s) => (
            <div key={s} className="flex min-h-7 items-center justify-between gap-2">
              <StatePill tone={STATE_TONE[s]} icon={<StateGlyph state={s} />}>{c.states[s]}</StatePill>
              <span className="text-prose tabular-nums text-app-text">{counted(s)}</span>
            </div>
          ))}
        </PanelSection>
      )}
      <PanelSection label={c.side.eventsTitle}>
        {events.length === 0 ? <p className="text-prose text-app-text-tertiary">{c.side.eventsEmpty}</p> : (
          <Timeline
            ariaLabel={c.side.eventsTitle}
            items={events.map((e) => ({
              id: e.id,
              at: when(ctx, e.at),
              title: world().programs.find((p) => p.id === e.program)?.name ?? e.program,
              detail: e.what,
              who: e.who.startsWith('program:') ? undefined : shortNameOf(e.who),
              tone: e.tone,
              icon: Plug,
              onOpen: () => ctx.go(SP.program(e.program)),
            }))}
          />
        )}
      </PanelSection>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: c.title, detail: c.count(world().programs.length) }])} />
      {ctx.phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {table}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {table}
          <SidePanel width={340}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
