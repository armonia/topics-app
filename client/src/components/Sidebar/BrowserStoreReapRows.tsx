import { useCallback, useEffect, useRef, useState } from 'react';
// Relative and not `@/`: `bun test` does not resolve the client's alias, and
// these rows are mounted by `BrowserStoreReapRows.test.tsx`.
import { appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import { useT } from '../../hooks/useT';
import { SwitchRow } from './PreferenceRow';
import {
  BROWSER_STORE_REAP_MAX_DAYS,
  BROWSER_STORE_REAP_MIN_DAYS,
  clampBrowserStoreReapDays,
  resolveBrowserStoreReap,
} from '../../../../shared/browser-store-reap';

/**
 * THE CLEANUP OF CLOSED BROWSERS' DATA: two switches and their number of days.
 *
 * Two levels, because what the cleanup can take is not one thing (Attilio, on
 * #425: cookies and history are what keep the logins):
 *
 *   1. Empty the cache of closed browsers (`browser.storeReap.cache.*`): ON
 *      unless somebody switched it off. It removes only the cache of the
 *      browsers nobody opens any more and keeps their logins.
 *   2. Also delete logins and history (`browser.storeReap.whole.*`), indented
 *      under the first: OFF unless somebody switched it on. It removes the
 *      whole store, which cannot be undone. It is disabled while the first is
 *      off, because it only counts while the first is on.
 *
 * It sits under the other browser switch of this level (free unseen pages when
 * memory is short) because the two are the only app-wide decisions about the
 * browser panes, and they are the same kind of decision: what Topics may throw
 * away on its own.
 *
 * The values live on the server (`/api/app-settings`), not in this browser:
 * the reaper reads them at every start of the desktop app, whichever device
 * changed them. NULL means ON for level 1 and OFF for level 2, 60 days
 * (`shared/browser-store-reap.ts`).
 *
 * Nothing is drawn until the stored values are read: showing the default in
 * their place would state a choice that nobody has seen.
 *
 * The request and the state live here; what is drawn, and what each gesture
 * saves, is `BrowserStoreReapControls`, a function of its props with no hooks
 * so that a test can call it and press its controls without a DOM.
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
  return (
    <BrowserStoreReapControls
      settings={settings}
      typed={typed}
      saveFailed={saveFailed}
      tr={tr}
      onType={setTyped}
      onSave={(patch) => { void save(patch); }}
    />
  );
}

export interface BrowserStoreReapControlsProps {
  /** The three stored fields, as `GET /api/app-settings` returned them. */
  settings: Pick<
    AppBehaviorSettings,
    'browserStoreCacheReapEnabled' | 'browserStoreReapEnabled' | 'browserStoreReapAfterDays'
  >;
  /** The days field while it is being typed in; null shows the stored value. */
  typed: string | null;
  saveFailed: boolean;
  tr: (key: string) => string;
  onType: (raw: string | null) => void;
  onSave: (patch: Partial<AppBehaviorSettings>) => void;
}

/** The two switches, the days field and the save error, drawn from the stored values. */
export function BrowserStoreReapControls({ settings, typed, saveFailed, tr, onType, onSave }: BrowserStoreReapControlsProps) {
  const { cacheEnabled, wholeEnabled, afterDays } = resolveBrowserStoreReap(settings);

  // Out of range is brought to the nearest limit here too, so the field shows
  // at once the number the server is going to keep.
  const commit = (raw: string) => {
    onType(null);
    const n = Number(raw);
    if (raw.trim() === '' || Number.isNaN(n)) return;
    const days = clampBrowserStoreReapDays(n);
    if (days !== afterDays) onSave({ browserStoreReapAfterDays: days });
  };

  const [before, after] = tr('browser.storeReap.afterDays').split('{n}');
  // The Performance level has no max width: it grows to its widest line. These
  // two hints are the longest lines in it (the level-2 one took the panel from
  // 577 to 810 px), so they take no width of their own (`w-0`) and wrap inside
  // the width the other rows give the panel (`min-w-full`).
  const wrapped = (text: string) => <span className="block w-0 min-w-full">{text}</span>;
  return (
    <>
      <SwitchRow
        label={tr('browser.storeReap.cache.setting')}
        hint={wrapped(tr('browser.storeReap.cache.hint'))}
        checked={cacheEnabled}
        onChange={(v) => { onSave({ browserStoreCacheReapEnabled: v }); }}
        testId="perf-browser-store-cache-reap"
      />
      {/* Level 2 sits under level 1 and is dead while level 1 is off: it only
          counts while the cache cleanup is on. It keeps showing what was chosen. */}
      <div className="pl-4" data-testid="perf-browser-store-reap-whole">
        <SwitchRow
          label={tr('browser.storeReap.whole.setting')}
          hint={wrapped(tr('browser.storeReap.whole.hint'))}
          checked={wholeEnabled}
          disabled={!cacheEnabled}
          onChange={(v) => { onSave({ browserStoreReapEnabled: v }); }}
          testId="perf-browser-store-reap"
        />
      </div>
      <label
        data-testid="perf-browser-store-reap-days"
        className={`flex items-center gap-1.5 px-3 pb-1.5 text-compact text-app-text-secondary coarse:min-h-11${cacheEnabled ? '' : ' opacity-50'}`}
      >
        <span>{before}</span>
        <input
          type="number"
          inputMode="numeric"
          min={BROWSER_STORE_REAP_MIN_DAYS}
          max={BROWSER_STORE_REAP_MAX_DAYS}
          step={1}
          value={typed ?? String(afterDays)}
          disabled={!cacheEnabled}
          onChange={(e) => onType(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-14 rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-right text-compact tabular-nums text-app-text outline-none focus:border-app-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed coarse:min-h-11"
        />
        <span>{after}</span>
      </label>
      {saveFailed && (
        <div role="alert" className="px-3 pb-1 text-mini text-red-500">{tr('browser.storeReap.saveFailed')}</div>
      )}
    </>
  );
}
