/**
 * Every deadline of SARIM in one list, computed from the live world: the due
 * day of every card of the kanban, and for every contract its end, the last
 * day to give notice and the next day of each obligation, read the way
 * «Contratti» reads them (a notice whose day has passed drops out, an (allow-italian: quotes the Italian interface)
 * obligation past its day stays, late, until it is closed). Each one knows the
 * place that opens it: the card, or the clause it comes from.
 */
import type { Tone } from '../../../../ui/types';
import type { SarimDeadlineKind, SarimDeadlineState } from '../../../../ui/copy/sarim-data';
import type { Contract, Obligation, SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import { agentById, teamById, teamIdOfPerson, world } from '../../world';
import type { SarimArea } from '../../../../ui/fixtures/sarim-org/people';
import type { DemoState } from '../../../app/store/state';
import type { ScreenCtx } from '../../../app/kit';
import { EMPTY_FILTERS, type ListFilterState } from '../../../app/filters';
import { liveCards, liveContracts, stageOf } from '../../model/live';
import { contractDates, currentVersion, daysTo } from '../../model/contracts';
import { dueSoonBefore } from '../../model/dafare';
import { SP } from '../../paths';
import { relDay } from '../contracts/actions';

export interface Deadline {
  id: string;
  day: string;
  kind: SarimDeadlineKind;
  area: SarimArea;
  /** Who has to act: a persona id, or an agent id for a card an agent holds. */
  owner: string;
  done: boolean;
  card?: SarimCard;
  contract?: Contract;
  obligation?: Obligation;
  /** The clause it is read from, for a contract deadline. */
  clause?: string;
  path: string;
}

/** Late when the day has passed, soon within 30 days (as «Contratti» counts it). (allow-italian: quotes the Italian interface) */
export function stateOf(d: Deadline, today: string): SarimDeadlineState {
  if (d.done) return 'done';
  const n = daysTo(d.day, today);
  return n < 0 ? 'late' : n <= 30 ? 'soon' : 'open';
}

export const STATE_TONE: Record<SarimDeadlineState, Tone> = { late: 'red', soon: 'amber', open: 'blue', done: 'green' };

const areaOfFlow = (flow: string): SarimArea => world().opsFlows.find((x) => x.id === flow)?.area ?? world().people.managerTeam;

export function contractDeadlines(contracts: Contract[], today: string): Deadline[] {
  return contractDates(contracts)
    .filter((d) => d.kind !== 'notice' || d.day >= today)
    .map((d) => ({
      id: d.id, day: d.day, kind: d.kind, area: d.contract.area, owner: d.obligation?.owner ?? d.contract.owner, done: d.done,
      contract: d.contract, obligation: d.obligation, clause: d.clause,
      path: d.clause ? SP.clause(d.contract.id, d.clause) : SP.contract(d.contract.id),
    }));
}

export function cardDeadlines(cards: SarimCard[]): Deadline[] {
  return cards.filter((c) => c.due).map((c) => ({
    id: `card:${c.id}`,
    day: c.due as string,
    kind: 'card' as const,
    area: areaOfFlow(c.flow),
    owner: c.worker.id, // who holds it now, an agent included, as «Da fare» names it (allow-italian: quotes the Italian interface)
    done: stageOf(c) === 'fatto', // allow-italian: stage id, compared by value
    card: c,
    path: SP.card(c.id),
  }));
}

/** The team of whoever must act: the team of the person, `Agenti` for an agent; the area of the deadline only when the owner is unknown. */
export function teamOfDeadline(d: Pick<Deadline, 'owner' | 'area'>): { id: string; label: string } {
  if (agentById(d.owner)) return world().people.agentsTeam;
  const team = teamById(teamIdOfPerson(d.owner) ?? d.area);
  return team ? { id: team.id, label: team.label } : { id: d.area, label: world().people.areaLabel[d.area] };
}

/** Every deadline, nearest first. */
export function allDeadlines(state: DemoState, today: string): Deadline[] {
  return [...cardDeadlines(liveCards(state)), ...contractDeadlines(liveContracts(state), today)]
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/** Whether a day is «entro 7 giorni» from today (late days included): the rule of «Da fare», used by its filter and by this list. (allow-italian: quotes the Italian interface) */
export function isDueSoon(day: string, today: string): boolean {
  return day < dueSoonBefore(today);
}

/** The open deadlines of the week, the late ones included: what the overview tile counts and the filter it opens shows. */
export function dueWithin(list: Deadline[], today: string): Deadline[] {
  return list.filter((d) => !d.done && isDueSoon(d.day, today));
}

/** Where the schedule keeps its filters (`ctx.ui`), so another screen can open it already filtered. */
export const DEADLINE_KEYS = {
  filters: 'sarim.data.deadlines.filters',
  done: 'sarim.dl.done',
} as const;

/** Opens the schedule showing only what falls due within the week (late ones included), every other filter off. */
export function openWeek(ctx: Pick<ScreenCtx, 'ui' | 'go'>) {
  ctx.ui<ListFilterState>(DEADLINE_KEYS.filters, EMPTY_FILTERS)[1]({ query: '', tokens: [{ id: 't1', field: 'entro', op: 'is', value: 'week' }], saved: 'week' }); // allow-italian: field id
  ctx.ui<boolean>(DEADLINE_KEYS.done, false)[1](false);
  ctx.go(SP.deadlines());
}

/** What a deadline is, in words. */
export function whatOf(ctx: Pick<ScreenCtx, 'copy'>, d: Deadline): string {
  const w = ctx.copy.sarimData.deadlines.what;
  if (d.kind === 'card') return d.card?.title ?? '';
  if (d.kind === 'end') return w.end;
  if (d.kind === 'notice') return d.contract?.renewal.kind === 'tacito' ? w.noticeTacit : w.noticeOption; // allow-italian: data code compared by value
  return d.obligation?.what ?? '';
}

/** What it belongs to: the card code and its place, or the contract and its clause. */
export function aboutOf(ctx: Pick<ScreenCtx, 'copy'>, d: Deadline): string {
  if (d.card) return [d.card.id, d.card.place].filter(Boolean).join(' · ');
  const c = d.contract as Contract;
  const n = d.clause ? currentVersion(c).clauses.find((x) => x.id === d.clause)?.n : undefined;
  return n ? `${c.title} · ${ctx.copy.sarimData.common.clause(n)}` : c.title;
}

/** The same words as the deadlines of the contracts: `oggi`, `domani`, `tra 12 giorni`, `3 giorni fa`, `1 anno e 8 mesi fa`. (allow-italian: quotes the Italian interface) */
export function relativeDay(ctx: Pick<ScreenCtx, 'copy'>, day: string, today: string): string {
  return relDay(ctx, day, today);
}
