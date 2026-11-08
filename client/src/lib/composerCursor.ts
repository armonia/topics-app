/**
 * Cursor/selection preservation for text composers across a HOT RELOAD.
 *
 * The draft TEXT already survives a reload (chat → localStorage, board → server
 * draft), but the caret jumps to the end and focus is lost. This keeps the exact
 * caret + selection, and re-focuses the ONE composer you were actively typing in,
 * so a bundle-rev reload / dev HMR doesn't interrupt you mid-word.
 *
 * sessionStorage (not localStorage): a caret is per-tab-session ephemeral — it
 * should survive a reload of THIS tab, not resurrect in a new window days later.
 */

const ACTIVE_KEY = 'composer:active';

function key(k: string): string {
  return `composer:cursor:${k}`;
}

/** Remember the caret+selection for composer `k`. */
export function writeCursor(k: string, start: number, end: number): void {
  try { sessionStorage.setItem(key(k), `${start}:${end}`); } catch { /* private mode */ }
}

/** Read the saved caret+selection, or null. */
export function readCursor(k: string): [number, number] | null {
  try {
    const v = sessionStorage.getItem(key(k));
    if (!v) return null;
    const [a, b] = v.split(':').map((n) => Number.parseInt(n, 10));
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
  } catch { return null; }
}

/** Mark `k` as the composer that currently has focus (last-focused wins). */
export function markActiveComposer(k: string): void {
  try { sessionStorage.setItem(ACTIVE_KEY, k); } catch { /* private mode */ }
}

/** True if `k` was the focused composer at the last focus event (→ restore focus). */
export function wasActiveComposer(k: string): boolean {
  try { return sessionStorage.getItem(ACTIVE_KEY) === k; } catch { return false; }
}

/**
 * Apply the saved caret to `ta` (clamped to its current length). Focuses the
 * element only when it was the active composer before the reload, or when
 * `forceFocus` is set — so restoring one composer never steals focus from
 * another surface on an ordinary re-mount (e.g. a topic switch).
 */
export function restoreCursor(k: string, ta: HTMLTextAreaElement | null, forceFocus = false): void {
  if (!ta) return;
  const cur = readCursor(k);
  if (!cur) return;
  const max = ta.value.length;
  const start = Math.min(cur[0], max);
  const end = Math.min(cur[1], max);
  const focus = forceFocus || wasActiveComposer(k);
  try {
    if (focus) ta.focus();
    ta.setSelectionRange(start, end);
  } catch { /* detached / unsupported */ }
}
