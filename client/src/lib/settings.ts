import type { AppSettings } from '../types';

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  messageDensity: 'comfortable',
  sidebarWidth: 256,
  sidebarCollapsed: false,
  // Notifications default to on with sound; users disable from Settings.
  // `notifyEvenWhenFocused` defaults to false so we don't spam users who
  // already have the topic in front of them — they get the toast either way.
  notificationsEnabled: true,
  notificationsSound: true,
  notifyEvenWhenFocused: false,
  // Paid feature — OFF by default. New chats hit a paid provider turn, so the
  // "New Chat" affordances stay hidden until the user opts in from Settings.
  enableNewChat: false,
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
