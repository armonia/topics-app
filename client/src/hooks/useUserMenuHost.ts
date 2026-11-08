/**
 * WHAT A HOST OF THE USER MENU NEEDS FROM APP, out of App's body.
 *
 *  · `useMenuPreferences`: the values the preference levels read and the
 *    functions they write with. The same stores the Settings panel wrote
 *    (`saveSettings`, `setTheme`), so moving the controls moved no data.
 *  · `useUserMenuRequest`: a request to open the menu on a level
 *    (`lib/openUserMenu`), answered by the phone's title menu. On the desktop
 *    the user card answers the same event (`Sidebar/IdentityBlock`).
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppSettings, ThemeMode } from '../types';
import { saveSettings } from '../lib/settings';
import { OPEN_USER_MENU_EVENT, type OpenUserMenuDetail, type UserMenuRequest } from '../lib/openUserMenu';
import type { MenuPreferences } from '../components/Sidebar/AppearanceLevel';

export function useMenuPreferences({ settings, setSettings, themeMode, setTheme, onOpenShortcuts }: {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  themeMode: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  onOpenShortcuts: () => void;
}): MenuPreferences {
  const onSettingChange = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
  }, [settings, setSettings]);
  return useMemo(() => ({
    settings,
    onSettingChange,
    themeMode,
    onThemeChange: setTheme,
    onOpenShortcuts,
  }), [settings, onSettingChange, themeMode, setTheme, onOpenShortcuts]);
}

/**
 * The last request to open the menu, and a reset for when the person opens it
 * by hand. `n` changes on every request, so the host can remount its rows and
 * the level opens even when the same one is asked for twice in a row.
 */
export function useUserMenuRequest(enabled: boolean, open: () => void): [UserMenuRequest, () => void] {
  const [request, setRequest] = useState<UserMenuRequest>({ level: null, n: 0 });
  useEffect(() => {
    if (!enabled) return;
    const onRequest = (e: Event) => {
      const level = (e as CustomEvent<OpenUserMenuDetail>).detail?.level ?? null;
      setRequest((r) => ({ level, n: r.n + 1 }));
      open();
    };
    window.addEventListener(OPEN_USER_MENU_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_USER_MENU_EVENT, onRequest);
  }, [enabled, open]);
  const reset = useCallback(() => setRequest((r) => ({ level: null, n: r.n })), []);
  return [request, reset];
}
