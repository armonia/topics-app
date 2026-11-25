/**
 * The three views of «Da fare» in the ORBIT edition (allow-italian: quotes the Italian interface): the
 * list of the cards by flow (first, and the page the app opens on), the kanban,
 * and the table of flows against stages. They share one header: the view
 * switch on the right of the crumbs and, under it, the filter bar with the four
 * saved filters that stand for the old day page. What is on show is the filter
 * state of `model/dafare.ts` (kept in `ctx.ui`), not an address: pressing a
 * cell of the table writes the flow and stage tokens and opens the list.
 * Each screen is a component, so the hooks of the filter engine stay in it.
 */
import { useMemo, type ReactNode } from 'react';
import { Kanban, Layers } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import type { FilterBarModel } from '../../../../ui/filters/model';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';
import { KanbanBoard } from '../../../../ui/kanban/KanbanBoard';
import { HeaderBand, ViewSwitch } from '../../../../ui/kanban/KanbanHeader';
import { FlowStageTable } from '../../../../ui/kanban/StagesView';
import { CardGroups } from '../../../../ui/kanban/CardGroups';
import type { CardGroupModel, ChoiceModel, FlowRowModel, KanbanCardModel, KanbanColumnModel, StageColumnModel } from '../../../../ui/kanban/model';
import type { OpsFlow, OrbitCard, StageId } from '../../../../ui/fixtures/orbit-org/types';
import { agentById, world } from '../../world';
import type { ScreenCtx } from '../../../app/kit';
import { EMPTY_FILTERS, applyFilters, useListFilters, type FilterToken, type ListFilterState } from '../../../app/filters';
import { stageOf, waitingFor } from '../../model/live';
import { flowSummary, formatHours, isStuck, scopeCards, stageCounts, stuckCards, type FlowScope, type StagesSummary } from '../../model/stages';
import { flowLabel } from '../../model/flows';
import { INBOX_FILTERS_KEY, STAGE_FIELD, inboxFilters, daFarePath, type DaFareView } from '../../model/dafare';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { moveCard } from './actions';
import { STUCK_FIELD, YES, todoPresets, todoSchema } from './filters';
import { boardCardLines } from './boardCardLines';
import { APPROVAL, DONE, STAGE_GLYPH_OF, columnOrder, flowIcon, isOpen, kanbanCardModel, rowModel, stageLabel, stepAt, whoName, visibleCards, visibleFlows } from './model';

export type InboxView = DaFareView;

/** The flows folded in the list, by id (`ctx.ui`, so a folded flow stays folded). */
const FOLDED_KEY = 'orbit.dafare.folded';

/**
 * A card of the kanban says each fact once (the rule is `boardCardLines`): a
 * blocked card keeps its red reason and drops the step and what the worker is
 * doing; a card on its way keeps the step only when it adds something to
 * what the worker is doing; the checker shows at the check and the approval.
 * In «Da approvare» the line is the approver's. (allow-italian: quotes the Italian interface)
 */
function boardCard(card: OrbitCard, ctx: ScreenCtx, stage: StageId): KanbanCardModel {
  const m = kanbanCardModel(card, ctx);
  const actor = stepAt(card).step?.actor;
  const stepIsWorkers = (actor?.kind === 'agent' || actor?.kind === 'person') && actor.id === card.worker.id;
  const who = whoName(card.reviewer);
  const reviewerIsWorker = who.full === m.worker.fullName || who.short === m.worker.name;
  const lines = boardCardLines({ stage, step: m.step, stepIsWorkers, blockedReason: m.blocked?.reason, doing: m.worker.doing, reviewerIsWorker });
  const c = ctx.copy.kanban.card;
  return {
    ...m,
    step: lines.step ? m.step : '',
    worker: lines.doing ? m.worker : { ...m.worker, doing: '' },
    reviewer: lines.reviewer ? (stage === APPROVAL ? c.approver(who.short) : c.reviewer(who.short)) : '',
  };
}

/** The cards the person may see and the filter engine over them: every view reads it. */
function useTodoList(ctx: ScreenCtx) {
  const cards = useMemo(() => visibleCards(ctx.state, ctx.persona), [ctx.state, ctx.persona]);
  const schema = useMemo(() => todoSchema(ctx.copy, ctx.now), [ctx.copy, ctx.now]);
  const today = ctx.now.slice(0, 10);
  const presets = useMemo(() => todoPresets(ctx.copy, ctx.persona.id, today), [ctx.copy, ctx.persona.id, today]);
  const list = useListFilters(ctx, { key: INBOX_FILTERS_KEY, items: cards, schema, presets });
  return { cards, schema, list };
}

