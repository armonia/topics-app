/**
 * THE WORDS OF THE BOARD'S «FRENATO» CHIP (HUBBR-20), out of the component so
 * they can be read without React.
 *
 * The chip names who is held (Claude, Codex, or both), the window and its
 * share, and when the cards start again. The facts come from the server's
 * `GET /api/dispatch/brakes`: the walls in force, and the dispatcher's own
 * verdict card by card. A wall that holds no card is not named by the chip
 * (the cards on Automatic start on another runtime), so the chip never names a
 * brake the dispatcher is not applying to a card.
 */
import { PLAN_DISPATCH_HOLD_AT, providerHoldLabel, type DispatchBrake } from '../../../../shared/provider-hold';
import type { DispatchBrakeState } from '../../state/dispatchBrakes';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Provider = DispatchBrake['provider'];

const DAY_MS = 86_400_000;

/** Local midnight of the day `ms` falls in. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The restart time: the clock alone today, then "tomorrow" plus the clock, then the weekday and date plus the clock. */
export function whenLabel(untilMs: number, nowMs: number, tr: Translate, locale: string): string {
  const tag = locale === 'en' ? 'en-GB' : 'it-IT';
  const time = new Date(untilMs).toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((dayStart(untilMs) - dayStart(nowMs)) / DAY_MS);
  if (days <= 0) return tr('brake.when.today', { time });
  if (days === 1) return tr('brake.when.tomorrow', { time });
  const day = new Date(untilMs).toLocaleDateString(tag, { weekday: 'short', day: 'numeric', month: 'numeric' });
  return tr('brake.when.later', { day, time });
}

/** Whether the window is still below its end: the early stop, not a spent plan. */
function isEarlyStop(b: DispatchBrake): boolean {
  return b.utilization !== null && b.utilization < 100;
}

/** Why one provider is held, in the chip's lower case: the window, its share, and the restart time. */
export function brakeWhy(b: DispatchBrake, nowMs: number, tr: Translate, locale: string): string {
  if (b.window === 'api-down' || b.untilMs === null) return tr('brake.why.apiDown');
  const when = whenLabel(b.untilMs, nowMs, tr, locale);
  if (b.window === 'usage_limit') return tr('brake.why.plan', { when });
  const window = tr(`brake.window.${b.window}`);
  if (b.utilization === null) return tr('brake.why.spent', { window, when });
  return tr('brake.why.share', { window, pct: Math.round(b.utilization), when });
}

/** The same reason as a sentence for the popover's row, with the threshold on an early stop. */
export function brakeDetail(b: DispatchBrake, nowMs: number, tr: Translate, locale: string): string {
  const why = brakeWhy(b, nowMs, tr, locale);
  const sentence = why.charAt(0).toUpperCase() + why.slice(1);
  return isEarlyStop(b) ? `${sentence} (${tr('brake.threshold', { pct: PLAN_DISPATCH_HOLD_AT })})` : sentence;
}

/** How many cards a provider's wall holds, among `only` when given (the cards of one board). */
export function heldCount(state: DispatchBrakeState, provider: Provider, only?: ReadonlySet<string>): number {
  let n = 0;
  for (const [id, p] of state.held) if (p === provider && (!only || only.has(id))) n++;
  return n;
}

/** The walls that hold at least one card: the only ones the chip names. */
export function holdingBrakes(state: DispatchBrakeState, only?: ReadonlySet<string>): DispatchBrake[] {
  return state.brakes.filter((b) => heldCount(state, b.provider, only) > 0);
}

interface BrakeChipView {
  /** One provider's name, or both joined. */
  who: string;
  /** The reason after the name: one provider's own, or the first start again for two. */
  why: string;
}

/** What the chip says, or null when nothing is held (the chip is then absent). */
export function brakeChipView(brakes: readonly DispatchBrake[], nowMs: number, tr: Translate, locale: string): BrakeChipView | null {
  if (brakes.length === 0) return null;
  if (brakes.length === 1) return { who: providerHoldLabel(brakes[0].provider), why: brakeWhy(brakes[0], nowMs, tr, locale) };
  const names = brakes.map((b) => providerHoldLabel(b.provider));
  const ends = brakes.map((b) => b.untilMs).filter((t): t is number => t !== null);
  const why = ends.length > 0 ? tr('brake.why.next', { when: whenLabel(Math.min(...ends), nowMs, tr, locale) }) : tr('brake.why.apiDown');
  return { who: tr('brake.both', { a: names[0], b: names[1] }), why };
}

/** The count of held cards as a clause: one card waits, N cards wait. */
export function waitingClause(n: number, tr: Translate): string {
  return tr(n === 1 ? 'brake.cards.waitOne' : 'brake.cards.wait', { n });
}

/** The count of cards at work as a clause, zero included. */
export function workingClause(n: number, tr: Translate): string {
  if (n === 0) return tr('brake.cards.workNone');
  return tr(n === 1 ? 'brake.cards.workOne' : 'brake.cards.work', { n });
}

interface ColumnNoteView {
  /** The bold line: how many of this column wait, and for whom. */
  head: string;
  /** When they start again. */
  tail: string;
}

/**
 * The strip at the top of the Todo column: the held cards of THIS board, by
 * the walls that hold them, and the first restart among those walls.
 */
export function columnNoteView(state: DispatchBrakeState, todoIds: ReadonlySet<string>, nowMs: number, tr: Translate, locale: string): ColumnNoteView | null {
  const brakes = holdingBrakes(state, todoIds);
  if (brakes.length === 0) return null;
  const n = brakes.reduce((sum, b) => sum + heldCount(state, b.provider, todoIds), 0);
  const names = brakes.map((b) => providerHoldLabel(b.provider));
  const who = names.length === 1 ? names[0] : tr('brake.both', { a: names[0], b: names[1] });
  const ends = brakes.map((b) => b.untilMs).filter((t): t is number => t !== null);
  const one = n === 1;
  const head = tr(one ? 'brake.column.headOne' : 'brake.column.head', { n, who });
  if (ends.length < brakes.length) return { head, tail: tr(one ? 'brake.column.apiOne' : 'brake.column.api') };
  return { head, tail: tr(one ? 'brake.column.tailOne' : 'brake.column.tail', { when: whenLabel(Math.max(...ends), nowMs, tr, locale) }) };
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
