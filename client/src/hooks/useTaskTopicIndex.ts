/**
 * useTaskTopicIndex — a live topicId → task index for DISPATCHED tasks (those
 * with an `assignedTopicId`). Sourced from the global board feed once on mount,
 * refreshed on any task:* WebSocket event (same trigger as useGlobalBoard).
 *
 * Returns a STABLE resolver so a completion banner for a dispatched-task topic
 * can carry the taskId — clicking the OS notification then opens that task's
 * drawer (see useCompletionNotifier → notifyNative). Reads a ref, so the
 * resolver identity never changes and the notifier never re-subscribes.
 *
 * Non basta più il solo `taskId`: chi silenzia le notifiche deve sapere se
 * l'agente sta lavorando ADESSO (`isAgentWorking(dispatchState)`). Un topic di
 * un task già chiuso torna a essere una chat umana come tutte le altre, e
 * zittirla per sempre sarebbe il bug opposto — quindi la voce è completa,
 * `{ taskId, status, dispatchState }`, non la sola stringa.
 *
 * LA STESSA LETTURA SERVE ALLE CHAT. Da dentro la sessione di un task si deve
 * poter tornare alla sua SCHEDA, e quel legame è esattamente questo indice —
 * solo letto al contrario e in modo reattivo. Invece di una seconda fetch, ogni
 * refresh lo riversa in `state/taskSessions.ts`, lo store per-topic che la chat
 * osserva. Una fonte, due consumatori.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { WSMessage } from '../types';
import { boardApi, type TaskStatus } from '../lib/board';
import { applyTaskSessionIndex, type TopicTaskRef as StoreTaskRef } from '../state/taskSessions';

/** Il task che gira (o è girato) in un topic. */
export interface TopicTaskRef {
  taskId: string;
  /** Colonna kanban corrente (backlog | todo | in_progress | review | done). */
  status: TaskStatus;
  /** null = non dispatchato; queued | starting | working | waiting | delivered | needs_input | … */
  dispatchState: string | null;
}

export type TopicTaskResolver = (topicId: string) => TopicTaskRef | null;

export function useTaskTopicIndex(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): TopicTaskResolver {
  const mapRef = useRef<Map<string, TopicTaskRef>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const tasks = await boardApi.listAll();
      const m = new Map<string, TopicTaskRef>();
      const forStore: Record<string, StoreTaskRef> = {};
      for (const t of tasks) {
        if (!t.assignedTopicId) continue;
        m.set(t.assignedTopicId, { taskId: t.id, status: t.status, dispatchState: t.dispatchState });
        forStore[t.assignedTopicId] = { taskId: t.id, text: t.text, status: t.status, dispatchState: t.dispatchState };
      }
      mapRef.current = m;
      applyTaskSessionIndex(forStore);
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
