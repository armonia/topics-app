// Window chrome — traffic lights + drag regions, unified across Electron / Tauri.
// PORTING-PLAN.md §5b. Callsites import from here instead of branching on host.
//
// Two custom bits the Electron shell does natively and the Tauri shell must match:
//   1. Traffic lights are HIDDEN by default and revealed only while the Topics
//      menu is open (Electron: `window:showTrafficLights` IPC → setWindowButton-
//      Visibility; Tauri: the `set_traffic_lights` command toggles NSWindow's
//      standard buttons).
//   2. The titlebar / tab strips are window-drag handles. Electron uses the CSS
//      `-webkit-app-region: drag` (class `.app-drag-region`) / `no-drag`
//      (`.app-no-drag`). Tauri uses the `data-tauri-drag-region` attribute
//      (`deep` = drag the whole subtree minus interactive children; `false` =
//      opt out). We mirror the existing Electron classes onto those attributes
//      so no chrome markup needs per-host edits and tab drag-reorder (the
//      `.app-no-drag` tabs) keeps working.

import { isElectron, isTauri } from './index';
import { tauriInvoke } from './tauri';

interface ElectronWindowApi {
  showTrafficLights?(): void;
  hideTrafficLights?(): void;
}
function electronWindow(): ElectronWindowApi | undefined {
  return (window as unknown as { electronAPI?: { window?: ElectronWindowApi } }).electronAPI?.window;
}

/** Reveal the macOS traffic lights (close/min/zoom). No-op on web / non-mac. */
export function showTrafficLights(): void {
  if (isElectron) { electronWindow()?.showTrafficLights?.(); return; }
  if (isTauri) { void tauriInvoke('set_traffic_lights', { visible: true }); }
}

/** Hide the macOS traffic lights. No-op on web / non-mac. */
export function hideTrafficLights(): void {
  if (isElectron) { electronWindow()?.hideTrafficLights?.(); return; }
  if (isTauri) { void tauriInvoke('set_traffic_lights', { visible: false }); }
}

let dragWired = false;

/** Tauri-only: mirror Electron's drag CSS classes onto Tauri drag attributes so
 *  the same chrome (sidebar header, project header, tab strips) drags the window.
 *  `.app-drag-region` → `deep` (whole subtree drags; Tauri auto-excludes
 *  buttons/links/inputs/role=tab), `.app-no-drag` → `false` (explicit opt-out,
 *  e.g. the draggable reorder tabs). Idempotent per element via the `:not(...)`
 *  guard; a debounced observer covers panes/tabs mounted later. */
export function wireTauriDragRegions(): void {
  if (!isTauri || dragWired || typeof document === 'undefined') return;
  dragWired = true;

  const apply = (): void => {
    document
      .querySelectorAll('.app-drag-region:not([data-tauri-drag-region])')
      .forEach((el) => el.setAttribute('data-tauri-drag-region', 'deep'));
    document
      .querySelectorAll('.app-no-drag:not([data-tauri-drag-region])')
      .forEach((el) => el.setAttribute('data-tauri-drag-region', 'false'));
  };

  apply();

  // Re-apply when chrome is added (new pane/tab/project). Trailing-debounced so
  // it runs at most a few times a second even under heavy DOM churn (streaming
  // chat appends nodes constantly); the `:not(...)` guard keeps each pass cheap.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; apply(); }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
