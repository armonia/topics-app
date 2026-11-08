// Window chrome — traffic lights + drag regions, unified across Electron / Tauri.
// PORTING-PLAN.md §5b. Callsites import from here instead of branching on host.
//
// Two custom bits the Electron shell does natively and the Tauri shell must match:
//   1. Traffic lights are hidden by default by the shell and REVEALED by the
//      app once the chrome is up (Electron: `window:showTrafficLights` IPC →
//      setWindowButtonVisibility; Tauri: the `set_traffic_lights` command
//      toggles NSWindow's standard buttons). They used to come and go with the
//      «Topics» dropdown; that dropdown is gone from the desktop, so they are
//      permanent and the word «Topics» sits to their right.
//   2. The titlebar / tab strips are window-drag handles. Electron uses the CSS
//      `-webkit-app-region: drag` (class `.app-drag-region`) / `no-drag`
//      (`.app-no-drag`). Tauri uses the `data-tauri-drag-region` attribute
//      (`deep` = drag the whole subtree minus interactive children; `false` =
//      opt out). L'attributo lo emette adesso il RENDER (`lib/shell/dragRegion.ts`,
//      costanti `DRAG_REGION` / `NO_DRAG_REGION` sparse accanto alla classe):
//      prima lo specchiava un MutationObserver su `document.body` con
//      `subtree: true`, che con xterm costava migliaia di record al secondo per
//      non trovare quasi mai niente. Vedi quel file per la misura.

import { isTauri } from './index';
import { tauriInvoke } from './tauri';

/** Reveal the macOS traffic lights (close/min/zoom). No-op on web / non-mac. */
export function showTrafficLights(): void {
  if (isTauri) { void tauriInvoke('set_traffic_lights', { visible: true }); }
}


