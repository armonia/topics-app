/**
 * Il ponte fra l'indice dei topic e il predicato di `lib/taskSession.ts`.
 *
 * Rende un RISOLUTORE, non uno stato: la board ha N card, e ognuna vuole sapere
 * di sé. Il risolutore cambia identità solo quando cambia l'INSIEME degli id dei
 * topic — non a ogni metadato che si muove — così le card memoizzate non si
 * ridisegnano perché una chat qualsiasi ha ricevuto un token. Vedi
 * l'intestazione di `lib/taskSession.ts` per il perché delle chiavi al posto
 * della mappa.
 */
import { useMemo } from 'react';
import { useTopics } from '../contexts/TopicsContext';
import { taskSessionState, type TaskSessionState } from '../lib/taskSession';

export type TaskSessionResolver = (assignedTopicId: string | null | undefined) => TaskSessionState;

export function useTaskSessionResolver(): TaskSessionResolver {
  const topics = useTopics();
  // La chiave di memoizzazione è l'elenco ORDINATO degli id: `Object.keys` segue
  // l'ordine di inserimento, quindi senza `sort()` un semplice riordino della
  // mappa produrrebbe una stringa nuova e un risolutore nuovo per niente.
  const idsKey = useMemo(() => Object.keys(topics).sort().join(','), [topics]);
  return useMemo(() => {
    const ids = new Set<string>(idsKey ? idsKey.split(',') : []);
    const resolve: TaskSessionResolver = (assignedTopicId) => taskSessionState(assignedTopicId, ids);
    return resolve;
  }, [idsKey]);
}
