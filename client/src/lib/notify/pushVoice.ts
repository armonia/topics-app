/**
 * Una sola voce per evento, quando il dispositivo è iscritto al push.
 *
 * Finché `push_subscriptions` era vuota il problema non esisteva: l'unica
 * superficie era la pagina, che al `task:review-ready` ricevuto via WebSocket
 * disegnava il suo banner. Dal momento in cui il telefono si iscrive, LO STESSO
 * evento arriva due volte — una via WebSocket alla pagina, una via push al
 * service worker — e ogni evento diventa due banner sovrapposti.
 *
 * La regola è: se il dispositivo è iscritto, per gli eventi che il push copre
 * parla il push. Non è una scelta di stile, è l'unica che tiene ad app chiusa:
 * la pagina lì non c'è, quindi la voce affidabile è quella del worker, e averne
 * una seconda quando l'app è aperta non aggiunge informazione — aggiunge un
 * doppione.
 *
 * L'insieme coperto è ESPLICITO e va tenuto allineato a `maybeSendPush`
 * (`server/push-triggers.ts`). Un evento che il push NON manda continua a
 * passare dalla pagina: silenziare tutto «tanto c'è il push» perderebbe i
 * segnali dei terminali (`session:state`), che il push non emette e che
 * altrimenti sparirebbero senza che nessuno lo dica.
 */

/** Il segnale, dal punto di vista di chi decide chi lo annuncia. */
export type NotifyEventKind =
  | 'task:review-ready'
  | 'task:parked'
  | 'message:new'
  | 'session:state';

/**
 * Gli eventi che il server manda ANCHE via push.
 *
 * `message:new` c'è perché il suo gemello lato server è `stream:end` («Claude ha
 * finito di rispondere»): nomi diversi, stesso fatto per l'utente — la risposta
 * è pronta. Due banner che dicono la stessa cosa restano due banner.
 */
export const PUSH_COVERED_EVENTS: ReadonlySet<NotifyEventKind> = new Set<NotifyEventKind>([
  'task:review-ready',
  'task:parked',
  'message:new',
]);

/**
 * La pagina può disegnare il banner per questo evento?
 *
 * `subscribed` è «questo dispositivo ha una subscription push VIVA» — non «il
 * browser supporta il push» e nemmeno «il permesso è concesso»: senza una
 * subscription registrata nessuna push arriverà mai, e tacere per lasciar
 * parlare una voce che non esiste è il modo esatto in cui si perde una notifica.
 */
export function inPageBannerAllowed(subscribed: boolean, event: NotifyEventKind): boolean {
  if (!subscribed) return true;
  return !PUSH_COVERED_EVENTS.has(event);
}
