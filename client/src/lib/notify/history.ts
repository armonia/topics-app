// La CRONOLOGIA delle notifiche, lato client: la porta HTTP e le due decisioni
// pure che la governano.
//
// Il registro vive sul server (migration 102) e non nel browser, di proposito:
// una notifica può partire da una finestra e vederla è naturale da un'altra (o
// dal telefono), e un contatore per-finestra sarebbe un numero diverso per ogni
// scheda aperta. Qui dentro non c'è stato: lo tiene `useNotificationHistory`.

import type { NotificationRow } from '../../../../shared/notification-log';
import { NOTIFICATION_MAX_ROWS } from '../../../../shared/notification-log';
import { apiFetch } from '../shell/net';

export interface NotificationHistoryPage {
  rows: NotificationRow[];
  unseen: number;
  /** The unseen subjects (group key, or row id when ungrouped). */
  unseenKeys?: string[];
}

/** Le ultime righe + quante non viste. */
export async function fetchNotificationHistory(opts: { limit?: number; before?: string } = {}): Promise<NotificationHistoryPage> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.before) q.set('before', opts.before);
  const qs = q.toString();
  const r = await apiFetch(`/api/notifications${qs ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(`GET /api/notifications ${r.status}`);
  const data = (await r.json()) as Partial<NotificationHistoryPage>;
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    unseen: data.unseen ?? 0,
    ...(Array.isArray(data.unseenKeys) ? { unseenKeys: data.unseenKeys } : {}),
  };
}

// ── Decisioni pure ──────────────────────────────────────────────────────────

/**
 * Put the row a live epoch wrote (`attention:updated.history`) at the top,
 * without duplicating it.
 *
 * The id check is NOT theoretical: a read of the newest page that lands just
 * before the frame already holds the row, and without it the same
 * notification would show twice at the top of the list.
 */
export function mergeNotificationRow(rows: NotificationRow[], row: NotificationRow, cap = 200): NotificationRow[] {
  const without = rows.filter((r) => r.id !== row.id);
  return [row, ...without].slice(0, cap);
}

/**
 * Merge a PAGE into the list already in hand, instead of replacing it.
 *
 * Replacing is what the panel used to do, and it undid its own paging: every
 * open re-read the newest page and threw away both the older pages the reader
 * had asked for and the live rows accumulated since. Same id, the server copy
 * wins (it carries the authoritative `seenAt`); order is by time, newest first,
 * because that is the order the panel reads in and a page fetched with `before`
 * arrives after the rows it belongs under.
 */
export function mergeNotificationPage(
  prev: NotificationRow[],
  incoming: NotificationRow[],
  cap = NOTIFICATION_MAX_ROWS,
): NotificationRow[] {
  const byId = new Map<string, NotificationRow>();
  for (const r of prev) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()]
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, cap);
}
