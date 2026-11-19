/**
 * A duration as a person reads it: «12 min», «1 h 20», «2 g 4 h». The
 * countdowns printed «oltre la stima di 340 min»; past an hour the figure is
 * rounded so it does not claim a precision an estimate does not have.
 */
import type { Countdown } from '../../../shared/task-countdown';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const DAY_MIN = 24 * 60;

export function etaText(tr: Translate, ms: number): string {
  const raw = Math.max(1, Math.round(ms / 60_000));
  if (raw < 60) return tr('eta.min', { n: raw });
  // 5 minutes under three hours, a quarter of an hour up to a day, whole hours past it.
  const step = raw < 180 ? 5 : raw < DAY_MIN ? 15 : 60;
  const min = Math.round(raw / step) * step;
  if (min < DAY_MIN) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? tr('eta.hm', { h, m }) : tr('eta.h', { h });
  }
  const hours = Math.round(min / 60);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? tr('eta.dh', { d, h }) : tr('eta.d', { d });
}

/** The countdown in one short piece: «~40 min», and when a checkpoint raised it, saying so. */
export function countdownText(tr: Translate, c: Countdown): string {
  const time = etaText(tr, c.remainingMs);
  return c.revisedAt === null ? tr('board.countdown.left', { time }) : tr('board.countdown.leftRevised', { time });
}

/** The tooltip: the time spent, and where the figure comes from. */
export function countdownTitle(tr: Translate, c: Countdown, elapsedMs: number): string {
  const spent = etaText(tr, elapsedMs);
  if (c.revisedAt === null) return tr('board.countdown.title', { spent, total: etaText(tr, c.totalMs) });
  const at = tr(c.revisedAt === 0.5 ? 'board.countdown.at.half' : c.revisedAt === 0.75 ? 'board.countdown.at.threeQuarters' : 'board.countdown.at.end');
  return tr('board.countdown.titleRevised', { spent, from: etaText(tr, c.departureMs), at, to: etaText(tr, c.totalMs) });
}
