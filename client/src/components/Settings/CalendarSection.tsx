import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, Loader2, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Switch } from '../Shared/Switch';
import { Select } from '../Shared/Select';
import {
  CALENDAR_HORIZON_CHOICES,
  CALENDAR_REFRESH_CHOICES,
  DEFAULT_CALENDAR_HORIZON_DAYS,
  DEFAULT_CALENDAR_REFRESH_MINUTES,
} from '../../../../shared/calendar';
import { appSettingsApi, calendarApi, type AppBehaviorSettings, type CalendarProbe } from '../../lib/api';

/**
 * CALENDAR: where the agenda comes from, and how often it is re-read.
 *
 * ── WHY AN ADDRESS AND NOT A "SIGN IN WITH GOOGLE" BUTTON ───────────────────
 * The button would need an OAuth client shipped inside a public repository and
 * a vendor review before the consent screen stops calling this app unsafe. The
 * same events are already published by the provider as an iCalendar feed
 * (Google: Settings > "Secret address in iCal format"), and that address works
 * the same for Apple, Outlook, Proton and Fastmail. One field instead of a
 * credential store, and the integration is not tied to one vendor.
 *
 * ── THE FIELD IS A SECRET ───────────────────────────────────────────────────
 * Whoever holds that URL reads the calendar. It is typed into a password field,
 * it never comes back from the server (the agenda payload does not carry it),
 * and once saved this panel shows that it IS set without showing what it is.
 *
 * ── YOU TEST IT BEFORE YOU SAVE IT ──────────────────────────────────────────
 * "Test" reads the address in the field and answers with the calendar's own
 * name and how many events the next week holds. A panel that can only tell you
 * whether it worked AFTER saving has the order inverted, and the first typo
 * gets stored.
 */
