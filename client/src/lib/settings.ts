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
    // PANE-01-ALLOWED: non-pane ui-state key (app settings: fontSize, density, sidebar width/collapsed). Not one of the 6 legacy pane keys.
    fetch('/api/ui-state/settings', { // PANE-01-ALLOWED
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).catch(() => {});
  }, 1000);
}

/** Load settings from server (call once at app init, merges with localStorage) */
export async function loadSettingsFromServer(): Promise<AppSettings | null> {
  try {
    // PANE-01-ALLOWED: non-pane ui-state key (app settings). Read-only GET for initial hydration.
    const res = await fetch('/api/ui-state/settings'); // PANE-01-ALLOWED
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
