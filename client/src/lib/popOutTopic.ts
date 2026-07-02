// Pop topics out into their own OS window — shared by the pane header button
// and the group/pane menu pop-out actions.
//
// Returns true only when a window actually opened (or was reused). Callers must
// NOT close or remove the source pane on false: a blocked popup, a shell with
// no window handler, or a "the topic is already open in another window, so we
// just focused it" all return false, and closing anyway would destroy the pane
// with nowhere for it to go.
import { isTauri } from './shell/index';
import { tauriInvoke } from './shell/tauri';
import { useWindowPresenceStore } from '../state/windowPresence';

/** Pop-out is supported in every shell now: Tauri opens a real detached window
 *  (`window_detach`), web/Electron use `window.open`. Kept as an export so call
 *  sites can still gate UI on it if a future shell drops support. */
export const canPopOut = true;

const isWkWebView =
  typeof window !== 'undefined' &&
  !!(window as Window & { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;

/**
 * If every requested topic is already open in some OTHER presence window, focus
 * that window instead of opening a new one. Returns true when it handled the
 * request (caller should NOT detach again / should NOT close the source).
 */
async function focusIfAlreadyElsewhere(topicIds: string[]): Promise<boolean> {
  if (!isTauri || topicIds.length === 0) return false;
  const self = (() => {
    try {
      return sessionStorage.getItem('topics-window-id') ?? '';
    } catch {
      return '';
    }
  })();
  const windows = Object.values(useWindowPresenceStore.getState().windows);
  // Find a single other window that holds ALL requested topics — only then is
  // "focus it" unambiguous. Partial overlap falls through to a fresh detach.
  const holder = windows.find(
    (w) =>
      w.windowId !== self &&
      !!w.windowLabel &&
      topicIds.every((id) => w.topicIds.includes(id)),
  );
  if (!holder?.windowLabel) return false;
  try {
    const focused = await tauriInvoke<boolean>('window_focus_label', {
      label: holder.windowLabel,
    });
    return focused === true;
  } catch {
    return false;
  }
}

/**
 * Pop `topicIds` out into a new window. Async because the Tauri path awaits the
 * shell. Contract for every call site: close the source pane(s) ONLY when this
 * resolves true.
 */
export async function popOutTopics(topicIds: string[]): Promise<boolean> {
  const ids = topicIds.filter(Boolean);
  if (ids.length === 0) return false;

  if (isTauri) {
    // Already open elsewhere → focus that window, don't spawn a duplicate (and
    // return false so the caller keeps the source rather than closing into the
    // void — the topics live in the other window now).
    if (await focusIfAlreadyElsewhere(ids)) return false;
    try {
      const label = await tauriInvoke<string>('window_detach', { topics: ids });
      return typeof label === 'string' && label.length > 0;
    } catch {
      return false;
    }
  }

  // Web / Electron: window.open with a ?topics= URL (Electron's
  // setWindowOpenHandler intercepts to spawn a BrowserWindow).
  const url = `${window.location.origin}?topics=${ids.map(encodeURIComponent).join(',')}`;
  const name = `detach-${ids[0]}`;
  const win = isWkWebView
    ? window.open(url, name, 'width=900,height=700')
    : window.open(url, name);
  return !!win;
}

/** Single-topic convenience — preserves the three existing call sites. */
export async function popOutTopic(topicId: string): Promise<boolean> {
  return popOutTopics([topicId]);
}
