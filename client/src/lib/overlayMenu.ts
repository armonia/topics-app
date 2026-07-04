/**
 * overlayMenu — legacy shim for the native transparent overlay menus.
 *
 * These menus were an ELECTRON-only feature: a native transparent window that
 * stacked above the OS-level WebContentsView so a dropdown wasn't occluded by
 * the browser pane. The Electron shell was archived in v2.0.0 and the Tauri
 * shell renders its browser panes without that occlusion problem, so callers
 * (BrowserDevControls) always take their React-dropdown fallback path.
 *
 * `overlayMenusAvailable()` therefore returns false and `showOverlayMenu()` is a
 * no-op — kept only so the existing callsites compile unchanged.
 */

export interface OverlayMenuItem {
  id: string;
  label: string;
  divider?: boolean;
}

/** Native overlay menus were an Electron-only path; never available now. */
export function overlayMenusAvailable(): boolean {
  return false;
}

/** No-op: the native overlay menu path is gone (see overlayMenusAvailable). */
export async function showOverlayMenu(_opts: {
  anchorEl: HTMLElement | null;
  items: OverlayMenuItem[];
  side?: 'bottom' | 'top' | 'right' | 'left';
  estimatedWidth?: number;
}): Promise<string | null> {
  return null;
}
