import { useCallback, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../types';
import { subscribeSession } from './messageStore';

/**
 * I messaggi di UNA sessione, con un risveglio che arriva solo per quella.
 *
 * È la seconda metà dello spostamento dei messaggi fuori da `App` (vedi
 * `messageStore.ts` per la prima). Da sola, la prima metà romperebbe la chat:
 * se `App` non si ri-renderizza più quando arriva un token, e nessuno si è
 * iscritto, il messaggio nuovo non raggiunge lo schermo. Questo hook è
 * l'iscrizione.
 *
 * `getSessionMessages` arriva dall'esterno invece di leggere lo store da qui,
 * perché non è una lettura nuda: filtra i messaggi di contesto e tiene una cache
 * per riferimento. Quella logica resta dov'è, in `useChat`, insieme al resto
 * della chat. Qui c'è solo il collegamento.
 *
 * Il contratto che `useSyncExternalStore` impone e che si eredita gratis:
 * `getSessionMessages(sk)` deve restituire lo STESSO array finché quella
 * sessione non cambia. Lo fa già — la sua cache è indicizzata per `src` — ed è
 * la ragione per cui una chat ferma non si ri-renderizza mai.
 */
export function useSessionMessages(
  sessionKey: string,
  getSessionMessages: (sk: string) => ChatMessage[],
): ChatMessage[] {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeSession(sessionKey, onChange),
    [sessionKey],
  );
  const snapshot = useCallback(
    () => getSessionMessages(sessionKey),
    [sessionKey, getSessionMessages],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
