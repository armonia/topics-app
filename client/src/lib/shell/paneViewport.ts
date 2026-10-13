/**
 * THE MAC'S NATIVE PANE WHILE ANOTHER DEVICE USES ITS PAGE (TOPIC-BROWSER-05).
 *
 * A page the Mac's pane hosts (NATIVE-HOST-01) is laid out by the WKWebView, at
 * the size of the view. An iPad that used it got the Mac's layout, scaled down
 * and letterboxed. Now the server tells the pane the size of the device using
 * the page, and the view takes that size in CSS px: whole when the slot has
 * room for it, scaled down with WKWebView's page zoom when it has not. Page zoom
 * moves the layout viewport and the media queries with it, which the CSS zoom
 * the toolbar uses does not. The Mac sees the iPad's page, smaller, centered in
 * its slot, and the iPad gets its own layout back at 1:1.
 *
 * The Mac's user using the page takes it back: a trusted pointer, key or wheel
 * event in the page. A viewer's input arrives as synthetic events
 * (nativeDomHost INPUT_FN), which are never trusted, so it cannot take it back
 * by itself.
 *
 * Pure, apart from the page-side strings: the hook applies it.
 */

export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }

export interface PaneView {
  /** Where the native view goes, in window px. */
  rect: Rect;
  /** WKWebView's page zoom: 1 except while a larger device's page is scaled into the slot. */
  pageZoom: number;
}

/** The lowest page zoom the shell applies (lib.rs `browser_set_page_zoom`). */
export const MIN_PAGE_ZOOM = 0.25;

const centered = (slot: Rect, width: number, height: number): Rect => ({
  x: slot.x + (slot.width - width) / 2,
  y: slot.y + (slot.height - height) / 2,
  width,
  height,
});

/**
 * The view inside its slot: at the size of the device using the page (scaled
 * down to fit, never up), else letterboxed to the emulated device, else the
 * whole slot. Without page zoom (a shell that predates the command) the remote
 * size is only clamped to the slot, like the emulation.
 */
export function paneView(
  slot: Rect,
  opts: { remote?: Size | null; device?: Size | null; canZoom?: boolean },
): PaneView {
  const { remote, device } = opts;
  if (remote && opts.canZoom) {
    const s = Math.min(1, slot.width / remote.width, slot.height / remote.height);
    const width = Math.max(1, Math.round(remote.width * s));
    const height = Math.max(1, Math.round(remote.height * s));
    // From the rounded width, so the page is laid out exactly as wide as the
    // device: its width is what decides its layout, and the device's own
    // mirror shows it 1:1 only when it matches (browserFit).
    return { rect: centered(slot, width, height), pageZoom: Math.max(MIN_PAGE_ZOOM, width / remote.width) };
  }
  const box = remote ?? device;
  if (box) return { rect: centered(slot, Math.min(box.width, slot.width), Math.min(box.height, slot.height)), pageZoom: 1 };
  return { rect: slot, pageZoom: 1 };
}

/**
 * Counts the trusted pointer, key and wheel events in the page. Installed by
 * the pane's fast poll on every document, like the focus hook next to it. A
 * modifier on its own, or a key with Cmd, is not using the page: Cmd+Tab out
 * of a focused pane would otherwise take the page from the device using it.
 */
export const INSTALL_USE_HOOK =
  "if(!window.__tUseHook){window.__tUseHook=1;window.__topicsLocalUse=0;" +
  "var __tUse=function(e){if(e.isTrusted)window.__topicsLocalUse++};" +
  "addEventListener('pointerdown',__tUse,true);" +
  "addEventListener('keydown',function(e){if(!e.metaKey&&!/^(Meta|Control|Alt|Shift|CapsLock|Fn)$/.test(e.key))__tUse(e)},true);" +
  "addEventListener('wheel',__tUse,{capture:true,passive:true});}";

/** The count, read in the same evaluation. */
export const LOCAL_USE_COUNT_JS = 'window.__topicsLocalUse||0';

/**
 * Did the Mac's user use the page since the last read? The count lives in the
 * document, so a new document counts from zero again: anything above zero
 * there is news. The first read only sets the baseline.
 */
export function usedSince(last: number, seen: number): boolean {
  if (last < 0) return false;
  return seen < last ? seen > 0 : seen > last;
}
