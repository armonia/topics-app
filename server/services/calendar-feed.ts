/**
 * THE SYNC: an iCalendar feed, read when someone is looking, and not otherwise.
 *
 * PULL, NOT A TIMER. There is no background job polling a URL every quarter of
 * an hour for a window nobody has open. The configured interval is the MAXIMUM
 * AGE of the cached agenda: whoever asks gets the cache if it is fresher than
 * that, and pays for a fetch if it is not. An app sitting in the dock makes
 * zero requests, and the first glance after lunch is at most one HTTP call old.
 *
 * A FAILED FETCH DOES NOT ERASE THE AGENDA. The network drops, the feed 500s,
 * the URL was rotated: the answer keeps the events already read, carries the
 * reason in `error`, and `syncedAt` stays at the last SUCCESSFUL read, so the
 * surface can say "as of 9:12" instead of quietly showing a stale list as if it
 * were live. The opposite -- emptying the agenda on the first hiccup -- turns a
 * transient into "you have nothing today", which is a lie with consequences.
 *
 * THE URL IS A SECRET AND NEVER COMES BACK OUT. It goes in from Settings, it is
 * read from the database here, and no response of this module contains it: an
 * agenda payload that echoed it would leak a read-anything link into every
 * client on the local network.
 */

import {
  CALENDAR_MAX_EVENTS,
  DEFAULT_CALENDAR_HORIZON_DAYS,
  DEFAULT_CALENDAR_REFRESH_MINUTES,
  type CalendarAgenda,
  type CalendarEvent,
} from "../../shared/calendar";
import { getAppSettings } from "./app-settings";
import { expandOccurrences, meetingUrlOf, parseIcs } from "./ical";

/** What a feed read produced, before it becomes an agenda. */
interface FeedState {
  url: string;
  events: CalendarEvent[];
  syncedAt: number | null;
  fetchedAt: number;
  error: string | null;
  /** The feed's own name (`X-WR-CALNAME`), when it publishes one. */
  name?: string;
}

/** One slot, not a map: this is a single-user desktop app with one feed
 *  configured. Keyed by URL anyway, so changing the address in Settings does
 *  not show the previous calendar's events for one refresh. */
let cached: FeedState | null = null;

/** The window a feed read is allowed to take. A calendar that hangs must not
 *  hold the sidebar's request open: past this the answer is the last agenda
 *  plus a timeout, which is the honest one. */
const FETCH_TIMEOUT_MS = 10_000;

/** Feeds are text. A body past this is not an agenda, it is an accident (a
 *  login page, an error dump, the wrong URL), and parsing megabytes of it would
 *  cost more than saying so. */
const MAX_FEED_BYTES = 8 * 1024 * 1024;

export interface CalendarConfig {
  enabled: boolean;
  url: string | null;
  refreshMinutes: number;
  horizonDays: number;
}

/** The configuration as the rest of the server sees it: settings first, the
 *  code defaults where nothing was written. */
export function calendarConfig(settings = getAppSettings()): CalendarConfig {
  return {
    enabled: settings.calendarEnabled === true && !!settings.calendarFeedUrl,
    url: settings.calendarFeedUrl,
    refreshMinutes: settings.calendarRefreshMinutes ?? DEFAULT_CALENDAR_REFRESH_MINUTES,
    horizonDays: settings.calendarHorizonDays ?? DEFAULT_CALENDAR_HORIZON_DAYS,
  };
}

/**
 * `webcal://` is the same feed with a scheme browsers invented for the
 * "subscribe" button; nothing but https answers it. Anything that is not http
 * or https is refused rather than handed to `fetch` -- a `file://` address in
 * this field would be a local file read triggered from Settings.
 */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = trimmed.startsWith("webcal://") ? `https://${trimmed.slice("webcal://".length)}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/** One line, no URL in it, no stack: this string is shown to a person under a
 *  field they can fix. */
function describeFailure(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "the calendar did not answer in time";
    return err.message.slice(0, 200);
  }
  return "the calendar could not be read";
}

/** Fetch and nothing else -- the parsing lives in `agendaFrom`, so a test can
 *  hand the text in without a server to fetch from. */
async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "text/calendar, text/plain;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`the calendar answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("the calendar feed is too large to read");
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("that address does not return a calendar feed");
  return text;
}

