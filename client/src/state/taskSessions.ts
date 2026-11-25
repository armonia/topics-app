import { useCallback, useSyncExternalStore } from 'react';
import { createKeyedListeners } from '../lib/keyedListeners';

/**
 * L'altra metà del legame fra una SCHEDA di task e la SESSIONE che la lavora:
 * dato un topic, qual è il suo task.
 *
 * PERCHÉ ESISTE. Il verso scheda → sessione ce l'aveva già (`assignedTopicId`
 * sta sulla card). Il verso opposto no: da dentro la chat dell'agente non c'era
 * modo di tornare alla scheda, cioè alla superficie dove si decide — e il
 * `Topic` non porta l'id del task, perché il legame vive sul task.
 *
 * LA FORMA. Uno store di modulo con sottoscrizione PER TOPIC, come
 * `topicPreviews.ts` e per lo stesso motivo: ogni chat aperta chiede del proprio
 * topic e basta, e un task che cambia stato dall'altra parte della board non
 * deve svegliare nessuna delle altre.
 *
 * UNA SOLA FONTE. Lo riempie `useTaskTopicIndex`, montato una volta in App, con
 * la stessa fetch del feed globale che serviva già al silenziatore delle
 * notifiche: nessuna richiesta in più, nessun secondo listener WS.
 *
 * IDENTITÀ. `getTopicTask` rende lo stesso oggetto finché quel topic non cambia
 * — `useSyncExternalStore` lo pretende (uno snapshot nuovo a ogni chiamata è un
 * loop infinito), e per le chat ferme significa zero render.
 */

/** Il task che gira (o è girato) in un topic. */
export interface TopicTaskRef {
  taskId: string;
  /** Serve alla riga di ritorno: mostrare l'id nudo non direbbe niente. */
  text: string;
  /** Colonna kanban corrente (backlog | todo | in_progress | review | done). */
  status: string;
  /** null = non dispatchato; queued | starting | working | waiting | … */
  dispatchState: string | null;
}

let state: Record<string, TopicTaskRef> = {};
/** Iscritti per topic. È l'unica ragione per cui questo store esiste. */
const perTopic = createKeyedListeners<string>();
/** The reverse direction, task → topic, for the board card's loader (`useTaskAction`). */
let topicByTask = new Map<string, string>();
/** Subscribers to the reverse index: woken only when a task's topic changes. */
const perTask = new Map<string, Set<() => void>>();

/** Il task di un topic, con identità stabile finché non cambia. */
export function getTopicTask(topicId: string): TopicTaskRef | undefined {
  return state[topicId];
}

/** Si iscrive a UN topic: un task che si muove altrove non lo sveglia. */
export function subscribeTopicTask(topicId: string, fn: () => void): () => void {
  return perTopic.subscribe(topicId, fn);
}

/**
 * Rimpiazza l'indice intero con quello appena letto dal feed di board.
 *
 * Sostituzione e non fusione: un task che perde il suo `assignedTopicId` (o che
 * viene archiviato) sparisce dal feed, e fondendo resterebbe nell'indice per
 * sempre — la riga di ritorno punterebbe a una scheda che non c'è.
 *
 * Sveglia SOLO i topic per cui qualcosa è davvero cambiato: il feed si rilegge
 * a ogni evento `task:*`, che durante un dispatch arriva a raffica, e ogni
 * rilettura produce oggetti nuovi ma quasi sempre uguali.
 */
export function applyTaskSessionIndex(next: Record<string, TopicTaskRef>): void {
  const touched: string[] = [];
  for (const [topicId, ref] of Object.entries(next)) {
    const prev = state[topicId];
    if (prev && prev.taskId === ref.taskId && prev.text === ref.text
      && prev.status === ref.status && prev.dispatchState === ref.dispatchState) {
      // Nessun cambiamento: si tiene l'oggetto VECCHIO, così l'identità regge.
      next[topicId] = prev;
      continue;
    }
    touched.push(topicId);
  }
  for (const topicId of Object.keys(state)) {
    if (!(topicId in next)) touched.push(topicId);
  }
  state = next;
  for (const topicId of touched) {
    perTopic.emit(topicId);
  }
  const nextByTask = new Map<string, string>();
  for (const [topicId, ref] of Object.entries(next)) nextByTask.set(ref.taskId, topicId);
  const prevByTask = topicByTask;
  topicByTask = nextByTask;
  for (const [taskId, subs] of perTask) {
    if (prevByTask.get(taskId) !== nextByTask.get(taskId)) for (const fn of subs) fn();
  }
}

/** The topic of ONE task, waking only when that task's topic changes. */
export function useTaskTopicId(taskId: string | undefined): string | undefined {
  const subscribe = useCallback((onChange: () => void) => {
    if (!taskId) return () => {};
    let subs = perTask.get(taskId);
    if (!subs) { subs = new Set(); perTask.set(taskId, subs); }
    subs.add(onChange);
    return () => {
      const s = perTask.get(taskId);
      if (!s) return;
      s.delete(onChange);
      if (s.size === 0) perTask.delete(taskId);
    };
  }, [taskId]);
  const snapshot = useCallback(() => (taskId ? topicByTask.get(taskId) : undefined), [taskId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Il task di un topic, con un risveglio che arriva solo per quello. */
export function useTopicTask(topicId: string | undefined): TopicTaskRef | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => (topicId ? subscribeTopicTask(topicId, onChange) : () => {}),
    [topicId],
  );
  const snapshot = useCallback(() => (topicId ? getTopicTask(topicId) : undefined), [topicId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** @internal Solo per i test: riporta lo store allo stato di boot. */
export function __resetTaskSessions(): void {
  state = {};
  perTopic.clear();
  topicByTask = new Map();
  perTask.clear();
}
