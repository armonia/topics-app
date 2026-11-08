/**
 * useTaskTopicIndex — a live topicId → task index for DISPATCHED tasks (those
 * with an `assignedTopicId`), DERIVED from the board feed everyone else already
 * reads (`boardTasksStore`, written by `useGlobalBoard`).
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
 * solo letto al contrario e in modo reattivo. Ogni giro lo riversa in
 * `state/taskSessions.ts`, lo store per-topic che la chat osserva. Una fonte,
 * due consumatori.
 *
 * PERCHÉ NON FETCHA PIÙ. Questo hook è montato in App senza condizioni, e la
 * sua `listAll()` era una SECONDA lettura del feed globale (1,44 MB, 145 ms,
 * misurati il 15/08) a ogni evento `task:*`, non coalescata e senza guardia
 * d'ordine: durante una raffica di dispatch bastava che due risposte tornassero
 * invertite perché nello store della chat restasse installata la voce VECCHIA —
 * cioè un `dispatchState` che dice «sta lavorando» di un turno già finito, che
 * è precisamente la cosa che decide se una notifica si vede o no. Derivandolo
 * dallo store la fetch è una sola, ed è già ordinata all'origine.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { BoardTask } from '../lib/board';
import { getBoardTasks, subscribeBoardTasks } from '../lib/boardTasksStore';
import { buildTopicTaskIndex, type TopicTaskRef } from '../lib/taskTopicIndex';
import { applyTaskSessionIndex } from '../state/taskSessions';

export type { TopicTaskRef };

export type TopicTaskResolver = (topicId: string) => TopicTaskRef | null;

/**
 * SUBSCRIBED OUTSIDE THE RENDER. This hook is mounted in `App`, and nothing it
 * returns changes: the resolver is stable and reads a ref, and the chat store
 * is written from here. It used to read the rows with `useBoardTasks()`, which
 * made `App` re-render on every write of the store, that is on every
 * `task:updated` an agent at work re-emits, only to run an effect. Now the
 * store wakes a plain callback, which rebuilds the index when the rows changed
 * (the store keeps the array on a repeated feed) and renders nobody.
 */
export function useTaskTopicIndex(): TopicTaskResolver {
  const mapRef = useRef<Map<string, TopicTaskRef>>(new Map());

  useEffect(() => {
    let seen: readonly BoardTask[] | null = null;
    const sync = () => {
      const tasks = getBoardTasks();
      if (tasks === seen) return;
      seen = tasks;
      const index = buildTopicTaskIndex(tasks);
      mapRef.current = index.byTopic;
      // Sostituzione dell'indice intero: `applyTaskSessionIndex` sveglia solo i
      // topic in cui qualcosa è davvero cambiato, quindi un giro a vuoto (lo
      // store riscritto con le stesse righe) non costa un render a nessuna chat.
      applyTaskSessionIndex(index.forStore);
    };
    sync();
    return subscribeBoardTasks(sync);
  }, []);

  return useCallback((topicId: string) => mapRef.current.get(topicId) ?? null, []);
}
