/**
 * AUTOMAZIONI > CALENDARIO: the hub's reminders with a date and the jobs that
 * end, by day, soonest first. The appointments stay in the pinned calendar
 * tile: here only what Jarvis will do; the agent's prompt never in the row.
 *
 * A row opens on what it will do (the description written for the person, or
 * the hub's own sentence for a reminder without one), how it writes to you,
 * when, on which channel and who runs it, as the hub's reminder panel said.
 * The agent's instructions sit behind their own fold, closed: they are for
 * the agent (commands, paths), and are drawn only once the person opens them.
 * A reminder whose time has passed stays on its day, marked late, instead of
 * vanishing.
 */
import { useState } from 'react';
import { AlarmClock, ChevronDown, ChevronRight, ListChecks, MessageCircle } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { calendarDays, type CalendarEntry, type CalendarKind } from '../../lib/automationsCalendar';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import type { Clock } from './automationsUi';

const CHIP = 'inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 text-mini @max-2xl:h-8';

type Tr = ReturnType<typeof useT>;

const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function dayLabel(tr: Tr, clock: Clock, day: number | null, offset: number | null): string {
  if (day === null) return tr('auto.cal.undated');
  if (offset === 0) return `${tr('auto.cal.today')} · ${clock.longDay(day)}`;
  if (offset === 1) return `${tr('auto.cal.tomorrow')} · ${clock.longDay(day)}`;
  if (offset === -1) return `${tr('auto.cal.yesterday')} · ${clock.longDay(day)}`;
  return clock.longDay(day);
}

/** What the reminder will do: its own description, or the hub's sentence for one without. */
function whatOf(tr: Tr, clock: Clock, i: CalendarEntry, offset: number | null): string | null {
  if (i.what) return i.what;
  if (i.kind !== 'promemoria') return null;
  const when = i.next !== null
    ? tr('auto.cal.defaultWhen', { when: `${offset === 0 ? tr('auto.cal.today') : offset === 1 ? tr('auto.cal.tomorrow') : offset === -1 ? tr('auto.cal.yesterday') : clock.longDay(i.next)}, ${clock.time(i.next)}` })
    : '';
  const says = i.says ? tr('auto.cal.defaultSays', { says: i.says }) : tr('auto.cal.defaultSilent');
  return capFirst(tr('auto.cal.defaultWhat', { when, says }));
}