/** The header of the three views: the crumbs and the view switch, then the filter bar. */
function Header({ ctx, view, bar }: { ctx: ScreenCtx; view: InboxView; bar: FilterBarModel }) {
  const k = ctx.copy.kanban;
  const views: ChoiceModel[] = [
    { id: 'list', label: k.views.list },
    { id: 'kanban', label: k.views.kanban },
    { id: 'stages', label: k.views.stages },
  ];
  const switcher = <ViewSwitch views={views} active={view} label={k.views.label} compact={ctx.phone} onPick={(v) => ctx.go(daFarePath(v as InboxView))} />;
  /* On a phone the title of the page is already in the bar above: the pane header would say it twice, so only the view switch stays. */
  if (ctx.phone) {
    return (
      <HeaderBand>
        {switcher}
        <FilterBar copy={ctx.copy} {...bar} placeholder={ctx.copy.filters.on.cards} phone />
      </HeaderBand>
    );
  }
  return (
    <>
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: k.title }])}>{switcher}</PaneHeader>
      <HeaderBand>
        <FilterBar copy={ctx.copy} {...bar} placeholder={ctx.copy.filters.on.cards} />
      </HeaderBand>
    </>
  );
}

function frame(children: ReactNode) {
  return <div className="flex h-full min-h-0 min-w-0 flex-col">{children}</div>;
}

function NoMatch({ ctx, onClear }: { ctx: ScreenCtx; onClear: () => void }) {
  const k = ctx.copy.kanban;
  return (
    <EmptyState icon={Kanban} title={k.empty.title} action={<Button onClick={onClear}>{k.empty.clear}</Button>}>
      {k.empty.body}
    </EmptyState>
  );
}

/** Opens the list with exactly these filters, the way a cell of the table or a link from another screen asks. */
function openList(ctx: ScreenCtx, opts: { flow?: string; stage?: string; stuck?: boolean }) {
  const base = inboxFilters(opts.flow, opts.stage);
  const stuck: FilterToken[] = opts.stuck ? [{ id: `${STUCK_FIELD}:${YES}`, field: STUCK_FIELD, op: 'is', value: YES }] : [];
  ctx.ui<ListFilterState>(INBOX_FILTERS_KEY, EMPTY_FILTERS)[1]({ ...base, tokens: [...base.tokens, ...stuck] });
  ctx.go(SP.inbox());
}

/* ---------- list ---------- */

/** The nearest due day among the open cards of a flow (`9999` when none has one). */
const nearestDue = (cards: OrbitCard[]) => cards.filter(isOpen).reduce((best, c) => (c.due && c.due < best ? c.due : best), '9999');

/**
 * The cards of the list grouped by flow, the most urgent group first: the one
 * with stopped cards, then the one with cards that wait for the person, then
 * the one whose due day is nearest. Inside a group the open cards come first,
 * the stopped ones on top.
 */
function cardGroups(items: OrbitCard[], folded: string[], ctx: ScreenCtx): CardGroupModel[] {
  const mine = new Set(waitingFor(items, ctx.persona.id).map((c) => c.id));
  const order = columnOrder(ctx.now);
  const byFlow = new Map<string, OrbitCard[]>();
  for (const c of items) byFlow.set(c.flow, [...(byFlow.get(c.flow) ?? []), c]);
  return [...byFlow]
    .map(([flow, cards]) => ({
      flow,
      cards: [...cards.filter(isOpen).sort(order), ...cards.filter((c) => !isOpen(c)).sort(order)],
      stuck: cards.filter((c) => isStuck(c, world().opsFlows, ctx.now)).length,
      waiting: cards.filter((c) => mine.has(c.id)).length,
      due: nearestDue(cards),
    }))
    .sort((a, b) => b.stuck - a.stuck || b.waiting - a.waiting || a.due.localeCompare(b.due)
      || world().opsFlows.findIndex((f) => f.id === a.flow) - world().opsFlows.findIndex((f) => f.id === b.flow))
    .map((g): CardGroupModel => ({
      id: g.flow,
      label: flowLabel(g.flow),
      icon: flowIcon(g.flow),
      open: !folded.includes(g.flow),
      total: g.cards.length,
      stuck: g.stuck,
      waiting: g.waiting,
      rows: g.cards.map((c) => rowModel(c, ctx)),
    }));
}

