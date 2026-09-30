/**
 * Board drafts on the server's ui-state store: the composer draft, the
 * per-task drafts and the pending review notes (see `boardDrafts` in
 * `./board`). Writes are debounced per key and flushed when the page hides;
 * failures are silent, the in-memory text is never blocked on the network.
 */

export async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: draft keys, not pane state
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (d?.value ?? null) as T | null;
  } catch { return null; }
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The value each armed timer is going to send: what a page-exit flush sends instead. */
const draftPending = new Map<string, unknown>();
/**
 * Browsers refuse a keepalive request whose body (summed over the ones still
 * in flight) passes 64 KiB. A bigger draft map goes out as a plain PUT: it
 * still lands when the page only went hidden, which is the common case.
 */
const UNLOAD_BODY_MAX = 60_000;

function sendDraft(key: string, value: unknown, keepalive: boolean): void {
  const body = JSON.stringify(value);
  // PANE-01-ALLOWED: draft keys, not pane state
  fetch(`/api/ui-state/${key}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    keepalive: keepalive && body.length <= UNLOAD_BODY_MAX,
  }).catch(() => {});
}

export function uiPutDebounced(key: string, value: unknown, ms = 800): void {
  const t = draftTimers.get(key);
  if (t) clearTimeout(t);
  draftPending.set(key, value);
  draftTimers.set(key, setTimeout(() => {
    draftTimers.delete(key);
    draftPending.delete(key);
    sendDraft(key, value, false);
  }, ms));
}

/**
 * Send every queued draft NOW, with `keepalive`, because the page is going
 * away. A reload or a closed window does not wait for the 800 ms debounce:
 * without this, whatever was typed since the last pause of 800 ms was lost
 * (measured: unload 300 ms after typing, 0 PUTs sent). Same shape as the
 * pagehide flush of the pane store and of the per-record browser stores.
 */
export function flushBoardDrafts(): void {
  if (!draftTimers.size) return;
  const pending = [...draftPending];
  for (const t of draftTimers.values()) clearTimeout(t);
  draftTimers.clear();
  draftPending.clear();
  for (const [key, value] of pending) sendDraft(key, value, true);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushBoardDrafts);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushBoardDrafts();
    });
  }
}
