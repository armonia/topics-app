/** The topic window's native page: keeping it on top, and asking it to re-measure. */
import { tauriInvoke } from '../../lib/shell/tauri';

/**
 * Put the window's page above the sibling native views.
 *
 * Z order among native views is CREATION order, and nothing but an explicit
 * reorder changes it (`tools/wkzprobe z`): a window opened before a browser
 * pane would float UNDER that pane, which is the one thing a floating window
 * may not do. The raise is a no-op outside the desktop shell, and a declared
 * gap on WebView2 and WebKitGTK (see `browser-platform-parity`).
 */
export function raiseNativeView(contextId: string): void {
  if (!contextId) return;
  void tauriInvoke('browser_raise', { id: contextId }).catch(() => {});
}

/** Tell the native views to re-measure: a window that MOVED without changing
 *  size fires no ResizeObserver, so nothing else would. */
export function requestReflow(contextId?: string, atAnimationFrame = false): void {
  // Targeted when we know whose page moved: an untargeted request makes every
  // native view in the app re-send its bounds, and here only one moved.
  const detail = contextId || atAnimationFrame ? { contextId, atAnimationFrame } : undefined;
  window.dispatchEvent(new CustomEvent('browser:reflow-request', { detail }));
}
