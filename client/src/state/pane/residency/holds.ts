import { createContext, useContext, useEffect } from 'react';
import { holdKey } from './registry';

/**
 * La chiave della pane che ci sta ospitando. La pubblica `PaneKeepAlive`, cioè
 * l'unico componente che la conosce sempre e per costruzione.
 *
 * Perché un context e non una prop: il guscio keep-alive CONGELA l'elemento
 * React del sottoalbero per ottenere il bailout, quindi una prop nuova non
 * arriverebbe mai a una pane nascosta. React invece propaga i context
 * ATTRAVERSO il bailout — è la stessa ragione per cui una chat nascosta continua
 * a ricevere i suoi messaggi (vedi la nota in `PaneKeepAlive.tsx`). Qui il
 * valore è comunque costante per tutta la vita della pane, quindi non provoca
 * nemmeno un render.
 */
export const PaneKeyContext = createContext<string | undefined>(undefined);

/** La chiave di residenza della pane corrente, se siamo dentro una. */
export function usePaneKey(): string | undefined {
  return useContext(PaneKeyContext);
}

/**
 * Trattiene la pane che ci ospita finché `active` è vero: nessuno sfratto, per
 * quante altre pane si aprano.
 *
 * Si usa per il lavoro che uno SMONTAGGIO PERDEREBBE, non per "questa pane è
 * importante". I due casi reali oggi:
 *
 *  - una pane browser mentre un agente la sta guidando: smontarla toglierebbe
 *    al server l'esecutore delle sue operazioni
 *    (`server/browser-native-delegate.ts`);
 *  - una chat con immagini o file in attesa di invio, o con un messaggio in
 *    modifica: sono gli unici pezzi di stato della chat che NON sono già
 *    persistiti (bozza, coda e scroll lo sono).
 *
 * Fuori da una pane (una superficie che non passa da `PaneKeepAlive`) non fa
 * nulla: nessuna chiave da trattenere, nessun errore.
 */
export function usePaneHold(active: boolean): void {
  const key = usePaneKey();
  useEffect(() => {
    if (!key || !active) return;
    return holdKey(key);
  }, [key, active]);
}
