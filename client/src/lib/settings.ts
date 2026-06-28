import type { AppSettings } from '../types';
import { isTauri } from './shell';

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
  // Experimental floating-splits layout — OFF by default, desktop-only.
  floatingSplits: false,
  // Overlay sidebar (slides over content instead of pushing it). Defaults ON on
  // Tauri — the migration target, where eliminating the sidebar-toggle terminal
  // relayout (literal zero frame-drop, content offset is constant) is the goal;
  // Electron/web stay push (false). Reversible from Settings ▸ Appearance.
  overlaySidebar: isTauri,
  // Experimental split-tree engine — OFF by default. Renders the standalone
  // grid through the unified layoutTree/<SplitTree> renderer; flip to dogfood.
  splitTreeEngine: false,
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

// Event name fired on every settings write so live consumers can re-read
// without polling localStorage on every render (see MessageList).
export const SETTINGS_CHANGED_EVENT = 'app-settings-changed';

export function saveSettings(settings: AppSettings) {
  // Write localStorage immediately (fast paint)
  localStorage.setItem('app-settings', JSON.stringify(settings));
  // Notify in-process consumers (cross-tab is covered by the 'storage' event).
  try { window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT)); } catch {}

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
