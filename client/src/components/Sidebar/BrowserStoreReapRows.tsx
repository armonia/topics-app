import { useCallback, useEffect, useRef, useState } from 'react';
import { appSettingsApi, type AppBehaviorSettings } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { SwitchRow } from './PreferenceRow';
import {
  BROWSER_STORE_REAP_MAX_DAYS,
  BROWSER_STORE_REAP_MIN_DAYS,
  clampBrowserStoreReapDays,
  resolveBrowserStoreReap,
} from '../../../../shared/browser-store-reap';

/**
 * THE CLEANUP OF CLOSED BROWSERS' DATA: the switch and its number of days.
 *
 * It sits under the other browser switch of this level (free unseen pages when
 * memory is short) because the two are the only app-wide decisions about the
 * browser panes, and they are the same kind of decision: what Topics may throw
 * away on its own. That one costs a reload; this one cannot be undone, which is
 * why it is a setting at all (Attilio, approving #425) and why the line under it
 * says "for good".
 *
 * The values live on the server (`/api/app-settings`), not in this browser:
 * the reaper reads them at every start of the desktop app, whichever device
 * changed them. NULL = never touched = on, 60 days (`shared/browser-store-reap.ts`).
 *
 * Nothing is drawn until the stored values are read: showing the default in
 * their place would state a choice that nobody has seen.
 */
export function BrowserStoreReapRows() {
  const tr = useT();
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  // What is being typed in the days field, until it is committed.
  const [typed, setTyped] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void appSettingsApi.get().then((s) => { if (alive.current) setSettings(s); }).catch(() => {});
    return () => { alive.current = false; };
  }, []);

  const save = useCallback(async (patch: Partial<AppBehaviorSettings>) => {
    setSaveFailed(false);
    try {
      const next = await appSettingsApi.update(patch);
      if (alive.current) setSettings(next);
    } catch {
      if (alive.current) setSaveFailed(true);
    }
  }, []);

  if (!settings) return null;
  const { enabled, afterDays } = resolveBrowserStoreReap(settings);

  // Out of range is brought to the nearest limit here too, so the field shows
  // at once the number the server is going to keep.
  const commit = (raw: string) => {
    setTyped(null);
    const n = Number(raw);
    if (raw.trim() === '' || Number.isNaN(n)) return;
    const days = clampBrowserStoreReapDays(n);
    if (days !== afterDays) void save({ browserStoreReapAfterDays: days });
  };

  const [before, after] = tr('browser.storeReap.afterDays').split('{n}');
  return (
    <>
      <SwitchRow
        label={tr('browser.storeReap.setting')}
        hint={tr('browser.storeReap.hint')}
        checked={enabled}
        onChange={(v) => { void save({ browserStoreReapEnabled: v }); }}
        testId="perf-browser-store-reap"
      />
      <label
        data-testid="perf-browser-store-reap-days"
        className={`flex items-center gap-1.5 px-3 pb-1.5 text-compact text-app-text-secondary coarse:min-h-11${enabled ? '' : ' opacity-50'}`}
      >
        <span>{before}</span>
        <input
          type="number"
          inputMode="numeric"
          min={BROWSER_STORE_REAP_MIN_DAYS}
          max={BROWSER_STORE_REAP_MAX_DAYS}
          step={1}
          value={typed ?? String(afterDays)}
          disabled={!enabled}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-14 rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-right text-compact tabular-nums text-app-text outline-none focus:border-app-accent disabled:cursor-not-allowed coarse:min-h-11"
        />
        <span>{after}</span>
      </label>
      {saveFailed && (
        <div role="alert" className="px-3 pb-1 text-mini text-red-500">{tr('browser.storeReap.saveFailed')}</div>
      )}
    </>
  );
}
