import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Video } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useLocale } from '../../hooks/useT';
import { openSettings } from '../../lib/openSettings';
import { calendarApi, type CalendarAgenda } from '../../lib/api';
import { isEventNow } from '../../../../shared/calendar';
import { agendaDays } from './agendaRows';

/**
 * THE BAND UNDER A PINNED CALENDAR: what is next, and the link to join it.
 *
 * ── WHY IT HANGS OFF THE PIN ────────────────────────────────────────────────
 * Pinning a tab is already a statement: I look at this every day. For a
 * calendar, "looking at it" means reading two lines -- the next meeting and how
 * to get into it -- and those two lines cost a whole page load and a context
 * switch. This is the same trade Arc and Dia make, and the reason the band
 * exists here and not as a pane of its own: a pane would be a second place to
 * open, which is the thing being avoided.
 *
 * ── AN EMPTY BAND IS NOT AN ANSWER ──────────────────────────────────────────
 * With no feed configured the band shows the DOOR to configure it, not an empty
 * agenda: "you have nothing today" and "I do not know what you have today" are
 * two different sentences, and only one of them is true here.
 *
 * ── IT READS WHILE IT IS OPEN, AND ONLY THEN ────────────────────────────────
 * Mounting means somebody opened the tile, so it reads once; while it stays
 * open it re-asks on a slow beat. The server answers out of its cache unless
 * the configured age has passed, so an open band does not mean a request per
 * minute to the calendar provider.
 */
export function CalendarAgendaBand() {
  const t = useT();
  const locale = useLocale();
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const next = await calendarApi.agenda(force);
      if (alive.current) { setAgenda(next); setNow(Date.now()); }
    } catch {
      // The band keeps whatever it had: a dropped request is not news worth a
      // red row in a sidebar.
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // A slow beat: it also moves the "now" mark and drops the meeting that has
    // just ended, which is what makes the band readable without touching it.
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  if (!agenda) return <div className="px-2 py-1.5 text-[11px] text-app-text-muted">…</div>;

  if (!agenda.configured) {
    return (
      <div className="space-y-1.5 px-2 py-2" data-testid="calendar-band-unconfigured">
        <div className="text-[11px] leading-snug text-app-text-muted">{t('calendar.agenda.notConfigured')}</div>
        <button
          type="button"
          onClick={() => openSettings('calendar')}
          className="rounded border border-app-border px-2 py-1 text-[11px] text-app-text-secondary transition-colors hover:bg-app-hover"
        >
          {t('calendar.agenda.configure')}
        </button>
      </div>
    );
  }

  const days = agendaDays(agenda.events, now);
  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-1 px-1 py-1" data-testid="calendar-band">
      {days.length === 0 && (
        <div className="px-1 py-1 text-[11px] text-app-text-muted">
          {agenda.error ?? t('calendar.agenda.empty')}
        </div>
      )}
      {days.map((day) => (
        <div key={day.date} className="space-y-0.5">
          <div className="px-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-tertiary">
            {day.offset === 0
              ? t('calendar.agenda.today')
              : day.offset === 1
                ? t('calendar.agenda.tomorrow')
                : new Date(day.events[0].start).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}
          </div>
          {day.events.map((event) => {
            const running = isEventNow(event, now);
            return (
              <div
                key={event.id}
                data-testid="calendar-band-event"
                className={`flex items-baseline gap-1.5 rounded px-1 py-0.5 ${running ? 'bg-primary/10' : ''}`}
              >
                <span className="w-[42px] flex-shrink-0 text-[10.5px] tabular-nums text-app-text-tertiary">
                  {event.allDay ? t('calendar.agenda.allDay') : timeOf(event.start)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-app-text" title={event.title}>
                  {event.title}
                </span>
                {running && (
                  <span className="flex-shrink-0 rounded bg-primary/20 px-1 text-[9.5px] font-semibold uppercase text-primary">
                    {t('calendar.agenda.now')}
                  </span>
                )}
                {event.meetingUrl && (
                  // The one action a calendar row has: the link is what the
                  // glance was for, and it must not require opening the page.
                  <a
                    href={event.meetingUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={t('calendar.agenda.join')}
                    className="flex-shrink-0 text-app-text-tertiary transition-colors hover:text-primary"
                  >
                    <Video size={12} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="flex items-center justify-between px-1 pt-0.5 text-[10px] text-app-text-muted">
        <span>
          {agenda.error
            ? agenda.error
            : agenda.syncedAt
              ? t('calendar.agenda.syncedAt', { time: timeOf(agenda.syncedAt) })
              : ''}
        </span>
        <button
          type="button"
          onClick={() => { void load(true); }}
          title={t('calendar.agenda.refresh')}
          aria-label={t('calendar.agenda.refresh')}
          className="text-app-text-tertiary transition-colors hover:text-app-text"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  );
}
