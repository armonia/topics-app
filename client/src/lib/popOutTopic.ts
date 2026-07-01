// Pop a topic out into its own window — shared by the pane header button and
// the pane-menu pop-out actions.
//
// Returns true only when a window actually opened. Callers must NOT close or
// remove the source pane on false: blocked popups and shells without a
// window-open handler return null from window.open, and closing anyway would
// destroy the pane with nowhere for it to go (the Tauri WKWebView has no
// new-window handler today, so every pop-out there returns null).
import { isTauri } from './shell/index';

/** Pop-out is not supported in the Tauri shell yet (no window.open handler,
 *  no `window:detach` command) — surface actions as disabled, not broken. */
export const canPopOut = !isTauri;

const isWkWebView =
  typeof window !== 'undefined' &&
  !!(window as Window & { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;

export function popOutTopic(topicId: string): boolean {
  if (!canPopOut) return false;
  const url = `${window.location.origin}?topic=${encodeURIComponent(topicId)}`;
  const win = isWkWebView
    ? window.open(url, `topic-${topicId}`, 'width=900,height=700')
    : window.open(url, `topic-${topicId}`);
  return !!win;
}
