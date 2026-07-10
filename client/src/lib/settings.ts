import type { AppSettings } from '../types';

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  messageDensity: 'comfortable',
  sidebarWidth: 256,
  sidebarCollapsed: false,
  // Notifications default to on with sound; users disable from Settings.
  // `notifyEvenWhenFocused` defaults to ON: with several topics open in
  // parallel the user wants the completion cue even on the visible one. The
  // toggle stays in Settings → Notifications for anyone who prefers it quiet.
  notificationsEnabled: true,
  notificationsSound: true,
  notifyEvenWhenFocused: true,
  // Chat is included in the local Claude subscription (the `claude-code` CLI
  // path draws from the Pro/Max plan, not metered API credits — verified
  // 2026-07), so the "New Chat" affordances ship ON. The toggle stays in
  // Settings → Features for anyone who wants to hide the entry points.
  enableNewChat: true,
  // Experimental floating-splits layout — OFF by default, desktop-only.
  floatingSplits: false,
  // Animated "working" glow ring around actively-streaming chat panes — ON by
  // default (subtle, readability-safe; users can disable in Settings → Appearance).
  workingGlow: true,
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