export function AutomationsCalendar({ items, now, clock, who = {} }: {
  items: CalendarEntry[];
  now: number;
  clock: Clock;
  /** Who runs each reminder, by key, from the hub's model. */
  who?: Readonly<Record<string, string>>;
}) {
  const tr = useT();
  const [kind, setKind] = useState<CalendarKind | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState<string | null>(null);
  const days = calendarDays(items, now, kind);
  const count = (k: CalendarKind | null) => calendarDays(items, now, k).reduce((s, d) => s + d.items.length, 0);
  const chips: Array<{ k: CalendarKind | null; label: string; icon?: typeof AlarmClock }> = [
    { k: null, label: tr('auto.cal.all') },
    { k: 'promemoria', label: tr('auto.cal.promemoria'), icon: AlarmClock },
    { k: 'compito', label: tr('auto.cal.compito'), icon: ListChecks },
  ];
  return (
    <div data-testid="automations-calendar">
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map(({ k, label, icon: I }) => (
          <button
            key={String(k)}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`${CHIP} ${kind === k ? 'border-transparent bg-primary/10 text-primary' : 'border-app-border text-app-text-secondary hover:bg-app-hover'}`}
          >
            {I && <I size={13} aria-hidden="true" />}{label}
            <span className={`tabular-nums ${kind === k ? 'text-primary' : 'text-app-text-muted'}`}>{count(k)}</span>
          </button>
        ))}
      </div>
      {days.length === 0 && <p className="mt-4 text-compact text-app-text-secondary">{tr('auto.cal.empty')}</p>}
      {days.map((d) => (
        <div key={String(d.day)} className="mt-[18px]" data-testid="automations-calendar-day">
          <h4 className="m-0 mb-1.5 text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary">
            {dayLabel(tr, clock, d.day, d.offset)}
          </h4>
          <div className="flex flex-col gap-1.5">
            {d.items.map((i) => {
              const I = i.kind === 'compito' ? ListChecks : AlarmClock;
              const late = i.next !== null && i.next < now;
              const expanded = open === i.key;
              const what = expanded ? whatOf(tr, clock, i, d.offset) : null;
              const runner = who[i.key] ?? null;
              const says = i.says ? tr('auto.cal.via', { says: i.says }) : tr('auto.cal.silent');
              return (
                <div key={i.key} className="rounded border border-app-border bg-surface text-compact text-app-text" data-testid="automations-calendar-item" data-key={i.key} data-late={late || undefined}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={tr('auto.cal.open', { title: i.title })}
                    data-testid="automations-calendar-toggle"
                    onClick={() => { setOpen(expanded ? null : i.key); setPromptOpen(null); }}
                    className="flex h-9 w-full items-center gap-2 rounded px-3 text-left hover:bg-app-hover @max-2xl:h-11"
                  >
                    <span className={`w-11 flex-none tabular-nums ${late ? WARNING_TEXT : 'text-app-text-secondary'}`}>{i.next !== null ? clock.time(i.next) : ''}</span>
                    <I size={13} className="flex-none text-app-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    {late && <span data-testid="automations-calendar-late" className={`flex-none rounded-xs bg-amber-500/15 px-1 text-mini font-semibold ${WARNING_TEXT}`}>{tr('auto.cal.late')}</span>}
                    {i.kind === 'compito' && i.when && <span className="flex-none truncate text-mini text-app-text-muted">{tr('auto.cal.checks', { when: i.when })}</span>}
                    <span className="flex flex-none items-center gap-1 truncate text-mini text-app-text-muted"><MessageCircle size={11} aria-hidden="true" />{says}</span>
                    {expanded ? <ChevronDown size={13} className="flex-none text-app-text-muted" aria-hidden="true" /> : <ChevronRight size={13} className="flex-none text-app-text-muted" aria-hidden="true" />}
                  </button>
                  {expanded && (
                    <div data-testid="automations-calendar-detail" className="border-t border-app-border-subtle px-3 pb-2.5 pt-2 text-compact">
                      {what && <p className="m-0 text-app-text">{what}</p>}
                      {i.means && <p className="m-0 mt-1 text-app-text-secondary">{tr('auto.cal.means', { means: i.means })}</p>}
                      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-mini">
                        <dt className="text-app-text-muted">{tr('auto.cal.fact.when')}</dt>
                        <dd className="m-0 text-app-text">{i.when ?? (i.next !== null ? `${clock.longDay(i.next)} ${clock.time(i.next)}` : tr('auto.cal.undated'))}</dd>
                        {i.says && (<><dt className="text-app-text-muted">{tr('auto.cal.fact.channel')}</dt><dd className="m-0 text-app-text">{i.says}</dd></>)}
                        {runner && (<><dt className="text-app-text-muted">{tr('auto.cal.fact.who')}</dt><dd className="m-0 text-app-text" data-testid="automations-calendar-who">{runner}</dd></>)}
                      </dl>
                      {i.prompt && (
                        <div className="mt-2">
                          <button
                            type="button"
                            aria-expanded={promptOpen === i.key}
                            data-testid="automations-calendar-prompt-toggle"
                            onClick={() => setPromptOpen(promptOpen === i.key ? null : i.key)}
                            className="inline-flex items-center gap-1 text-mini text-app-text-secondary hover:text-app-text"
                          >
                            {promptOpen === i.key ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                            {tr('auto.cal.prompt')}
                          </button>
                          {promptOpen === i.key && (
                            <p data-testid="automations-calendar-prompt" className="m-0 mt-1 whitespace-pre-wrap rounded-sm bg-app-inset px-2 py-1.5 text-mini text-app-text-secondary">{i.prompt}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="mt-4 rounded border border-dashed border-app-border px-3 py-2 text-mini text-app-text-secondary">{tr('auto.cal.note')}</p>
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