/**
 * The feed text turned into the events of a window.
 *
 * Exported because it is the whole computation, clock included as an argument:
 * a test pins `now` and asserts on what a Tuesday morning shows, which is not
 * something a function reading `Date.now()` can be asked.
 */
export function agendaFrom(text: string, now: number, horizonDays: number): { events: CalendarEvent[]; name?: string } {
  const calendar = parseIcs(text);
  const to = now + horizonDays * 86_400_000;
  const occurrences = expandOccurrences(calendar, now, to).slice(0, CALENDAR_MAX_EVENTS);
  const events = occurrences.map((occ): CalendarEvent => ({
    id: `${occ.event.uid}@${occ.start}`,
    title: occ.event.summary || "(no title)",
    start: new Date(occ.start).toISOString(),
    end: new Date(occ.end).toISOString(),
    allDay: occ.event.start.dateOnly,
    location: occ.event.location,
    meetingUrl: meetingUrlOf(occ.event),
  }));
  return { events, name: calendar.name };
}

function emptyAgenda(configured: boolean, error: string | null = null): CalendarAgenda {
  return { events: [], syncedAt: null, configured, error };
}

/**
 * The agenda for right now.
 *
 * `force` is the button in Settings and the refresh gesture on the tile: it
 * skips the freshness check and nothing else. Everything else -- what is
 * configured, what is stale, what a failure does -- is the same path.
 */
export async function getAgenda(opts: { force?: boolean; now?: number } = {}): Promise<CalendarAgenda> {
  const now = opts.now ?? Date.now();
  const config = calendarConfig();
  if (!config.enabled || !config.url) return emptyAgenda(false);
  const url = normalizeFeedUrl(config.url);
  if (!url) return emptyAgenda(true, "that address is not a valid calendar feed URL");

  const maxAge = config.refreshMinutes * 60_000;
  const fresh = cached && cached.url === url && !opts.force && now - cached.fetchedAt < maxAge;
  if (!fresh) {
    try {
      const text = await fetchFeed(url);
      const { events, name } = agendaFrom(text, now, config.horizonDays);
      cached = { url, events, syncedAt: now, fetchedAt: now, error: null, name };
    } catch (err) {
      const message = describeFailure(err);
      // Keep what the last good read produced; only the reason and the fetch
      // stamp move. A different URL has nothing to keep.
      cached = cached && cached.url === url
        ? { ...cached, fetchedAt: now, error: message }
        : { url, events: [], syncedAt: null, fetchedAt: now, error: message };
    }
  } else if (cached) {
    // Fresh cache, but the window moved: an event that ended while nobody was
    // looking must not still be on the list.
    cached = { ...cached, events: cached.events.filter((e) => Date.parse(e.end) > now) };
  }

  const state = cached;
  if (!state) return emptyAgenda(true);
  return {
    events: state.events,
    syncedAt: state.syncedAt === null ? null : new Date(state.syncedAt).toISOString(),
    configured: true,
    error: state.error,
  };
}

export interface FeedProbe {
  ok: boolean;
  /** The calendar's own name, when the feed publishes one. */
  name?: string;
  /** How many occurrences the next week holds. Proof the address is not just
   *  reachable but is the calendar the person meant. */
  events?: number;
  error?: string;
}

/**
 * "Test this address" in Settings, before saving it.
 *
 * It reads the URL it is GIVEN rather than the stored one: the point is to
 * answer about the string in the field, and to answer BEFORE that string is
 * written anywhere.
 */
export async function probeFeed(rawUrl: string, now = Date.now()): Promise<FeedProbe> {
  const url = normalizeFeedUrl(rawUrl);
  if (!url) return { ok: false, error: "that address is not a valid calendar feed URL" };
  try {
    const text = await fetchFeed(url);
    const { events, name } = agendaFrom(text, now, DEFAULT_CALENDAR_HORIZON_DAYS);
    return { ok: true, name, events: events.length };
  } catch (err) {
    return { ok: false, error: describeFailure(err) };
  }
}

/** Drop the cache. Called when the configuration changes -- a new URL, the
 *  switch turned off -- so the next read cannot answer out of the previous
 *  calendar. Exported for the tests, which need a clean slate per case. */
export function resetCalendarCache(): void {
  cached = null;
}
