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
 * Browsers refuse a keepalive request whose body, summed over the keepalive
 * requests still in flight, passes 64 KiB, and they count BYTES: WebKit rejects
 * the fetch outright, so the draft is lost with the page. A draft that does not
 * fit in what is left goes out as a plain PUT: it still lands when the page
 * only went hidden, which is the common case. The margin under 65,536 leaves
 * room for the keepalive writes of the other stores.
 */
const UNLOAD_BODY_MAX = 60_000;
/** Bytes of this module's keepalive bodies whose request has not settled yet. */
let keepaliveBytesInFlight = 0;
const encoder = new TextEncoder();

function sendDraft(key: string, value: unknown, keepalive: boolean): void {
  const body = JSON.stringify(value);
  const bytes = keepalive ? encoder.encode(body).length : 0;
  const useKeepalive = keepalive && keepaliveBytesInFlight + bytes <= UNLOAD_BODY_MAX;
  if (useKeepalive) keepaliveBytesInFlight += bytes;
  const settle = (): void => { if (useKeepalive) keepaliveBytesInFlight -= bytes; };
  try {
    // PANE-01-ALLOWED: draft keys, not pane state
    fetch(`/api/ui-state/${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
      keepalive: useKeepalive,
    }).then(settle, settle);
  } catch {
    settle();
  }
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
