/**
 * Dates and names the team screens print. Everything is read in Rome time,
 * whatever the browser's zone, so a screenshot reads the same everywhere.
 */
import type { TeamCopy } from '../../../../ui/copy/team';
import { PERSONAS } from '../../../../ui/fixtures/org/people';

const ZONE = 'Europe/Rome';

const day = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = new Intl.DateTimeFormat('it-IT', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('it-IT', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dm = new Intl.DateTimeFormat('it-IT', { timeZone: ZONE, day: '2-digit', month: '2-digit' });

/** `2026-11-06` */
export const dayOf = (iso: string): string => day.format(new Date(iso));
/** `10:30` */
export const timeOf = (iso: string): string => hm.format(new Date(iso));
/** `10:30:08` */
export const secondsOf = (iso: string): string => clockFormat.format(new Date(iso));
/** `06/11` */
export const shortDay = (iso: string): string => dm.format(new Date(iso));
/** `06/11/2026` from a `YYYY-MM-DD`. */
export const formatDay = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** `oggi 10:30`, `ieri 17:40`, `02/11 10:15`: the day word when it helps. */
export function whenLabel(copy: TeamCopy, iso: string, nowIso: string): string {
  const d = dayOf(iso);
  const today = dayOf(nowIso);
  const diff = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000);
  const t = timeOf(iso);
  if (diff === 0) return `${copy.common.today} ${t}`;
  if (diff === 1) return `${copy.common.ago.days(1)} ${t}`;
  return `${shortDay(iso)} ${t}`;
}

/** `3 minuti fa`, `2 ore fa`, `ieri`, `4 giorni fa`. (allow-italian: quotes the Italian interface) */
export function agoLabel(copy: TeamCopy, iso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(iso);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return copy.common.ago.justNow;
  if (min < 60) return copy.common.ago.minutes(min);
  const diff = Math.round((Date.parse(`${dayOf(nowIso)}T12:00:00Z`) - Date.parse(`${dayOf(iso)}T12:00:00Z`)) / 86_400_000);
  if (diff === 0) return copy.common.ago.hours(Math.floor(min / 60));
  return copy.common.ago.days(diff);
}

/** The name a person goes by in a line: a role marked as an example. */
export function personName(id: string): string {
  return PERSONAS.find((p) => p.id === id)?.name ?? id;
}

/** `YYYY-MM-DDTHH:mm:00+01:00` with the offset Rome has on that day. */
export function romeIso(dayKey: string, time: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  /* Summer time runs from the last Sunday of March to the last Sunday of October. */
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const t = Date.UTC(y, m - 1, d);
  const summer = t >= Date.UTC(y, 2, lastSunday(2)) && t < Date.UTC(y, 9, lastSunday(9));
  return `${dayKey}T${time.length === 5 ? `${time}:00` : time}${summer ? '+02:00' : '+01:00'}`;
}
