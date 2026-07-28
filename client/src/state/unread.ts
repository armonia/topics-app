import type { UnreadData } from '../types';

/**
 * Riduttori PURI del conteggio non-letti.
 *
 * Vivono fuori da `useWebSocket` per un motivo di sostanza, non di ordine: la
 * loro proprietà importante è l'IDENTITÀ del valore di ritorno. `unreadData`
 * risale fino ad `App` e da lì ridiscende nel provider delle notifiche e nella
 * sidebar, quindi un oggetto nuovo — anche se identico campo per campo —
 * ri-renderizza l'albero intero. Entrambe le funzioni restituiscono `prev`
 * IDENTICO quando non cambia niente, ed è questo che rende il no-op gratis.
 * Qui la regola si può fissare con dei test; dentro l'hook no.
 */

/**
 * Applica un `unread:updated` dal server. Restituisce `prev` se il conteggio è
 * già quello: è il caso più frequente, perché ogni client riceve il frame ogni
 * volta che chiunque, ovunque, apre una tab.
 */
export function applyUnreadUpdate(prev: UnreadData, topicId: string, unreadCount: number): UnreadData {
  // Riga assente ≡ zero. Senza il `?? 0` un `unread:updated{0}` su una topic
  // mai stata non letta — cioè il frame più comune di tutti — fabbricherebbe
  // una riga a zero e con essa un render globale, per non dire niente di nuovo.
  // Non materializzarla è anche coerente col server, che dal canto suo non
  // scrive righe a zero (`POST /topics/:id/read` esce subito).
  if ((prev[topicId]?.unreadCount ?? 0) === unreadCount) return prev;
  return {
    ...prev,
    [topicId]: {
      lastReadAt: prev[topicId]?.lastReadAt || new Date().toISOString(),
      unreadCount,
    },
  };
}

/**
 * Azzeramento ottimistico locale sul ping di focus. Restituisce `prev` se la
 * topic era già letta (o mai vista), così un cambio di tab su chat già lette —
 * cioè quasi sempre — non costa un render.
 */
export function clearUnreadFor(prev: UnreadData, topicId: string): UnreadData {
  if (!prev[topicId]?.unreadCount) return prev;
  return { ...prev, [topicId]: { ...prev[topicId], unreadCount: 0 } };
}

/** C'è davvero qualcosa da azzerare? Va letto PRIMA di `clearUnreadFor`. */
export function hasUnread(data: UnreadData, topicId: string): boolean {
  return (data[topicId]?.unreadCount ?? 0) > 0;
}
