/**
 * THE WORDS OF THE BOARD'S «FRENATO» CHIP (HUBBR-20), out of the component so
 * they can be read without React.
 *
 * The chip names who is held (Claude, Codex, or both), the window and its
 * share, and when the cards start again. The facts come from the server's
 * `GET /api/dispatch/brakes`, which applies the dispatcher's own rule: the
 * chip never names a brake the dispatcher is not applying.
 */
import { PLAN_DISPATCH_HOLD_AT, providerHoldLabel, type DispatchBrake } from '../../../../shared/provider-hold';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const DAY_MS = 86_400_000;

/** Local midnight of the day `ms` falls in. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** «alle 14:20», «domani alle 14:20», «ven 7/11 alle 14:20». */
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

/** Why one provider is held, in the chip's lower case: «quota 5h al 94%, riparte alle 14:20». */
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

interface BrakeChipView {
  /** «Claude», «Codex», or «Claude e Codex». */
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
