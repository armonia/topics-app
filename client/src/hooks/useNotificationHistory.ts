import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';
import type { NotificationRow } from '../../../shared/notification-log';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import {
  fetchNotificationHistory,
  mergeNotificationPage,
  mergeNotificationRow,
  type NotificationHistoryPage,
} from '../lib/notify/history';
import { NOTIFICATION_MAX_ROWS, NOTIFICATION_PAGE_SIZE } from '../../../shared/notification-log';

export interface NotificationHistoryState {
  rows: NotificationRow[];
  loading: boolean;
  /** There may be OLDER rows than the ones in hand: the registry keeps up to
   *  `NOTIFICATION_MAX_ROWS` and a page is `NOTIFICATION_PAGE_SIZE` long. */
  hasMore: boolean;
  /** An older page is on its way. */
  loadingMore: boolean;
  /** Ask for the page BEFORE the oldest row in hand. Idempotent while in
   *  flight, a no-op when there is nothing older. */
  loadMore: () => void;
  /** Read the newest page again (the inbox's «History» tab, at every open). */
  reload: () => void;
}

/**
 * THE HISTORY of the notifications for this window: READ ONLY
 * (notifications-redesign, design section 9.2, «Cronologia»).
 *
 * The rows are the server's (one per lit transition, written by the attention
 * store) and they enter no number any more: the inbox's number is the lit
 * subjects (`state/attentionTotal.ts`). So this hook reads and merges, and
 * writes nothing: no counter, no "mark all seen" on open. A row's dot is not
 * here either: the panel draws it from the attention store (the subject still
 * lit), not from the row's `seenAt`.
 *
 * Two sources: the row a live epoch wrote, carried by its `attention:updated`
 * frame (`history`), and the HTTP read (at mount and at every open of the
 * tab). A read that started before a live frame does not overwrite what that
 * frame said. A row with no subject (a system notice) has no frame: it arrives
 * with the next read.
 */
export function useNotificationHistory(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
): NotificationHistoryState {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  // Starts `true`: at mount the read is already in flight, and showing «no
  // notifications» for an instant before the list would be a short lie.
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // One read at a time, queued and not dropped.
  const inFlight = useRef<Promise<NotificationHistoryPage | null> | null>(null);
  const rowsRef = useRefMirror(rows);
  // How many live truths have passed: a read that started before one of them
  // carries an older picture, and is merged but does not win.
  const liveTick = useRef(0);

  const load = useCallback((): Promise<NotificationHistoryPage | null> => {
    const next: Promise<NotificationHistoryPage | null> = (inFlight.current ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => {
        const startedAt = liveTick.current;
        return fetchNotificationHistory({ limit: NOTIFICATION_PAGE_SIZE }).then((page) => ({ page, startedAt }));
      })
      .then(({ page, startedAt }) => {
        // MERGE, not replace: the newest page must not throw away the older
        // pages the reader asked for, nor the live rows arrived since. A read
        // overtaken by a live frame keeps the frame's `seenAt`.
        setRows((prev) => (liveTick.current === startedAt
          ? mergeNotificationPage(prev, page.rows)
          : mergeNotificationPage(page.rows, prev)));
        setHasMore(page.rows.length >= NOTIFICATION_PAGE_SIZE);
        return page;
      })
      .catch(() => null)
      .finally(() => {
        if (inFlight.current === next) inFlight.current = null;
        setLoading(false);
      });
    inFlight.current = next;
    return next;
  }, []);

  useEffect(() => { void load(); }, [load]);

  useWSSubscription(onWSMessage, 'attention:updated', (msg) => {
    const row = msg.history;
    if (!row) return;
    liveTick.current += 1;
    setRows((prev) => mergeNotificationRow(prev, row, NOTIFICATION_MAX_ROWS));
  });

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    const oldest = rowsRef.current[rowsRef.current.length - 1]?.createdAt;
    if (!oldest) return;
    setLoadingMore(true);
    void fetchNotificationHistory({ limit: NOTIFICATION_PAGE_SIZE, before: oldest })
      .then((page) => {
        setRows((prev) => mergeNotificationPage(prev, page.rows));
        setHasMore(page.rows.length >= NOTIFICATION_PAGE_SIZE);
      })
      .catch(() => {
        /* unreachable server: keep what is on screen, and keep the control
           offered - the next click is the retry */
      })
      .finally(() => setLoadingMore(false));
  }, [hasMore, loadingMore, rowsRef]);

  const reload = useCallback(() => { void load(); }, [load]);

  return { rows, loading, hasMore, loadingMore, loadMore, reload };
}
