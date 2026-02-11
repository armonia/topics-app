import { useState, useEffect, useCallback } from 'react';
import type { ThemeMode } from '../types';

function getStoredTheme(): ThemeMode {
  try {
    return (localStorage.getItem('theme') as ThemeMode) || 'system';
  } catch {
    return 'system';
  }
}

function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => getEffectiveTheme(getStoredTheme()));

  useEffect(() => {
    const effective = getEffectiveTheme(themeMode);
    setEffectiveTheme(effective);
    
    // Apply to document
    document.documentElement.classList.toggle('dark', effective === 'dark');
    localStorage.setItem('theme', themeMode);
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
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, []);

  return { themeMode, effectiveTheme, toggleTheme, setTheme };
}
