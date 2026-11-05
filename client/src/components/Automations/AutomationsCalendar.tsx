/**
 * AUTOMAZIONI > CALENDARIO: the hub's reminders with a date and the jobs that
 * end, by day, soonest first. The appointments stay in the pinned calendar
 * tile: here only what Jarvis will do, never its prompt.
 */
import { useState } from 'react';
import { AlarmClock, ListChecks } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { calendarDays, type CalendarEntry, type CalendarKind } from '../../lib/automations';
import type { Clock } from './automationsUi';

const CHIP = 'inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 text-mini @max-2xl:h-8';

export function AutomationsCalendar({ items, now, clock }: { items: CalendarEntry[]; now: number; clock: Clock }) {
  const tr = useT();
  const [kind, setKind] = useState<CalendarKind | null>(null);
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
            {d.day === null ? tr('auto.cal.undated')
              : d.offset === 0 ? `${tr('auto.cal.today')} · ${clock.longDay(d.day)}`
                : d.offset === 1 ? `${tr('auto.cal.tomorrow')} · ${clock.longDay(d.day)}`
                  : clock.longDay(d.day)}
          </h4>
          <div className="flex flex-col gap-1.5">
            {d.items.map((i) => {
              const I = i.kind === 'compito' ? ListChecks : AlarmClock;
              return (
                <div key={i.key} className="flex h-9 items-center gap-2 rounded border border-app-border bg-surface px-3 text-compact text-app-text @max-2xl:h-11" data-testid="automations-calendar-item">
                  <span className="w-11 flex-none tabular-nums text-app-text-secondary">{i.next !== null ? clock.time(i.next) : ''}</span>
                  <I size={13} className="flex-none text-app-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="flex-none truncate text-mini text-app-text-muted">{i.says ? tr('auto.cal.via', { says: i.says }) : tr('auto.cal.jarvis')}</span>
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
