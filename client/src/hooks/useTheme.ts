import { useState, useEffect, useCallback } from 'react';
import type { ThemeMode, WSMessage } from '../types';
import { useServerState } from './useServerState';

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
    setEffectiveTheme(effective);
    document.documentElement.classList.toggle('dark', effective === 'dark');
    // Phase F · 3rd no-flash layer: sync the resolved theme into the
    // Electron native chrome so the title bar / vibrancy material match
    // without flicker. No-op outside Electron.
    // Electron native-chrome theme bridge (preload-exposed). Not part of the
    // shared electronAPI .d.ts; describe just the slice we touch here.
    const electronTheme = (window as unknown as {
      electronAPI?: { theme?: { setResolved?: (theme: 'light' | 'dark') => Promise<void> } };
    }).electronAPI?.theme;
    if (electronTheme && typeof electronTheme.setResolved === 'function') {
      electronTheme.setResolved(effective).catch(() => {});
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
