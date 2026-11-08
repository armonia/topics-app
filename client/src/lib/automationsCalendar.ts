/**
 * The hub's calendar for «Automazioni > Calendario»: the reminders with a
 * date and the tasks that end, by day. Pure reads, no words: the view
 * formats them. The agent's prompt is kept for its own closed fold, never
 * for the row (HUBBR-14).
 */
import { asRecord, str, num } from './automationsHead';

export type CalendarKind = 'promemoria' | 'compito';

export interface CalendarEntry {
  key: string;
  kind: CalendarKind;
  title: string;
  next: number | null;
  when: string | null;
  says: string | null;
  /** What it will do for you, in the words written for you (never the agent's prompt). */
  what: string | null;
  /** What it writes to you, in the hub's words. */
  means: string | null;
  /** The agent's instructions: shown only when the person opens them, behind their own fold. */
  prompt: string | null;
}

/** The hub's calendar: reminders with a date and tasks that end. */
export function readCalendar(raw: unknown): CalendarEntry[] | null {
  const items = asRecord(raw)?.items;
  if (!Array.isArray(items)) return null;
  return items.flatMap((i) => {
    const o = asRecord(i);
    const key = o && str(o.key);
    const title = o && str(o.title);
    if (!o || !key || !title) return [];
    return [{ key, kind: o.kind === 'compito' ? ('compito' as const) : ('promemoria' as const), title, next: num(o.next), when: str(o.when), says: str(o.says), what: str(o.what), means: str(o.means), prompt: str(o.prompt) }];
  });
}

export interface CalendarDay {
  /** Midnight of the day, or null for the undated ones (last). */
  day: number | null;
  /** 0 today, 1 tomorrow, more after; below 0 a day already gone (-1 yesterday). */
  offset: number | null;
  items: CalendarEntry[];
}

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The entries by day, soonest first. What already passed stays, on its day:
 * a reminder that did not fire on time shows as late instead of vanishing.
 */
export function calendarDays(items: CalendarEntry[], now: number, kind: CalendarKind | null = null): CalendarDay[] {
  const today = midnight(now);
  const days = new Map<number | null, CalendarEntry[]>();
  const sorted = [...items].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  for (const i of sorted) {
    if (kind && i.kind !== kind) continue;
    const day = i.next === null ? null : midnight(i.next);
    days.set(day, [...(days.get(day) ?? []), i]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, offset: day === null ? null : Math.round((day - today) / 86_400_000), items: list }));
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
