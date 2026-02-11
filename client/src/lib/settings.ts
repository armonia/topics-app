import type { AppSettings } from '../types';

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  messageDensity: 'comfortable',
  sidebarWidth: 256,
  sidebarCollapsed: false,
};

export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem('app-settings');
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem('app-settings', JSON.stringify(settings));
}
