import { useState, useEffect, useCallback } from 'react';
import type { ThemeMode, WSMessage } from '../types';
import { useServerState } from './useServerState';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export function useTheme(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  const [themeMode, setThemeMode] = useServerState<ThemeMode>('theme', 'system', {
    localStorageKey: 'theme',
    debounceMs: 300,
    onMessage,
  });
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => getEffectiveTheme(themeMode));

  useEffect(() => {
    const effective = getEffectiveTheme(themeMode);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- converging sync: resolves themeMode (incl. 'system' via matchMedia, which can't run in render) alongside the DOM/native side effects below; only re-runs when themeMode changes, never loops
    setEffectiveTheme(effective);
    document.documentElement.classList.toggle('dark', effective === 'dark');
    // Tauri native chrome: set the NSWindow appearance so the traffic lights and
    // the per-region vibrancy material re-tint to match light/dark (set_theme in
    // src-tauri/src/lib.rs). No-op off macOS / on web.
    if (isTauri) {
      void tauriInvoke('set_theme', { theme: effective }).catch(() => {});
    }
  }, [themeMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (themeMode !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const effective = getEffectiveTheme('system');
      setEffectiveTheme(effective);
      document.documentElement.classList.toggle('dark', effective === 'dark');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  const toggleTheme = useCallback(() => {
    setThemeMode(prev => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'system';
      return 'light';
    });
  }, [setThemeMode]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, [setThemeMode]);

  return { themeMode, effectiveTheme, toggleTheme, setTheme };
}