export function ListScreen({ ctx }: { ctx: ScreenCtx }) {
  const { list } = useTodoList(ctx);
  const [folded, setFolded] = ctx.ui<string[]>(FOLDED_KEY, []);
  const groups = cardGroups(list.items, folded, ctx);
  return frame(
    <>
      <Header ctx={ctx} view="list" bar={list.bar} />
      {list.items.length === 0 ? (
        <NoMatch ctx={ctx} onClear={list.bar.onClear} />
      ) : (
        <div className={`min-h-0 flex-1 overflow-y-auto ${PAGE_GUTTER} py-3`}>
          <CardGroups
            groups={groups}
            copy={ctx.copy}
            phone={ctx.phone}
            onToggle={(flow) => setFolded((prev) => (prev.includes(flow) ? prev.filter((x) => x !== flow) : [...prev, flow]))}
            onOpen={(id) => ctx.go(SP.card(id))}
          />
        </div>
      )}
    </>,
  );
}

/* ---------- kanban ---------- */

/** Whether the filter lets a stage stay open: with `stage is …` tokens only those stages do; `stage is not …` closes the named ones. */
function stageOpen(tokens: FilterToken[], stage: string): boolean {
  const stages = tokens.filter((t) => t.field === STAGE_FIELD);
  const wanted = stages.filter((t) => t.op === 'is');
  if (wanted.length > 0 && !wanted.some((t) => t.value === stage)) return false;
  return stages.every((t) => t.op !== 'not' || t.value !== stage);
}

export function KanbanScreen({ ctx }: { ctx: ScreenCtx }) {
  const { cards, schema, list } = useTodoList(ctx);
  /* A stage on the filter folds the other columns instead of hiding their cards: the cards are filtered by everything else. */
  const rest = useMemo(() => ({ ...schema, fields: schema.fields.filter((f) => f.id !== STAGE_FIELD) }), [schema]);
  const shown = useMemo(() => applyFilters(cards, rest, list.state, ctx.now), [cards, rest, list.state, ctx.now]);
  const summary = flowSummary(shown, 'all', ctx.now);
  const piles = summary.accumulation;
  const stuckPerStage = stageCounts(stuckCards(shown, ctx.now));
  const st = ctx.copy.kanban.stages;
  /* Under each title, the numbers of the column; «Fatto» says the window it covers, as it has no wait. (allow-italian: quotes the Italian interface) */
  const factsOf = (id: StageId, n: number): string => {
    if (id === DONE) return world().stages.find((x) => x.id === id)?.hint ?? '';
    if (n === 0) return '';
    return [st.wait(formatHours(summary.times[id].avgHours)), stuckPerStage[id] ? st.stuck(stuckPerStage[id]) : ''].filter(Boolean).join(' · ');
  };
  const order = columnOrder(ctx.now);
  const columns: KanbanColumnModel[] = world().stages.map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    facts: factsOf(s.id, summary.counts[s.id]),
    glyph: STAGE_GLYPH_OF[s.id],
    cards: shown.filter((c) => stageOf(c) === s.id).sort(order).map((c) => boardCard(c, ctx, s.id)),
    folded: !stageOpen(list.state.tokens, s.id),
    piles: piles === s.id,
  }));
  const onScreen = columns.filter((c) => !c.folded).reduce((n, c) => n + c.cards.length, 0);
  const byId = new Map(cards.map((c) => [c.id, c]));
  return frame(
    <>
      <Header ctx={ctx} view="kanban" bar={{ ...list.bar, shown: onScreen, total: cards.length }} />
      {shown.length === 0 ? (
        <NoMatch ctx={ctx} onClear={list.bar.onClear} />
      ) : (
        <KanbanBoard
          columns={columns}
          copy={ctx.copy}
          phone={ctx.phone}
          onOpen={(id) => ctx.go(SP.card(id))}
          onMove={(id, to) => {
            const card = byId.get(id);
            if (card) moveCard(ctx, card, to as StageId);
          }}
          /* Opening a folded column adds its stage to the ones on show. */
          onUnfold={(id) => list.bar.onAddToken({ field: STAGE_FIELD, op: 'is', value: id })}
        />
      )}
    </>,
  );
}

