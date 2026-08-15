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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useBoardTasks } from '../lib/boardTasksStore';
import { buildTopicTaskIndex, type TopicTaskRef } from '../lib/taskTopicIndex';
import { applyTaskSessionIndex } from '../state/taskSessions';

export type { TopicTaskRef };

export type TopicTaskResolver = (topicId: string) => TopicTaskRef | null;

export function useTaskTopicIndex(): TopicTaskResolver {
  const tasks = useBoardTasks();
  const index = useMemo(() => buildTopicTaskIndex(tasks), [tasks]);
  const mapRef = useRef(index.byTopic);

  useEffect(() => {
    mapRef.current = index.byTopic;
    // Sostituzione dell'indice intero: `applyTaskSessionIndex` sveglia solo i
    // topic in cui qualcosa è davvero cambiato, quindi un giro a vuoto (lo
    // store riscritto con le stesse righe) non costa un render a nessuna chat.
    applyTaskSessionIndex(index.forStore);
  }, [index]);

  return useCallback((topicId: string) => mapRef.current.get(topicId) ?? null, []);
}
