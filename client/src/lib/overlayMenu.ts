/**
 * overlayMenu — render a dropdown as a NATIVE transparent menu window above the
 * browser pane, instead of a React popover that the OS-level WebContentsView
 * would paint over.
 *
 * This is a thin, generic wrapper over `window.electronAPI.overlay.showMenu`
 * (electron-app/overlay-manager.ts) — the same path PaneAddMenu uses for the
 * "+" menu. The native window stacks above the WebContentsView (Electron
 * #15899 fix), so the browser stays visible and the menu is never occluded.
 *
 * Use `overlayMenusAvailable()` to branch: when true, call `showOverlayMenu`
 * and act on the returned item id; otherwise fall back to the component's
 * existing React dropdown (web build / no native browser).
 */

import { overlayThemeColors } from './popoverStyles';

export interface OverlayMenuItem {
  id: string;
  label: string;
  divider?: boolean;
}

/** True when the native overlay menu path is usable (Electron + overlay API). */
export function overlayMenusAvailable(): boolean {
  const api = window.electronAPI;
  return !!api?.overlay?.showMenu && !!api?.browserNative?.isAvailable;
}

/**
 * Show a native menu anchored to `anchorEl`. Returns the selected item id, or
 * null if cancelled (blur / Esc). No-op (null) when the overlay API is absent.
 */
export async function showOverlayMenu(opts: {
  anchorEl: HTMLElement | null;
  items: OverlayMenuItem[];
  side?: 'bottom' | 'top' | 'right' | 'left';
  estimatedWidth?: number;
}): Promise<string | null> {
  const api = window.electronAPI?.overlay;
  if (!api?.showMenu || !opts.anchorEl) return null;
  const r = opts.anchorEl.getBoundingClientRect();
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  return api.showMenu({
    anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
    items: opts.items,
    side: opts.side ?? 'bottom',
    theme,
    estimatedWidth: opts.estimatedWidth,
    // Pass the live app theme so the native overlay matches the in-app popovers
    // instead of falling back to the hardcoded white panel — the same palette
    // PaneAddMenu already sends. Without this the browser's native menus read as
    // a different (unthemed) surface from the rest of the app.
    colors: overlayThemeColors(),
  });
}