export function CalendarSection() {
  const t = useT();
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [probe, setProbe] = useState<CalendarProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void appSettingsApi.get().then((s) => { if (alive.current) setSettings(s); }).catch(() => {});
    return () => { alive.current = false; };
  }, []);

  const patch = useCallback(async (body: Partial<AppBehaviorSettings>) => {
    setSaveError(null);
    try {
      const next = await appSettingsApi.update(body);
      if (alive.current) setSettings(next);
      return true;
    } catch (err) {
      if (alive.current) setSaveError(err instanceof Error ? err.message : t('calendar.saveFailed'));
      return false;
    }
  }, [t]);

  const configured = !!settings?.calendarFeedUrl;
  const enabled = settings?.calendarEnabled === true && configured;

  const save = async () => {
    const url = feedUrl.trim();
    if (!url) return;
    // Saving the address is also what turns the sync on: someone who pastes a
    // feed and walks away has not asked for a switch to flip later.
    const ok = await patch({ calendarFeedUrl: url, calendarEnabled: true });
    if (ok && alive.current) setFeedUrl('');
  };

  const test = async () => {
    const url = feedUrl.trim();
    if (!url) return;
    setProbing(true);
    setProbe(null);
    try {
      const result = await calendarApi.probe(url);
      if (alive.current) setProbe(result);
    } catch {
      if (alive.current) setProbe({ ok: false, error: t('calendar.unreachable') });
    } finally {
      if (alive.current) setProbing(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-app-text">
          <CalendarDays size={15} className="text-app-text-tertiary" />
          {t('settings.section.calendar')}
        </h3>
        <p className="text-[11.5px] leading-relaxed text-app-text-muted">{t('calendar.blurb')}</p>
      </header>

      {/* The switch. Off with no address is not a choice yet, so it stays
          inert until there is something to switch on. */}
      <div className="flex items-start justify-between gap-3 border-b border-app-border py-2">
        <div className={`min-w-0 flex-1${configured ? '' : ' opacity-50'}`}>
          <div className="text-[12.5px] text-app-text">{t('calendar.sync')}</div>
          <div className="mt-0.5 text-[11px] text-app-text-muted">
            {configured ? t('calendar.sync.configured') : t('calendar.sync.needsUrl')}
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={!configured}
          label={t('calendar.sync')}
          onChange={(v) => { void patch({ calendarEnabled: v }); }}
          className="mt-0.5"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-[12px] text-app-text" htmlFor="calendar-feed-url">
          {t('calendar.feedUrl')}
        </label>
        <p className="text-[11px] leading-relaxed text-app-text-muted">{t('calendar.feedUrl.how')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="calendar-feed-url"
            data-testid="calendar-feed-url"
            // A password field, because that is what this string is: it is a
            // read-anything link to a personal calendar, typed on a screen
            // somebody may well be sharing.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={feedUrl}
            placeholder={configured ? t('calendar.feedUrl.set') : t('calendar.feedUrl.placeholder')}
            onChange={(e) => { setFeedUrl(e.target.value); setProbe(null); }}
            className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2.5 py-1.5 text-[12px] text-app-text placeholder:text-app-text-muted focus:border-primary focus:outline-none coarse:min-h-11"
          />
          <button
            type="button"
            data-testid="calendar-test"
            disabled={!feedUrl.trim() || probing}
            onClick={() => { void test(); }}
            className="flex items-center gap-1.5 rounded-md border border-app-border px-2.5 py-1.5 text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover disabled:opacity-40 coarse:min-h-11 coarse:px-3"
          >
            {probing && <Loader2 size={12} className="animate-spin" />}
            {t('calendar.test')}
          </button>
          <button
            type="button"
            data-testid="calendar-save"
            disabled={!feedUrl.trim()}
            onClick={() => { void save(); }}
            className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 coarse:min-h-11 coarse:px-3"
          >
            {t('calendar.save')}
          </button>
        </div>

        {probe && (
          <div
            data-testid="calendar-probe"
            className={`flex items-start gap-1.5 text-[11.5px] ${probe.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {probe.ok ? <Check size={13} className="mt-0.5 flex-shrink-0" /> : <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" />}
            <span>
              {probe.ok
                ? t('calendar.probe.ok', { name: probe.name ?? t('calendar.unnamed'), n: String(probe.events ?? 0) })
                : probe.error}
            </span>
          </div>
        )}
        {saveError && <div className="text-[11.5px] text-red-600 dark:text-red-400">{saveError}</div>}

        {configured && (
          <button
            type="button"
            data-testid="calendar-forget"
            onClick={() => { void patch({ calendarFeedUrl: null, calendarEnabled: false }); }}
            className="text-[11.5px] text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
          >
            {t('calendar.forget')}
          </button>
        )}
      </div>

      {/* The two dials. Closed sets, not free numbers: "every minute" written
          by hand would hammer a provider from a machine that cannot see it. */}
      <div className="space-y-1 border-t border-app-border pt-3">
        <Dial
          label={t('calendar.refresh')}
          hint={t('calendar.refresh.hint')}
          value={settings?.calendarRefreshMinutes ?? DEFAULT_CALENDAR_REFRESH_MINUTES}
          options={CALENDAR_REFRESH_CHOICES.map((m) => ({ value: String(m), label: t('calendar.minutes', { n: String(m) }) }))}
          onChange={(v) => { void patch({ calendarRefreshMinutes: Number(v) }); }}
        />
        <Dial
          label={t('calendar.horizon')}
          hint={t('calendar.horizon.hint')}
          value={settings?.calendarHorizonDays ?? DEFAULT_CALENDAR_HORIZON_DAYS}
          options={CALENDAR_HORIZON_CHOICES.map((d) => ({ value: String(d), label: t('calendar.days', { n: String(d) }) }))}
          onChange={(v) => { void patch({ calendarHorizonDays: Number(v) }); }}
        />
      </div>
    </div>
  );
}

/** A labelled dropdown over a closed set. `SettingSelect` is not reused here:
 *  it carries an "Auto (env/default)" entry, and these two dials have no such
 *  state -- a calendar always refreshes at SOME interval. */
function Dial({ label, hint, value, options, onChange }: {
  label: string;
  hint: string;
  value: number;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="text-[12px] text-app-text">{label}</span>
        <span className="text-[11px] break-words text-app-text-muted">{hint}</span>
      </span>
      <Select
        ariaLabel={label}
        align="right"
        value={String(value)}
        onChange={onChange}
        className="max-w-full min-w-[140px] flex-shrink-0"
        options={options}
      />
    </div>
  );
}
