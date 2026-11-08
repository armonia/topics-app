// Canonical "open a URL outside the app" helper.
//
// Delegates to the shell bridge (`openExternal` in lib/shell/external.ts): the Tauri
// opener plugin on the desktop shell, or window.open on the web. Both renderer
// link surfaces — chat markdown links (MessageContent) and terminal links
// (wrappedLinkProvider) — route through here so there is ONE place that decides
// how an external link opens.
//
// De-dupe guard: a repeat open of the SAME url within DEDUPE_MS is swallowed.
// This neutralises the ways a single user intent can fire the open twice —
// an accidental double-click, a duplicated event handler, or any path that
// activates the link more than once — so a link can never open twice for one
// click. The window is just above the OS double-click threshold (~500ms);
// genuinely re-opening the same URL is still possible after it elapses.

import { openExternal } from './shell/external';

const DEDUPE_MS = 600;

let lastUrl = '';
let lastAt = 0;

export function openExternalOnce(url: string): void {
  if (!url) return;

  // ABSOLUTE urls only past this point: the Tauri opener plugin gets the raw
  // string, and a relative '/api/media?…' either fails or gets hijacked into
  // an in-app browser pane (the "vedo un browser topics" bug). One decision
  // point here protects every caller.
  try { url = new URL(url, window.location.origin).toString(); } catch { /* keep as-is */ }

  const now = Date.now();
  if (url === lastUrl && now - lastAt < DEDUPE_MS) return;
  lastUrl = url;
  lastAt = now;

  // Routes through the shell bridge: Electron preload, Tauri opener plugin, or
  // window.open on web — one decision point for every host (PORTING-PLAN.md §5b).
  void openExternal(url);
}
