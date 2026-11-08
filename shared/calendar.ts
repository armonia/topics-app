/**
 * THE CALENDAR, as both sides see it.
 *
 * One agenda shape, declared once: the server builds it out of an iCalendar
 * feed, the sidebar and the settings panel read it. Nothing here knows about
 * ICS syntax (that is `server/services/ical.ts`) and nothing here talks to the
 * network: this module is the vocabulary the two sides share, plus the two
 * questions the client asks on its own -- is this page a calendar, and is this
 * event happening now.
 */

/** One occurrence, already expanded: a recurring event contributes one of these
 *  per instance inside the window, never a rule for the reader to apply. */
export interface CalendarEvent {
  /** Stable across refreshes: the feed UID plus the occurrence start. Two
   *  instances of the same daily meeting are two different ids. */
  id: string;
  title: string;
  /** ISO-8601 instants. An all-day event starts at local midnight and ends at
   *  the local midnight that closes it, so the caller never has to know that
   *  the feed wrote a bare date. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** The video call, when the event carries one (Meet, Zoom, Teams, Jitsi,
   *  Whereby). This is the one field that turns a listing into something you
   *  can act on: the reason to look at the agenda is usually to join. */
  meetingUrl?: string;
}

export interface CalendarAgenda {
  /** Sorted by start, earliest first, already cut to the horizon. */
  events: CalendarEvent[];
  /** When the feed was last read, ISO-8601. `null` = never read. */
  syncedAt: string | null;
  /** Someone has entered a feed URL and the switch is on. When false the
   *  surfaces show the door to Settings instead of an empty agenda. */
  configured: boolean;
  /** The last fetch failed and this is why, in one line. The events already
   *  read are still there: an unreachable network does not erase this
   *  morning's agenda. */
  error: string | null;
}

/** How often the feed may be re-read, in minutes. It is a MAXIMUM AGE, not a
 *  timer: nothing is fetched while nobody is looking. */
export const CALENDAR_REFRESH_CHOICES = [5, 15, 30, 60] as const;
export const DEFAULT_CALENDAR_REFRESH_MINUTES = 15;

/** How far ahead the agenda looks, in days. */
export const CALENDAR_HORIZON_CHOICES = [1, 3, 7, 30] as const;
export const DEFAULT_CALENDAR_HORIZON_DAYS = 7;

/** Never send back an unbounded list: the sidebar band shows a handful, and a
 *  feed with a hundred all-day holidays would otherwise fill the wire with
 *  rows nobody scrolls. */
export const CALENDAR_MAX_EVENTS = 50;

/**
 * The web calendars whose page, once pinned, gets the agenda band.
 *
 * Host plus path prefix, because `outlook.live.com` is also a mailbox: a pinned
 * inbox that starts showing calendar rows would be answering a question nobody
 * asked. Google is the one in the card, the others cost one line each and the
 * feed side is vendor-neutral anyway.
 */
const CALENDAR_PAGES: ReadonlyArray<{ host: string; path?: string }> = [
  { host: 'calendar.google.com' },
  { host: 'outlook.office.com', path: '/calendar' },
  { host: 'outlook.live.com', path: '/calendar' },
  { host: 'www.icloud.com', path: '/calendar' },
  { host: 'calendar.proton.me' },
  { host: 'calendar.yahoo.com' },
];

/** Is this URL the web page of a calendar? Used to decide whether a pinned
 *  browser tile opens on the agenda. Anything unparseable is not. */
export function isCalendarPageUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return CALENDAR_PAGES.some(
    (p) => host === p.host && (!p.path || parsed.pathname.toLowerCase().startsWith(p.path)),
  );
}

