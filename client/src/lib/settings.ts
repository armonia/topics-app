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

let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveSettings(settings: AppSettings) {
  // Write localStorage immediately (fast paint)
  localStorage.setItem('app-settings', JSON.stringify(settings));

  // Debounced server sync (1s for resize-heavy changes)
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    fetch('/api/ui-state/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).catch(() => {});
  }, 1000);
}

/** Load settings from server (call once at app init, merges with localStorage) */
export async function loadSettingsFromServer(): Promise<AppSettings | null> {
  try {
    const res = await fetch('/api/ui-state/settings');
    if (!res.ok) return null;
    const serverSettings = await res.json();
    if (!serverSettings) return null;
    const merged = { ...DEFAULT_SETTINGS, ...serverSettings };
    localStorage.setItem('app-settings', JSON.stringify(merged));
    return merged;
  } catch {
    return null;
  }
}
