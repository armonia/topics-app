/**
 * useTaskTopicIndex — a live topicId → taskId index for DISPATCHED tasks (those
 * with an `assignedTopicId`). Sourced from the global board feed once on mount,
 * refreshed on any task:* WebSocket event (same trigger as useGlobalBoardCount).
 *
 * Returns a STABLE resolver so a completion banner for a dispatched-task topic
 * can carry the taskId — clicking the OS notification then opens that task's
 * drawer (see useCompletionNotifier → notifyNative). Reads a ref, so the
 * resolver identity never changes and the notifier never re-subscribes.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { WSMessage } from '../types';
import { boardApi } from '../lib/board';

export function useTaskTopicIndex(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): (topicId: string) => string | null {
  const mapRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const tasks = await boardApi.listAll();
      const m = new Map<string, string>();
      for (const t of tasks) if (t.assignedTopicId) m.set(t.assignedTopicId, t.id);
      mapRef.current = m;
    } catch {
      /* keep the last index on a transient failure */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'task:created' || t === 'task:updated' || t === 'task:deleted') void refresh();
    });
  }, [onMessage, refresh]);

  return useCallback((topicId: string) => mapRef.current.get(topicId) ?? null, []);
}
