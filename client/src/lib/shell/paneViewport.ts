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

/**
 * The lowest page zoom the shell applies (lib.rs `browser_set_page_zoom`). A
 * pane may be a tenth of the window (MIN_PANE_FRACTION), and WKWebView still
 * lays a 1180x820 page out exactly in a 59x41 frame at 0.05.
 */
export const MIN_PAGE_ZOOM = 0.05;

const centered = (slot: Rect, width: number, height: number): Rect => ({
  x: slot.x + (slot.width - width) / 2,
  y: slot.y + (slot.height - height) / 2,
  width,
  height,
});

/**
 * The zoom WebKit really applies for `zoom`. It keeps zoom factors as 32-bit
 * floats, and one rounded up lays the page out a pixel narrower: 246/820 is
 * 0.3, which became a page 819 wide. The largest float32 not above `zoom`.
 */
export function zoomFloor32(zoom: number): number {
  const f = Math.fround(zoom);
  if (f <= zoom) return f;
  const bits = new Float32Array([f]);
  new Uint32Array(bits.buffer)[0] -= 1;
  return bits[0];
}

/**
 * The view inside its slot: at the size of the device using the page (scaled
 * down to fit, never up), else letterboxed to the emulated device, else the
 * whole slot. Without page zoom (a shell that predates the command) the remote
 * size is only clamped to the slot, like the emulation.
 *
 * WebKit lays the page out at floor(frame / zoom), with the frame in whole
 * points (measured on WKWebView). The width decides the layout, so the zoom
 * comes from a whole frame width and the page is exactly as wide as the
 * device. The height is the device's, or a few pixels less when no whole frame
 * height gives it exactly: a shorter page shows whole and 1:1 on the device
 * (browserFit), a taller one would be scaled down to fit.
 */
export function paneView(
  slot: Rect,
  opts: { remote?: Size | null; device?: Size | null; canZoom?: boolean },
): PaneView {
  const { remote, device } = opts;
  if (remote && opts.canZoom) {
    const s = Math.min(1, slot.width / remote.width, slot.height / remote.height);
    const width = Math.max(1, Math.floor(remote.width * s + 1e-9));
    const pageZoom = Math.max(MIN_PAGE_ZOOM, zoomFloor32(width / remote.width));
    const exact = Math.ceil(remote.height * pageZoom - 1e-9);
    const height = exact <= slot.height && exact / pageZoom < remote.height + 1
      ? exact
      : Math.max(1, Math.floor(remote.height * pageZoom));
    return { rect: centered(slot, width, height), pageZoom };
  }
  const box = remote ?? device;
  if (box) return { rect: centered(slot, Math.min(box.width, slot.width), Math.min(box.height, slot.height)), pageZoom: 1 };
  return { rect: slot, pageZoom: 1 };
}

/**
 * The view parked off-screen (a hidden pane, or one behind a still) when the
 * device using the page changes: it is laid out all the same, since that device
 * sees it. Without a measured slot (a pane born hidden) it takes the size
 * itself at zoom 1, or keeps `last` when the Mac takes the page back. Never the
 * parked frame as a slot: that one is already scaled, and fitting it again
 * shrank the page on every new size.
 */
export function parkedView(
  slot: Rect | null,
  opts: { remote?: Size | null; device?: Size | null; canZoom?: boolean; last: Size },
): PaneView {
  if (slot) return paneView(slot, opts);
  const { width, height } = opts.remote ?? opts.last;
  return { rect: { x: 0, y: 0, width, height }, pageZoom: 1 };
}

/**
 * Counts the trusted pointer, key and wheel events in the page. Installed by
 * the pane's fast poll on every document, like the focus hook next to it. A
 * modifier on its own, or a key with Cmd, is not using the page: Cmd+Tab out
 * of a focused pane would otherwise take the page from the device using it.
 *
 * Frames of the same origin count too: a rich-text editor is often one, and
 * typing in it is using the page. Every poll walks the frames and hooks the
 * ones it has not hooked yet, so a frame added later is counted within a poll,
 * before its own `load` (which waits for every image in it). A navigation
 * inside a frame is caught by a `load` listener on the document, because a
 * frame's load event never reaches `window`: the DOM leaves the window out of
 * the path of every load event. A frame of another origin cannot be reached
 * from the page: it is tried once and remembered, so the poll does not throw
 * for it every 120 ms. Input there is the known limit (an NSEvent monitor in
 * the shell would see it).
 */
export const INSTALL_USE_HOOK =
  "if(!window.__tUseOn){window.__topicsLocalUse=0;var __tUseTop=window,__tUseForeign=new WeakSet();" +
  "window.__tUseOn=function(w){var d;try{d=w&&w.document}catch(x){return false}if(!d)return true;" +
  "if(!w.__tUseHook){w.__tUseHook=1;" +
  "var u=function(e){if(e.isTrusted)__tUseTop.__topicsLocalUse++};" +
  "w.addEventListener('pointerdown',u,true);" +
  "w.addEventListener('keydown',function(e){if(!e.metaKey&&!/^(Meta|Control|Alt|Shift|CapsLock|Fn)$/.test(e.key))u(e)},true);" +
  "w.addEventListener('wheel',u,{capture:true,passive:true});}" +
  "if(!d.__tUseDoc){d.__tUseDoc=1;" +
  "d.addEventListener('load',function(e){var t=e.target;if(t&&t.tagName==='IFRAME'&&__tUseTop.__tUseOn(t.contentWindow)===false)__tUseForeign.add(t)},true);}" +
  "var l=d.getElementsByTagName('iframe');" +
  "for(var i=0;i<l.length;i++){var f=l[i];if(!__tUseForeign.has(f)&&__tUseTop.__tUseOn(f.contentWindow)===false)__tUseForeign.add(f)}" +
  "return true};}" +
  "window.__tUseOn(window);";

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
