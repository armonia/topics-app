/**
 * The stages of «Da fare», computed only from the cards: how many stand in each (allow-italian: quotes the Italian interface)
 * column, how long a card waits in each, which are stopped, where work piles
 * up, and how much of what got done was closed by an agent or by a person.
 *
 * Pure functions over the cards passed in: a screen hands them the live cards
 * (`liveCards(state)`), so a card moved on the kanban moves every number here.
 * Every number can be taken for one flow or for all of them together.
 */
import type { OpsFlow, SarimCard, StageId } from '../../../ui/fixtures/sarim-org/types';
import { world } from '../world';
import { stageOf, stageSince } from './live';

/** One flow by its id, or every flow together. */
export type FlowScope = string | 'all'; // allow-italian: scope name, compared by value

/** The columns in kanban order. */
const STAGE_IDS: StageId[] = world().stages.map((s) => s.id);
const DONE: StageId = 'fatto'; // allow-italian: stage id, compared by value

export interface StageTime {
  /** Mean hours a card spent in the column (for a card still there: from entering it to now). */
  avgHours: number;
  /** How many stays the mean is made of. */
  samples: number;
}

export interface StagesSummary {
  counts: Record<StageId, number>;
  times: Record<StageId, StageTime>;
  stuck: number;
  accumulation: StageId | undefined;
  share: { agent: number; person: number };
  total: number;
}

function perStage<T>(make: () => T): Record<StageId, T> {
  return Object.fromEntries(STAGE_IDS.map((id) => [id, make()])) as Record<StageId, T>;
}

/** The cards of one flow, or all of them. */
export function scopeCards(cards: SarimCard[], scope: FlowScope): SarimCard[] {
  return scope === 'all' ? cards : cards.filter((c) => c.flow === scope); // allow-italian: scope name, compared by value
}

export function stageCounts(cards: SarimCard[]): Record<StageId, number> {
  const counts = perStage(() => 0);
  for (const c of cards) counts[stageOf(c)] += 1;
  return counts;
}

/** Hours from `a` to `b` (negative when `b` comes first). */
export function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}

/**
 * Mean wait per column, from the history: each stay lasts from entering a
 * column to entering the next one, and the stay in the current column lasts
 * until `now`. A card that came back to a column counts each stay. «Fatto» is (allow-italian: quotes the Italian interface)
 * the end of the line, not a wait: it reads 0 with no samples.
 */
export function stageTimes(cards: SarimCard[], now: string): Record<StageId, StageTime> {
  const sums = perStage(() => ({ hours: 0, samples: 0 }));
  for (const c of cards) {
    c.history.forEach((e, i) => {
      if (e.stage === DONE) return;
      const end = c.history[i + 1]?.at ?? now;
      sums[e.stage].hours += Math.max(0, hoursBetween(e.at, end));
      sums[e.stage].samples += 1;
    });
  }
  const times = perStage((): StageTime => ({ avgHours: 0, samples: 0 }));
  for (const id of STAGE_IDS) {
    const s = sums[id];
    times[id] = { avgHours: s.samples ? s.hours / s.samples : 0, samples: s.samples };
  }
  return times;
}

/** Stopped: blocked on something outside it, or in the same open column longer than its flow allows. Never in «Fatto». (allow-italian: quotes the Italian interface) */
export function isStuck(card: SarimCard, flows: OpsFlow[], now: string): boolean {
  if (stageOf(card) === DONE) return false;
  if (card.blocked) return true;
  const flow = flows.find((f) => f.id === card.flow);
  if (!flow) return false;
  return hoursBetween(stageSince(card), now) > flow.stuckAfterHours;
}

export function stuckCards(cards: SarimCard[], now: string): SarimCard[] {
  return cards.filter((c) => isStuck(c, world().opsFlows, now));
}

/** The open column holding the most cards; on a tie, the one where cards wait longest. None when every open column is empty. */
export function accumulation(cards: SarimCard[], now: string): StageId | undefined {
  const counts = stageCounts(cards);
  const times = stageTimes(cards, now);
  let best: StageId | undefined;
  for (const id of STAGE_IDS) {
    if (id === DONE || counts[id] === 0) continue;
    if (!best || counts[id] > counts[best] || (counts[id] === counts[best] && times[id].avgHours > times[best].avgHours)) best = id;
  }
  return best;
}

/** For a card in «Fatto»: who moved it there, from the last entry of its history. (allow-italian: quotes the Italian interface) */
export function closedBy(card: SarimCard): 'agent' | 'person' | undefined {
  if (stageOf(card) !== DONE) return undefined;
  const by = card.history[card.history.length - 1]?.by ?? '';
  return by.startsWith('agent:') ? 'agent' : 'person';
}

/** How many of the cards in «Fatto» an agent closed, and how many a person did. (allow-italian: quotes the Italian interface) */
export function agentShare(cards: SarimCard[]): { agent: number; person: number } {
  const share = { agent: 0, person: 0 };
  for (const c of cards) {
    const who = closedBy(c);
    if (who) share[who] += 1;
  }
  return share;
}

export function flowSummary(cards: SarimCard[], scope: FlowScope, now: string): StagesSummary {
  const list = scopeCards(cards, scope);
  return {
    counts: stageCounts(list),
    times: stageTimes(list, now),
    stuck: stuckCards(list, now).length,
    accumulation: accumulation(list, now),
    share: agentShare(list),
    total: list.length,
  };
}

/** A wait in the short form a card prints: `35 min`, `3 h 10`, `2 g`. */
export function formatHours(h: number): string {
  const minutes = Math.max(0, Math.round(h * 60));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, '0')}` : `${minutes / 60} h`;
  }
  return `${Math.round(minutes / (24 * 60))} g`; // allow-italian: «g» is the Italian short form of days, shown as written
}
