/**
 * The words and the classes the Automations view shares between its parts:
 * times in the person's locale, the last run of a row, the schedule of a job
 * the hub does not describe, and the few class strings every part draws with.
 * No React here, so the component files keep Fast Refresh.
 */
import { Bot, Cpu, GitBranch, ListChecks, Monitor } from 'lucide-react';
import type { AutomationRow, AutomationSystem, ScheduleParts } from '../../lib/automations';

export type Tr = (key: string, vars?: Record<string, string | number>) => string;

export const SECTION = 'mb-1.5 mt-[18px] flex items-center gap-2 text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary';
export const SECTION_COUNT = 'font-medium normal-case tracking-normal text-app-text-muted tabular-nums';
export const SECTION_REST = 'ml-auto truncate font-normal normal-case tracking-normal text-app-text-muted @max-2xl:hidden';
export const BOX = 'overflow-hidden rounded border border-app-border bg-surface';
export const BUTTON = 'inline-flex h-[26px] flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-app-border bg-elevated px-2.5 text-mini text-app-text-body hover:bg-app-hover disabled:pointer-events-none disabled:opacity-50 @max-2xl:h-9 @max-2xl:text-compact';
export const BUTTON_PRIMARY = 'inline-flex h-[26px] flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent bg-primary px-2.5 text-mini text-white hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-50 @max-2xl:h-9 @max-2xl:text-compact';
export const BUTTON_ON = 'border-transparent bg-primary/10 text-primary';
export const ICON_BUTTON = 'inline-flex h-6 w-6 flex-none items-center justify-center rounded-xs text-app-text-muted hover:bg-app-hover hover:text-app-text disabled:pointer-events-none disabled:opacity-40';

/** The glyph of each system, the same on the chips, the sections and the detail. */
export const SYSTEM_ICON: Record<AutomationSystem, typeof Bot> = { jarvis: Bot, mac: Cpu, github: GitBranch, pc: Monitor, workflow: ListChecks };

export interface Clock {
  time(ms: number): string;
  /** «22:13» today, «lun 09:00» on another day. */
  dayTime(ms: number): string;
  /** «21/10». */
  date(ms: number): string;
  /** «gio 5 nov». */
  longDay(ms: number): string;
}

export function makeClock(locale: string, now: () => number): Clock {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const wd = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
  return {
    time: (ms) => time.format(ms),
    dayTime: (ms) => (sameDay(ms, now()) ? time.format(ms) : `${wd.format(ms).replace(/\.$/, '')} ${time.format(ms)}`),
    date: (ms) => date.format(ms),
    longDay: (ms) => long.format(ms).replace(/\./g, ''),
  };
}

/** Minutes, hours and minutes, or days, in the chosen language. */
export function durationWords(ms: number, tr: Tr): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return tr('auto.dur.min', { n: min });
  if (min < 48 * 60) return tr('auto.dur.hours', { h: Math.floor(min / 60), m: min % 60 });
  return tr('auto.dur.days', { n: Math.round(min / 1440) });
}

/**
 * The last-run cell: the time, with the exit or the error when it went wrong.
 * Without a time it says how things stand, never a mute dash: a launchd job
 * whose log is silent has only the count of today's runs, a job that runs
 * without writing the hour «runs», one that never started «not yet».
 */
export function lastRunWords(row: AutomationRow, clock: Clock, tr: Tr): string {
  const { at, outcome, exit } = row.last;
  if (at === null) {
    if (row.runsToday > 0) return tr(row.runsToday === 1 ? 'auto.last.runsTodayOne' : 'auto.last.runsToday', { n: row.runsToday });
    if (outcome === 'ok') return tr('auto.last.runs');
    if (row.next !== null) return tr('auto.last.notYet');
    return tr('auto.last.none');
  }
  const time = clock.dayTime(at);
  if (outcome === 'error') return exit !== null && exit !== 0 ? tr('auto.last.exit', { time, n: exit }) : tr('auto.last.error', { time });
  if (outcome === 'skipped') return tr('auto.last.skipped', { time });
  return time;
}

/** The next-run cell: the time («~» when the hub only guesses it), or the cadence when there is no time. */
export function nextRunWords(row: AutomationRow, now: number, clock: Clock): string {
  if (row.next !== null && row.next > now) return `${row.nextApprox ? '~' : ''}${clock.dayTime(row.next)}`;
  return row.when ?? '';
}

/** The brands that answer in the row's model steps, once each. */
export function modelBrands(row: Pick<AutomationRow, 'flow'>): string[] {
  const out: string[] = [];
  for (const n of row.flow?.nodes ?? []) for (const w of n.who) if (w.brand && !out.includes(w.brand)) out.push(w.brand);
  return out;
}

/** Weighted tokens in short: «850», «12 k», «1,2 M». */
export function tokenWords(n: number, locale: string): string {
  if (n >= 1e6) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n / 1e6)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(Math.round(n));
}

/** The providers' own names, the same on every surface. */
export function providerName(p: string): string {
  return ({ claude: 'Claude', codex: 'Codex', muse: 'Muse', free: 'Free' } as Record<string, string>)[p] ?? p;
}

export function scheduleWords(s: ScheduleParts | null, clock: Clock, tr: Tr): string | null {
  if (!s) return null;
  switch (s.kind) {
    case 'minutes':
      return tr('auto.sched.minutes', { n: s.n });
    case 'hours':
      return s.n === 1 ? tr('auto.sched.hour') : tr('auto.sched.hours', { n: s.n });
    case 'days':
      return s.n === 1 ? tr('auto.sched.day') : tr('auto.sched.days', { n: s.n });
    case 'expr':
      return tr('auto.sched.expr', { expr: s.expr });
    case 'at':
      return tr('auto.sched.at', { date: `${clock.longDay(s.at)} ${clock.time(s.at)}` });
  }
}

/** «oggi 22:13», «ieri 21:13», «lun 4 nov 05:02». */
export function runWhen(at: number, now: number, clock: Clock, tr: Tr): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (at >= day.getTime()) return tr('auto.run.today', { time: clock.time(at) });
  if (at >= day.getTime() - 86_400_000) return tr('auto.run.yesterday', { time: clock.time(at) });
  return `${clock.longDay(at)} ${clock.time(at)}`;
}

/** «0,4 s», «6,1 s», «3 min». */
export function secondsWords(ms: number, locale: string): string {
  if (ms >= 120_000) return `${Math.round(ms / 60_000)} min`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1000)} s`;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
