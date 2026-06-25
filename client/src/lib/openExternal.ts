// Canonical "open a URL outside the app" helper.
//
// In Electron we hand the URL to the system browser via the preload bridge
// (window.electronAPI.openExternal → IPC → shell.openExternal). In web mode we
// fall back to window.open. Both renderer link surfaces — chat markdown links
// (MessageContent) and terminal links (wrappedLinkProvider) — route through
// here so there is ONE place that decides how an external link opens.
//
// De-dupe guard: a repeat open of the SAME url within DEDUPE_MS is swallowed.
// This neutralises the ways a single user intent can fire the open twice —
// an accidental double-click, a duplicated event handler, or any path that
// activates the link more than once — so a link can never open twice for one
// click. The window is just above the OS double-click threshold (~500ms);
// genuinely re-opening the same URL is still possible after it elapses.

import { openExternal } from './shell/app';

const DEDUPE_MS = 600;

let lastUrl = '';
let lastAt = 0;

export function openExternalOnce(url: string): void {
  if (!url) return;

  const now = Date.now();
  if (url === lastUrl && now - lastAt < DEDUPE_MS) return;
  lastUrl = url;
  lastAt = now;

  // Routes through the shell bridge: Electron preload, Tauri opener plugin, or
  // window.open on web — one decision point for every host (PORTING-PLAN.md §5b).
  void openExternal(url);
}