/* ---------- per stage ---------- */

/** Why work piles up where it does: the open stage with the most cards, or on a tie the one where cards wait longest. */
function pileSentence(s: StagesSummary, ctx: ScreenCtx): string | undefined {
  const f = ctx.copy.kanban.stages;
  const at = s.accumulation;
  if (!at) return undefined;
  const n = s.counts[at];
  const tie = world().stages.some((x) => x.id !== at && x.id !== DONE && s.counts[x.id] === n);
  return tie ? f.pilesTie(n, stageLabel(at), formatHours(s.times[at].avgHours)) : f.pilesWhy(n, stageLabel(at));
}

/** One row of the table: a flow, or all of them (`flow` undefined). */
function flowRow(cards: OrbitCard[], flow: OpsFlow | undefined, flowCount: number, ctx: ScreenCtx): FlowRowModel {
  const f = ctx.copy.kanban.stages;
  const scope: FlowScope = flow?.id ?? 'all';
  const s = flowSummary(cards, scope, ctx.now);
  const stuckPerStage = stageCounts(stuckCards(scopeCards(cards, scope), ctx.now));
  const label = flow ? flowLabel(flow.id) : f.allFlows;
  const why = pileSentence(s, ctx);
  return {
    flow: flow?.id,
    label,
    icon: flow ? flowIcon(flow.id) : Layers,
    sub: flow ? f.flowSub(agentById(flow.agent)?.name ?? flow.agent, formatHours(flow.stuckAfterHours)) : f.allFlowsSub(flowCount),
    cells: world().stages.map((x) => ({
      stage: x.id,
      count: s.counts[x.id],
      wait: x.id === DONE || s.counts[x.id] === 0 ? '' : f.wait(formatHours(s.times[x.id].avgHours)),
      stuck: stuckPerStage[x.id],
      stuckLabel: f.stuck(stuckPerStage[x.id]),
      piles: s.accumulation === x.id,
      pilesLabel: f.piles,
      pilesWhy: s.accumulation === x.id ? why : undefined,
      label: f.cell(label, x.label, s.counts[x.id], stuckPerStage[x.id]),
    })),
    stuck: s.stuck,
    stuckLabel: f.stuck(s.stuck),
    stuckOpenLabel: f.openStuck(label, s.stuck),
    share: { agent: s.share.agent, person: s.share.person, agentLabel: f.agents(s.share.agent), personLabel: f.persons(s.share.person) },
    openLabel: f.openFlow(label),
  };
}

export function StagesScreen({ ctx }: { ctx: ScreenCtx }) {
  const { list } = useTodoList(ctx);
  /* The table counts the cards that pass the filters, so a saved filter such as «Ferme» reads per flow and per stage. */
  const cards = list.items;
  const columns: StageColumnModel[] = world().stages.map((s) => ({ id: s.id, label: s.label, hint: s.hint, glyph: STAGE_GLYPH_OF[s.id] }));
  /* With a filter on, only the flows that still have a card are listed, as the list does. */
  const filtered = list.state.tokens.length > 0 || list.state.query.trim() !== '';
  const flows = visibleFlows(ctx.state, ctx.persona).filter((fl) => !filtered || cards.some((c) => c.flow === fl.id));
  /* The row of all flows only when there are two or more: with one it would repeat that flow's numbers. */
  const rows = [...flows.map((flow) => flowRow(cards, flow, flows.length, ctx)), ...(flows.length > 1 ? [flowRow(cards, undefined, flows.length, ctx)] : [])];
  return frame(
    <>
      <Header ctx={ctx} view="stages" bar={list.bar} />
      {cards.length === 0 ? (
        <NoMatch ctx={ctx} onClear={list.bar.onClear} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`${PAGE_GUTTER} py-3`}>
            <FlowStageTable
              columns={columns}
              rows={rows}
              copy={ctx.copy}
              phone={ctx.phone}
              onCell={(flow, stage) => openList(ctx, { flow, stage })}
              onFlow={(flow) => openList(ctx, { flow })}
              onStuck={(flow) => openList(ctx, { flow, stuck: true })}
            />
          </div>
        </div>
      )}
    </>,
  );
}
